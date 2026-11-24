import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { t } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import { ownerOf } from '../usage/spend.ts';
import type { ClaudeStreamQuota, WorkersFile } from './config.ts';
import type { QuotaReading, QuotaWindow } from './quota.ts';

/**
 * The `claude-stream` quota source: subscription usage windows read from `rate_limit_event` lines
 * in Claude Code's `stream-json` run logs (for claude-cli workers naming this source).
 * Calls nothing and spends no quota: tail-only reads of the newest logs in this project's state.
 */

export const DEFAULT_MAX_AGE_HOURS = 168;
const FILES = 30;
const TAIL = 1024 * 1024;

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5 hours',
  seven_day: '7 days',
  seven_day_opus: '7 days opus',
  seven_day_sonnet: '7 days sonnet',
};

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

const roundPct = (value: number): number => Math.round(value * 100) / 100;

/** Maps known Claude rateLimitType values to human window names and preserves unknown types verbatim. */
export function claudeWindowName(rateLimitType: string): string {
  return WINDOW_NAMES[rateLimitType] ?? rateLimitType;
}

function resetOf(entry: Record<string, unknown>): string | undefined {
  const raw = entry.resetsAt ?? entry.resets_at;
  const n = num(raw);
  if (n !== undefined) return new Date(n > 1e12 ? n : n * 1000).toISOString();
  if (typeof raw === 'string' && Number.isFinite(Date.parse(raw))) return new Date(raw).toISOString();
  return undefined;
}

function observedAtOf(event: Record<string, unknown>, info: Record<string, unknown>, fallbackAt?: string): string | undefined {
  for (const candidate of [event.alba_at, event.timestamp, event.at, info.timestamp, info.at]) {
    if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))) {
      return new Date(candidate).toISOString();
    }
    const n = num(candidate);
    if (n !== undefined) return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  return fallbackAt;
}

export interface ClaudeLimits {
  windows: QuotaWindow[];
  observedAt?: string;
}

interface RawWindow {
  utilization?: number;
  status?: string;
  resetsAt?: string;
}

