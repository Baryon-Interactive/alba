import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { excludeLocally } from '../skills/mount.ts';
import { LiveFold } from '../workers/adapters/activity.ts';

export type DeliveryVia = 'hook' | 'steer' | 'turn';
export type InboxDeliveryState = 'sent' | 'delivered' | 'read' | 'answered';
export type SayDeliveryMode = 'live' | 'steer' | 'file';

export interface InboxDeliveryRecord {
  id: string;
  at: string;
  via: DeliveryVia;
  event?: string;
}

export interface ReadInboxOptions {
  openedAt?: string;
  /** Timestamps (ISO) of model activity (messages, tool calls, commands) from the run's events, or the latest activity timestamp. */
  activityAt?: string | readonly string[];
  /** Path to the run's JSONL events file; read when `activityAt` is not provided. */
  eventsFile?: string;
}

/** One message left in a worktree's `.alba/inbox.md` for the run that is working there. */
export interface InboxMessage {
  id: string;
  reply?: string;
  delivery?: InboxDeliveryState;
  delivered_at?: string;
  via?: DeliveryVia;
  at: string;
  author: string;
  text: string;
  /** Set when the worker has appended `seen <time>` under the message, acknowledged it, opened the inbox, or acted after delivery. */
  seen?: string;
}

const HEADER = /^## (\S+) (\S+) (\S+)$/;
const SEEN = /^seen (\S+)$/;
const VALID_VIA = new Set<string>(['hook', 'steer', 'turn']);
const INBOX_EXCLUDES = ['.alba/inbox.md', '.alba/inbox-ack', '.alba/inbox-delivered', '.alba/inbox-claimed/', '.alba/outbox.jsonl'];
const MAX_PAYLOAD_BYTES = 16 * 1024;
const TRUNC_NOTE = '\n... [truncated; full message is in .alba/inbox.md]';

export const inboxPath = (worktree: string): string => path.join(worktree, '.alba', 'inbox.md');
export const deliveredPath = (worktree: string): string => path.join(worktree, '.alba', 'inbox-delivered');

/** Reads the inbox. A message is seen when a `seen <time>` line appears before the next header. */
export function parseInbox(text: string): InboxMessage[] {
  const out: InboxMessage[] = [];
  let cur: { id: string; reply?: string; at: string; author: string; seen?: string } | undefined;
  const body: string[] = [];
  const flush = () => {
    if (!cur) return;
    const message = body.join('\n').trim();
    if (message) out.push({ ...cur, text: message });
    body.length = 0;
  };
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) { flush(); cur = { id: header[1], at: header[2], author: header[3] }; continue; }
    if (!cur) continue;
    if (/^reply \S+$/.test(line) && body.every(l => !l.trim())) { cur.reply = line.slice(6); continue; }
    const seen = SEEN.exec(line);
    if (seen && cur.seen === undefined) { cur.seen = seen[1]; continue; }
    body.push(line);
  }
  flush();
  return out;
}

/** Reads `.alba/inbox-delivered` JSONL records, keeping the first valid record per message id. */
export function readDelivered(worktree: string): Map<string, InboxDeliveryRecord> {
  const out = new Map<string, InboxDeliveryRecord>();
  const file = deliveredPath(worktree);
  if (!existsSync(file)) return out;
  try {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const v = JSON.parse(line) as Record<string, unknown>;
        if (typeof v.id !== 'string' || !v.id || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) continue;
        if (typeof v.via !== 'string' || !VALID_VIA.has(v.via)) continue;
        if (!out.has(v.id)) out.set(v.id, { id: v.id, at: v.at, via: v.via as DeliveryVia, ...(typeof v.event === 'string' ? { event: v.event } : {}) });
      } catch { /* ignore malformed lines */ }
    }
  } catch { /* unreadable delivery log */ }
  return out;
}

/** Appends one delivery record to `.alba/inbox-delivered` and keeps it out of git. */
export function appendDelivered(worktree: string, record: InboxDeliveryRecord): void {
  const file = deliveredPath(worktree);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  excludeLocally(worktree, INBOX_EXCLUDES);
}

