import type { CapacityUsage, Stage } from '../api/types.ts';

/** Current project cap use: monitored jobs retain their kind and heavy-class slots. */
export function capacityUsage(orders: { stage: Stage; kind: string; heavy?: string }[], caps: Record<string, number>): Record<string, CapacityUsage> {
  const usage = Object.fromEntries(Object.entries(caps).map(([key, cap]) => [key, { used: 0, cap, monitoring: 0 }]));
  for (const order of orders) {
    if (order.stage !== 'running' && order.stage !== 'monitoring') continue;
    // An order whose kind is also its heavy class holds one slot of it, not two.
    for (const key of new Set([order.kind, order.heavy])) {
      if (!key || !Object.hasOwn(usage, key)) continue;
      usage[key].used++;
      if (order.stage === 'monitoring') usage[key].monitoring++;
    }
  }
  return usage;
}
