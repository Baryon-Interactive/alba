import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { excludeLocally } from '../skills/mount.ts';

/** One message left in a worktree's `.alba/inbox.md` for the run that is working there. */
export interface InboxMessage {
  id: string;
  reply?: string;
  delivery?: 'sent' | 'read' | 'answered';
  at: string;
  author: string;
  text: string;
  /** Set when the worker has appended `seen <time>` under the message. */
  seen?: string;
}

const HEADER = /^## (\S+) (\S+) (\S+)$/;
const SEEN = /^seen (\S+)$/;

export const inboxPath = (worktree: string): string => path.join(worktree, '.alba', 'inbox.md');

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

export function readInbox(worktree: string, openedAt?: string): InboxMessage[] {
  const file = inboxPath(worktree);
  const ack = path.join(worktree, '.alba', 'inbox-ack');
  const ids = new Set(existsSync(ack) ? readFileSync(ack, 'utf8').split(/\s+/) : []);
  return (existsSync(file) ? parseInbox(readFileSync(file, 'utf8')) : []).map(m => {
    const seen = m.seen ?? (m.id && ids.has(m.id) ? m.at : openedAt && openedAt >= m.at ? openedAt : undefined);
    return { ...m, ...(seen ? { seen } : {}), delivery: seen ? 'read' : 'sent' };
  });
}

/** Creates an empty inbox when a run starts, so a worker that follows the rule "read the inbox" finds a file instead of failing the same read again and again. */
export function ensureInbox(worktree: string): void {
  const file = inboxPath(worktree);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, '', 'utf8');
  excludeLocally(worktree, ['.alba/inbox.md', '.alba/inbox-ack', '.alba/outbox.jsonl']);
}

/** The machine-lock helper (src/run/lock-helper.mjs) at `.alba/bin/lock.mjs` of the worktree, kept out of git. */
export function installLockHelper(worktree: string): void {
  const to = path.join(worktree, '.alba', 'bin', 'lock.mjs');
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./lock-helper.mjs', import.meta.url)), to);
  excludeLocally(worktree, ['.alba/bin/']);
}

/** Appends one message and keeps the file out of git via the worktree's info/exclude (never the repository .gitignore). */
export function appendInbox(worktree: string, message: { id?: string; at: string; author: string; text: string; reply?: string }): string {
  const file = inboxPath(worktree);
  const id = message.id ?? randomUUID();
  mkdirSync(path.dirname(file), { recursive: true });
  // Escape header/metadata-looking body lines so the simple format cannot manufacture another entry.
  const text = message.text.trim().replace(/^(## |seen |reply )/gm, '> $1');
  appendFileSync(file, `## ${id} ${message.at} ${message.author.replace(/\s+/g, '-')}\n${message.reply ? `reply ${message.reply}\n` : ''}\n${text}\n\n`, 'utf8');
  excludeLocally(worktree, ['.alba/inbox.md', '.alba/inbox-ack', '.alba/outbox.jsonl']);
  return id;
}
