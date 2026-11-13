import type { Quote } from '@api';
import { t } from '@/i18n';
import { tokens, usd } from './format.ts';

export interface CostLabel {
  /** What to print: "$1.20", "~$1.20" for an estimate, or "unknown". Never "$0.000" for a number nobody knows. */
  text: string;
  known: boolean;
  estimated: boolean;
}

/** A cost that is not there is unknown, not zero. An estimate (from a price table) is marked. */
export function costLabel(cost: number | undefined, estimated?: boolean): CostLabel {
  if (cost === undefined) return { text: t('unknown'), known: false, estimated: false };
  return { text: usd(cost, estimated), known: true, estimated: !!estimated };
}

/** The sum over runs: unknown when no run has a cost; an estimate when any part of it is. */
export function sumCost(runs: { cost_usd?: number; cost_estimated?: boolean }[]): CostLabel {
  const known = runs.filter(r => r.cost_usd !== undefined);
  if (!known.length) return costLabel(undefined);
  return costLabel(known.reduce((n, r) => n + (r.cost_usd ?? 0), 0), known.some(r => r.cost_estimated));
}

export function tokenLabel(n: number | undefined): string {
  return n === undefined ? t('unknown') : tokens(n);
}


/** "20 × 1.5 credits = 30 credits, cap asked 50": unit price, quantity, total, and what the executor asks to be allowed. */
export function quoteSummary(q: Pick<Quote, 'unit' | 'unitPrice' | 'quantity' | 'total' | 'capRequested'>): string {
  const parts: string[] = [];
  if (q.quantity !== undefined && q.unitPrice !== undefined) parts.push(`${q.quantity} × ${q.unitPrice} ${q.unit}${q.total !== undefined ? ` = ${q.total} ${q.unit}` : ''}`);
  else if (q.total !== undefined) parts.push(`${q.total} ${q.unit}`);
  parts.push(t('cap asked: {n} {unit}', { n: q.capRequested, unit: q.unit }));
  return parts.join(' · ');
}

export interface UnitTotals { unit: string; approved: number; spent: number; pending: number }

/** Totals of quotes per unit. Credits and dollars are never added together. */
export function totalsByUnit(quotes: Pick<Quote, 'unit' | 'status' | 'spent' | 'capRequested' | 'approval'>[]): UnitTotals[] {
  const by = new Map<string, UnitTotals>();
  for (const q of quotes) {
    const u = by.get(q.unit) ?? { unit: q.unit, approved: 0, spent: 0, pending: 0 };
    if (q.status === 'approved') { u.approved += q.approval?.cap ?? 0; u.spent += q.spent; }
    else if (q.status === 'pending') u.pending += q.capRequested;
    by.set(q.unit, u);
  }
  return [...by.values()].sort((a, b) => a.unit.localeCompare(b.unit));
}
