import type { ProjectConfig } from '../config.ts';
import { readStateJson, updateStateJson, stateTransaction } from '../orders/state-files.ts';

interface DraftBudget { day: string; keys: string[] }
const file = '_producer-drafting-budget.json';
export function draftBudgetRemaining(project: ProjectConfig, now = new Date()): number {
  const budget = readStateJson<DraftBudget>(project, file, { day: '', keys: [] });
  return Math.max(0, (project.producer.budgets.draft_runs_per_day ?? Infinity) - (budget.day === now.toISOString().slice(0, 10) ? budget.keys.length : 0));
}
export function recordDraftTurns(project: ProjectConfig, keys: string[], now = new Date()): void {
  const day = now.toISOString().slice(0, 10);
  updateStateJson<DraftBudget>(project, file, { day, keys: [] }, old => ({ day, keys: [...new Set([...(old.day === day ? old.keys : []), ...keys])] }));
}
export function reserveDraftAllowance(project: ProjectConfig, key: string, now = new Date()): void {
  stateTransaction(project, () => {
    const old = readStateJson<DraftBudget>(project, file, { day: '', keys: [] });
    if (old.day === now.toISOString().slice(0, 10) && old.keys.includes(key)) return;
    if (draftBudgetRemaining(project, now) < 1) throw new Error('Daily draft allowance is exhausted.');
    recordDraftTurns(project, [key], now);
  });
}