/** Extracts model activity timestamps (messages, tool calls, commands, file changes) from a run's JSONL events file. */
export function activityTimesFromEvents(eventsFile: string): string[] {
  if (!existsSync(eventsFile)) return [];
  const fold = new LiveFold();
  const times: string[] = [];
  let lastSeen: string | undefined;
  try {
    for (const raw of readFileSync(eventsFile, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        const observed = typeof ev.alba_at === 'string' ? ev.alba_at : typeof ev.timestamp === 'string' ? ev.timestamp : typeof ev.at === 'string' ? ev.at : '';
        fold.event(ev, observed);
        const act = fold.state.last_activity_at;
        if (act && act !== lastSeen && Number.isFinite(Date.parse(act))) {
          times.push(act);
          lastSeen = act;
        }
      } catch { /* skip non-JSON or partial line */ }
    }
  } catch { /* unreadable events file */ }
  return times;
}

/** Formats inbox messages for mid-run delivery, oldest first, capped at 16 KiB UTF-8. */
export function frameInboxMessages(messages: readonly Pick<InboxMessage, 'id' | 'at' | 'author' | 'text'>[], maxBytes = MAX_PAYLOAD_BYTES): string {
  const framed = messages.map(m => [
    `[alba message id=${m.id} from=${m.author} at=${m.at}]`,
    m.text,
    `After acting on this message, append ${m.id} to .alba/inbox-ack; if a reply is needed, append a JSON line to .alba/outbox.jsonl with "reply": "${m.id}".`,
  ].join('\n')).join('\n\n');
  const buf = Buffer.from(framed, 'utf8');
  if (buf.length <= maxBytes) return framed;
  const noteBytes = Buffer.byteLength(TRUNC_NOTE, 'utf8');
  let end = Math.max(0, maxBytes - noteBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + TRUNC_NOTE;
}

function firstActivityAfter(times: readonly string[], deliveredAt: string): string | undefined {
  const target = Date.parse(deliveredAt);
  if (!Number.isFinite(target)) return undefined;
  let best: string | undefined;
  let bestMs = Infinity;
  for (const t of times) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > target && ms < bestMs) {
      bestMs = ms;
      best = t;
    }
  }
  return best;
}

export function readInbox(worktree: string, openedOrOpts?: string | ReadInboxOptions): InboxMessage[] {
  const opts: ReadInboxOptions = typeof openedOrOpts === 'string' ? { openedAt: openedOrOpts } : (openedOrOpts ?? {});
  const openedAt = opts.openedAt;
  const file = inboxPath(worktree);
  const ack = path.join(worktree, '.alba', 'inbox-ack');
  const ids = new Set(existsSync(ack) ? readFileSync(ack, 'utf8').split(/\s+/).filter(Boolean) : []);
  const delivered = readDelivered(worktree);
  const activityTimes: string[] = opts.activityAt !== undefined
    ? (typeof opts.activityAt === 'string' ? [opts.activityAt] : [...opts.activityAt])
    : opts.eventsFile ? activityTimesFromEvents(opts.eventsFile) : [];
  return (existsSync(file) ? parseInbox(readFileSync(file, 'utf8')) : []).map(m => {
    const del = delivered.get(m.id);
    const explicitSeen = m.seen ?? (m.id && ids.has(m.id) ? m.at : openedAt && openedAt >= m.at ? openedAt : undefined);
    const activitySeen = !explicitSeen && del ? firstActivityAfter(activityTimes, del.at) : undefined;
    const seen = explicitSeen ?? activitySeen;
    const delivery: InboxDeliveryState = seen ? 'read' : del ? 'delivered' : 'sent';
    return {
      ...m,
      ...(del ? { delivered_at: del.at, via: del.via } : {}),
      ...(seen ? { seen } : {}),
      delivery,
    };
  });
}

/** Creates an empty inbox when a run starts, so a worker that follows the rule "read the inbox" finds a file instead of failing the same read again and again. */
export function ensureInbox(worktree: string): void {
  const file = inboxPath(worktree);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, '', 'utf8');
  excludeLocally(worktree, INBOX_EXCLUDES);
}

/** The machine-lock helper (src/run/lock-helper.mjs) at `.alba/bin/lock.mjs` of the worktree, kept out of git. */
export function installLockHelper(worktree: string): void {
  const to = path.join(worktree, '.alba', 'bin', 'lock.mjs');
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./lock-helper.mjs', import.meta.url)), to);
  copyFileSync(fileURLToPath(new URL('./named-lock.mjs', import.meta.url)), path.join(path.dirname(to), 'named-lock.mjs'));
  excludeLocally(worktree, ['.alba/bin/']);
}

