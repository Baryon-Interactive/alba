import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { readLibrary } from '../design/library.ts';
import { targetStatus } from '../design/read.ts';
import { orderText } from '../routing/classify.ts';
import { activeLeases, occupants } from '../resources/leases.ts';

export const GOAL_TRIGGERS = ['target-failing', 'target-unmeasured', 'gap-unowned'] as const;
export const isGoalTrigger = (trigger: string) => (GOAL_TRIGGERS as readonly string[]).includes(trigger);
export const isGoalDraft = (trigger: string) => isGoalTrigger(trigger) || trigger === 'idle-capacity';
export function goalOrderMatches(project: ProjectConfig, orders: Orders, id: string) {
  return orders.all().filter(d => !['merged', 'cancelled', 'dropped'].includes(orders.stage(d).stage)).flatMap(d => {
    let body = ''; try { body = orderText(project, d.order.tag); } catch { /* planned orders have no body */ }
    const offset = body.indexOf(id);
    return offset < 0 ? [] : [{ order: d.order.tag, id, offset }];
  });
}
export function designGoalCases(project: ProjectConfig, orders: Orders) {
  if (!project.design?.enabled) return [];
  const library = readLibrary(project), milestone = library.milestone.find(m => m.status === 'active');
  if (!milestone) return [];
  const targets = library.target.filter(t => milestone.criteria.some(c => 'target' in c && c.target === t.id));
  const systems = new Set([...targets.map(t => t.system), ...(milestone.systems ?? [])]);
  const context = (system: string) => ({ milestone: milestone.id, system: library.system.find(s => s.code === system), rules: library.rule.filter(r => r.system === system && r.status === 'active'), gaps: library.gap.filter(g => g.system === system && g.status === 'open') });
  const targetCases = targets.flatMap(t => {
    const status = targetStatus(t), trigger = status === 'failing' ? 'target-failing' : status === 'unmeasured' && !t.measure ? 'target-unmeasured' : undefined;
    if (!trigger) return [];
    const matches = goalOrderMatches(project, orders, t.id);
    return matches.length ? [] : [{ key: `goal/${t.id}`, trigger, facts: { ...context(t.system), goal: t.id, target: t, orderMatches: matches }, summary: `${t.id}: ${t.metric}; ${status}; ${t.last_value ?? 'unmeasured'} ${t.unit}, range ${t.min ?? '−∞'} … ${t.max ?? '∞'}.` }];
  });
  const gapCases = library.gap.filter(g => systems.has(g.system) && g.status === 'open' && !g.order).flatMap(g => {
    const matches = goalOrderMatches(project, orders, g.id);
    return matches.length ? [] : [{ key: `goal/${g.id}`, trigger: 'gap-unowned', facts: { ...context(g.system), goal: g.id, gap: g, orderMatches: matches }, summary: `${g.id}: ${g.text}` }];
  });
  return [...targetCases, ...gapCases];
}
export function freeGoalCapacity(project: ProjectConfig, orders: Orders, ram: number | undefined): string[] {
  const min = project.dispatch.min_free_ram_gb;
  if (min !== undefined && (ram === undefined || ram < min)) return [];
  const running = occupants(project, orders), leases = activeLeases(project, orders);
  return Object.entries(project.dispatch.caps).filter(([kind, cap]) => {
    const used = running.filter(o => o.kind === kind).length + orders.all().filter(d => ['running', 'monitoring'].includes(orders.stage(d).stage) && d.order.heavy === kind).length + leases.filter(l => !l.acceptance?.measurement && l.acceptance?.cap === kind).length;
    return used < cap;
  }).map(([kind]) => kind);
}
