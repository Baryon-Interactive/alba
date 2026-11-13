import path from 'node:path';
import { fail } from '../i18n.ts';

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
}
export interface RoleConfig extends RoleDefinition { sources: Record<string, string> }
export type Roles = Record<string, RoleConfig>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Keep absent keys absent: project overrides replace only the keys they actually define. */
export function validateRoles(raw: unknown, file: string): Roles {
  function error(key: string, message: string): never { return fail('{file}: {key}: {message}', { file, key, message }); }
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
    const known = ['description', 'kinds', 'skills', 'mcp', 'rules', 'workers', 'default', 'requires', 'effort', 'reasoning'];
    for (const k of Object.keys(value)) if (!known.includes(k)) error(`${at}.${k}`, 'unknown key');
    const role: RoleConfig = { sources: {} };
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

/** Stable shared-file order, followed by project-only roles; matching kinds use this order. */
export function effectiveRoles(project: { roles?: Roles }, workers?: { roles?: Roles }): Roles {
  const out: Roles = { ...workers?.roles };
  for (const [id, role] of Object.entries(project.roles ?? {})) {
    const shared = out[id];
    out[id] = { ...shared, ...role, ...(shared?.mcp || role.mcp ? { mcp: { ...shared?.mcp, ...role.mcp } } : {}), ...(shared?.workers || role.workers ? { workers: { ...shared?.workers, ...role.workers } } : {}), sources: { ...shared?.sources, ...role.sources } };
  }
  if (Object.entries(out).filter(([id, r]) => id === 'default' || r.default).length > 1) fail('Define exactly one default role after project overrides.');
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