/** Copies the inbox hook helper (`src/run/inbox-hook.mjs`) to `.alba/bin/inbox-hook.mjs` in the worktree and excludes it locally. */
export function installInboxHook(worktree: string): string {
  const to = path.join(worktree, '.alba', 'bin', 'inbox-hook.mjs');
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./inbox-hook.mjs', import.meta.url)), to);
  excludeLocally(worktree, ['.alba/bin/', ...INBOX_EXCLUDES]);
  return to;
}

/** Quotes a shell argument safely for hook commands on Windows and POSIX (paths with spaces). */
export function quoteHookArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Builds the command line invoked by Claude or agy lifecycle hooks. */
export function hookCommand(hookScript: string, engine: 'claude' | 'agy', event: 'post-tool-use' | 'pre-invocation' | 'stop', nodeBin = process.execPath): string {
  return `${quoteHookArg(nodeBin)} ${quoteHookArg(hookScript)} ${engine} ${event}`;
}

function isTracked(worktree: string, relPath: string): boolean {
  try {
    return execFileSync('git', ['-C', worktree, 'ls-files', '--', relPath], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Installs Alba's `"alba"` hook group into `<worktree>/.agents/hooks.json` for agy runs.
 * Preserves all other groups. Refuses to edit a tracked `.agents/hooks.json`, returning a warning instead.
 */
export function installAgyInboxHooks(worktree: string, hookScript: string, nodeBin = process.execPath): { installed: boolean; warning?: string } {
  const rel = '.agents/hooks.json';
  const file = path.join(worktree, '.agents', 'hooks.json');
  if (isTracked(worktree, rel)) {
    return { installed: false, warning: `${rel} is tracked in git; live message hooks skipped (falling back to file inbox).` };
  }
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { installed: false, warning: `${rel} is not a JSON object; live message hooks skipped (falling back to file inbox).` };
      }
      existing = parsed as Record<string, unknown>;
    } catch {
      return { installed: false, warning: `${rel} could not be parsed as JSON; live message hooks skipped (falling back to file inbox).` };
    }
  }
  const merged = {
    ...existing,
    alba: {
      PreInvocation: [{ type: 'command', command: hookCommand(hookScript, 'agy', 'pre-invocation', nodeBin), timeout: 10 }],
      Stop: [{ type: 'command', command: hookCommand(hookScript, 'agy', 'stop', nodeBin), timeout: 10 }],
    },
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  excludeLocally(worktree, ['/.agents/hooks.json']);
  return { installed: true };
}

/**
 * Removes Alba's `"alba"` group from `<worktree>/.agents/hooks.json`, leaving every other group intact.
 * Never edits a tracked `.agents/hooks.json`. Deletes the file if `"alba"` was the only group.
 */
export function cleanAgyInboxHooks(worktree: string): void {
  const rel = '.agents/hooks.json';
  const file = path.join(worktree, '.agents', 'hooks.json');
  if (!existsSync(file) || isTracked(worktree, rel)) return;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'alba')) return;
    const next = { ...(parsed as Record<string, unknown>) };
    delete next.alba;
    if (Object.keys(next).length === 0) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch { /* leave unrecognized files alone */ }
}

/** Removes Alba's worktree hook entries (leaving other groups in `.agents/hooks.json` alone) and the copied hook helper. */
export function cleanInboxHooks(worktree: string): void {
  cleanAgyInboxHooks(worktree);
  rmSync(path.join(worktree, '.alba', 'bin', 'inbox-hook.mjs'), { force: true });
}

/** Appends one message and keeps the file out of git via the worktree's info/exclude (never the repository .gitignore). */
export function appendInbox(worktree: string, message: { id?: string; at: string; author: string; text: string; reply?: string }): string {
  const file = inboxPath(worktree);
  const id = message.id ?? randomUUID();
  mkdirSync(path.dirname(file), { recursive: true });
  // Escape header/metadata-looking body lines so the simple format cannot manufacture another entry.
  const text = message.text.trim().replace(/^(## |seen |reply )/gm, '> $1');
  appendFileSync(file, `## ${id} ${message.at} ${message.author.replace(/\s+/g, '-')}\n${message.reply ? `reply ${message.reply}\n` : ''}\n${text}\n\n`, 'utf8');
  excludeLocally(worktree, INBOX_EXCLUDES);
  return id;
}
