import type { CleanItem, CleanPlan } from '@api';

export const REMOVING: CleanItem['action'][] = ['remove', 'prune', 'delete'];

export interface CleanSummary {
  /** Items the plan would change. */
  removing: CleanItem[];
  /** Items it leaves alone, with the reason on each. */
  leaving: CleanItem[];
  /** What would be freed; `unknown` counts the items whose size was not measured. */
  bytes: number;
  unknown: number;
  links: number;
}

export function summarizePlan(plan: CleanPlan): CleanSummary {
  const removing = plan.items.filter(i => REMOVING.includes(i.action));
  const leaving = plan.items.filter(i => !REMOVING.includes(i.action));
  return {
    removing, leaving,
    bytes: removing.reduce((n, i) => n + (i.bytes ?? i.measuredBytes ?? 0), 0),
    unknown: removing.filter(i => i.bytes === undefined).length,
    links: removing.reduce((n, i) => n + i.links, 0),
  };
}
