import { existsSync } from 'node:fs';
import type { ProjectConfig } from '../config.ts';
import type { OrderDoc, Report, Stage } from '../orders/model.ts';
import { Orders } from '../orders/service.ts';
import { stateStore } from '../orders/backend.ts';
import { tick, type Probes, type TickResult } from '../tick/gather.ts';
import type { OrderActivity, TickReport, WorkerState } from '../tick/plan.ts';
import type { WorkersFile } from '../workers/config.ts';
import type { QuotaReading } from '../workers/quota.ts';
import { cachedEndpointProbe, probeEndpoint } from '../run/endpoint.ts';

export interface OrderRow {
  project: string;
  tag: string;
  title: string;
  stage: Stage;
  why: string;
  kind: string;
  worker?: string;
  updated: string;
  report?: Report;           // the report that is current for the stage, if any
  runWorker?: string;        // worker of the open run
  activity?: OrderActivity;
}

export interface ProjectView {
  config: ProjectConfig;
  orders: Orders;
  rows: OrderRow[];
  tick?: TickReport;
  workers?: WorkerState[];
  quotas?: QuotaReading[];
  history?: QuotaReading[];
  error?: string;
}

export interface Snapshot {
  at: string;
  projects: ProjectView[];
  freeRamGb?: number;
  minFreeRamGb?: number;
  workersFile?: WorkersFile;
}

/** Stages that only a person can move, in the order they are shown. */
export const NEEDS_YOU: readonly Stage[] = ['awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped'];

/** What each of those stages is waiting for, in words. */
export const WAITING_FOR: Record<string, string> = {
  'awaiting-user': 'waiting for your answer or click',
  'awaiting-review': 'waiting for your review',
  blocked: 'blocked, needs your decision',
  failed: 'failed, needs a look',
  dropped: 'dropped by the worker, needs a look',
};

export function rowsOf(project: ProjectConfig, orders: Orders, activity: Record<string, OrderActivity> = {}): OrderRow[] {
  const docs = orders.all();
  const merged = orders.mergedSet(docs);
  return docs.map((d: OrderDoc) => {
    const { stage, why } = orders.stage(d, merged);
    const latest = [...d.reports].sort((a, b) => b.seq - a.seq)[0];
    const open = d.runs.find(r => r.ended === undefined);
    return {
      project: project.id, tag: d.order.tag, title: d.order.title, stage, why, kind: d.order.kind, worker: d.order.worker, updated: d.order.updated,
      report: NEEDS_YOU.includes(stage) ? latest : undefined, runWorker: open?.worker, activity: activity[d.order.tag],
    };
  }).sort((a, b) => (a.tag < b.tag ? -1 : 1));
}

/**
 * Calls to slow things (a quota command, a PowerShell memory query, git in a worktree) are answered from memory for a short time. Once
 * an answer is older than that, it is still given, and a fresh one is read in the background (when the probes can do that
 * without blocking): a page never waits for the slow command except the very first time. A command that failed is not kept.
 */
export function cachedProbes(base: Probes, ttlMs: number): Probes & { prime(commands: readonly (readonly string[])[], timeoutSeconds?: number): Promise<void> } {
  const memo = new Map<string, { at: number; value: unknown }>();
  const refreshing = new Set<string>();
  const once = <T>(key: string, make: () => T, refresh?: () => Promise<T>): T => {
    const hit = memo.get(key);
    const age = hit ? base.now().getTime() - hit.at : Infinity;
    if (hit && age < ttlMs) return hit.value as T;
    if (hit && refresh) {
      if (!refreshing.has(key)) {
        refreshing.add(key);
        refresh().then(value => { memo.set(key, { at: base.now().getTime(), value }); }, () => { /* the old answer stays */ }).finally(() => refreshing.delete(key));
      }
      return hit.value as T;
    }
    const value = make();
    memo.set(key, { at: base.now().getTime(), value });
    return value;
  };
  const { runCommandAsync, freeRamGbAsync, gitActivityAsync } = base;
  /** Fills the memory in the background (a server calls this when it starts), so not even the first page waits for a slow command. */
  const prime = async (commands: readonly (readonly string[])[], timeoutSeconds = 60): Promise<void> => {
    const fill = async (key: string, read: () => Promise<unknown>) => {
      if (memo.has(key) || refreshing.has(key)) return;
      refreshing.add(key);
      try { memo.set(key, { at: base.now().getTime(), value: await read() }); } catch { /* the first page reads it then */ } finally { refreshing.delete(key); }
    };
    const jobs: Promise<void>[] = [];
    if (freeRamGbAsync) jobs.push(fill('ram', () => freeRamGbAsync.call(base)));
    if (runCommandAsync) for (const c of commands) jobs.push(fill(`cmd:${c.join('\0')}`, () => runCommandAsync.call(base, [...c], timeoutSeconds)));
    await Promise.all(jobs);
  };
  return {
    ...base,
    prime,
    // Unlike quota reads, even an empty endpoint cache returns immediately.
    endpointAvailable: cachedEndpointProbe(() => base.now().getTime(), (host, port, timeout) => (base.probePort ?? probeEndpoint)(host, port, timeout), ttlMs),
    runCommand: (command, timeout) => once(`cmd:${command.join('\u0000')}`, () => base.runCommand(command, timeout), runCommandAsync ? () => runCommandAsync.call(base, command, timeout) : undefined),
    freeRamGb: () => once('ram', () => base.freeRamGb(), freeRamGbAsync ? () => freeRamGbAsync.call(base) : undefined),
    gitActivity: worktree => once(`git:${worktree}`, () => base.gitActivity(worktree), gitActivityAsync ? () => gitActivityAsync.call(base, worktree) : undefined),
  };
}

/** Reads everything the board shows. Quota and the machine are read through the tick, in dry-run form, without recording history. */
export function buildSnapshot(configs: ProjectConfig[], workers: WorkersFile | undefined, probes: Probes, actor = 'web'): Snapshot {
  const snapshot: Snapshot = { at: probes.now().toISOString(), projects: [], workersFile: workers };
  for (const config of configs) {
    const orders = new Orders(stateStore(config), () => probes.now().toISOString(), actor);
    const view: ProjectView = { config, orders, rows: [] };
    try {
      let result: TickResult | undefined;
      if (workers) result = tick(config, orders, workers, probes, { record: false });
      view.rows = rowsOf(config, orders, result?.activity);
      if (result) { view.tick = result.report; view.workers = result.workers; view.quotas = result.quotas; view.history = result.history; }
    } catch (e) {
      view.error = (e as Error).message.split('\n')[0];
      if (!view.rows.length && existsSync(config.state_dir)) view.rows = rowsOf(config, orders);
    }
    snapshot.projects.push(view);
    const min = config.dispatch.min_free_ram_gb;
    if (min !== undefined) snapshot.minFreeRamGb = Math.max(snapshot.minFreeRamGb ?? 0, min);
  }
  if (workers) snapshot.freeRamGb = probes.freeRamGb();
  return snapshot;
}
