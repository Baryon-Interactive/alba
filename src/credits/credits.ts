import type * as A from '../api/types.ts';
import { randomUUID } from 'node:crypto';
import { UserError, t } from '../i18n.ts';
import type { OrderDoc, StoredQuote } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const spentOf = (q: StoredQuote) => round(q.ledger.reduce((n, e) => n + e.amount, 0));
/** Held by the gate and not lapsed (without the hold under `except`). */
const heldOf = (q: StoredQuote, except?: string, now = Date.now()) => round((q.holds ?? []).filter(h => Date.parse(h.until) > now && h.key !== except).reduce((n, h) => n + h.amount, 0));

export function toQuote(project: string, tag: string, q: StoredQuote): A.Quote {
  const spent = spentOf(q), held = heldOf(q);
  return {
    id: q.id, project, tag, service: q.service, unit: q.unit, ...(q.unit_price !== undefined ? { unitPrice: q.unit_price } : {}), ...(q.quantity !== undefined ? { quantity: q.quantity } : {}),
    ...(q.total !== undefined ? { total: q.total } : {}), capRequested: q.cap_requested, ...(q.note ? { note: q.note } : {}), created: q.created, by: q.by, status: q.status,
    ...(q.approval ? { approval: { cap: q.approval.cap, ...(q.approval.note ? { note: q.approval.note } : {}), by: q.approval.by, at: q.approval.at } } : {}),
    spent, ...(held ? { held } : {}), ...(q.status === 'approved' && q.approval ? { remaining: round(q.approval.cap - spent - held) } : {}), ledger: q.ledger.map(e => ({ at: e.at, amount: e.amount, what: e.what, by: e.by, ...(e.unknown ? { unknown: true as const } : {}), ...(e.key ? { key: e.key } : {}) })),
  };
}

/** What was approved, spent and is still waiting for approval, by unit (units are never added together). */
export function creditsOf(doc: OrderDoc): A.OrderSpend['credits'] | undefined {
  if (!doc.quotes?.length) return undefined;
  const out: NonNullable<A.OrderSpend['credits']> = {};
  for (const q of doc.quotes) {
    const row = out[q.unit] ??= { approved: 0, spent: 0, pending: 0 };
    if (q.status === 'approved' && q.approval) { row.approved = round(row.approved + q.approval.cap); row.spent = round(row.spent + spentOf(q)); }
    if (q.status === 'pending') row.pending = round(row.pending + q.cap_requested);
  }
  return out;
}

export function quoteList(project: string, orders: Orders, status?: string): A.QuoteList {
  const items = orders.all().flatMap(d => (d.quotes ?? []).map(q => toQuote(project, d.order.tag, q))).filter(q => !status || q.status === status).sort((a, b) => (a.created < b.created ? -1 : 1));
  return { project, count: items.length, items };
}

export interface GateResult { ok: boolean; why: string; remaining?: number; hold?: { key: string; amount: number; until: string } }

/**
 * The hard gate before a paid call: the quote must be approved and must have at least `need` left, after what was spent and
 * what other calls hold. A gate that passes holds `need` under `key` (made up when not given) until the spend with that key
 * books it, or until it lapses (`minutes`, an hour by default): two calls that pass the gate at once cannot both spend the last of
 * the cap. `need` 0 only reads what is left (for the holder of `key`: its own hold counts as left). The executor runs
 * `alba credits gate <TAG> <quote> --need N` first and does not go on when it exits 1.
 */
export function gate(orders: Orders, tag: string, id: string, need: number, options: { key?: string; minutes?: number } = {}): GateResult {
  const doc = orders.get(tag);
  const q = doc.quotes?.find(x => x.id.toLowerCase() === id.toLowerCase());
  if (!q) return { ok: false, why: t('{tag} has no quote {id}.', { tag: doc.order.tag, id }) };
  if (q.status === 'pending') return { ok: false, why: t('Quote {id} of {tag} waits for approval; do not spend.', { id: q.id, tag: doc.order.tag }) };
  if (q.status === 'rejected') return { ok: false, why: t('Quote {id} of {tag} was rejected; do not spend.', { id: q.id, tag: doc.order.tag }) };
  const remaining = round(q.approval!.cap - spentOf(q) - heldOf(q, options.key, Date.parse(orders.now())));
  if (need > remaining + 1e-9) return { ok: false, remaining, why: t('Quote {id} of {tag} has {remaining} {unit} left, {need} are needed; do not spend.', { id: q.id, tag: doc.order.tag, remaining, unit: q.unit, need }) };
  const ok = t('Quote {id} of {tag}: {need} of {remaining} {unit} left may be spent.', { id: q.id, tag: doc.order.tag, need, remaining, unit: q.unit });
  if (!(need > 0)) return { ok: true, remaining, why: ok };
  const key = options.key?.trim() || `hold-${randomUUID().slice(0, 8)}`;
  try {
    const made = orders.hold(doc.order.tag, q.id, { amount: need, key, minutes: options.minutes });
    return { ok: true, remaining, hold: { key, amount: need, until: made.hold.until }, why: `${ok} ${t('Held as {key} until {until}: book it with --key {key}.', { key, until: made.hold.until })}` };
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return { ok: false, remaining, why: error.message };
  }
}

export function formatQuotes(items: readonly A.Quote[]): string {
  if (!items.length) return t('(none)');
  return items.map(q => `${q.tag}/${q.id}  ${q.status.padEnd(8)}  ${q.service}  ${q.status === 'approved' ? `${q.spent}/${q.approval!.cap}` : `asks ${q.capRequested}`} ${q.unit}${q.note ? `  ${q.note}` : ''}`).join('\n');
}
