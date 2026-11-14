import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import type * as A from '../api/types.ts';
import { readStateJson, writeStateFile } from '../orders/state-files.ts';
import { planClean, applyClean, type CleanEnv } from './clean.ts';

const STATE = '_clean-round.json';
const EVERY_MINUTES = 30;

/** The classes a project lets go without a click: auto_classes, and worktrees/packages only with auto_destructive. */
export function autoCleanClasses(project: ProjectConfig): string[] {
  const c = project.clean;
  return (c?.auto_classes ?? []).filter(k => !['worktrees', 'packages'].includes(k) || c?.auto_destructive === true);
}

/**
 * Cleanup for a project whose producer round does not run (producer or round turned off): its allowed classes are
 * applied on their own every 30 minutes. A project with a producer round cleans there instead (src/producer/round.ts),
 * and a paused producer stops this too. Returns the applied plan, or undefined when nothing was due or allowed.
 */
export function scheduledClean(project: ProjectConfig, orders: Orders, env: CleanEnv, paused = false): A.CleanPlan | undefined {
  if (project.producer.enabled && project.producer.round?.enabled) return;
  if (paused) return;
  const classes = autoCleanClasses(project);
  if (!classes.length) return;
  const now = env.probes.now();
  const last = readStateJson<{ at: string } | undefined>(project, STATE, undefined);
  if (last && now.getTime() - Date.parse(last.at) < EVERY_MINUTES * 60000) return;
  writeStateFile(project, STATE, JSON.stringify({ at: now.toISOString() }));
  const plan = planClean(project, orders, env);
  plan.items = plan.items.filter(i => ['remove', 'prune', 'delete'].includes(i.action) && classes.includes(i.pathClass ?? ''));
  if (!plan.items.length) return;
  return applyClean(project, orders, plan, env);
}
