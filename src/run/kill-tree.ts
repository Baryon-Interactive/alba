import { execFile, execFileSync } from 'node:child_process';

export interface ProcessInfo { pid: number; parentPid: number; createdAt: string }
export interface ProcessStop { stopped: number[]; leftRunning: number[] }

const requirePlatform = () => {
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) throw new Error(`Process management is unsupported on ${process.platform}.`);
};

/** Real descendants, leaves first; an older process with a stale parent pid is never traversed. */
export function descendantPids(processes: readonly ProcessInfo[], rootPid: number): number[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const p of processes) children.set(p.parentPid, [...(children.get(p.parentPid) ?? []), p]);
  const root = processes.find(p => p.pid === rootPid);
  if (!root) return [];
  const ordered: number[] = [];
  const visited = new Set([rootPid]);
  const visit = (parent: ProcessInfo) => {
    for (const child of children.get(parent.pid) ?? []) {
      if (!(Date.parse(child.createdAt) >= Date.parse(parent.createdAt)) || visited.has(child.pid)) continue;
      visited.add(child.pid);
      visit(child);
      ordered.push(child.pid);
    }
  };
  visit(root);
  return ordered;
}

/** The program that lists every process, and how to read its output. */
function snapshotCommand(): { program: string; args: string[]; timeout: number; parse(text: string): ProcessInfo[] } {
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) throw new Error(`Process management is unsupported on ${process.platform}.`);
  if (process.platform !== 'win32') return { program: 'ps', args: ['-eo', 'pid=,ppid=,lstart=,stat='], timeout: 10000, parse: text => text.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(line);
    return row && !row[4].startsWith('Z') ? [{ pid: Number(row[1]), parentPid: Number(row[2]), createdAt: row[3] }] : [];
  }) };
  // One CIM query for the whole snapshot. Unreadable creation times cannot identify a real descendant.
  const script = "@(Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | Select-Object ProcessId,ParentProcessId,@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress";
  return { program: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script], timeout: 30000, parse: text => {
    const rows = JSON.parse(text.trim() || '[]') as { ProcessId: number; ParentProcessId: number; CreatedAt: string }[] | { ProcessId: number; ParentProcessId: number; CreatedAt: string };
    return (Array.isArray(rows) ? rows : [rows]).map(p => ({ pid: Number(p.ProcessId), parentPid: Number(p.ParentProcessId), createdAt: p.CreatedAt }));
  } };
}
function processSnapshot(): ProcessInfo[] {
  const c = snapshotCommand();
  return c.parse(execFileSync(c.program, c.args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: c.timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }));
}
const run = (program: string, args: string[], timeout: number): Promise<string> => new Promise((resolve, reject) =>
  execFile(program, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, text) => error ? reject(error) : resolve(text)));
/** The same snapshot without blocking the event loop. */
export async function processSnapshotAsync(): Promise<ProcessInfo[]> {
  const c = snapshotCommand();
  return c.parse(await run(c.program, c.args, c.timeout));
}

/** Exact identity at the millisecond precision used by recorded ISO process start times. */
export function processStartMatches(createdAt: string, expectedStartedAt: string | undefined): boolean {
  const actual = Date.parse(createdAt);
  return Number.isFinite(actual) && expectedStartedAt !== undefined && actual === Date.parse(expectedStartedAt);
}

/**
 * How long after a run was recorded as started its process may have been created. Alba records the run, then spawns its
 * process at once; this bounds the identity check for a run whose process creation time could not be read at launch.
 */
export const LAUNCH_WINDOW_MS = 120_000;

/**
 * Without a recorded creation time: was a process created at `createdAt` started for a run recorded as started at `launchedAt`?
 * Only a process created from shortly before that moment (`ps` rounds to seconds; 15 s of slack) to `LAUNCH_WINDOW_MS` after it
 * counts; a process that reused the pid later does not.
 */
export function launchedWithin(createdAt: string | undefined, launchedAt: string | undefined): boolean {
  const at = Date.parse(createdAt ?? ''), from = Date.parse(launchedAt ?? '');
  return Number.isFinite(at) && Number.isFinite(from) && at >= from - 15_000 && at <= from + LAUNCH_WINDOW_MS;
}

/** Is the process created at `createdAt` the run's own: its recorded creation time, else the launch window of the run's start. */
export function runProcessMatches(createdAt: string | undefined, expectedStartedAt: string | undefined, launchedAt?: string): boolean {
  if (createdAt === undefined) return false;
  return expectedStartedAt ? processStartMatches(createdAt, expectedStartedAt) : launchedWithin(createdAt, launchedAt);
}

/** How long a process gets to end after SIGTERM before SIGKILL follows (posix). */
export const TERM_GRACE_MS = 5000;

