import type { WorkerKindHistory } from '../api/types.ts';
import type { OrderDoc } from '../orders/model.ts';
import { ownerOf } from '../usage/spend.ts';
import type { WorkerConfig } from '../workers/config.ts';

/** How many runs of one kind a worker needs before its accepted share counts. */
export const MIN_SAMPLES = 3;

/**
 * For every worker and kind: how many of its runs were accepted without being sent back, and how many were sent back.
 * A run counts once it has a verdict: the first `approve` or `rework` after it (before the next run starts). A run that
 * ended failed without a report block counts as `failed`: it delivered nothing, so it weighs against the accepted share
 * (a worker whose runs keep dying must not look like "100% accepted"). A run with no verdict yet, a cancelled or capacity
 * ending, and imported runs (their worker is whatever the table said) do not count.
 * The kind is the order's classified kind, else its own.
 */
export function workerHistory(docs: readonly OrderDoc[], workers: readonly WorkerConfig[]): Record<string, Record<string, WorkerKindHistory>> {
  const out: Record<string, Record<string, WorkerKindHistory>> = {};
  for (const doc of docs) {
    const kind = doc.order.routing?.kind || doc.order.kind;
    if (!kind) continue;
    const runs = [...doc.runs].sort((a, b) => a.seq - b.seq);
    runs.forEach((run, i) => {
      if (run.imported) return;
      const owner = ownerOf(workers, run.worker);
      if (!owner) return;
      if (run.outcome === 'failed' && run.missing_report && run.end?.kind !== 'killed-by-alba') {
        const h = ((out[owner.id] ??= {})[kind] ??= { kind, accepted: 0, reworked: 0, samples: 0 });
        h.failed = (h.failed ?? 0) + 1;
        h.samples = h.accepted + h.reworked + h.failed;
        return;
      }
      if (run.outcome !== 'completed') return;
      const until = runs[i + 1]?.seq ?? Infinity;
      const verdict = [...doc.actions].sort((a, b) => a.seq - b.seq).find(a => a.seq > run.seq && a.seq < until && (a.kind === 'approve' || a.kind === 'rework'));
      if (!verdict) return;
      const h = ((out[owner.id] ??= {})[kind] ??= { kind, accepted: 0, reworked: 0, samples: 0 });
      if (verdict.kind === 'approve') h.accepted++; else h.reworked++;
      h.samples = h.accepted + h.reworked + (h.failed ?? 0);
    });
  }
  for (const byKind of Object.values(out)) for (const h of Object.values(byKind)) if (h.samples >= MIN_SAMPLES) h.rate = h.accepted / h.samples;
  return out;
}
