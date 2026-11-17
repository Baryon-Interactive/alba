import type { Run } from '../orders/model.ts';
import type { WorkerConfig } from '../workers/config.ts';

/** Runs in a row that end failed without a report before a worker is paused. */
export const TRIP_AFTER_FAILURES = 3;
/** How long the pause lasts; then one run may try again, and another such failure pauses it again. */
export const TRIP_MINUTES = 60;

/** A run that ended failed and delivered no report: the process died, could not start, or stopped without saying anything. */
export function brokenRun(run: Run): boolean {
  return run.outcome === 'failed' && !!run.missing_report && run.end?.kind !== 'killed-by-alba';
}

/**
 * The worker's circuit breaker. When its last `trip_after_failures` ended runs (cancelled, capacity, alba-stopped and monitor
 * wake-ups aside)
 * all failed without a report, it is paused until `trip_minutes` after the last of them. After the pause one run may start;
 * if that one fails the same way the pause starts again. Any other ending closes the breaker.
 */
export function workerTrip(runs: readonly Run[], worker: Pick<WorkerConfig, 'trip_after_failures' | 'trip_minutes'>, now: Date): { failures: number; since: string; until: string } | undefined {
  const after = worker.trip_after_failures ?? TRIP_AFTER_FAILURES;
  if (after <= 0) return undefined;
  const ended = runs
    .filter(r => r.ended !== undefined && !r.imported && !r.monitor && r.outcome !== 'cancelled' && r.outcome !== 'capacity' && r.end?.kind !== 'killed-by-alba')
    .sort((a, b) => Date.parse(b.ended!) - Date.parse(a.ended!));
  let failures = 0;
  for (const run of ended) { if (!brokenRun(run)) break; failures++; }
  if (failures < after) return undefined;
  const since = ended[0]!.ended!;
  const until = new Date(Date.parse(since) + (worker.trip_minutes ?? TRIP_MINUTES) * 60000);
  return now < until ? { failures, since, until: until.toISOString() } : undefined;
}