export interface SignalDeps {
  snapshot(): ProcessInfo[];
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  sleep(ms: number): void;
  now(): number;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const posixDeps: SignalDeps = { snapshot: processSnapshot, signal: (pid, signal) => process.kill(pid, signal), sleep: sleepSync, now: () => Date.now() };

/**
 * Posix stop of verified processes: SIGTERM to each that is still the same process (its creation time unchanged), then, for any
 * that has not ended within `graceMs`, SIGKILL (again only while it is the same process). Returns the pids that were signalled.
 */
export function terminateThenKill(targets: readonly ProcessInfo[], deps: SignalDeps = posixDeps, graceMs = TERM_GRACE_MS): number[] {
  const same = (list: readonly ProcessInfo[], p: ProcessInfo) => list.some(q => q.pid === p.pid && processStartMatches(q.createdAt, p.createdAt));
  const stopped: number[] = [];
  const now = deps.snapshot();
  for (const target of targets) {
    if (!same(now, target)) continue;
    try { deps.signal(target.pid, 'SIGTERM'); stopped.push(target.pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  if (!stopped.length) return stopped;
  const end = deps.now() + graceMs;
  for (;;) {
    const current = deps.snapshot();
    const left = targets.filter(t => stopped.includes(t.pid) && same(current, t));
    if (!left.length) return stopped;
    if (deps.now() >= end) {
      for (const target of left) {
        try { deps.signal(target.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      return stopped;
    }
    deps.sleep(250);
  }
}

export interface StopOptions {
  /** When the run was recorded as started: identifies the root when its creation time was never recorded (see `launchedWithin`). */
  launchedAt?: string;
  /** Descendants to leave running, each with everything under it (the job a delivered report hands to the monitor). */
  spare?: readonly number[];
}

function stopValidated(pid: number, expectedStartedAt: string | undefined, tree: boolean, options: StopOptions = {}): ProcessStop {
  const none = { stopped: [], leftRunning: [] };
  if (!Number.isInteger(pid) || pid <= 0) return none;
  if (expectedStartedAt ? !Number.isFinite(Date.parse(expectedStartedAt)) : !Number.isFinite(Date.parse(options.launchedAt ?? ''))) return none;
  const processes = processSnapshot();
  const root = processes.find(p => p.pid === pid);
  if (!root || !runProcessMatches(root.createdAt, expectedStartedAt, options.launchedAt)) return none;
  const descendants = descendantPids(processes, pid);
  const spared = new Set<number>();
  for (const id of options.spare ?? []) if (descendants.includes(id)) { spared.add(id); for (const below of descendantPids(processes, id)) spared.add(below); }
  const targets = tree ? [...descendants.filter(id => !spared.has(id)), pid] : [pid];
  const leftRunning = tree ? descendants.filter(id => spared.has(id)) : descendants;
  if (process.platform !== 'win32') {
    return { stopped: terminateThenKill(targets.map(id => processes.find(p => p.pid === id)!)), leftRunning };
  }
  // Recheck identity immediately before each stop as a pid may have been reused since the snapshot.
  const commands = targets.map(id => {
    const at = new Date(processes.find(p => p.pid === id)!.createdAt).toISOString();
    return `try { $p = Get-Process -Id ${id} -ErrorAction Stop; if ($p.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'") -eq '${at}') { Stop-Process -InputObject $p -Force -ErrorAction Stop; ${id} } } catch { }`;
  });
  const text = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', commands.join('\n')], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return { stopped: text.trim().split(/\s+/).map(Number).filter(id => targets.includes(id)), leftRunning };
}

/** Stop the verified root and real descendants, leaves first, on all supported platforms. */
export function stopProcessTree(pid: number, expectedStartedAt: string | undefined, launchedAt?: string): number[] {
  requirePlatform();
  try { return stopValidated(pid, expectedStartedAt, true, { launchedAt }).stopped; } catch { return []; }
}

/**
 * A person stops a run: validate the root's identity, then stop it and every real descendant (the capture wrapper, the worker
 * CLI under it and what that started), except the `spare` ones and what is under them (returned as `leftRunning`).
 */
export function stopProcessTreeVerified(pid: number, expectedStartedAt: string | undefined, options: StopOptions = {}): ProcessStop {
  requirePlatform();
  try { return stopValidated(pid, expectedStartedAt, true, options); } catch { return { stopped: [], leftRunning: [] }; }
}

/** Lingering workers may own background jobs: validate identity and stop only the worker. */
export function stopProcessOnly(pid: number, expectedStartedAt: string | undefined): ProcessStop {
  requirePlatform();
  try { return stopValidated(pid, expectedStartedAt, false); } catch { return { stopped: [], leftRunning: [] }; }
}

export interface TreeStop { gone: boolean; stopped: number[]; problem?: string }
export interface TreeTarget {
  pid: number;
  /** OS creation time of the root, when it was read. */
  startedAt?: string;
  /** Lower bound (epoch ms) for the root's creation when `startedAt` is unknown: the moment before it was spawned. */
  notBefore: number;
  /** The caller holds the live process handle, so a process with this pid is certainly the root. */
  ownsRoot?: boolean;
  /** Verified members observed while the command was running, including parents that may since have exited. */
  members?: ProcessInfo[];
}

/**
 * The root (when it is the recorded process) and its real descendants, leaves first, as full records. A root that has exited is
 * still a valid parent for processes it started, as long as they were created after it and before any process that reused its pid.
 */
export function treeMembers(processes: readonly ProcessInfo[], target: TreeTarget): ProcessInfo[] {
  const slack = process.platform === 'win32' ? 0 : 1000;
  const live = processes.find(p => p.pid === target.pid);
  const lower = target.startedAt && Number.isFinite(Date.parse(target.startedAt)) ? Date.parse(target.startedAt) : target.notBefore - slack;
  // Without a recorded creation time, a process with the pid counts as the root only if it was created after we spawned it.
  const rootAlive = !!live && (target.ownsRoot || (target.startedAt !== undefined ? processStartMatches(live.createdAt, target.startedAt) : Date.parse(live.createdAt) >= lower));
  const cutoff = live && !rootAlive ? Date.parse(live.createdAt) : Infinity;
  const root: ProcessInfo = rootAlive ? live! : { pid: target.pid, parentPid: 0, createdAt: new Date(lower).toISOString() };
  const children = new Map<number, ProcessInfo[]>();
  // Historical links bridge exited parents. Reused PIDs must never replace a recorded identity.
  const history = (target.members ?? []).filter(p => p.pid !== target.pid);
  const links = [...history, ...processes.filter(p => !history.some(h => h.pid === p.pid && processStartMatches(p.createdAt, h.createdAt)))];
  for (const p of links) children.set(p.parentPid, [...(children.get(p.parentPid) ?? []), p]);
  const ordered: ProcessInfo[] = [];
  const visited = new Set([target.pid]);
  const visit = (parent: ProcessInfo, atRoot: boolean) => {
    const floor = atRoot ? lower : Date.parse(parent.createdAt);
    const replacement = processes.find(p => p.pid === parent.pid && !processStartMatches(p.createdAt, parent.createdAt));
    const ceiling = atRoot ? cutoff : replacement ? Date.parse(replacement.createdAt) : Infinity;
    for (const child of children.get(parent.pid) ?? []) {
      const at = Date.parse(child.createdAt);
      if (!(at >= floor && at < ceiling) || visited.has(child.pid)) continue;
      visited.add(child.pid);
      visit(child, false);
      if (processes.some(p => p.pid === child.pid && processStartMatches(p.createdAt, child.createdAt))) ordered.push(child);
    }
  };
  visit(root, true);
  return rootAlive ? [...ordered, root] : ordered;
}

async function killMembers(members: readonly ProcessInfo[]): Promise<number[]> {
  if (process.platform !== 'win32') {
    const done: number[] = [];
    for (const m of members) { try { process.kill(m.pid, 'SIGKILL'); done.push(m.pid); } catch { /* already gone */ } }
    return done;
  }
  // Recheck identity immediately before each stop as a pid may have been reused since the snapshot.
  const commands = members.map(m => {
    const at = new Date(m.createdAt).toISOString();
    return `try { $p = Get-Process -Id ${m.pid} -ErrorAction Stop; if ($p.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'") -eq '${at}') { Stop-Process -InputObject $p -Force -ErrorAction Stop; ${m.pid} } } catch { }`;
  });
  const text = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', commands.join('\n')], 30000);
  return text.trim().split(/\s+/).map(Number).filter(id => members.some(m => m.pid === id));
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Stops a process, or the descendants it left behind, without blocking the event loop, and says whether they are gone.
 * "Gone" is only reported from a fresh process snapshot that shows no member; listing failures are retried until the deadline.
 */
export async function stopTreeAsync(target: TreeTarget, deadlineMs = 90_000): Promise<TreeStop> {
  requirePlatform();
  const end = Date.now() + deadlineMs, stopped = new Set<number>();
  target = { ...target, members: [...(target.members ?? [])] };
  let problem: string | undefined;
  for (let round = 0; Date.now() < end; round++) {
    let members: ProcessInfo[];
    try { members = treeMembers(await processSnapshotAsync(), target); }
    catch (error) { problem = `Could not list the processes: ${(error as Error).message}`; await pause(Math.min(15_000, 1000 * 2 ** Math.min(round, 4), Math.max(0, end - Date.now()))); continue; }
    if (!members.length) return { gone: true, stopped: [...stopped] };
    for (const member of members) if (!target.members!.some(p => p.pid === member.pid && p.createdAt === member.createdAt)) target.members!.push(member);
    problem = undefined;
    try { for (const id of await killMembers(members)) stopped.add(id); }
    catch (error) { problem = `Could not stop ${members.map(m => m.pid).join(', ')}: ${(error as Error).message}`; }
    await pause(Math.min(round < 2 ? 250 : Math.min(15_000, 1000 * 2 ** Math.min(round - 2, 4)), Math.max(0, end - Date.now())));
  }
  return { gone: false, stopped: [...stopped], problem: problem ?? 'Processes were still running after the stop attempts.' };
}
