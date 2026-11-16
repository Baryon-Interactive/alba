import { rolePolicy } from '../routing/choose.ts';
import { machineProblems, machinesView, refreshMachines } from '../machines/probe.ts';
import { loadMachines } from '../machines/config.ts';
import { workerPinProblem } from '../routing/route.ts';
import { roleResults } from '../roles/statistics.ts';
import { effectiveRoles, resolveRole } from '../roles/config.ts';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { OrderDoc, Run } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import type { QuotaConfig, WorkersFile } from '../workers/config.ts';
import { availability, failed, parseCommandQuota, staticQuota, type QuotaReading } from '../workers/quota.ts';
import { readCodexSessions } from '../workers/codex-quota.ts';
import { openCommand } from '../workers/adapters/index.ts';
import { stopProcessOnly, stopProcessTree, stopProcessTreeVerified } from '../run/kill-tree.ts';
import { cachedEndpointProbe, endpointOf, PROBE_TIMEOUT_MS, probeEndpoint } from '../run/endpoint.ts';
import { trailingTransientFailures } from '../run/launch.ts';
import { spawnDetachedProgram } from '../run/spawn.ts';
import { workerEnvironment } from '../run/environment.ts';
import { orderSpend, ownerOf, spendToday } from '../usage/spend.ts';
import { routingOf } from '../routing/classify.ts';
import { foundationGaps, foundationStates, missingText } from '../foundations/foundations.ts';
import { workerHistory } from '../routing/history.ts';
import { isGenericKind } from '../routing/kinds.ts';
import { monitoringLines } from '../monitor/monitor.ts';
import { activeLeases, heavyOf, occupants, usesOf } from '../resources/leases.ts';
import { appendStateFile, readStateFile, stateProject } from '../orders/state-files.ts';
import { stateStore, type StateProject } from '../orders/backend.ts';
import { SqliteStore, type QuotaHistoryOptions } from '../orders/sqlite-store.ts';
import type { LoopFinding } from '../run/loops.ts';
import { limitWords } from '../run/handoff.ts';
import { applyNudges } from '../run/nudge.ts';
import { pendingNotes } from '../run/prompt.ts';
import { readReceipt } from '../run/progress.ts';
import { collectUsage, budgetWarnings } from '../usage/accounting.ts';
import { liveRuns } from '../run/live.ts';
import { pickupOutbox } from '../run/messages.ts';
import { lingeringOf } from '../run/lingering.ts';
import { tableStartedAt } from '../monitor/process.ts';
import { producerHeartbeatProblem } from '../producer/producer.ts';
import { producerSessionHeartbeatProblem } from '../producer/session.ts';
import { budgetProblem } from '../producer/session-usage.ts';
import { independentChecks } from '../review/independent.ts';
import { evidenceOf, pruneSeen, watchRun } from '../run/watch.ts';
import { compareDispatchOrder, planTick, type OrderActivity, type TickInput, type TickOrder, type TickReport, type WorkerState } from './plan.ts';
import { isSilentEnd } from '../run/end-reason.ts';
import type { Finish } from '../run/finish.ts';
import { editorPoolsOf, editorSlots, runMachine } from '../editors/pool.ts';

