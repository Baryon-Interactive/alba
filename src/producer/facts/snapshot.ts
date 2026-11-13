import { effectiveRoles } from '../../roles/config.ts';
import { rolesView } from '../../roles/view.ts';
import type { WorkersFile } from '../../workers/config.ts';
import type { WorkerState } from '../../tick/plan.ts';
import type { ProjectConfig } from '../../config.ts';
import { stateStore } from '../../orders/backend.ts';
import { Orders } from '../../orders/service.ts';
import { usageRows } from '../../usage/store.ts';
import { computeFacts, type FactsSnapshot } from './engine.ts';

export const FACTS_META = 'producer-facts';
export function readFacts(project: ProjectConfig): FactsSnapshot | undefined {
  return stateStore(project).readMeta(FACTS_META) as FactsSnapshot | undefined;
}
/** Called only by real ticks in the coordinator worker (or the standalone tick process). */
export function refreshFacts(project: ProjectConfig, now: Date, workers?: WorkersFile, states?: readonly WorkerState[]): void {
  const store = stateStore(project), previous = readFacts(project);
  if (previous && now.getTime() - Date.parse(previous.at) < 300_000) return;
  const snapshot = computeFacts({ orders: new Orders(store).all(), events: store.events(), usage: usageRows(project), caps: project.dispatch.caps, now: now.toISOString(), constraints: project.producer.constraints, budget: project.budget, previous, roleDefinitions: effectiveRoles(project, workers), roleAvailability: rolesView(project, workers, [], [], states).roles });
  store.writeMeta(FACTS_META, snapshot);
}
