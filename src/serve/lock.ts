import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fail, t } from '../i18n.ts';

export interface LockInfo { pid: number; started: string; port?: number }

export const lockFile = (stateDir: string): string => path.join(stateDir, 'serve.lock');

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

/**
 * Takes the lock of a state folder for this process (`alba serve`): only one serve runs per folder. Returns a function that gives it back.
 * A lock of a dead process is taken over; one held by a live process is an error naming it.
 */
export function acquireLock(stateDir: string, info: LockInfo, alive: (pid: number) => boolean = isAlive, times: LockTimes = systemTimes): () => void {
  mkdirSync(stateDir, { recursive: true });
  const file = lockFile(stateDir);
  const holder = lockHolder(stateDir, alive, times);
  if (holder) fail('{dir} is already served by alba serve (pid {pid}, since {since}). Stop that one first.', { dir: stateDir, pid: holder.pid, since: holder.started });
  rmSync(file, { force: true });
  try { writeFileSync(file, JSON.stringify(info) + '\n', { flag: 'wx' }); }
  catch { fail('{dir} was just taken by another alba serve. Try again.', { dir: stateDir }); }
  return () => {
    try { const current = JSON.parse(readFileSync(file, 'utf8')) as LockInfo; if (current.pid === info.pid && current.started === info.started) rmSync(file, { force: true }); } catch { /* already gone */ }
  };
}

/** The one line a scheduled tick prints when it finds the lock. */
export const skipLine = (holder: LockInfo): string => t('tick skipped: alba serve (pid {pid}) holds this state folder and runs the ticks itself.', { pid: holder.pid });
