import type { Route, Routing } from '../api/types.ts';
import { effectiveRoles, resolveRole } from '../roles/config.ts';
import type { WorkersFile } from '../workers/config.ts';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { Order, OrderDoc, StoredRouting } from '../orders/model.ts';
import type { WorkerState } from '../tick/plan.ts';
import { chooseWorker, rolePolicy } from './choose.ts';
import { routingOf } from './classify.ts';
import { isGenericKind } from './kinds.ts';

/** The kind shown on the order and used to resolve its role: explicit, then classified. */
export const effectiveKind = (order: Pick<Order, 'kind' | 'routing'>): string => (isGenericKind(order.kind) ? order.routing?.kind || order.kind : order.kind);

/** The stored routing as the interface shows it (without the fingerprint). */
export const toRouting = (r: StoredRouting): Routing => ({ kind: r.kind, tags: r.tags, source: r.source, why: r.why, at: r.at });

/** Use the dispatch role everywhere, including reroute validation and manual starts. */
export function roleForOrder(project: ProjectConfig, doc: OrderDoc, file?: WorkersFile) {
  return resolveRole(effectiveRoles(project, file), { ...doc.order, kind: effectiveKind({ ...doc.order, routing: routingOf(project, doc) }) });
}

/** A removed/disabled worker or changed role must not leave an order pinned forever. */
export function workerPinProblem(project: ProjectConfig, doc: OrderDoc, file: WorkersFile): string | undefined {
  const pin = doc.order.next_worker;
  if (!pin) return;
  const worker = file.workers.find(w => w.id === pin);
  if (!worker) return t('Worker pin {worker} dropped: unknown worker.', { worker: pin });
  if (!worker.enabled) return t('Worker pin {worker} dropped: disabled worker.', { worker: pin });
  const role = roleForOrder(project, doc, file);
  if (!role.definition) return t('Worker pin {worker} dropped: order has no role.', { worker: pin });
  const missing = (role.definition.requires ?? []).filter(c => !worker.capabilities.includes(c));
  if (missing.length) return t('Worker pin {worker} dropped: role {role} requires missing capabilities: {missing}.', { worker: pin, role: role.id!, missing: missing.join(', ') });
}

/** The choice of worker for one order as of now. Nothing is started and nothing is stored. */
export function routeFor(project: ProjectConfig, doc: OrderDoc, workers: readonly WorkerState[], at: string = new Date().toISOString(), file?: WorkersFile): Route {
  const routing = routingOf(project, doc, at);
  const kind = isGenericKind(doc.order.kind) ? routing.kind : doc.order.kind;
  const role = resolveRole(effectiveRoles(project, file), { ...doc.order, kind: kind || doc.order.kind });
  const choice = chooseWorker({ kind, tags: routing.tags, workerText: doc.order.worker, pinnedWorker: doc.order.next_worker, role: rolePolicy(role) }, workers);
  return {
    project: project.id, tag: doc.order.tag, routing: toRouting({ ...routing, kind: kind || routing.kind }),
    ...(choice.named ? { named: choice.named } : {}), outcome: choice.outcome, ...(choice.chosen ? { chosen: choice.chosen } : {}), ...(choice.ideal ? { ideal: choice.ideal } : {}),
    why: `role ${role.id ?? 'none'} (${role.source}); ${choice.why}`, candidates: choice.candidates,
    role,
  };
}

/** `alba route`'s text for one order. */
export function formatRoute(route: Route, stage?: string): string {
  const r = route.routing;
  const what = r.kind ? `${r.kind}${r.tags.length ? ` +${r.tags.join(' +')}` : ''}` : t('unclassified');
  const head = `${route.tag}${stage ? `  [${stage}]` : ''}  ${what} (${r.source}: ${r.why})`;
  const verdictWord: Record<string, string> = { chosen: t('chosen'), 'passed-over': t('passed over'), unavailable: t('cannot start now'), unfit: t('does not take it') };
  const outcome = route.outcome === 'chosen' ? `→ ${route.chosen}` : route.outcome === 'nobody-fits' ? `→ ${t('nobody takes it')}` : `→ ${t('waits for {w}', { w: route.ideal ?? '-' })}`;
  const lines = route.candidates.map(c => `    ${c.worker} [${verdictWord[c.verdict]}]: ${c.reason}`);
  const role = route.role;
  const d = role?.definition;
  // A route with a worker group shows the group in its order; an earlier-style role also shows its skills, MCP servers and rules.
  const roleLines = !role ? [] : d?.group ? [`    route: ${role.id ?? 'none'} (${role.source})`, `    group ${d.group}: ${(d.workers?.prefer ?? []).join(' > ')}`, `    requires: ${(d.requires ?? []).join(', ') || '-'}; avoid: ${(d.workers?.avoid ?? []).join(', ') || '-'}`]
    : [`    role: ${role.id ?? 'none'} (${role.source})`, ...(d ? [`    skills: ${(d.skills ?? []).join(', ') || '-'}`, `    MCP: ${Object.keys(d.mcp ?? {}).join(', ') || '-'}`, `    rules: ${d.rules ?? '-'}`, `    requires: ${(d.requires ?? []).join(', ') || '-'}`, `    prefer: ${(d.workers?.prefer ?? []).join(', ') || '-'}; avoid: ${(d.workers?.avoid ?? []).join(', ') || '-'}`] : [])];
  return [`${head}  ${outcome}${route.named ? `  (${t('worker text names it by {how}', { how: route.named })})` : ''}`, ...roleLines, ...lines].join('\n');
}
