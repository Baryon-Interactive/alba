import { rolesView } from '../roles/view.ts';
import { hasLegacyRoles, migrateRoles } from '../roles/migrate.ts';
import { fail } from '../i18n.ts';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { classifyOrders } from '../routing/classify.ts';
import { formatRoute, routeFor, toRouting } from '../routing/route.ts';
import { skillsView, orderSkillsView } from '../skills/view.ts';
import { systemProbes, tick } from '../tick/gather.ts';
import type { WorkersFile } from '../workers/config.ts';

export interface RoutingValues { json?: boolean; all?: boolean; model?: boolean; order?: string; applicable?: boolean }

/** Orders `alba route` looks at when none are named: the ones that are ready or wait for a need. `--all`: every open order. */
function wanted(orders: Orders, tags: string[], all: boolean | undefined): string[] {
  if (tags.length) return tags.map(tag => orders.get(tag).order.tag);
  const docs = orders.all();
  const merged = orders.mergedSet(docs);
  const stages = all ? ['queued', 'waiting-needs', 'idle', 'draft', 'held', 'running', 'awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped'] : ['queued', 'waiting-needs'];
  return docs.filter(d => stages.includes(orders.stage(d, merged).stage)).map(d => d.order.tag);
}

/** `alba route`, `alba classify` and `alba skills`. Returns undefined for any other command. */
export async function runRouting(group: string, rest: string[], values: RoutingValues, cfg: ProjectConfig, orders: Orders, workers: () => WorkersFile): Promise<string | undefined> {
  if (group === 'roles') {
    let file: WorkersFile | undefined;
    try { file = workers(); } catch { file = undefined; }
    const view = rolesView(cfg, file, orders.all(), [], file ? tick(cfg, orders, file, systemProbes, { record: false }).workers : []);
    if (rest[0] === 'show' && rest.length === 2) {
      const role = view.roles.find(r => r.id === rest[1]);
      if (!role) fail('Unknown role "{id}".', { id: rest[1] });
      return JSON.stringify(role, null, 2);
    }
    if ((rest[0] === 'list' && rest.length === 1) || !rest.length) return JSON.stringify(view, null, 2);
    return fail('Usage: alba roles list | alba roles show <ID>');
  }
  if (group === 'routing') {
    // alba routing [list] [--json]: worker groups and routes; alba routing migrate: the routing that replaces the roles of each file
    let file: WorkersFile | undefined;
    try { file = workers(); } catch { file = undefined; }
    if (rest[0] === 'migrate' && rest.length === 1) {
      const out: string[] = [];
      for (const [label, roles, current] of [[cfg.file, cfg.roles, cfg.uses_routing], [file?.file, file?.roles, file?.uses_routing]] as const) {
        if (!label || !hasLegacyRoles(roles)) continue;
        if (current) { out.push(t('{file}: already uses routing.', { file: label })); continue; }
        const m = migrateRoles(roles);
        out.push(t('# {file}: replace "roles:" with', { file: label }), m.yaml.trimEnd(), ...(m.notes.length ? ['', t('# Moved out of the routes:'), ...m.notes.map(n => `#   ${n}`)] : []), '');
      }
      return out.length ? out.join('\n') : t('Nothing to migrate: no roles in the project or workers file.');
    }
    if (rest.length && !(rest[0] === 'list' && rest.length === 1)) return fail('Usage: alba routing [list] [--json] | alba routing migrate');
    const view = rolesView(cfg, file, orders.all(), [], file ? tick(cfg, orders, file, systemProbes, { record: false }).workers : []);
    if (values.json) return JSON.stringify(view, null, 2);
    const lines = [t('Worker groups'), ...(view.groups.length ? view.groups.map(g => `  ${g.name}: ${g.members.map(m => (m === '*' ? t('anyone else') : m)).join(' > ')}${g.routes.length ? `  (${t('routes')}: ${g.routes.join(', ')})` : ''}`) : [`  ${t('none')}`]), '', t('Routes')];
    for (const r of view.roles) {
      const who = r.group ? `${t('group')} ${r.group}` : r.workers?.prefer?.length ? `${t('prefer')} ${r.workers.prefer.join(' > ')}` : t('any worker');
      lines.push(`  ${r.id}${r.default || r.id === 'default' ? ` (${t('default')})` : ''}: ${r.kinds?.length ? r.kinds.join(', ') : r.default || r.id === 'default' ? t('everything no other route takes') : '-'} -> ${who}${r.workers?.avoid?.length ? `; ${t('avoid')} ${r.workers.avoid.join(', ')}` : ''}${r.requires?.length ? `; ${t('requires')} ${r.requires.join(', ')}` : ''}  [${t('now')}: ${r.qualifying.join(', ') || t('nobody')}]`);
    }
    return lines.join('\n');
  }
  if (group === 'route') {
    // alba route [TAG...] [--all] [--json]: who would take each order and why; nothing is started or stored
    const file = workers();
    const world = tick(cfg, orders, file, systemProbes, { record: false });
    const merged = orders.mergedSet();
    const routes = wanted(orders, rest, values.all).map(tag => { const doc = orders.get(tag); return { stage: orders.stage(doc, merged).stage, route: routeFor(cfg, doc, world.workers, undefined, file) }; });
    if (values.json) return JSON.stringify(routes.map(r => r.route), null, 2);
    if (!routes.length) return t('No orders to route.');
    const counts = { chosen: 0, 'nobody-fits': 0, 'none-available': 0 };
    for (const r of routes) counts[r.route.outcome]++;
    return [...routes.map(r => formatRoute(r.route, r.stage)), '', t('{n} order(s): {chosen} would start now, {fit} nobody takes, {wait} wait for a worker.', { n: routes.length, chosen: counts.chosen, fit: counts['nobody-fits'], wait: counts['none-available'] })].join('\n');
  }
  if (group === 'classify') {
    // alba classify [TAG...] [--all] [--model] [--json]: store each order's kind and tags (rules; with --model also ask the classifier worker)
    const file = values.model ? workers() : undefined;
    const tags = wanted(orders, rest, values.all ?? rest.length === 0);
    const out = await classifyOrders({ project: cfg, orders, workers: file ?? { workers: [], quota_sources: {}, file: '' }, probes: systemProbes }, { tags, model: values.model === true });
    if (values.json) return JSON.stringify(out.map(o => ({ tag: o.tag, routing: toRouting(o.routing), ...(o.asked ? { asked: true } : {}), ...(o.problem ? { problem: o.problem } : {}) })), null, 2);
    return out.map(o => `${o.tag}  ${o.routing.kind || t('unclassified')}${o.routing.tags.length ? ` +${o.routing.tags.join(' +')}` : ''}  (${o.routing.source}: ${o.routing.why})${o.problem ? `  [${o.problem}]` : ''}`).join('\n') || t('No orders to classify.');
  }
  if (group === 'skills') {
    // alba skills [--order TAG] [--json]: the registry, and what an order gets
    let file: WorkersFile | undefined;
    try { file = workers(); } catch { file = undefined; }
    if (values.order) {
      const view = orderSkillsView(cfg, file, orders.get(values.order));
      if (values.json) return JSON.stringify(view, null, 2);
      return [t('{tag} gets {n} skill(s), put into {where} of its worktree:', { tag: view.tag, n: view.skills.length, where: view.mountedAt.join(', ') }), ...view.skills.map(s => `  ${s.name}  [${s.layer}: ${s.why}]`), ...view.suggestions.map(s => `  ${t('suggested by a worker')}: ${s.path}: ${s.reason}`)].join('\n');
    }
    const view = skillsView(cfg, file, orders);
    if (values.json) return JSON.stringify(view, null, 2);
    const usable = view.skills.filter(s => s.applicable), other = view.skills.filter(s => !s.applicable);
    const out = [t('Sources:'), ...view.sources.map(s => `  ${s.id}  [${s.scope}]  ${s.dir}  ${s.exists ? t('{n} skill(s)', { n: s.count }) : t('missing')}`)];
    out.push('', view.engine ? t('Skills this project can use (engine {engine}):', { engine: view.engine }) : t('Skills this project can use:'), ...usable.map(s => `  ${s.name}  [${s.source}${s.engines.length ? ` ${s.engines.join('/')}` : ''}]  ${s.tags.length ? s.tags.join(',') : '-'}  ${s.layers.join('+') || '-'}${s.usedBy.orders.length ? `  ${t('used by')} ${s.usedBy.orders.join(',')}` : ''}${s.included ? `  ${t('(included by the project)')}` : ''}`));
    if (other.length && !values.applicable) out.push('', t('Not applicable to this project:'), ...other.map(s => `  ${s.name}  [${s.source}${s.engines.length ? ` ${s.engines.join('/')}` : ''}]  ${s.inapplicable ?? '-'}`));
    if (view.mounts.length) out.push('', t('Put into the worktree at:'), ...view.mounts.map(m => `  ${m.worker} (${m.engine}): ${m.mounts.join(', ')}`));
    if (view.problems.length) out.push('', t('Problems:'), ...view.problems.map(p => `  ${p}`));
    return out.join('\n');
  }
  return undefined;
}
