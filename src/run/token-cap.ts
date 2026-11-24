import { t } from '../i18n.ts';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import type { Probes } from '../tick/gather.ts';
import type { WorkerConfig, WorkersFile } from '../workers/config.ts';
import type { Run } from '../orders/model.ts';
import { totalUsage } from '../usage/fold.ts';
import { withCost, type RunUsage } from '../usage/usage.ts';
import { liveRuns, liveSummary } from './live.ts';
import { parseStreamLog } from '../workers/adapters/index.ts';
import { saveWipSnapshot } from './wip.ts';
import { requeueUndeliveredInbox } from './messages.ts';

/** Which per-run limit a run went over, and the line that says so; undefined while it is inside all of them. */
export function runCapExceeded(run: Pick<Run, 'started'>, worker: Pick<WorkerConfig, 'max_tokens_per_run' | 'max_minutes_per_run' | 'max_usd_per_run' | 'price'> | undefined, usage: RunUsage | undefined, now: Date): { cap: 'tokens' | 'minutes' | 'usd'; limit: number; value: number; summary: string } | undefined {
  if (!worker) return undefined;
  const tokens = usage?.total_tokens ?? 0;
  if (worker.max_tokens_per_run !== undefined && tokens > worker.max_tokens_per_run)
    return { cap: 'tokens', limit: worker.max_tokens_per_run, value: tokens, summary: `Stopped by alba: max_tokens_per_run exceeded (${tokens} > ${worker.max_tokens_per_run}).` };
  const minutes = (now.getTime() - Date.parse(run.started)) / 60000;
  if (worker.max_minutes_per_run !== undefined && minutes > worker.max_minutes_per_run)
    return { cap: 'minutes', limit: worker.max_minutes_per_run, value: Math.round(minutes), summary: `Stopped by alba: max_minutes_per_run exceeded (${Math.round(minutes)} > ${worker.max_minutes_per_run} minutes).` };
  const cost = usage ? withCost(usage, worker.price).cost_usd : undefined;
  if (worker.max_usd_per_run !== undefined && cost !== undefined && cost > worker.max_usd_per_run)
    return { cap: 'usd', limit: worker.max_usd_per_run, value: Math.round(cost * 100) / 100, summary: `Stopped by alba: max_usd_per_run exceeded ($${cost.toFixed(2)} > $${worker.max_usd_per_run}).` };
  return undefined;
}

/**
 * Enforce a worker's per-run limits (tokens, wall-clock minutes, dollars) at dispatcher passes, including a process that exited
 * between passes. The run is stopped, its uncommitted work is kept in a WIP ref, and the order goes to `failed` for a person.
 */
export function stopTokenCappedRuns(project: ProjectConfig, orders: Orders, workers: WorkersFile, probes: Probes): string[] {
  const done: string[] = [];
  for (const doc of orders.all()) {
    const run = doc.runs.find(r => r.ended === undefined);
    if (!run || run.imported) continue;
    const supply = workers.workers.find(w => w.id === run.worker);
    const worker = run.phase_timeout_minutes === undefined ? supply : { ...supply, max_minutes_per_run: Math.min(run.phase_timeout_minutes, supply?.max_minutes_per_run ?? Infinity) };
    if (worker?.max_tokens_per_run === undefined && worker?.max_minutes_per_run === undefined && worker?.max_usd_per_run === undefined) continue;
    const live = liveRuns.read(project, doc.order.tag, run, probes, doc.order.worktree);
    const usage = totalUsage(liveRuns.accounting(run)?.turns ?? []);
    const over = runCapExceeded(run, worker, usage, probes.now());
    if (!over) continue;
    if (run.pid && probes.isAlive(run.pid)) {
      // Structured runs own a capture process and the CLI beneath it; stop both through the guarded worker stop.
      const stopped = probes.kill?.(run.pid, run.process_started_at, run.started);
      if (!stopped?.includes(run.pid)) {
        done.push(t('Refusing to stop process {pid} of {tag}: it is not the process this run started.', { pid: run.pid, tag: doc.order.tag }));
        continue;
      }
    }
    const file = run.events_file ?? run.log;
    const session = file ? parseStreamLog(probes.head?.(file, 65536) ?? probes.readText(file)?.slice(0, 65536) ?? '').sessionId : undefined;
    const wip = saveWipSnapshot(doc.order.worktree ?? run.cwd, { tag: doc.order.tag, runId: run.id, kind: 'killed-by-alba' });
    orders.patchRun(doc.order.tag, run.id, { ...(usage ? { usage } : {}), live_summary: liveSummary(live), ...(session ? { session } : {}) });
    orders.runEnd(doc.order.tag, 'failed', { kind: 'killed-by-alba', detail: 'stopped by alba (token-cap-stopped)', why: over.summary, ...wip });
    orders.report(doc.order.tag, { status: 'failed', summary: over.summary, evidence: file ? [file] : [], commits: [] }, 'tick');
    orders.record(doc.order.tag, 'token-cap-stopped', { run: run.id, cap: over.limit, kind: over.cap, value: over.value, ...(over.cap === 'tokens' ? { total_tokens: over.value } : {}) });
    requeueUndeliveredInbox(orders, doc.order.tag, run);
    done.push(`${doc.order.tag}: ${over.summary}`);
  }
  return done;
}
