import type { ConfigEdit } from './api.ts';

/** `"*"` as the last member of a worker group: anyone else after the listed workers. */
export const ANYONE = '*';

/** The fields of a route the console edits; other keys of the route (`workers`) are kept as they are. */
export interface RouteDraft { description?: string; kinds?: string[]; requires?: string[]; group?: string; avoid?: string[]; default?: boolean; [key: string]: unknown }
/** The `routing` section of one file, as written there. */
export interface RoutingDraft { groups: Record<string, string[]>; routes: Record<string, RouteDraft>; default?: string; avoid?: string[] }

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The routing of a file from `GET /api/config` (`values.routing`); a file without one gives an empty routing. */
export function routingOf(values: Record<string, unknown> | undefined): RoutingDraft {
  const raw = record(values?.routing) ? values.routing : {};
  const groups: Record<string, string[]> = {};
  if (record(raw.groups)) for (const [name, list] of Object.entries(raw.groups)) groups[name] = strings(list);
  const routes: Record<string, RouteDraft> = {};
  if (record(raw.routes)) for (const [id, route] of Object.entries(raw.routes)) routes[id] = record(route) ? { ...route } as RouteDraft : {};
  return { groups, routes, ...(typeof raw.default === 'string' ? { default: raw.default } : {}), ...(Array.isArray(raw.avoid) ? { avoid: strings(raw.avoid) } : {}) };
}

/** Does the file still route with legacy `roles` (a mapping with at least one role) and no `routing` yet? */
export const hasLegacyRoles = (values: Record<string, unknown> | undefined) => record(values?.roles) && Object.keys(values.roles).length > 0 && values.routing === undefined;

/** A route as it is written back: empty lists, an empty description and a false default are left out. */
export function cleanRoute(route: RouteDraft): RouteDraft {
  const out: RouteDraft = {};
  for (const [k, v] of Object.entries(route)) {
    if (v === undefined || v === '' || v === false) continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

/**
 * The edits that turn one file's routing into another, each as small as it can be: a changed group or route is written as a whole
 * (the server keeps the comments of what did not change), a removed one is removed. A rename is a removal and an addition, so it
 * goes in the same request as the routes that now name the new group.
 */
export function routingEdits(before: RoutingDraft, after: RoutingDraft): ConfigEdit[] {
  const edits: ConfigEdit[] = [];
  const section = <T,>(key: 'groups' | 'routes', a: Record<string, T>, b: Record<string, T>, clean: (v: T) => unknown) => {
    for (const name of Object.keys(a)) if (!Object.hasOwn(b, name)) edits.push({ path: ['routing', key, name] });
    for (const [name, v] of Object.entries(b)) if (!Object.hasOwn(a, name) || !same(clean(a[name]), clean(v))) edits.push({ path: ['routing', key, name], value: clean(v) });
  };
  section('groups', before.groups, after.groups, v => v);
  section('routes', before.routes, after.routes, cleanRoute);
  if ((before.default ?? '') !== (after.default ?? '')) edits.push(after.default ? { path: ['routing', 'default'], value: after.default } : { path: ['routing', 'default'] });
  if (!same(before.avoid ?? [], after.avoid ?? [])) edits.push(after.avoid?.length ? { path: ['routing', 'avoid'], value: after.avoid } : { path: ['routing', 'avoid'] });
  return edits;
}

/** The routes of a routing that draw on a group (by `group`, or `default` for the orders no route takes). */
export function groupUsers(routing: RoutingDraft, name: string): string[] {
  return [...Object.entries(routing.routes).filter(([, r]) => r.group === name).map(([id]) => id), ...(routing.default === name ? ['routing.default'] : [])];
}

/** A group renamed in place (its position kept), with every route of the same routing that named it pointed at the new name. */
export function renameGroup(routing: RoutingDraft, from: string, to: string): RoutingDraft {
  const groups = Object.fromEntries(Object.entries(routing.groups).map(([k, v]) => [k === from ? to : k, v]));
  const routes = Object.fromEntries(Object.entries(routing.routes).map(([id, r]) => [id, r.group === from ? { ...r, group: to } : r]));
  return { ...routing, groups, routes, ...(routing.default === from ? { default: to } : {}) };
}

/** A member moved up (-1) or down (+1); `"*"` stays last. */
export function moveMember(list: string[], index: number, by: -1 | 1): string[] {
  const to = index + by;
  if (to < 0 || to >= list.length || list[index] === ANYONE || list[to] === ANYONE) return list;
  const out = [...list];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

/** "Anyone else" turned on (`"*"` appended) or off. */
export const withAnyone = (list: string[], on: boolean) => (on ? [...list.filter(m => m !== ANYONE), ANYONE] : list.filter(m => m !== ANYONE));
/** A member added before `"*"`, once. */
export const addMember = (list: string[], member: string) => (list.includes(member) ? list : list.includes(ANYONE) ? [...list.filter(m => m !== ANYONE), member, ANYONE] : [...list, member]);

/** A name a group or route may have (the loader's rule). */
export const validName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);

/** One edit for a whole section: written when it changed, removed when it became empty. */
export function sectionEdit(path: (string | number)[], before: unknown, after: unknown): ConfigEdit[] {
  const empty = after === undefined || after === '' || (Array.isArray(after) && !after.length) || (record(after) && !Object.keys(after).length);
  if (empty) return before === undefined ? [] : [{ path }];
  return same(before, after) ? [] : [{ path, value: after }];
}

/** A number typed into a field: empty is "not set" (`undefined`), anything else must be a finite number. */
export function numberField(text: string): { ok: true; value: number | undefined } | { ok: false } {
  const s = text.trim();
  if (!s) return { ok: true, value: undefined };
  const n = Number(s);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
}

/** The value at a dotted place of the values from `GET /api/config`. */
export function valueAt(values: Record<string, unknown> | undefined, path: string[]): unknown {
  let at: unknown = values;
  for (const k of path) at = record(at) ? at[k] : undefined;
  return at;
}

/** A section written as JSON in a text box: `undefined` for an empty box (the section is removed), or the parse error. */
export function parseSection(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
