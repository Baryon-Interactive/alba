import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { startRun, type RunContext } from '../run/launch.ts';
import { findOrderFile } from '../run/prompt.ts';
import { tick, type TickResult } from '../tick/gather.ts';
import type { Move } from '../tick/plan.ts';
import { kindOfOrder } from '../resources/leases.ts';
import { existsSync } from 'node:fs';
import { plannedRefusal } from './producer.ts';

export function dispatchCandidates(project: ProjectConfig, orders: Orders, result: TickResult) {
  const queued = result.dispatchOrder.map(tag => orders.get(tag));
  const kinds = [...new Set(result.report.moves.map(m => kindOfOrder(project, orders.get(m.tag))))];
  return kinds.flatMap(kind => {
    const move = result.report.moves.find(m => kindOfOrder(project, orders.get(m.tag)) === kind);
    if (!move) return [];
    const next = queued.filter(d => d.order.tag !== move.tag && kindOfOrder(project, d) === kind).slice(0, 2).map(d => ({ tag: d.order.tag,
      why: result.report.heldBack.find(h => h.tag === d.order.tag)?.why ?? result.report.problems.find(p => p.tag === d.order.tag)?.text ?? `Later in dispatch order (priority ${d.order.priority ?? 0}, position ${result.dispatchOrder.indexOf(d.order.tag) + 1}).` }));
    return [{ kind, move, next, why: `First eligible order under the tick's continuation, rework, priority and queue ordering. ${move.why ?? ''}` }];
  });
}

/** Use a fresh dry tick immediately before launch; proposals confer no capacity reservation. */
export function executeDispatch(ctx: RunContext, tag: string): string {
  const doc = ctx.orders.get(tag), stage = ctx.orders.stage(doc).stage;
  if (stage === 'planned') throw new Error(`Dispatch refused: ${plannedRefusal(ctx.orders, tag)}`);
  if (stage !== 'queued') throw new Error(`Dispatch refused: ${tag} is ${stage}.`);
  const merged = ctx.orders.mergedSet();
  if (doc.order.needs.some(n => !merged.has(n))) throw new Error('Dispatch refused: needs are not merged.');
  const ram = ctx.probes.freeRamGb();
  if (ctx.project.dispatch.min_free_ram_gb !== undefined && (ram === undefined || ram < ctx.project.dispatch.min_free_ram_gb)) throw new Error('Dispatch refused: free memory is below the minimum or unavailable.');
  const result = tick(ctx.project, ctx.orders, ctx.workers, ctx.probes, { record: false });
  const candidate = dispatchCandidates(ctx.project, ctx.orders, result).find(c => c.move.tag === tag);
  if (!candidate) throw new Error(`Dispatch refused: ${result.report.heldBack.find(h => h.tag === tag)?.why ?? result.report.problems.find(p => p.tag === tag)?.text ?? 'a different order is next, or caps, quota, resources or worker limits changed'}.`);
  let file: string | undefined;
  try { file = findOrderFile(ctx.project.work_orders, tag); } catch { /* draft it first */ }
  if (!file || !existsSync(file)) throw new Error('Dispatch refused: order body is missing; draft it first.');
  const move: Move = candidate.move;
  const started = startRun(ctx, tag, move.worker, { capsChecked: true, capReserve: move.capReserve, route: { why: candidate.why, rejected: move.rejected ?? [] }, ...(move.rotated ? { rotate: move.rotated } : {}) });
  ctx.orders.record(tag, 'producer-dispatch', { worker: move.worker, mode: started.mode });
  return started.mode === 'card' ? started.text : `Started ${tag} with ${move.worker} (${started.run}).`;
}
