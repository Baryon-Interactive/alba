import path from 'node:path';
import { fail } from '../i18n.ts';

export const RANK_BY_VALUES = ['preference', 'acceptance', 'cost-per-accept'] as const;
export type RankBy = (typeof RANK_BY_VALUES)[number];

export interface RoleServer { /** An HTTP (streamable) MCP server instead of a program: the run's editor. */ url?: string; command: string; args: string[]; env_from?: string[]; engines?: string[]; /** Only these of the server's tools are offered (absent: all); set for tool plugin servers. */ tools?: string[] }
export interface RoleDefinition {
  description?: string;
  default?: boolean;
  requires?: string[];
  effort?: string;
  reasoning?: string;
  kinds?: string[];
  skills?: string[];
  mcp?: Record<string, RoleServer>;
  rules?: string;
  workers?: { prefer?: string[]; avoid?: string[]; only?: string[] };
  /** A route's worker group (`routing.routes.<id>.group`): its members, in order, become `workers.prefer` and `workers.only`. */
  group?: string;
  rank_by?: RankBy;
}
export interface RoleConfig extends RoleDefinition { sources: Record<string, string> }
export type Roles = Record<string, RoleConfig>;
/** `routing.groups`: named, ordered lists of workers (ids, aliases, model families or other groups), the layer above the workers. */
export type WorkerGroups = Record<string, string[]>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Keep absent keys absent: project overrides replace only the keys they actually define. */
export function validateRoles(raw: unknown, file: string, prefix = 'roles'): Roles {
  function error(key: string, message: string): never { return fail('{file}: {key}: {message}', { file, key: prefix === 'roles' ? key : key.replace(/^roles/, prefix), message }); }
  if (!record(raw)) error('roles', 'must be a mapping');
  const list = (v: unknown, key: string): string[] => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) error(key, 'must be a list of non-empty strings');
    return [...new Set((v as string[]).map(x => x.trim()))];
  };
  const rejectSecrets = (v: unknown, key: string): void => {
    if (!record(v)) return;
    for (const [k, value] of Object.entries(v)) {
      if (/key|token|secret|password/i.test(k) && value !== undefined && value !== null && value !== '' && !record(value) && !Array.isArray(value)) error(`${key}.${k}`, 'literal secrets are forbidden; use env_from with environment variable names');
      rejectSecrets(value, `${key}.${k}`);
    }
  };
  const out: Roles = {};
  for (const [id, value] of Object.entries(raw)) {
    const at = `roles.${id}`;
    if (!identifier.test(id)) error(at, 'role names must contain letters, digits, underscores or hyphens');
    if (!record(value)) error(at, 'must be a mapping');
    rejectSecrets(value, at);
    const known = ['description', 'kinds', 'skills', 'mcp', 'rules', 'workers', 'default', 'requires', 'effort', 'reasoning', 'rank_by'];
    for (const k of Object.keys(value)) if (!known.includes(k)) error(`${at}.${k}`, 'unknown key');
    const role: RoleConfig = { sources: {} };
    if (value.rank_by !== undefined) {
      if (!(RANK_BY_VALUES as readonly unknown[]).includes(value.rank_by)) error(`${at}.rank_by`, 'must be preference, acceptance or cost-per-accept');
      role.rank_by = value.rank_by as RankBy; role.sources.rank_by = file;
    }
    for (const k of ['description', 'rules', 'effort', 'reasoning'] as const) if (value[k] !== undefined) {
      if (typeof value[k] !== 'string' || !value[k].trim()) error(`${at}.${k}`, 'must be non-empty text');
      role[k] = k === 'rules' ? path.resolve(path.dirname(path.resolve(file)), value[k]) : value[k];
      role.sources[k] = file;
    }
    for (const k of ['kinds', 'skills', 'requires'] as const) if (value[k] !== undefined) { role[k] = list(value[k], `${at}.${k}`); role.sources[k] = file; }
    if (value.default !== undefined) {
      if (typeof value.default !== 'boolean') error(`${at}.default`, 'must be true or false');
      role.default = value.default; role.sources.default = file;
    }
    if (value.workers !== undefined) {
      if (!record(value.workers)) error(`${at}.workers`, 'must be a mapping');
      role.workers = {};
      for (const [k, v] of Object.entries(value.workers)) {
        if (k !== 'prefer' && k !== 'avoid' && k !== 'only') error(`${at}.workers.${k}`, 'unknown key');
        role.workers[k] = list(v, `${at}.workers.${k}`); role.sources[`workers.${k}`] = file;
      }
      role.sources.workers = file;
    }
    if (value.mcp !== undefined) {
      if (!record(value.mcp)) error(`${at}.mcp`, 'must be a mapping');
      role.mcp = {};
      for (const [name, server] of Object.entries(value.mcp)) {
        const key = `${at}.mcp.${name}`;
        if (!identifier.test(name)) error(key, 'server names must contain letters, digits, underscores or hyphens');
        if (!record(server)) error(key, 'must be a mapping');
        for (const k of Object.keys(server)) if (!['command', 'args', 'env_from', 'engines'].includes(k)) error(`${key}.${k}`, 'unknown key; pass secrets using env_from names');
        if (typeof server.command !== 'string' || !server.command.trim()) error(`${key}.command`, 'must be a non-empty command');
        if (!Array.isArray(server.args) || server.args.some(x => typeof x !== 'string')) error(`${key}.args`, 'must be a list of strings');
        const entry: RoleServer = { command: server.command, args: server.args as string[] };
        if (server.env_from !== undefined) {
          entry.env_from = list(server.env_from, `${key}.env_from`);
          if (entry.env_from.some(n => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) error(`${key}.env_from`, 'must contain environment variable names only, never NAME=value');
        }
        if (server.engines !== undefined) entry.engines = list(server.engines, `${key}.engines`);
        role.mcp[name] = entry;
        role.sources[`mcp.${name}`] = file;
      }
      role.sources.mcp = file;
    }
    Object.defineProperty(out, id, { value: role, enumerable: true, writable: true, configurable: true });
  }
  if (Object.entries(out).filter(([id, r]) => id === 'default' || r.default).length > 1) error('roles', 'define exactly one default role');
  return out;
}

