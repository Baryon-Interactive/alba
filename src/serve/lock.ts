import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fail, t } from '../i18n.ts';

export interface LockInfo { pid: number; started: string; port?: number }

export interface ServeExitRecord {
  pid: number;
  started: string;
  ended_at: string;
  how: 'clean' | 'crashed';
  why?: string;
}

export type PreviousServeEnd =
  | { how: 'none' }
  | { how: 'clean'; pid: number; started: string; ended_at: string }
  | { how: 'crashed'; pid: number; started: string; ended_at: string; why?: string }
  | { how: 'killed'; pid: number; started: string };

export interface LockRelease {
  (): void;
  previous: PreviousServeEnd;
}

export const lockFile = (stateDir: string): string => path.join(stateDir, 'serve.lock');
export const exitFile = (stateDir: string): string => path.join(stateDir, 'serve.exit.json');

export function writeServeExit(stateDir: string, record: ServeExitRecord): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = exitFile(stateDir);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(record) + '\n', 'utf8');
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    }
  } catch { /* best-effort during shutdown or crash */ }
}

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

export interface LockTimes {
  bootTime(): number;
  processStartedAt(pid: number): number | undefined;
}
const systemTimes: LockTimes = {
  bootTime: () => Date.now() - os.uptime() * 1000,
  processStartedAt(pid) {
    if (pid === process.pid) return Date.now() - process.uptime() * 1000;
    try {
      const text = process.platform === 'win32'
        ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
        : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const time = Date.parse(text.trim());
      return Number.isFinite(time) ? time : undefined;
    } catch { return undefined; }
  },
};

/** Who holds the state folder's lock, if that process is still there. A lock left by a process that is gone is not a lock. */
export function lockHolder(stateDir: string, alive: (pid: number) => boolean = isAlive, times: LockTimes = systemTimes): LockInfo | undefined {
  let info: LockInfo;
  try { info = JSON.parse(readFileSync(lockFile(stateDir), 'utf8')) as LockInfo; } catch { return undefined; }
  if (!Number.isInteger(info.pid) || info.pid <= 0 || !alive(info.pid)) return undefined;
  const started = Date.parse(info.started);
  // Old malformed timestamps cannot prove reuse; keep the conservative live-pid behavior for those locks.
  if (Number.isFinite(started)) {
    if (started < times.bootTime()) return undefined;
    const processStart = times.processStartedAt(info.pid);
    if (processStart !== undefined && processStart > started) return undefined;
  }
  return info;
}

function inspectPreviousEnd(stateDir: string): PreviousServeEnd {
  let deadLock: LockInfo | undefined;
  try {
    const parsed = JSON.parse(readFileSync(lockFile(stateDir), 'utf8')) as LockInfo;
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0 && typeof parsed.started === 'string') deadLock = parsed;
  } catch { /* no readable lock */ }

  let recorded: ServeExitRecord | undefined;
  try {
    const parsed = JSON.parse(readFileSync(exitFile(stateDir), 'utf8')) as ServeExitRecord;
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0 && typeof parsed.started === 'string'
      && typeof parsed.ended_at === 'string' && (parsed.how === 'clean' || parsed.how === 'crashed')) {
      recorded = parsed;
    }
  } catch { /* no readable exit record */ }

  if (deadLock) {
    if (recorded && recorded.pid === deadLock.pid && recorded.started === deadLock.started) {
      return recorded.how === 'clean'
        ? { how: 'clean', pid: deadLock.pid, started: deadLock.started, ended_at: recorded.ended_at }
        : { how: 'crashed', pid: deadLock.pid, started: deadLock.started, ended_at: recorded.ended_at, ...(recorded.why ? { why: recorded.why } : {}) };
    }
    return { how: 'killed', pid: deadLock.pid, started: deadLock.started };
  }
  if (recorded) {
    return recorded.how === 'clean'
      ? { how: 'clean', pid: recorded.pid, started: recorded.started, ended_at: recorded.ended_at }
      : { how: 'crashed', pid: recorded.pid, started: recorded.started, ended_at: recorded.ended_at, ...(recorded.why ? { why: recorded.why } : {}) };
  }
  return { how: 'none' };
}

/**
 * Takes the lock of a state folder for this process (`alba serve`): only one serve runs per folder. Returns a function that gives it back,
 * tagged with `previous` describing how the last serve on this folder ended.
 * A lock of a dead process is taken over; one held by a live process is an error naming it.
 */
export function acquireLock(stateDir: string, info: LockInfo, alive: (pid: number) => boolean = isAlive, times: LockTimes = systemTimes): LockRelease {
  mkdirSync(stateDir, { recursive: true });
  const file = lockFile(stateDir);
  const holder = lockHolder(stateDir, alive, times);
  if (holder) fail('{dir} is already served by alba serve (pid {pid}, since {since}). Stop that one first.', { dir: stateDir, pid: holder.pid, since: holder.started });
  const previous = inspectPreviousEnd(stateDir);
  rmSync(file, { force: true });
  try { writeFileSync(file, JSON.stringify(info) + '\n', { flag: 'wx' }); }
  catch { fail('{dir} was just taken by another alba serve. Try again.', { dir: stateDir }); }
  try { rmSync(exitFile(stateDir), { force: true }); } catch { /* best-effort */ }
  const release = () => {
    try { const current = JSON.parse(readFileSync(file, 'utf8')) as LockInfo; if (current.pid === info.pid && current.started === info.started) rmSync(file, { force: true }); } catch { /* already gone */ }
  };
  return Object.assign(release, { previous });
}

/** The one line a scheduled tick prints when it finds the lock. */
export const skipLine = (holder: LockInfo): string => t('tick skipped: alba serve (pid {pid}) holds this state folder and runs the ticks itself.', { pid: holder.pid });