/** Everything the tick reads from the outside world, so tests and dry runs can substitute it. */
export interface Probes {
  now(): Date;
  runCommand(command: string[], timeoutSeconds: number, options?: { cwd: string; env: Record<string, string>; envUnset: string[] }): string;      // stdout of a command, run without a shell
  freeRamGb(): number | undefined;
  /** The same two, without blocking (optional): a cache that holds an old answer refreshes it through these. */
  runCommandAsync?(command: string[], timeoutSeconds: number): Promise<string>;
  freeRamGbAsync?(): Promise<number | undefined>;
  gitActivityAsync?(worktree: string): Promise<{ lastCommitAt?: string; dirtyFiles?: number }>;
  worktrees(root: string): { path: string; branch?: string }[];
  gitActivity(worktree: string): { lastCommitAt?: string; dirtyFiles?: number };
  fileTime(file: string): string | undefined;
  isAlive(pid: number): boolean;
  /** Background TCP connect to a model endpoint. */
  probePort?(host: string, port: number, timeoutMs: number): Promise<boolean>;
  /** Cached per-worker answer; false until the first background probe succeeds. */
  endpointAvailable?(worker: string, host: string, port: number, timeoutMs: number): boolean;
  tail(file: string, bytes: number): string;                          // the last bytes of a text file, or '' if it is missing
  readText(file: string): string | undefined;
  /** The first bytes of a text file (where Codex prints its session id), or '' if it is missing. Optional: without it the whole file is read. */
  head?(file: string, bytes: number): string;
  /** Runs a program to its end (bounded by a timeout) with stdout and stderr written to a log file; for one-off questions to a worker. Optional. */
  runWorkerOnce?(job: { program: string; args: string[]; cwd: string; env: Record<string, string>; envUnset: string[]; logFile: string; timeoutSeconds: number }): Promise<{ code?: number; timedOut: boolean }>;
  /** Runs a monitor's check command (no shell) in a folder, to its end or the timeout; stdout and stderr together. `error` is set when it could not be started. Optional. */
  runCheck?(command: string[], cwd: string, timeoutSeconds: number): { code: number | null; output: string; timedOut: boolean; error?: string };
  /** Stops a run's verified process tree on Windows, Linux and macOS; returns stopped pids. `launchedAt` (the run's start) identifies a root whose creation time was never recorded. Optional. */
  kill?(pid: number, expectedStartedAt: string | undefined, launchedAt?: string): number[];
  /** Stops a run's verified process tree except the `spare` descendants and what is under them, which it returns as `leftRunning`. Optional. */
  stopTree?(pid: number, expectedStartedAt: string | undefined, options?: { launchedAt?: string; spare?: readonly number[] }): { stopped: number[]; leftRunning: number[] };
  /** Stops only the run process and leaves descendants alive, returning those descendants. */
  stopProcessOnly?(pid: number, expectedStartedAt: string | undefined): { stopped: number[]; leftRunning: number[] };
  /** When the process started, as an ISO time, or undefined when it cannot be read. Used to be sure a pid is still the run's own process. Optional. */
  processStartedAt?(pid: number): string | undefined;
  /** Starts a program in the background with stdout and stderr appended to a log file; returns its pid. */
  spawnDetached(program: string, args: string[], options: { cwd: string; env: Record<string, string>; envUnset: string[]; logFile: string; eventsFile?: string; stdinFile?: string }): number;
}

/** The editor pool a queued order's run would take a port of (an order with more than one is refused at its start). */
function editorPoolOf(project: ProjectConfig, doc: OrderDoc): { editorPool?: string } {
  const pools = editorPoolsOf(project, doc);
  return pools.length === 1 ? { editorPool: pools[0].name } : {};
}

/** The editor ports of each pool by machine with who holds them now, and the machine of each worker, for the plan. */
function editorPortsInput(project: ProjectConfig, workers: readonly WorkerState[], workersFile?: string): Pick<TickInput, 'editorPorts' | 'workerMachines'> {
  const slots = editorSlots(project);
  const local = runMachine(project, undefined, workersFile);
  const editorPorts = Object.fromEntries(Object.values(project.editors ?? {}).map(pool => [pool.name, Object.fromEntries(Object.entries(pool.machines).map(([machine, m]) => [machine, { ports: m.ports.length, taken: slots.filter(s => s.pool === pool.name && s.machine === machine).map(s => s.tag) }]))]));
  return { editorPorts, workerMachines: Object.fromEntries(workers.map(w => [w.config.id, w.config.host ?? local])) };
}