/** Keys a route does not take, and where they belong instead: a route says only which workers do a kind of job. */
const MOVED: Record<string, string> = {
  skills: 'a route only routes; attach skills by kind with skills.by_kind, or to one order with --skills',
  mcp: 'MCP servers come from tool plugins: enable the tool under plugins.enable and list it under plugins.by_kind',
  tools: 'list tools by kind under plugins.by_kind',
  rules: 'put the rules in a skill and attach it with skills.by_kind',
  effort: 'set the model and effort in the worker\'s launch template',
  reasoning: 'set the model and effort in the worker\'s launch template',
};

/**
 * `routing` (in alba.yaml or the workers file): worker groups, the routes that send kinds of work to them, and the group of the
 * orders no route takes. Routes become roles with a `group`, so routing, the role statistics and the console treat them alike.
 */
export function validateRouting(raw: unknown, file: string): { roles: Roles; groups: WorkerGroups; avoid: string[] } {
  function error(key: string, message: string): never { return fail('{file}: {key}: {message}', { file, key, message }); }
  if (!record(raw)) error('routing', 'must be a mapping with groups, routes, default and avoid');
  for (const k of Object.keys(raw)) if (!['groups', 'routes', 'default', 'avoid'].includes(k)) error(`routing.${k}`, 'unknown key (groups, routes, default, avoid)');
  const list = (v: unknown, key: string): string[] => {
    if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== 'string' || !x.trim())) error(key, 'must be a non-empty list of worker ids, aliases, model families or group names');
    return [...new Set((v as string[]).map(x => x.trim()))];
  };
  const groups: WorkerGroups = {};
  if (raw.groups !== undefined) {
    if (!record(raw.groups)) error('routing.groups', 'must map a group name to a list of workers');
    for (const [name, members] of Object.entries(raw.groups)) {
      if (!identifier.test(name)) error(`routing.groups.${name}`, 'group names must contain letters, digits, underscores or hyphens');
      groups[name] = list(members, `routing.groups.${name}`);
    }
  }
  const avoidAll = raw.avoid === undefined ? [] : list(raw.avoid, 'routing.avoid');
  if (avoidAll.includes(ANY)) error('routing.avoid', 'lists workers, not "*"');
  const routes = raw.routes === undefined ? {} : raw.routes;
  if (!record(routes)) error('routing.routes', 'must be a mapping of route names');
  const shaped: Record<string, unknown> = {};
  const routeGroups: Record<string, string> = {};
  for (const [id, value] of Object.entries(routes)) {
    const at = `routing.routes.${id}`;
    if (!record(value)) error(at, 'must be a mapping');
    for (const k of Object.keys(value)) {
      if (Object.hasOwn(MOVED, k)) error(`${at}.${k}`, MOVED[k]);
      if (!['description', 'kinds', 'requires', 'group', 'avoid', 'workers', 'default', 'rank_by'].includes(k)) error(`${at}.${k}`, 'unknown key (description, kinds, requires, group, avoid, workers, default, rank_by)');
    }
    if (value.rank_by !== undefined && !(RANK_BY_VALUES as readonly unknown[]).includes(value.rank_by)) {
      error(`${at}.rank_by`, 'must be preference, acceptance or cost-per-accept');
    }
    const workers = value.workers === undefined ? undefined : value.workers;
    if (workers !== undefined && !record(workers)) error(`${at}.workers`, 'must be a mapping');
    if (value.group !== undefined) {
      if (typeof value.group !== 'string' || !identifier.test(value.group)) error(`${at}.group`, 'must be the name of a worker group');
      if (workers && (workers.prefer !== undefined || workers.only !== undefined)) error(`${at}.workers`, 'a group already orders and limits the workers; use either group or workers.prefer/only');
      routeGroups[id] = value.group;
    }
    const avoid = value.avoid === undefined ? [] : list(value.avoid, `${at}.avoid`);
    if (avoid.includes(ANY)) error(`${at}.avoid`, 'lists workers, not "*"');
    const merged = workers || avoid.length ? { ...workers, ...(avoid.length ? { avoid: [...new Set([...((workers?.avoid as string[] | undefined) ?? []), ...avoid])] } : {}) } : undefined;
    const { group: _group, avoid: _avoid, ...rest } = value;
    shaped[id] = { ...rest, ...(merged ? { workers: merged } : {}) };
  }
  const roles = validateRoles(shaped, file, 'routing.routes');
  for (const [id, group] of Object.entries(routeGroups)) { roles[id].group = group; roles[id].sources.group = file; }
  if (raw.default !== undefined) {
    if (typeof raw.default !== 'string' || !identifier.test(raw.default)) error('routing.default', 'must be the name of a worker group');
    const already = Object.entries(roles).find(([id, r]) => id === 'default' || r.default);
    if (already) error('routing.default', `route ${already[0]} is already the default; keep one of the two`);
    Object.defineProperty(roles, 'default', { value: { default: true, group: raw.default, sources: { default: file, group: file } }, enumerable: true, writable: true, configurable: true });
  }
  return { roles, groups, avoid: avoidAll };
}

