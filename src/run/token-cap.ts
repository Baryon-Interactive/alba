import { t } from '../i18n.ts';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import type { Probes } from '../tick/gather.ts';
import type { WorkersFile } from '../workers/config.ts';
import { totalUsage } from '../usage/fold.ts';
import { liveRuns, liveSummary } from './live.ts';
import { parseStreamLog } from '../workers/adapters/index.ts';
import { saveWipSnapshot } from './wip.ts';

/** Enforce observed usage at dispatcher passes, including a process that exited between passes. */
export function stopTokenCappedRuns(project: ProjectConfig, orders: Orders, workers: WorkersFile, probes: Probes): string[] {
  const done: string[] = [];
  for (const doc of orders.all()) {
    const run = doc.runs.find(r => r.ended === undefined);
    if (!run || run.imported) continue;
    const cap = workers.workers.find(w => w.id === run.worker)?.max_tokens_per_run;
    if (cap === undefined) continue;
    const live = liveRuns.read(project, doc.order.tag, run, probes, doc.order.worktree);
    const usage = totalUsage(liveRuns.accounting(run)?.turns ?? []);
    if ((usage?.total_tokens ?? 0) <= cap) continue;
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
    const summary = `Stopped by alba: max_tokens_per_run exceeded (${usage!.total_tokens} > ${cap}).`;
    const wip = saveWipSnapshot(doc.order.worktree ?? run.cwd, { tag: doc.order.tag, runId: run.id, kind: 'killed-by-alba' });
    orders.patchRun(doc.order.tag, run.id, { usage, live_summary: liveSummary(live), ...(session ? { session } : {}) });
    orders.runEnd(doc.order.tag, 'failed', { kind: 'killed-by-alba', detail: 'stopped by alba (token-cap-stopped)', why: summary, ...wip });
    orders.report(doc.order.tag, { status: 'failed', summary, evidence: file ? [file] : [], commits: [] }, 'tick');
    orders.record(doc.order.tag, 'token-cap-stopped', { run: run.id, cap, total_tokens: usage!.total_tokens });
    done.push(`${doc.order.tag}: ${summary}`);
  }
  return done;
}
