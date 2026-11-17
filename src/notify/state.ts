import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { machineDir } from '../resources/machine-store.ts';
import type { NotifyPayload } from './channels.ts';
import type { TriggerName } from './config.ts';

export interface ConditionState {
  first_seen: string;
  notified_at?: string;
  cleared_at?: string;
  trigger: TriggerName;
  title?: string;
  text?: string;
  project?: string;
  tag?: string;
  worker?: string;
  projects?: string[];
  instance?: string;
}

export interface HeldNotification {
  to: string[];
  payload: NotifyPayload;
}

export interface RestartRecord {
  at: string;
  how: 'clean' | 'crashed' | 'killed';
  pid: number;
}

export interface NotifyStateFile {
  version: 1;
  conditions: Record<string, ConditionState>;
  held: HeldNotification[];
  last_digest_date?: string;
  digest_armed_date?: string;
  restarts: RestartRecord[];
}

const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_TOTAL_MS = 3_000;
const RESTART_KEEP_MS = 48 * 3600 * 1000;
let tmpSeq = 0;

const waitSlice = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => { Atomics.wait(waitSlice, 0, 0, ms); };

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const notifyStatePath = (dir: string = machineDir()): string => path.join(dir, 'notify-state.json');
export const notifyLockPath = (dir: string = machineDir()): string => path.join(dir, 'notify-state.lock');

export function emptyNotifyState(): NotifyStateFile {
  return { version: 1, conditions: {}, held: [], restarts: [] };
}

function normalizeState(raw: unknown): NotifyStateFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyNotifyState();
  const obj = raw as Record<string, unknown>;
  const conditions = typeof obj.conditions === 'object' && obj.conditions !== null && !Array.isArray(obj.conditions)
    ? (obj.conditions as Record<string, ConditionState>)
    : {};
  const held = Array.isArray(obj.held) ? (obj.held as HeldNotification[]) : [];
  const restarts = Array.isArray(obj.restarts) ? (obj.restarts as RestartRecord[]) : [];
  return {
    version: 1,
    conditions,
    held,
    ...(typeof obj.last_digest_date === 'string' ? { last_digest_date: obj.last_digest_date } : {}),
    ...(typeof obj.digest_armed_date === 'string' ? { digest_armed_date: obj.digest_armed_date } : {}),
    restarts,
  };
}

export function readNotifyState(dir: string = machineDir()): NotifyStateFile {
  const file = notifyStatePath(dir);
  if (!existsSync(file)) return emptyNotifyState();
  try {
    return normalizeState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptyNotifyState();
  }
}

function acquireStateLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const lock = notifyLockPath(dir);
  const token = `${process.pid}:${Date.now()}:${++tmpSeq}`;
  const deadline = Date.now() + LOCK_WAIT_TOTAL_MS;
  for (;;) {
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token }) + '\n', { flag: 'wx' });
      return () => {
        try {
          const cur = JSON.parse(readFileSync(lock, 'utf8')) as { token?: string };
          if (cur.token === token) rmSync(lock, { force: true });
        } catch { /* already released */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const cur = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: number; at?: number };
        if (!cur.pid || !pidAlive(cur.pid) || (typeof cur.at === 'number' && Date.now() - cur.at > STALE_LOCK_MS)) {
          stale = true;
        }
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) stale = true;
        } catch { /* vanished */ }
      }
      if (stale || Date.now() >= deadline) {
        try { rmSync(lock, { force: true }); } catch { /* retry */ }
        continue;
      }
      sleepSync(10);
    }
  }
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf8');
    for (let i = 0; ; i++) {
      try {
        renameSync(tmp, file);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === 'EPERM' || code === 'EACCES') && i < 4) {
          sleepSync(10);
          continue;
        }
        throw err;
      }
    }
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* moved or gone */ }
  }
}

export function updateNotifyState<T>(dir: string, now: Date, mutate: (state: NotifyStateFile) => T): T {
  const release = acquireStateLock(dir);
  try {
    const state = readNotifyState(dir);
    const cutoff = now.getTime() - RESTART_KEEP_MS;
    state.restarts = state.restarts.filter(r => Date.parse(r.at) >= cutoff);
    const out = mutate(state);
    writeAtomic(notifyStatePath(dir), JSON.stringify(state, null, 2) + '\n');
    return out;
  } finally {
    release();
  }
}