/** In a group, `"*"` stands for every other worker the route does not avoid, after the ones listed. */
export const ANY = '*';

/** The workers of a group in order, with the groups it names expanded in place; `"*"`, if any, comes last. */
export function groupMembers(groups: WorkerGroups, name: string, where: string, seen: string[] = []): string[] {
  if (!Object.hasOwn(groups, name)) fail('{where}: there is no worker group "{group}" under routing.groups.', { where, group: name });
  if (seen.includes(name)) fail('{where}: worker group "{group}" contains itself ({path}).', { where, group: name, path: [...seen, name].join(' -> ') });
  const all = [...new Set(groups[name].flatMap(m => (Object.hasOwn(groups, m) ? groupMembers(groups, m, where, [...seen, name]) : [m])))];
  return all.includes(ANY) ? [...all.filter(m => m !== ANY), ANY] : all;
}

type WorkerNames = { id: string; aliases?: string[]; model_family?: string };

/**
 * Stable shared-file order, followed by project-only roles; matching kinds use this order. A route with a `group` is resolved here:
 * the group's workers, in order, become its preference and the only workers it may use, unless the group ends in `"*"` (anyone
 * else after them). `routing.groups` of the project file replace the workers file's of the same name. `routing.avoid` of either file
 * is added to every route's avoid list. With the workers given, a group member that names no worker is an error.
 */
