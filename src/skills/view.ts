import type { OrderSkills, SkillLayer, SkillsView } from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import type { WorkersFile } from '../workers/config.ts';
import { mountsFor } from './mount.ts';
import { planSkills } from './plan.ts';
import { readRegistry } from './registry.ts';

const OPEN_STAGES_EXCLUDED = new Set(['merged', 'cancelled']);

/** The registry as the interface shows it, with what attaches each skill and who uses it. */
export function skillsView(project: ProjectConfig, workers: WorkersFile | undefined, orders: Orders): SkillsView {
  const registry = readRegistry(workers?.skills, project);
  const docs = orders.all();
  const merged = orders.mergedSet(docs);
  const open = docs.filter(d => !OPEN_STAGES_EXCLUDED.has(orders.stage(d, merged).stage));
  const layers = new Map<string, Set<SkillLayer>>();
  const usedOrders = new Map<string, string[]>();
  const usedWorkers = new Map<string, Set<string>>();
  const problems = [...registry.problems];
  for (const doc of open) {
    const plan = planSkills(project, workers, doc);
    for (const s of plan.selection.selected) {
      (layers.get(s.skill.name) ?? layers.set(s.skill.name, new Set()).get(s.skill.name)!).add(s.layer);
      if (s.layer !== 'core') (usedOrders.get(s.skill.name) ?? usedOrders.set(s.skill.name, []).get(s.skill.name)!).push(doc.order.tag);
    }
    for (const p of plan.selection.problems) if (!problems.includes(p)) problems.push(p);
  }
  for (const doc of docs) for (const run of doc.runs) for (const name of run.skills ?? []) (usedWorkers.get(name) ?? usedWorkers.set(name, new Set()).get(name)!).add(run.worker);
  const always = project.skills?.always ?? [];
  const byKind = project.skills?.by_kind ?? {};
  const named = new Set([...always, ...Object.values(byKind).flat()]);
  return {
    project: project.id,
    sources: registry.sources,
    skills: registry.skills.map(({ skillFile: _f, core, inapplicable, ...s }) => ({
      ...s,
      layers: [...new Set<SkillLayer>([...(core ? ['core' as const] : []), ...(named.has(s.name) ? ['project' as const] : []), ...(layers.get(s.name) ?? [])])],
      usedBy: { orders: usedOrders.get(s.name) ?? [], workers: [...(usedWorkers.get(s.name) ?? [])] },
      ...(inapplicable ? { inapplicable } : {}),
      included: (project.skills?.include ?? []).some(x => x.toLowerCase() === s.name.toLowerCase()), excluded: (project.skills?.exclude ?? []).some(x => x.toLowerCase() === s.name.toLowerCase()),
    })),
    ...(project.skills?.engine ? { engine: project.skills.engine } : {}), always, byKind, include: project.skills?.include ?? [], exclude: project.skills?.exclude ?? [],
    mounts: (workers?.workers ?? []).filter(w => !w.card_only).map(w => ({ worker: w.id, engine: w.engine, mounts: mountsFor(w) })),
    problems,
  };
}

/** What one order gets at its next run, and what workers suggested to change in shared skills. */
export function orderSkillsView(project: ProjectConfig, workers: WorkersFile | undefined, doc: OrderDoc): OrderSkills {
  const plan = planSkills(project, workers, doc);
  const suggestions = doc.reports.flatMap(r => (r.skill_suggestions ?? []).map(s => ({ ...s, ...(r.run ? { run: r.run } : {}), at: r.at })));
  // the folders depend on the engine: the worker of its latest run, else every worker that could take it
  const lastWorker = workers?.workers.find(w => w.id === doc.runs[doc.runs.length - 1]?.worker);
  const mountedAt = lastWorker ? mountsFor(lastWorker) : [...new Set((workers?.workers ?? []).filter(w => !w.card_only).flatMap(w => mountsFor(w)))];
  return { project: project.id, tag: doc.order.tag, skills: plan.listed, mountedAt: mountedAt.length ? mountedAt : plan.mounts, suggestions };
}
