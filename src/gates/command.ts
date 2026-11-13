import { execFile, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { processStartedAtAsync } from '../monitor/process.ts';
import { processSnapshotAsync, treeMembers, stopTreeAsync, type ProcessInfo, type TreeStop, type TreeTarget } from '../run/kill-tree.ts';

export class GateSetupError extends Error {}

export interface GateCommandResult { exit: number | null; stdout: string; stderr: string; timedOut: boolean; tree: TreeStop; pid?: number; startedAt?: string; spawnedAt: number; members: ProcessInfo[] }
export interface GateCommandOptions {
  /** After the command ends, find and stop descendants it left behind (default true). */
  sweep?: boolean;
  /** How long a process-tree stop may keep trying before it reports the tree as still running. */
  stopDeadlineMs?: number;
  /** Replaceable in tests: the creation-time lookup and the process-tree stop. */
  lookupStartedAt?: (pid: number, signal?: AbortSignal) => Promise<string | undefined>;
  stopTree?: (target: TreeTarget, deadlineMs?: number) => Promise<TreeStop>;
  snapshot?: () => Promise<ProcessInfo[]>;
  onMembers?: (members: ProcessInfo[]) => void;
  beforeStop?: () => void;
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The OS creation time of a child, retried a few times: a single failed lookup must not leave the child unidentified. */
async function childStartedAt(pid: number, alive: () => boolean, signal: AbortSignal, lookup: NonNullable<GateCommandOptions['lookupStartedAt']>): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    const at = await lookup(pid, signal);
    if (at !== undefined) return at;
    if (!alive()) return undefined;
    await delay(300);
  }
  return undefined;
}

/**
 * Finishes on process exit even if a descendant inherited the output pipes.
 * The result is only returned after the process tree has been checked: `tree.gone` is true when a fresh process listing showed no
 * member of it (the command, or any descendant started after it). Callers must keep the gate's leases while it is false.
 */
export function gateCommand(argv: string[], cwd: string, timeoutMs: number, log?: string,
  onSpawn?: (pid: number, startedAt: string | undefined) => void, options: GateCommandOptions = {}): Promise<GateCommandResult> {
  return new Promise((resolve, reject) => {
    const spawnedAt = Date.now();
    let child: ReturnType<typeof spawn>;
    try { child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(new GateSetupError((error as Error).message)); return; }
    let stdout = '', stderr = '', timedOut = false, overflow = false, settled = false;
    let logError: GateSetupError | undefined, tracking: NodeJS.Timeout | undefined, observed: Promise<void> | undefined;
    const members: ProcessInfo[] = [];
    let identity: Promise<string | undefined> = Promise.resolve(undefined), grace: NodeJS.Timeout | undefined;
    const lookup = new AbortController();
    const running = () => child.exitCode === null && child.signalCode === null;
    const finish = async (exit: number | null, error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace); clearTimeout(tracking);
      child.stdout?.destroy(); child.stderr?.destroy();
      let tree: TreeStop = { gone: true, stopped: [] }, startedAt: string | undefined;
      if (child.pid && (timedOut || overflow || running() || options.sweep !== false)) {
        try {
          options.beforeStop?.();
          await observed;
          startedAt = await Promise.race([identity, delay(5000).then(() => undefined)]);
          tree = await (options.stopTree ?? stopTreeAsync)({ pid: child.pid, startedAt, notBefore: spawnedAt, ownsRoot: running(), members }, options.stopDeadlineMs);
        } catch (problem) { tree = { gone: false, stopped: [], problem: (problem as Error).message }; }
      }
      lookup.abort();
      const identityOf = { tree, pid: child.pid, startedAt, spawnedAt, members };
      error ??= logError;
      if (error) reject(Object.assign(error, identityOf));
      else if (overflow) reject(Object.assign(new Error('Command stdout exceeded 8 MiB.'), identityOf));
      else resolve({ exit: exit ?? child.exitCode, stdout, stderr, timedOut, ...identityOf });
    };
    const timer = setTimeout(() => { timedOut = true; void finish(child.exitCode); }, timeoutMs);
    child.once('error', error => void finish(null, new GateSetupError(error.message)));
    child.once('spawn', () => {
      try { onSpawn?.(child.pid!, undefined); }
      catch (error) { void finish(null, new GateSetupError((error as Error).message)); return; }
      identity = childStartedAt(child.pid!, running, lookup.signal, options.lookupStartedAt ?? processStartedAtAsync);
      const observe = () => {
        observed = (options.snapshot ?? processSnapshotAsync)().then(processes => {
          for (const m of treeMembers(processes, { pid: child.pid!, notBefore: spawnedAt, ownsRoot: running(), members })) {
            if (!members.some(p => p.pid === m.pid && p.createdAt === m.createdAt)) members.push(m);
          }
          if (!settled) options.onMembers?.([...members]);
        }).catch(() => { /* stopTree must still confirm the final tree; a listing failure never proves it gone */ }).finally(() => {
          if (!settled) tracking = setTimeout(observe, Date.now() - spawnedAt < 60_000 ? 5000 : 30_000);
        });
      };
      if (options.sweep !== false) observe();
      void identity.then(startedAt => {
        if (settled) return;
        try { onSpawn?.(child.pid!, startedAt); }
        catch (error) { void finish(null, new GateSetupError((error as Error).message)); }
      });
    });
    child.stdout!.setEncoding('utf8');
    const append = (chunk: string | Buffer) => {
      if (!log || logError) return;
      try { appendFileSync(log, chunk); }
      catch (error) { logError = new GateSetupError(`Could not append gate log: ${(error as Error).message}`); }
    };
    child.stdout!.on('data', (chunk: string) => {
      append(chunk);
      if (stdout.length + chunk.length <= 8 * 1024 * 1024) stdout += chunk;
      else if (!overflow) { overflow = true; void finish(null); }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      append(chunk);
      if (stderr.length < 8 * 1024 * 1024) stderr += chunk.toString('utf8').slice(0, 8 * 1024 * 1024 - stderr.length);
    });
    child.once('exit', code => {
      clearTimeout(timer); clearTimeout(grace);
      // Drain buffered output briefly; close is optional because descendants may own pipes.
      grace = setTimeout(() => void finish(code), 100);
      child.once('close', () => void finish(code));
    });
  });
}

/** Git output without blocking the event loop (the commands here read refs and history, they never write). */
export function gitText(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, text, err) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${(err || error.message).toString().trim().split('\n')[0]}`));
      else resolve(text);
    });
  });
}

/** Worktree operations yield the event loop and have a bounded lifetime (a large checkout on Windows can take many minutes). */
export async function worktreeGit(root: string, args: string[], timeoutMs: number): Promise<void> {
  const result = await gateCommand(['git', ...args], root, timeoutMs, undefined, undefined, { sweep: false });
  if (result.timedOut || result.exit !== 0) throw new GateSetupError(`git ${args.join(' ')} ${result.timedOut ? 'timed out' : `exited ${result.exit}`}. ${result.stderr}${result.stdout}`);
}
