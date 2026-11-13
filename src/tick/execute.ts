import { t } from '../i18n.ts';
import { runAcceptanceTrials } from '../review/acceptance.ts';
import { applyFinish, findFinishes } from '../run/finish.ts';
import { startRun, type RunContext } from '../run/launch.ts';
import { runMonitors } from '../monitor/monitor.ts';
import { reconcileLeases } from '../resources/leases.ts';
import { continueToolJobs } from '../plugins/jobs.ts';
import { reconcileEditors } from '../editors/pool.ts';
import { stopLoopingRun } from '../run/watch.ts';
import { stopLingeringRun } from '../run/lingering.ts';
import { stopTokenCappedRuns } from '../run/token-cap.ts';
import { tick, type TickResult } from './gather.ts';
import type { TickReport } from './plan.ts';
import { refreshFacts } from '../producer/facts/snapshot.ts';
import { saveBriefReadings } from '../producer/briefs.ts';
import { pollIndependentChecks } from '../review/independent.ts';

/**
 * The real tick:
 *  1. record the end of runs whose process is gone (report block, transient error, or failure);
 *  2. start due resumes, and at most `maxDispatch` new orders, one at a time;
 *     quota and machine resources are read again before every start, because they change between ticks;
 *  3. report like the dry run does, plus what was done.
 */
export function executeTick(ctx: RunContext, options: { maxDispatch: number }): TickResult {
  const done: string[] = [];
  const failures: string[] = [];
  const recordFinishes = () => {
    for (const f of findFinishes(ctx.project, ctx.orders, ctx.probes, ctx.workers)) {
      applyFinish(ctx.orders, f, ctx.project);
      done.push(t('recorded the end of run {run} of {tag}: {outcome}{status} ({why})', { run: f.run, tag: f.tag, outcome: f.outcome, status: f.report ? `, ${f.report.status}` : '', why: f.why }));
    }
  };
  done.push(...stopTokenCappedRuns(ctx.project, ctx.orders, ctx.workers, ctx.probes));
  recordFinishes();
  pollIndependentChecks(ctx);
  // Long jobs handed to the monitor: one check each; the ones that ended are queued again and start first below.
  const monitored = runMonitors(ctx.project, ctx.orders, ctx.probes);
  done.push(...monitored.done);
  // Leases of orders that no longer run (and are not waiting to be continued) go back before anything new is started.
  if (ctx.project.resources) done.push(...reconcileLeases(ctx.project, ctx.orders, ctx.probes.now()));
  // The editor of a run that ended (whatever the reason) is stopped and its port given back.
  if (ctx.project.editors) done.push(...reconcileEditors(ctx.project, ctx.orders));
  // Tool jobs: one whose quote a person decided, or that waited for a resource, is started again.
  if (ctx.project.plugins) done.push(...continueToolJobs(ctx.project, ctx.orders, ctx.probes.spawnDetached));
  runAcceptanceTrials(ctx.project, ctx.orders);
  const tried = new Set<string>();
  const stopped = new Set<string>();
  let dispatched = 0;
  let starts = 0;
  let result: TickResult;
  for (;;) {
    result = tick(ctx.project, ctx.orders, ctx.workers, ctx.probes, { record: true, nudge: true });
    // `dispatch.on_loop: stop`: a run that goes round in circles is stopped (its process, then the record), and the pass is read again.
    const loopers = ctx.project.dispatch.on_loop === 'stop' ? result.report.problems.filter(p => p.kind === 'looping' && p.tag && !stopped.has(p.tag)) : [];
    if (loopers.length) {
      for (const p of loopers) { stopped.add(p.tag!); done.push(stopLoopingRun(ctx.project, ctx.orders, ctx.probes, p.tag!, p.evidence ?? [])); }
      continue;
    }
    // `dispatch.on_lingering: stop`: a run that has handed in its report but whose process stays is stopped (that process only), and its end is recorded as usual.
    const lingerers = ctx.project.dispatch.on_lingering === 'stop' ? result.report.problems.filter(p => p.kind === 'lingering' && p.tag && !stopped.has(p.tag)) : [];
    if (lingerers.length) {
      for (const p of lingerers) { stopped.add(p.tag!); done.push(stopLingeringRun(ctx.orders, ctx.probes, p.tag!)); }
      recordFinishes();
      continue;
    }
    const move = result.report.moves.find(m => m.mode !== 'card' && !tried.has(m.tag) && (m.mode === 'resume' || dispatched < options.maxDispatch));
    if (!move) break;
    tried.add(move.tag);
    try {
      const started = startRun(ctx, move.tag, move.worker, { capsChecked: true, capReserve: move.capReserve, route: move.why ? { why: move.why, rejected: move.rejected ?? [] } : undefined, ...(move.rotated ? { rotate: move.rotated } : {}) });
      if (started.mode === 'start') done.push(t('{verb} {tag} with {worker} (run {run}, pid {pid}, log {log})', { verb: move.rotated ? t('handed over ({from}: {reason}) and started', move.rotated) : move.mode === 'resume' ? t('resumed') : t('started'), tag: move.tag, worker: move.worker, run: started.run ?? '-', pid: started.pid ?? '-', log: started.log ?? '-' }));
      if (move.mode === 'dispatch') dispatched++;
      if (started.mode === 'start') starts++;
    } catch (e) {
      failures.push(t('could not start {tag}: {why}', { tag: move.tag, why: (e as Error).message.split('\n')[0] }));
    }
  }
  const report: TickReport = result.report;
  report.dispatched = starts;
  report.done = done;
  for (const text of failures) report.problems.push({ kind: 'launch', text });
  for (const p of monitored.problems) report.problems.push({ kind: 'monitor', tag: p.tag, text: p.text });
  report.exitCode = report.problems.length ? 2 : report.moves.length ? 1 : 0;
  refreshFacts(ctx.project, ctx.probes.now(), ctx.workers, result.workers);
  if (ctx.project.producer.brief) saveBriefReadings(ctx.project, { report, activity: result.activity });
  return { ...result, report };
}
