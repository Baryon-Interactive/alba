import type { ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { kindOfOrder, usesOf } from '../resources/leases.ts';

/** A gate stops yielding to an order that has been dispatchable for this long: something other than the gate is holding it back. */
export const YIELD_CAP_MS = 2 * 3_600_000;
const SENTENCE = 'Queued orders have dispatch priority.';

export interface GateNeeds { name: string; uses?: string[]; kind?: string }
export interface YieldDecision { reason?: string; capped?: string }

/** When the order became dispatchable as far as the record shows: its latest queue-like action. */
function queuedSince(doc: OrderDoc): number {
  const last = doc.actions.filter(a => ['queue', 'rework', 'answer', 'monitor', 'approve'].includes(a.kind)).sort((a, b) => b.seq - a.seq)[0];
  const at = Date.parse(last?.at ?? doc.order.updated);
  return Number.isFinite(at) ? at : 0;
}

/**
 * The one rule for CLI and serve: a gate yields while a queued order whose needs are met wants a resource the gate needs
 * (or counts against the gate's kind cap), for at most two hours per order. Orders that need nothing the gate needs never delay it.
 * `override` replaces the rule for deterministic tests. Production callers use this rule unchanged.
 */
export function yieldDecision(project: ProjectConfig, orders: Orders, gate: GateNeeds, now: Date, override?: boolean | (() => boolean)): YieldDecision {
  if (override !== undefined) return (typeof override === 'function' ? override() : override) ? { reason: SENTENCE } : {};
  const waiting: string[] = [], capped: string[] = [];
  for (const doc of orders.ready()) {
    const uses = usesOf(project, doc).filter(r => gate.uses?.includes(r));
    const sameKind = !!gate.kind && [kindOfOrder(project, doc), doc.order.heavy].includes(gate.kind);
    if (!uses.length && !sameKind) continue;
    if (now.getTime() - queuedSince(doc) > YIELD_CAP_MS) capped.push(doc.order.tag);
    else waiting.push(`${doc.order.tag} (${uses.length ? `needs ${uses.join(', ')}` : `kind ${gate.kind}`})`);
  }
  return {
    ...(waiting.length ? { reason: `${SENTENCE} Waiting for ${waiting.join('; ')}.` } : {}),
    ...(capped.length ? { capped: `Gate ${gate.name} no longer yields to ${capped.join(', ')}: dispatchable for over 2 h without starting.` } : {}),
  };
}