export const systemProbes: Probes = {
  now: () => new Date(),
  runCommand(command, timeoutSeconds, options) {
    // Only stdout is the answer; many tools print progress to stderr.
    const env = { ...process.env, ...options?.env };
    for (const key of options?.envUnset ?? []) delete env[key];
    return execFileSync(command[0], command.slice(1), { cwd: options?.cwd, env, encoding: 'utf8', timeout: timeoutSeconds * 1000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  },
  runCommandAsync(command, timeoutSeconds) {
    return new Promise((resolve, reject) => {
      execFile(command[0], command.slice(1), { encoding: 'utf8', timeout: timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
  },
  // os.freemem() is the same reading as Win32_OperatingSystem.FreePhysicalMemory, without a 3 s PowerShell start.
  freeRamGbAsync() { return Promise.resolve(os.freemem() / 2 ** 30); },
  gitActivityAsync(worktree) {
    const git = (...args: string[]) => new Promise<string>((resolve, reject) => {
      execFile('git', ['-C', worktree, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    return Promise.all([git('log', '-1', '--format=%cI'), git('status', '--porcelain')])
      .then(([last, status]) => ({ lastCommitAt: last.trim() ? new Date(last.trim()).toISOString() : undefined, dirtyFiles: status.split(/\r?\n/).filter(Boolean).length }))
      .catch(() => ({}));
  },
  freeRamGb() { return os.freemem() / 2 ** 30; },
  worktrees(root) {
    try {
      const text = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return text.split(/\r?\n\r?\n/).map(block => {
        const p = /^worktree (.+)$/m.exec(block)?.[1];
        const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
        return p ? { path: p, branch: b } : undefined;
      }).filter((x): x is { path: string; branch: string | undefined } => x !== undefined);
    } catch { return []; }
  },
  gitActivity(worktree) {
    const git = (...args: string[]) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const last = git('log', '-1', '--format=%cI').trim();
      const dirty = git('status', '--porcelain').split('\n').filter(Boolean).length;
      return { lastCommitAt: last ? new Date(last).toISOString() : undefined, dirtyFiles: dirty };
    } catch { return {}; }
  },
  fileTime(file) {
    return existsSync(file) ? statSync(file).mtime.toISOString() : undefined;
  },
  isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  },
  probePort: probeEndpoint,
  tail(file, bytes) {
    if (!existsSync(file)) return '';
    const size = statSync(file).size;
    const fd = openSync(file, 'r');
    try {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally { closeSync(fd); }
  },
  readText(file) {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  },
  head(file, bytes) {
    if (!existsSync(file)) return '';
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(statSync(file).size, bytes));
      readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.toString('utf8');
    } finally { closeSync(fd); }
  },
  runWorkerOnce(job) {
    return new Promise(resolve => {
      mkdirSync(path.dirname(job.logFile), { recursive: true });
      const env = workerEnvironment(process.env, job.env, job.envUnset);
      const child = execFile(job.program, job.args, { cwd: job.cwd, env, encoding: 'utf8', timeout: job.timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        appendFileSync(job.logFile, String(stdout ?? '') + String(stderr ?? ''), 'utf8');
        const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({ timedOut: !!e?.killed, ...(typeof e?.code === 'number' ? { code: e.code } : e ? {} : { code: 0 }) });
      });
      child.stdin?.end();       // a program that reads its standard input when it is not a terminal must see it end
    });
  },
  kill(pid, expectedStartedAt, launchedAt) {
    return stopProcessTree(pid, expectedStartedAt, launchedAt);
  },
  stopTree: stopProcessTreeVerified,
  stopProcessOnly,
  processStartedAt(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try {
      const text = process.platform === 'win32'
        ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const at = new Date(text);
      return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
    } catch { return undefined; }
  },
  runCheck(command, cwd, timeoutSeconds) {
    const r = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', timeout: timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, timedOut, ...(r.error && !timedOut ? { error: r.error.message } : {}) };
  },
  spawnDetached: spawnDetachedProgram,
};

/**
 * A process's creation time for a check that repeats (is a run's pid still its process?). With the system's probes it comes
 * from one process table read in the background (src/monitor/process.ts) and never waits: undefined when not known yet,
 * which callers read as "cannot tell". `probes.processStartedAt` itself asks the system now; it is what records the identity
 * of a process just started (a cached answer could belong to an earlier process with the same pid). Other probes (tests,
 * replays) are asked directly.
 */
export function startedAtForCheck(probes: Probes, pid: number): string | undefined {
  if (probes.processStartedAt === systemProbes.processStartedAt) return tableStartedAt(pid);
  return probes.processStartedAt?.(pid);
}

/** The last run ended at a limit and its worker hands such orders over: who, why, and whether a paid worker may take it. */
function rotateOf(d: OrderDoc, lastRun: OrderDoc['runs'][number] | undefined, lastActionSeq: number, file: WorkersFile): { rotate?: { from: string; reason: string; allowPaid: boolean } } {
  if (!lastRun?.ended || lastRun.outcome !== 'capacity' || lastRun.limit === 'unreachable' || lastActionSeq >= lastRun.seq) return {};
  const worker = file.workers.find(w => w.id === lastRun.worker);
  if (worker?.on_limit !== 'rotate') return {};
  return { rotate: { from: worker.id, reason: limitWords(lastRun.limit), allowPaid: worker.rotate_paid === true || worker.cost === 'paid' || (d.order.mandate?.spend_cap ?? 0) > 0 } };
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The worker's newest ended run, across orders. Sequence breaks a tie on the same timestamp. */
function latestEnded(docs: readonly OrderDoc[], workerId: string): Run | undefined {
  let best: Run | undefined;
  for (const doc of docs) for (const run of doc.runs) {
    if (run.worker !== workerId || run.ended === undefined) continue;
    if (!best || run.ended > best.ended! || (run.ended === best.ended && run.seq > best.seq)) best = run;
  }
  return best;
}

/** Finds a worktree for a tag when the order does not record one: its branch or folder name contains the tag as a word. */
export function findWorktree(tag: string, list: readonly { path: string; branch?: string }[]): string | undefined {
  const want = tag.toLowerCase();
  return list.find(w => tokens(path.basename(w.path)).includes(want) || tokens(w.branch ?? '').includes(want))?.path;
}

export function readQuotaHistory(target: StateProject | string, options: QuotaHistoryOptions = {}): QuotaReading[] {
  const store = stateStore(stateProject(target));
  if (store instanceof SqliteStore) return store.quotaHistory(options);
  const readings = (readStateFile(target, 'quota-history.jsonl') ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line) as QuotaReading);
  return readings.filter(q => options.source === undefined || q.source === options.source).slice(-(options.limit ?? 500));
}

export function readTickQuotaHistory(target: StateProject | string, current: readonly QuotaReading[], now: string): QuotaReading[] {
  const store = stateStore(stateProject(target));
  if (store instanceof SqliteStore) return store.tickQuotaHistory(current, now);
  return (readStateFile(target, 'quota-history.jsonl') ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line) as QuotaReading);
}

function readSources(file: WorkersFile, names: Set<string>, probes: Probes, at: string): QuotaReading[] {
  const output = new Map<string, string | Error>();
  return [...names].map(name => {
    const source: QuotaConfig = file.quota_sources[name];
    if (source.type === 'static') return staticQuota(name, source, at);
    if (source.type === 'codex-sessions') {
      try { return readCodexSessions(name, source, at); } catch (e) { return failed(name, at, t('the quota reader failed: {error}', { error: (e as Error).message.split('\n')[0] })); }
    }
    const key = source.command.join('\u0000');
    if (!output.has(key)) {
      try { output.set(key, probes.runCommand(source.command, source.timeout_seconds)); } catch (e) { output.set(key, e as Error); }
    }
    const got = output.get(key)!;
    return got instanceof Error ? failed(name, at, got.message.split('\n')[0]) : parseCommandQuota(name, source, got, at);
  });
}

export interface TickOptions { /** Open runs of the other projects that share the workers file, by worker id: they use the same concurrency. */ peers?: Map<string, number>; record: boolean; /** Producer preview only: planned orders compete for the same slots, without launching. */ includePlanned?: boolean; /** A real tick may write one commit reminder. A dry run only reads reminders already sent. */ nudge?: boolean; finishes?: { tag: string; run: string; outcome: string; why: string }[] }

export interface TickResult { report: TickReport; quotas: QuotaReading[]; workers: WorkerState[]; activity: Record<string, OrderActivity>; history: QuotaReading[]; dispatchOrder: string[]; silentEnds?: Finish[] }

// Raw CLI/routing/API probes also use a non-blocking cache, without a board wrapper.
const endpointCaches = new WeakMap<Probes, ReturnType<typeof cachedEndpointProbe>>();
function endpointReader(probes: Probes): ReturnType<typeof cachedEndpointProbe> {
  if (probes.endpointAvailable) return probes.endpointAvailable;
  let read = endpointCaches.get(probes);
  if (!read) {
    read = cachedEndpointProbe(() => probes.now().getTime(), (host, port, timeout) => (probes.probePort ?? probeEndpoint)(host, port, timeout));
    endpointCaches.set(probes, read);
  }
  return read;
}

/** One-shot CLI commands await the first answers; a new process cannot reuse a background cache. */
export async function prewarmEndpointProbes(orders: Orders, workers: WorkersFile, probes: Probes): Promise<Probes> {
  const docs = orders.all();
  const answers = new Map<string, boolean>();
  const key = (worker: string, host: string, port: number) => JSON.stringify([worker, host, port]);
  await Promise.all(workers.workers.map(async worker => {
    if (worker.card_only || !worker.launch || latestEnded(docs, worker.id)?.limit !== 'unreachable') return;
    const endpoint = endpointOf(worker);
    if (!endpoint) return;
    const answer = await (probes.probePort ?? probeEndpoint)(endpoint.host, endpoint.port, PROBE_TIMEOUT_MS).catch(() => false);
    answers.set(key(worker.id, endpoint.host, endpoint.port), answer);
  }));
  return { ...probes, endpointAvailable: (worker, host, port, timeout) => answers.get(key(worker, host, port)) ?? endpointReader(probes)(worker, host, port, timeout) };
}

/** Reads orders, quota and the machine, then lets `planTick` decide. Writes the quota history, and, when `nudge` is set, a commit reminder. */
export function tick(project: ProjectConfig, orders: Orders, workersFile: WorkersFile, probes: Probes, options: TickOptions): TickResult {
  if (options.record) for (const doc of orders.all()) if (doc.runs.some(r => !r.ended)) pickupOutbox(orders, doc.order.tag);
  const now = probes.now();
  const at = now.toISOString();
  const used = new Set(workersFile.workers.map(w => w.quota).filter((q): q is string => !!q));
  const quotas = readSources(workersFile, used, probes, at);
  const history = readTickQuotaHistory(project, quotas, at);
  if (options.record && quotas.length) {
    appendStateFile(project, 'quota-history.jsonl', quotas.map(q => JSON.stringify(q)).join('\n') + '\n');
  }

  const docs = orders.all();
  const merged = orders.mergedSet(docs);
  const stageOf = (d: OrderDoc) => orders.stage(d, merged).stage;

  const owner = (text: string | undefined) => ownerOf(workersFile.workers, text);
  const results = roleResults(docs, [], '', at);
  const histories = workerHistory(docs, workersFile.workers);
  const checks = independentChecks(orders);
  const spent = spendToday(docs, workersFile.workers, probes, now);
  const workers: WorkerState[] = workersFile.workers.map(config => {
    const reading = config.quota ? quotas.find(q => q.source === config.quota) : undefined;
    const a = availability(config, reading, history, now);
    const today = spent.get(config.id) ?? 0;
    const overCap = config.daily_cap_usd !== undefined && today >= config.daily_cap_usd;
    if (overCap) { a.available = false; a.reasons.push(t('daily spend cap ${cap} reached (${spent} today)', { cap: config.daily_cap_usd!, spent: Number(today.toFixed(2)) })); }
    const own = docs.flatMap(d => d.runs.map(r => ({ r, open: r.ended === undefined })))
      .filter(x => owner(x.r.worker)?.id === config.id);
    return {
      config, available: a.available, reasons: a.reasons, startable: !!config.launch || config.card_only === true,
      roleHistory: Object.fromEntries(results.filter(r => r.worker === config.id).map(r => [r.role, { samples: r.samples, ...(r.acceptedShare !== null ? { rate: r.acceptedShare } : {}) }])),
      running: own.filter(x => x.open).length + checks.filter(r => r.worker === config.id && r.status === 'running').length + (options.peers?.get(config.id) ?? 0), history: histories[config.id] ?? {},
      runsToday: own.filter(x => !x.r.imported && !x.r.monitor && new Date(x.r.started).toDateString() === now.toDateString()).length + checks.filter(r => r.worker === config.id && new Date(r.started).toDateString() === now.toDateString()).length,
      ...(config.daily_cap_usd !== undefined ? { spendTodayUsd: today, overCap } : {}),
    };
  });
  const endpointDown: { worker: string; endpoint: string }[] = [];
  for (const w of workers) {
    if (w.config.card_only || !w.config.launch) continue;
    const last = latestEnded(docs, w.config.id);
    if (last?.limit !== 'unreachable') continue;
    const endpoint = endpointOf(w.config);
    if (!endpoint) continue;
    if (endpointReader(probes)(w.config.id, endpoint.host, endpoint.port, PROBE_TIMEOUT_MS)) continue;
    w.available = false;
    const phrase = t('endpoint unreachable');
    if (!w.reasons.includes(phrase)) w.reasons.push(phrase);
    endpointDown.push({ worker: w.config.id, endpoint: endpoint.label });
  }
  const alerts = workers.flatMap(w => {
    const reading = w.config.quota ? quotas.find(q => q.source === w.config.quota) : undefined;
    return availability(w.config, reading, history, now).alerts;
  });
  const uniqueAlerts = [...new Set(alerts)];

  const list = probes.worktrees(project.root);
  const activity: Record<string, OrderActivity> = {};
  const loops: Record<string, LoopFinding[]> = {};
  const lingering: Record<string, { status: string; summary: string; quietMinutes: number; ended?: boolean }> = {};
  const pinProblems: TickReport['problems'] = [];
  const foundationSets = project.foundations ? foundationStates(project) : [];
  const tickOrders: TickOrder[] = docs.map((d, index) => {
    const o = d.order;
    const pinProblem = workerPinProblem(project, d, workersFile);
    if (pinProblem) {
      pinProblems.push({ kind: 'no-fit', tag: o.tag, text: `${o.tag}: ${pinProblem}` });
      if (options.record) orders.clearWorkerPin(o.tag, pinProblem);
    }
    const actualStage = stageOf(d);
    const stage = options.includePlanned && actualStage === 'planned' && o.needs.every(n => merged.has(n)) ? 'queued' : actualStage;
    const lastRun = [...d.runs].sort((x, y) => y.seq - x.seq)[0];
    const lastAction = [...d.actions].sort((x, y) => y.seq - x.seq).find(x => x.kind === 'queue' || x.kind === 'rework' || x.kind === 'answer' || x.kind === 'message' || x.kind === 'monitor');
    const bounced = lastAction?.bounce === true && lastAction.kind === 'message';
    const notes = pendingNotes(d);
    const open = d.runs.find(r => r.ended === undefined);
    if (open) {
      const worktree = o.worktree ?? findWorktree(o.tag, list);
      activity[o.tag] = { worktree, ...(worktree ? probes.gitActivity(worktree) : {}), finalFileAt: probes.fileTime(path.join(project.work_orders, `${o.tag}.last.txt`)), logAt: open?.log ? probes.fileTime(open.log) : undefined, openCommand: open?.log ? openCommand(probes.tail(open.log, 524288)) : undefined };
      const late = open ? lingeringOf(project, probes, open) : undefined;
      if (late) lingering[o.tag] = late;
      const receipt = open && !open.imported ? readReceipt(project, probes, o.tag, worktree) : undefined;
      if (open.events_file) {
        const live = liveRuns.read(project, o.tag, open, probes, worktree);
        activity[o.tag].logAt = live.last_event_at;
        activity[o.tag].openCommand = live.current?.command;
        activity[o.tag].waitingLong = live.phase === 'waiting_long_command';
        activity[o.tag].progress = live.plan;
      }
      if (receipt) { activity[o.tag].receiptAt = receipt.at; if (receipt.progress) activity[o.tag].progress = receipt.progress; }
      if (open) { const found = watchRun(project, probes, { tag: o.tag, run: open, lastCommitAt: activity[o.tag].lastCommitAt }, { record: options.record }); if (found.length) loops[o.tag] = found; }
    }
    const routing = routingOf(project, d, at);
    const effectiveKind = isGenericKind(o.kind) ? routing.kind || o.kind : o.kind;
    const gaps = foundationSets.length && (stage === 'queued' || open) ? foundationGaps(foundationSets, { kind: effectiveKind, tags: [...(o.tags ?? []), ...routing.tags] }) : [];
    return {
      ...(gaps.length ? { foundations: gaps.map(g => ({ set: g.name, mode: g.mode, missing: missingText(g) })) } : {}),
      role: rolePolicy(resolveRole(effectiveRoles(project, workersFile), { ...o, kind: isGenericKind(o.kind) ? routing.kind || o.kind : o.kind })),
      tag: o.tag, stage: open ? 'running' : stage, kind: isGenericKind(o.kind) ? routing.kind || o.kind : o.kind, kindTags: routing.tags, heavy: heavyOf(project, d), workerText: o.worker, pinnedWorker: pinProblem ? undefined : o.next_worker,
      ...(o.mandate?.spend_cap !== undefined ? { spendCapUsd: o.mandate.spend_cap, spentUsd: orderSpend(d, workersFile.workers, probes).cost_usd ?? 0 } : {}),
      priority: o.priority,
      row: o.source?.row ?? 1e6 + index,
      rework: notes.some(n => n.kind === 'rework' || n.kind === 'answer' || n.kind === 'message'),
      ...(lastAction?.kind === 'answer' ? { answer: true } : {}),
      transientFailures: lastRun?.worker ? trailingTransientFailures(d.runs, lastRun.worker) : 0, lastRunEndedAt: lastRun?.ended,
      resume: bounced || (!!lastRun?.ended && lastRun.outcome !== 'completed' && (lastAction?.seq ?? 0) < lastRun.seq),
      ...(lastRun?.worker && (bounced || lastRun.outcome !== 'completed' || notes.some(n => n.kind === 'monitor')) ? { resumeWorker: lastRun.worker } : {}),
      ...(notes.some(n => n.kind === 'monitor') ? { monitorResume: true } : {}),
      ...rotateOf(d, lastRun, lastAction?.seq ?? 0, workersFile),
      ...(stage === 'queued' && project.resources ? { uses: usesOf(project, d) } : {}),
      ...(stage === 'queued' && project.editors ? editorPoolOf(project, d) : {}),
      endedWithoutReport: stage === 'idle' && lastRun?.outcome === 'completed' && !d.reports.some(r => r.seq > lastRun.seq),
      ...(!open && lastRun?.ended && isSilentEnd(lastRun.end?.kind) && !['merged', 'cancelled', 'awaiting-review'].includes(stage) && !d.actions.some(a => a.seq > lastRun.seq && !a.bounce)
        ? { silentEnd: { run: lastRun.id, kind: lastRun.end!.kind, detail: lastRun.end!.detail, ...(lastRun.end!.wip_ref ? { wipRef: lastRun.end!.wip_ref } : {}) } }
        : {}),
      runStartedAt: open && !open.imported ? open.started : undefined,
    };
  });

  if (options.record) pruneSeen(project, docs.flatMap(d => d.runs.filter(r => r.ended === undefined).map(r => `${d.order.tag}:${r.id}`)));
  const report = planTick({
    now, orders: tickOrders, activity, workers, caps: project.dispatch.caps, reworkReserve: project.dispatch.rework_reserve,
    minFreeRamGb: project.dispatch.min_free_ram_gb, freeRamGb: project.dispatch.min_free_ram_gb !== undefined ? probes.freeRamGb() : undefined,
    stallMinutes: project.dispatch.stall_minutes, startReceiptMinutes: project.dispatch.start_receipt_minutes, longCommandMinutes: project.dispatch.long_command_minutes, alerts: uniqueAlerts, finishes: options.finishes, monitoring: monitoringLines(orders, now), loops, loopEvidence: evidenceOf, lingering,
    resources: project.resources ?? {}, leases: activeLeases(project, orders), occupants: occupants(project, orders), endpointDown,
    ...(project.editors ? editorPortsInput(project, workers, workersFile.file) : {}),
  });
  const waitingTags = docs.filter(d => d.runs.some(r => !r.ended) && stageOf(d) === 'awaiting-user').map(d => d.order.tag);
  report.problems.push(...pinProblems);
  try {
    const machines = loadMachines(project, workersFile.file);
    refreshMachines(project, probes, machines);
    report.problems.push(...machineProblems(machinesView(project, machines, now)));
  } catch (e) { report.problems.push({ kind: 'machine-down', text: `machines registry: ${(e as Error).message}` }); }
  if (waitingTags.length) {
    const waiting = report.needsUser.find(n => n.stage === 'awaiting-user');
    if (waiting) waiting.tags.push(...waitingTags); else report.needsUser.push({ stage: 'awaiting-user', tags: waitingTags });
  }
  for (const problem of applyNudges(project, orders, probes, activity, options.nudge === true)) report.problems.push(problem);
  const ledger = collectUsage(project, docs, workersFile, probes);
  if (project.usage_warnings) for (const s of ledger.signals) report.problems.push({ kind: 'usage-waste', tag: s.order, text: s.text, evidence: [`${s.run}: turns ${s.turns.join('-')}`, s.command ?? s.file ?? ''].filter(Boolean) });
  for (const warning of budgetWarnings(project, ledger.rows, now)) {
    report.problems.push({ kind: 'usage-budget', ...(warning.order ? { tag: warning.order } : {}), text: warning.text });
    if (options.record) for (const doc of docs.filter(d => !warning.order || d.order.tag === warning.order)) {
      const key = `usage-budget-${now.toISOString().slice(0,10)}-${doc.order.tag}-${warning.kind}`;
      if (!orders.store.readMeta(key)) { orders.record(doc.order.tag, 'usage-budget', { text: warning.text }); orders.store.writeMeta(key, true); }
    }
  }
  const heartbeatProblem = producerHeartbeatProblem(project, now);
  if (heartbeatProblem) report.problems.push({ kind: 'producer', text: heartbeatProblem });
  const sessionHeartbeatProblem = producerSessionHeartbeatProblem(project, now);
  if (sessionHeartbeatProblem) report.problems.push({ kind: 'producer', text: sessionHeartbeatProblem });
  const producerBudgetProblem = project.producer.enabled && budgetProblem(project);
  if (producerBudgetProblem) report.problems.push({ kind: 'producer', text: producerBudgetProblem });
  if (report.problems.length) report.exitCode = 2;
  return { report, quotas, workers, activity, history, dispatchOrder: tickOrders.filter(o => o.stage === 'queued').sort(compareDispatchOrder).map(o => o.tag) };
}
