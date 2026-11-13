import type { RunUsage } from '../api/types.ts';
import { adapters } from '../workers/adapters/index.ts';
export type { RunUsage };
export const UNKNOWN: RunUsage = { source: 'unknown' };
/** Engine-specific usage decoding is entirely owned by registered adapters. */
export function parseUsage(text: string, options: { cut?: boolean } = {}): RunUsage {
  for (const adapter of adapters) {
    const usage = adapter.usage(text, options.cut);
    if (usage) return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as unknown as RunUsage;
  }
  return UNKNOWN;
}

/** What a worker charges per million tokens (private workers file). */
export interface Price { input_per_mtok?: number; output_per_mtok?: number; per_mtok?: number }

/** The cost of a run: the engine's own figure when it printed one, else an estimate from the worker's price (marked as such), else nothing. */
export function withCost(usage: RunUsage, price: Price | undefined): RunUsage {
  if (usage.cost_usd !== undefined || !price) return usage;
  let cost: number | undefined;
  if (price.input_per_mtok !== undefined && price.output_per_mtok !== undefined && usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
    cost = (usage.input_tokens * price.input_per_mtok + usage.output_tokens * price.output_per_mtok) / 1e6;
  } else if (price.per_mtok !== undefined && usage.total_tokens !== undefined) {
    cost = (usage.total_tokens * price.per_mtok) / 1e6;
  }
  return cost === undefined ? usage : { ...usage, cost_usd: Math.round(cost * 1e6) / 1e6, cost_estimated: true };
}
