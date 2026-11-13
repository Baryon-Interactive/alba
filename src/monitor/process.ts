import { execFile, execFileSync } from 'node:child_process';

const processCommand = (pid: number): [string, string[]] => process.platform === 'win32'
  ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]]
  : ['ps', ['-o', 'lstart=', '-p', String(pid)]];

/** Cancellable identity lookup for background commands; never blocks the serve loop. */
export function processStartedAtAsync(pid: number, signal?: AbortSignal): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(undefined);
  const [program, args] = processCommand(pid);
  return new Promise(resolve => {
    execFile(program, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 15000, windowsHide: true, signal }, (error, text) => {
      const at = new Date(text.trim());
      resolve(error || Number.isNaN(at.getTime()) ? undefined : at.toISOString());
    });
  });
}

/**
 * Start times of other processes, looked up asynchronously and kept for at most sixty seconds.
 * Request paths and transactions only read this cache; a pid that is seen dead is forgotten, so a reused pid is looked up again.
 */
const known = new Map<number, { at: string; checked: number }>();
const lookups = new Map<number, Promise<string | undefined>>();
const failedAt = new Map<number, number>();
const RETRY_FAILED_MS = 30_000;

/** The cached creation time, or undefined when it is not known (never starts a lookup). */
export const knownStartedAt = (pid: number): string | undefined => {
  const entry = known.get(pid);
  if (entry && Date.now() - entry.checked < 60_000) return entry.at;
  known.delete(pid);
  return undefined;
};
export const forgetStartedAt = (pid: number): void => { known.delete(pid); failedAt.delete(pid); };

/** Looks the creation time up once per pid (concurrent callers share it); a failed lookup is retried after a pause, never cached as an answer. */
export function primeStartedAt(pid: number, lookup: (pid: number) => Promise<string | undefined> = processStartedAtAsync): Promise<string | undefined> {
  const have = knownStartedAt(pid);
  if (have !== undefined) return Promise.resolve(have);
  const running = lookups.get(pid);
  if (running) return running;
  if (Date.now() - (failedAt.get(pid) ?? -Infinity) < RETRY_FAILED_MS) return Promise.resolve(undefined);
  const job = lookup(pid).then(at => {
    if (at !== undefined) { known.set(pid, { at, checked: Date.now() }); failedAt.delete(pid); } else failedAt.set(pid, Date.now());
    return at;
  }, () => { failedAt.set(pid, Date.now()); return undefined; }).finally(() => lookups.delete(pid));
  lookups.set(pid, job);
  return job;
}

/** Test hook: forget everything cached. */
export function resetStartedAtCache(): void { known.clear(); lookups.clear(); failedAt.clear(); }

/** OS creation time, never inferred from a PID alone. Synchronous (it blocks on a child process): not for request paths or transactions. */
export function processStartedAt(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const [program, args] = processCommand(pid);
    const text = execFileSync(program, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
  } catch { return; }
}
