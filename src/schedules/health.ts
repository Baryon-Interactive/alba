import type { ScheduleFireView } from '../api/types.ts';
import type { OrderDoc } from '../orders/model.ts';
import { systemProbes, type Probes } from '../tick/gather.ts';
import { usageOf } from '../usage/spend.ts';
import type { WorkerConfig } from '../workers/config.ts';
import type { ScheduleFireRow } from './store.ts';

export function scheduleSpend(docs: OrderDoc[], now: Date, workers: readonly WorkerConfig[] = [], probes: Probes = systemProbes): number | 'unknown' {
  const since = now.getTime() - 7 * 86_400_000;
  let total = 0;
  for (const doc of docs) for (const run of doc.runs) {
    const at = Date.parse(run.started);
    if (at < since || at > now.getTime()) continue;
    const cost = usageOf(run, workers, probes).cost_usd;
    if (cost === undefined) return 'unknown';
    total += cost;
  }
  return Math.round(total * 1e6) / 1e6;
}

export function fireView(row: ScheduleFireRow): ScheduleFireView {
  return {
    plannedAt: row.planned_at, firedAt: row.fired_at, status: row.status,
    ...(row.first_planned_at ? { firstPlannedAt: row.first_planned_at } : {}),
    ...(row.count ? { count: row.count } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.order_tag ? { orderTag: row.order_tag } : {}),
    ...(row.manual ? { manual: true } : {}),
    ...(row.precheck ? { precheck: row.precheck } : {}),
    ...(row.output !== undefined ? { output: row.output } : {}),
  };
}

export function recentHistory(rows: ScheduleFireRow[]): ScheduleFireView[] {
  const history: ScheduleFireView[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const last = history.at(-1);
    if (last && row.status !== 'created' && row.status !== 'missed' && row.status === last.status
      && row.reason === last.reason && row.precheck === last.precheck && row.manual === !!last.manual) {
      last.count = (last.count ?? 1) + 1;
      last.firstPlannedAt = row.planned_at;
    } else {
      if (history.length === 10) break;
      history.push(fireView(row));
    }
  }
  return history;
}
