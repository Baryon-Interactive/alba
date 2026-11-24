import { execFile, execFileSync } from 'node:child_process';
import { setImmediate as nextTurn } from 'node:timers/promises';

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

/**
 * Every process's creation time from one OS call (one PowerShell for all of them instead of one per pid, about 2 s each on
 * Windows), refreshed in the background at most every `TABLE_MS`. The serve's end checks look at every open run every few
 * seconds; asking per pid kept its thread busy for seconds at a time with a handful of runs.
 */
const TABLE_MS = 30_000;
let table: { at: number; times: Map<number, string> } | undefined;
let refreshing: Promise<void> | undefined;
const tableCommand = (): [string, string[]] => process.platform === 'win32'
  ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Property ProcessId,CreationDate | ForEach-Object { if ($_.CreationDate) { '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o') } }"]]
  : ['ps', ['-eo', 'pid=,lstart=']];

/** Parses the table command's output: `<pid> <time>` per line. */
export function parseProcessTable(text: string): Map<number, string> {
  const times = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const at = new Date(m[2]);
    if (!Number.isNaN(at.getTime())) times.set(Number(m[1]), at.toISOString());
  }
  return times;
}

async function readSystemTable(): Promise<string> {
  // Creating the OS process can itself block on Windows. A cache lookup must return before launching it.
  await nextTurn();
  return new Promise((resolve, reject) => {
    const [program, args] = tableCommand();
    execFile(program, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, text) => (error ? reject(error) : resolve(text)));
  });
}

/** Reads the whole process table again (one call in flight at a time). */
export function refreshProcessTable(run: () => Promise<string> = readSystemTable): Promise<void> {
  refreshing ??= run().then(text => { table = { at: Date.now(), times: parseProcessTable(text) }; }, () => { table = { at: Date.now(), times: table?.times ?? new Map() }; })
    .finally(() => { refreshing = undefined; });
  return refreshing;
}

/**
 * A process's creation time without waiting: from the last process table, or undefined when it is not known yet (a pid that
 * started after the table was read). An old table, or an unknown pid, starts a refresh in the background. Callers treat an
 * unknown time as "cannot tell" (a live run stays open), and they check that the pid is alive first, so a stale entry can
 * only matter for a pid that died and was reused within one refresh.
 */
export function tableStartedAt(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const at = table?.times.get(pid);
  if (!table || Date.now() - table.at > TABLE_MS || at === undefined) void refreshProcessTable();
  return at;
}

/** Test hook: forget the process table. */
export function resetProcessTable(): void { table = undefined; }

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
