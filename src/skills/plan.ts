import type { OrderSkill } from '../api/types.ts';
import { orderPhases } from '../orders/phases.ts';
import { effectiveRoles, resolveRole } from '../roles/config.ts';
import type { ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import { routingOf } from '../routing/classify.ts';
import type { WorkerConfig, WorkersFile } from '../workers/config.ts';
import { orderTools, toolSkills } from '../plugins/tools.ts';
import { editorPoolsOf } from '../editors/pool.ts';
import { DEFAULT_MOUNTS, mountsFor } from './mount.ts';
import { orderSkills, readRegistry, selectSkills, type Registry, type Selection } from './registry.ts';

export interface SkillPlan { registry: Registry; selection: Selection; mounts: string[]; listed: OrderSkill[] }

/** The skills an order gets for a worker (or the default folder when no worker is known yet), without touching any worktree. */
export function planSkills(project: ProjectConfig, workers: WorkersFile | undefined, doc: OrderDoc, worker?: WorkerConfig): SkillPlan {
  const registry = readRegistry(workers?.skills, project);
  const routing = routingOf(project, doc);
  const role = resolveRole(effectiveRoles(project, workers), { role: orderPhases(project, doc)?.current.role ?? doc.order.role, kind: routing.kind || doc.order.kind });
  // A tool's skill comes with the tool: it joins the registry for this order only, and is selected because the order uses the tool.
  // A registry skill of the same name stays (the project's copy wins) and is selected for the tool.
  const fromTools = toolSkills(orderTools(project, doc, routing.kind || doc.order.kind).tools);
  registry.skills.push(...fromTools.filter(x => !registry.skills.some(s => s.name === x.skill.name)).map(x => x.skill));
  // An editor pool's skills come with the editor (`editors.<pool>.skills`).
  const fromEditors = editorPoolsOf(project, doc).flatMap(p => p.skills.map(name => ({ name, tool: `editor ${p.name}` })));
  const selection = selectSkills(project, registry, doc, routing, role.definition?.skills, [...fromTools.map(x => ({ name: x.skill.name, tool: x.tool })), ...fromEditors]);
  const mounts = worker ? mountsFor(worker) : DEFAULT_MOUNTS;
  return { registry, selection, mounts, listed: orderSkills(selection, mounts[0]) };
}

/** The values the launch environment placeholders `{skill_names}` and `{skill_allow}` stand for. */
export function skillEnvValues(selection: Selection): Record<string, string> {
  const names = selection.selected.map(s => s.skill.name);
  return { skill_names: names.join(','), skill_allow: names.map(n => `${JSON.stringify(n)}:"allow"`).join(',') };
}
