import { Document, visit } from 'yaml';
import { ANY, type Roles, type WorkerGroups } from './config.ts';

/**
 * The `routing` that replaces a file's `roles`, routing every order as before:
 * - each role becomes a route with a worker group: its `workers.only` in its preferred order, or its `workers.prefer` followed by
 *   `"*"` (anyone else after them) when the role did not limit its workers; roles with the same list share one group;
 * - a worker that two routes or more avoided, and every route that could reach it, goes to `routing.avoid`, written once;
 * - what a route no longer carries (skills, MCP servers, rules, effort) is listed with where it goes instead.
 * Nothing is written.
 */
export function migrateRoles(roles: Roles): { yaml: string; notes: string[] } {
  const groups: WorkerGroups = {};
  const routes: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  const entries = Object.entries(roles);
  // A worker avoided by two routes or more, and by every route that could reach it, goes to routing.avoid.
  const reach = (r: Roles[string], w: string) => !r.workers?.only?.length || r.workers.only.includes(w);
  const avoided = [...new Set(entries.flatMap(([, r]) => r.workers?.avoid ?? []))];
  const shared = avoided.filter(w => entries.filter(([, r]) => (r.workers?.avoid ?? []).includes(w)).length >= 2 && entries.every(([, r]) => !reach(r, w) || (r.workers?.avoid ?? []).includes(w)));
  for (const [id, r] of entries) {
    const route: Record<string, unknown> = {};
    if (r.description) route.description = r.description;
    if (r.kinds?.length) route.kinds = r.kinds;
    if (r.requires?.length) route.requires = r.requires;
    if (r.default && id !== 'default') route.default = true;
    const prefer = r.workers?.prefer ?? [], only = r.workers?.only, avoid = (r.workers?.avoid ?? []).filter(w => !shared.includes(w));
    let members: string[] | undefined;
    if (only?.length) {
      members = [...prefer.filter(w => only.includes(w)), ...only.filter(w => !prefer.includes(w))];
      const outside = prefer.filter(w => !only.includes(w));
      if (outside.length) notes.push(`route ${id}: workers.prefer named ${outside.join(', ')} outside workers.only; they were never chosen and are left out.`);
    } else if (prefer.length) members = [...prefer, ANY];
    if (r.group) route.group = r.group;
    else if (members) {
      const same = Object.entries(groups).find(([, list]) => list.join('\n') === members!.join('\n'));
      const name = same?.[0] ?? (Object.hasOwn(groups, id) ? `${id}-workers` : id);
      groups[name] = members;
      route.group = name;
    }
    if (avoid.length) route.avoid = avoid;
    const where = r.kinds?.length ? r.kinds.map(k => `skills.by_kind.${k}`).join(', ') : r.default || id === 'default' ? 'skills.always' : 'the orders that need them (--skills)';
    if (r.skills?.length) notes.push(`route ${id}: skills ${r.skills.join(', ')} -> ${where}.`);
    for (const server of Object.keys(r.mcp ?? {})) notes.push(`route ${id}: MCP server ${server} -> a tool plugin with that server (docs/workers/031-tool-plugins.md), enabled under plugins.enable and listed under plugins.by_kind.`);
    if (r.rules) notes.push(`route ${id}: rules ${r.rules} -> a skill with that text, attached with ${where}.`);
    if (r.effort || r.reasoning) notes.push(`route ${id}: effort/reasoning ${[r.effort, r.reasoning].filter(Boolean).join('/')} -> the worker's launch template (a model and its effort).`);
    routes[id] = route;
  }
  const routing: Record<string, unknown> = {};
  if (Object.keys(groups).length) routing.groups = groups;
  if (shared.length) routing.avoid = shared;
  routing.routes = routes;
  // Lists on one line (`[codex, claude-sonnet]`), mappings as blocks.
  const doc = new Document({ routing });
  visit(doc, { Seq(_, node) { node.flow = true; } });
  return { yaml: doc.toString({ flowCollectionPadding: false, lineWidth: 0 }), notes };
}
