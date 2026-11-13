import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n.ts';
import type { CodexSessionsQuota } from './config.ts';
import { failed, type QuotaReading, type QuotaWindow } from './quota.ts';

/**
 * The `codex-sessions` quota source: the usage windows of a Codex subscription, read from the session files Codex writes itself
 * (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`). After each turn Codex records the account's `rate_limits` there (primary
 * and secondary windows with `used_percent`, `window_minutes` and the reset time). Nothing is called and no quota is spent: the
 * reader only looks at the newest files. `codex exec --json` (what a worker's events file holds) does not carry these numbers,
 * but the same run writes them into its session file; a line of any of these shapes in any JSON Lines text is read the same way.
 */

/** How many of the newest session files are looked at, from how many day folders, and how much of the end of each. */
const FILES = 20, DAYS = 7, TAIL = 1024 * 1024;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** "5 hours", "7 days": a window is named by its length, so `window_full: "7 days"` stays right whichever slot Codex puts it in. */
export function windowName(minutes: number | undefined, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (minutes % 1440 === 0) return unit(minutes / 1440, 'day');
  if (minutes % 60 === 0) return unit(minutes / 60, 'hour');
  return unit(minutes, 'minute');
}

/** A reset time: epoch seconds (or milliseconds), an ISO text, or seconds after the event. */
function resetOf(limit: Record<string, unknown>, eventAt: string | undefined): string | undefined {
  const at = limit.resets_at ?? limit.resetsAt;
  const n = num(at);
  if (n !== undefined) return new Date(n > 1e12 ? n : n * 1000).toISOString();
  if (typeof at === 'string' && Number.isFinite(Date.parse(at))) return new Date(at).toISOString();
  const after = num(limit.resets_in_seconds ?? limit.resetsInSeconds);
  if (after !== undefined && eventAt && Number.isFinite(Date.parse(eventAt))) return new Date(Date.parse(eventAt) + after * 1000).toISOString();
  return undefined;
}

export interface CodexLimits { windows: QuotaWindow[]; balance?: string; observedAt?: string }

/** The rate limits one JSON line carries (a session file's `token_count`, an older `codex exec --json` event or an app-server notice). */
export function limitsOfLine(line: string): CodexLimits | undefined {
  if (!line.includes('ate_limits') && !line.includes('ateLimits')) return undefined;
  let e: unknown;
  try { e = JSON.parse(line); } catch { return undefined; }
  if (!record(e)) return undefined;
  const inner = (k: string) => (record(e[k]) ? e[k] as Record<string, unknown> : undefined);
  const rl = [inner('payload')?.rate_limits, inner('msg')?.rate_limits, e.rate_limits, inner('params')?.rateLimits, inner('payload')?.rateLimits].find(record);
  if (!rl) return undefined;
  const observedAt = [e.timestamp, e.alba_at].find((x): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x)));
  const windows: QuotaWindow[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const limit = rl[slot];
    if (!record(limit)) continue;
    const used = num(limit.used_percent ?? limit.usedPercent);
    if (used === undefined) continue;
    const resetsAt = resetOf(limit, observedAt);
    windows.push({ name: windowName(num(limit.window_minutes ?? limit.windowDurationMins), slot), usedPercent: used, ...(resetsAt ? { resetsAt } : {}) });
  }
  const credits = record(rl.credits) ? rl.credits : undefined;
  const balance = credits && credits.has_credits !== false && credits.unlimited !== true && num(credits.balance) !== undefined ? `${num(credits.balance)} credits` : undefined;
  if (!windows.length && !balance) return undefined;
  return { windows, ...(balance ? { balance } : {}), ...(observedAt ? { observedAt } : {}) };
}

/** The last rate limits in a JSON Lines text (the newest line that has any). */
export function latestLimits(text: string): CodexLimits | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) { const found = limitsOfLine(lines[i]!.trim()); if (found) return found; }
  return undefined;
}

function tail(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { closeSync(fd); }
}

/** The newest session files: those of the newest day folders (and any directly in `sessions`), most recently written first. */
export function newestSessionFiles(root: string, limit = FILES): string[] {
  const files: string[] = [];
  const entries = (dir: string) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  const jsonl = (dir: string) => entries(dir).filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => path.join(dir, e.name));
  files.push(...jsonl(root));
  let days = 0;
  const walk = (dir: string, depth: number): void => {
    for (const e of entries(dir).filter(x => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      if (days >= DAYS) return;
      const sub = path.join(dir, e.name);
      if (depth === 2) { files.push(...jsonl(sub)); days++; } else walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  const time = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
  return files.map(f => ({ f, at: time(f) })).sort((a, b) => b.at - a.at).slice(0, limit).map(x => x.f);
}

export const codexHomeOf = (config: CodexSessionsQuota, env: NodeJS.ProcessEnv = process.env): string => config.codex_home ?? env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

/**
 * One reading of a Codex subscription. A window whose reset time has passed since Codex wrote it is shown as 0 percent used.
 * A home without sessions folder is an error (the source names the wrong folder); a home with no limits written yet is a reading
 * without windows, so the first run can start.
 */
export function readCodexSessions(source: string, config: CodexSessionsQuota, at: string, env: NodeJS.ProcessEnv = process.env): QuotaReading {
  const root = path.join(codexHomeOf(config, env), 'sessions');
  if (!existsSync(root)) return failed(source, at, t('no Codex sessions folder at {path}; set codex_home to the CODEX_HOME the worker uses', { path: root.replace(/\\/g, '/') }));
  // A file written last may hold older limits (a long session that has not finished a turn since): the newest observation wins.
  let found: CodexLimits | undefined;
  const when = (x: CodexLimits | undefined) => (x?.observedAt ? Date.parse(x.observedAt) : -Infinity);
  for (const file of newestSessionFiles(root)) {
    let limits: CodexLimits | undefined;
    try { limits = latestLimits(tail(file, TAIL)); } catch { continue; }
    if (limits && (!found || when(limits) > when(found))) found = limits;
  }
  if (!found) return { source, at, ok: true, windows: [], entries: 0 };
  const now = Date.parse(at);
  const windows = found.windows.map(w => (w.resetsAt && Date.parse(w.resetsAt) <= now ? { name: w.name, usedPercent: 0 } : w));
  const amount = found.balance ? num(found.balance.split(' ')[0]) : undefined;
  return { source, at, ok: true, windows, entries: 1, ...(found.balance ? { balance: { raw: found.balance, ...(amount !== undefined ? { amount } : {}) } } : {}) };
}