export function effectiveRoles(project: { roles?: Roles; worker_groups?: WorkerGroups; routing_avoid?: string[] }, workers?: { roles?: Roles; worker_groups?: WorkerGroups; routing_avoid?: string[]; workers?: readonly WorkerNames[] }): Roles {
  const out: Roles = { ...workers?.roles };
  for (const [id, role] of Object.entries(project.roles ?? {})) {
    const shared = out[id];
    // A project route's group replaces the shared role's worker list, and the project's own worker list replaces a shared group.
    const base = shared && role.group !== undefined ? { ...shared, workers: shared.workers?.avoid ? { avoid: shared.workers.avoid } : undefined }
      : shared && (role.workers?.prefer || role.workers?.only) ? { ...shared, group: undefined } : shared;
    out[id] = { ...base, ...role, ...(base?.mcp || role.mcp ? { mcp: { ...base?.mcp, ...role.mcp } } : {}), ...(base?.workers || role.workers ? { workers: { ...base?.workers, ...role.workers } } : {}), sources: { ...base?.sources, ...role.sources } };
    if (out[id].group === undefined) delete out[id].group;
  }
  if (Object.entries(out).filter(([id, r]) => id === 'default' || r.default).length > 1) fail('Define exactly one default role after project overrides.');
  const groups: WorkerGroups = { ...workers?.worker_groups, ...project.worker_groups };
  const known = workers?.workers;
  const names = (w: WorkerNames) => [w.id, ...(w.aliases ?? []), ...(w.model_family ? [w.model_family] : [])].map(n => n.toLowerCase());
  const avoidAll = [...new Set([...(workers?.routing_avoid ?? []), ...(project.routing_avoid ?? [])])];
  if (known?.length) for (const m of avoidAll) if (!known.some(w => names(w).includes(m.toLowerCase()))) fail('routing.avoid: "{name}" is not a worker id, alias or model family.', { name: m });
  for (const [id, role] of Object.entries(out)) {
    let next = role;
    if (role.group !== undefined) {
      const members = groupMembers(groups, role.group, `route ${id}`);
      const listed = members.filter(m => m !== ANY);
      if (known?.length) for (const m of listed) if (!known.some(w => names(w).includes(m.toLowerCase()))) fail('worker group "{group}" (route {route}): "{name}" is not a worker id, alias or model family.', { group: role.group, route: id, name: m });
      const { only: _only, ...rest } = role.workers ?? {};
      next = { ...role, workers: { ...rest, prefer: listed, ...(members.includes(ANY) ? {} : { only: listed }) } };
    }
    if (avoidAll.length) next = { ...next, workers: { ...next.workers, avoid: [...new Set([...(next.workers?.avoid ?? []), ...avoidAll])] } };
    out[id] = next;
  }
  // With nothing but a shared avoid list, every order still goes to any worker except those.
  if (avoidAll.length && !Object.keys(out).length) out.default = { default: true, workers: { avoid: avoidAll }, sources: {} };
  return out;
}

export interface ResolvedRole { id?: string; source: 'explicit' | 'kind' | 'default' | 'none'; definition?: RoleConfig }
export function resolveRole(roles: Roles, order: { role?: string; kind: string }): ResolvedRole {
  if (order.role) {
    const definition = Object.hasOwn(roles, order.role) ? roles[order.role] : undefined;
    if (!definition) fail('Unknown role "{role}" on order; define it in roles in the project or workers file.', { role: order.role });
    return { id: order.role, source: 'explicit', definition };
  }
  for (const [id, definition] of Object.entries(roles)) if (definition.kinds?.includes(order.kind)) return { id, source: 'kind', definition };
  for (const [id, definition] of Object.entries(roles)) if (id === 'default' || definition.default) return { id, source: 'default', definition };
  // A setup with no roles at all (a new project, one worker): every order is for any worker, as if `roles: { default: {} }` were written.
  if (!Object.keys(roles).length) return { id: 'default', source: 'default', definition: { sources: {} } };
  return { source: 'none' };
}