/** Parses one `rate_limit_event` stream-json line into normalized quota windows. Broken lines return undefined. */
export function claudeLimitsOfLine(line: string, fallbackAt?: string): ClaudeLimits | undefined {
  if (!line.includes('rate_limit_event')) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return undefined; }
  if (!record(parsed) || parsed.type !== 'rate_limit_event') return undefined;
  const info = record(parsed.rate_limit_info) ? parsed.rate_limit_info : undefined;
  if (!info) return undefined;

  const byKey = new Map<string, RawWindow>();
  if (record(info.unifiedWindows)) {
    for (const [key, value] of Object.entries(info.unifiedWindows)) {
      if (!key.trim() || !record(value)) continue;
      const util = num(value.utilization);
      const status = typeof value.status === 'string' ? value.status : undefined;
      const resetsAt = resetOf(value);
      byKey.set(key.trim(), {
        ...(util !== undefined ? { utilization: util } : {}),
        ...(status ? { status } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }

  // Merge top-level window into unifiedWindows; top-level status belongs ONLY to rateLimitType.
  const topType = typeof info.rateLimitType === 'string' && info.rateLimitType.trim() ? info.rateLimitType.trim() : undefined;
  if (topType) {
    const existing = byKey.get(topType);
    const util = num(info.utilization) ?? existing?.utilization;
    const status = (typeof info.status === 'string' ? info.status : undefined) ?? existing?.status;
    const resetsAt = resetOf(info) ?? existing?.resetsAt;
    byKey.set(topType, {
      ...(util !== undefined ? { utilization: util } : {}),
      ...(status ? { status } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const windows: QuotaWindow[] = [];
  for (const [key, entry] of byKey) {
    const usedPercent = entry.utilization !== undefined
      ? roundPct(entry.utilization * 100)
      : entry.status === 'rejected'
        ? 100
        : undefined;
    if (usedPercent === undefined) continue;
    windows.push({
      name: claudeWindowName(key),
      usedPercent,
      ...(entry.resetsAt ? { resetsAt: entry.resetsAt } : {}),
    });
  }
  if (!windows.length) return undefined;
  const observedAt = observedAtOf(parsed, info, fallbackAt);
  return { windows, ...(observedAt ? { observedAt } : {}) };
}

/** Finds the newest `rate_limit_event` observation in a JSON Lines text. */
export function latestClaudeLimits(text: string, fallbackAt?: string): ClaudeLimits | undefined {
  let best: ClaudeLimits | undefined;
  let bestMs = -Infinity;
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const found = claudeLimitsOfLine(line, fallbackAt);
    if (!found) continue;
    const ms = found.observedAt ? Date.parse(found.observedAt) : -Infinity;
    if (!best || ms >= bestMs) {
      best = found;
      bestMs = ms;
    }
  }
  return best;
}

function tail(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { closeSync(fd); }
}

/** Collects stream-json log files of claude-cli runs whose worker names `sourceName`, newest log first. */
export function claudeRunLogFiles(file: WorkersFile, sourceName: string, docs: readonly OrderDoc[]): string[] {
  const seen = new Set<string>();
  const candidates: { file: string; mtimeMs: number }[] = [];
  for (const doc of docs) {
    for (const run of doc.runs) {
      const worker = ownerOf(file.workers, run.worker);
      if (!worker || worker.quota !== sourceName) continue;
      if (worker.engine !== 'claude-cli') continue;
      if (run.engine && run.engine !== 'claude-cli') continue;
      const logFile = run.events_file ?? run.log;
      if (!logFile || seen.has(logFile) || !existsSync(logFile)) continue;
      seen.add(logFile);
      let mtimeMs = 0;
      try { mtimeMs = statSync(logFile).mtimeMs; } catch { continue; }
      candidates.push({ file: logFile, mtimeMs });
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, FILES).map(c => c.file);
}

/**
 * Reads the newest `rate_limit_event` within `max_age_hours` across candidate Claude stream-json logs.
 * Newest observation timestamp wins even if a newer log holds an older event.
 */
export function readClaudeStream(
  source: string,
  config: ClaudeStreamQuota,
  at: string,
  logFiles: readonly string[],
): QuotaReading {
  const maxAgeHours = config.max_age_hours ?? DEFAULT_MAX_AGE_HOURS;
  const nowMs = Date.parse(at);
  const maxAgeMs = maxAgeHours * 3600 * 1000;

  const sorted = [...new Set(logFiles)]
    .map(file => {
      try {
        const st = statSync(file);
        return { file, mtimeMs: st.mtimeMs, mtimeIso: st.mtime.toISOString() };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is { file: string; mtimeMs: number; mtimeIso: string } => x !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, FILES);

  let best: ClaudeLimits | undefined;
  let bestMs = -Infinity;
  for (const { file, mtimeIso } of sorted) {
    let limits: ClaudeLimits | undefined;
    try { limits = latestClaudeLimits(tail(file, TAIL), mtimeIso); } catch { continue; }
    if (!limits) continue;
    const obsMs = limits.observedAt ? Date.parse(limits.observedAt) : Date.parse(mtimeIso);
    if (Number.isFinite(nowMs) && Number.isFinite(obsMs) && nowMs - obsMs > maxAgeMs) continue;
    if (!best || obsMs > bestMs) {
      best = limits;
      bestMs = obsMs;
    }
  }

  if (!best) {
    return {
      source,
      at,
      ok: true,
      windows: [],
      entries: 0,
      note: t('no Claude rate-limit event in the last {hours} hours', { hours: maxAgeHours }),
    };
  }

  const windows = best.windows.map(w => (w.resetsAt && Date.parse(w.resetsAt) <= nowMs ? { name: w.name, usedPercent: 0 } : w));
  return { source, at, ok: true, windows, entries: 1 };
}
