// The console's write paths for configuration files, order fields and bodies, and removing a worker, answered from made-up files.
import type { ServerResponse } from 'node:http';
import type { ConfigView, RoutingMigration } from '../../src/api/types.ts';

interface Ctx {
  path: string; method: string; url: URL; body: any; project: string; res: ServerResponse;
  send: (res: ServerResponse, status: number, body: unknown) => void;
  fail: (res: ServerResponse, status: number, code: string, message: string) => void;
}

type Values = Record<string, unknown>;
const files = new Map<string, { project: Values; workers: Values }>();
const start = (): { project: Values; workers: Values } => ({
  project: {
    dispatch: { caps: { gameplay: 2, art: 1 }, stall_minutes: 30, on_loop: 'report', long_commands: ['cook', 'package'] },
    resources: { editor: { slots: 1, exclusive: true, blocks: ['level'], note: 'One editor license' }, 'build-lane': { slots: 2 } },
    skills: { always: ['alba-report'], by_kind: { art: ['pixel-art'], ui: ['figma-notes'] }, max_per_order: 12 },
    budget: { tokens_per_day: 4000000, currency: 'USD' },
    clean: { idle_hours: 48, caches: ['Intermediate', 'DerivedDataCache'] },
    routing: { routes: { art: { kinds: ['art', 'vfx'], requires: ['vision'], group: 'visual', description: 'Pictures and effects' } } },
  },
  workers: {
    routing: { groups: { main: ['codex', 'claude-sonnet', '*'], visual: ['claude-opus', 'codex'] }, routes: { gameplay: { kinds: ['gameplay', 'bug'], group: 'main' } }, default: 'main' },
    quota_sources: { codex: { command: ['codex', 'usage', '--json'] } },
  },
});
const of = (project: string) => { if (!files.has(project)) files.set(project, start()); return files.get(project)!; };
const record = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);

function apply(root: Values, path: (string | number)[], value: unknown) {
  let at: Values = root;
  for (const k of path.slice(0, -1)) { if (!record(at[k])) at[k] = {}; at = at[k] as Values; }
  const last = path[path.length - 1];
  if (value === undefined) delete at[last]; else at[last] = structuredClone(value);
}

export function handleConfigEdit(c: Ctx): boolean {
  const { path, method, url, body, res, send, fail } = c;
  const target = (method === 'GET' ? url.searchParams.get('target') : body.target) === 'workers' ? 'workers' : 'project';
  if (path === 'config' && method === 'GET') {
    const file = target === 'workers' ? 'workers.yaml' : `${c.project}/alba.yaml`;
    return send(res, 200, { project: c.project, target, file, values: structuredClone(of(c.project)[target]), editable: [] } satisfies ConfigView), true;
  }
  if (path === 'config' && method === 'POST') {
    const edits = body.edits as { path: (string | number)[]; value?: unknown }[];
    if (!Array.isArray(edits) || !edits.length) return fail(res, 400, 'bad_request', 'Nothing to change.'), true;
    if (edits.some(e => e.path[0] === 'dispatch' && e.path[1] === 'on_loop' && e.value !== undefined && e.value !== 'report' && e.value !== 'stop')) return fail(res, 400, 'bad_request', 'alba.yaml: "dispatch.on_loop" must be "report" or "stop".'), true;
    const copy = structuredClone(of(c.project)[target]);
    for (const e of edits) apply(copy, e.path, e.value);
    if (!body.dryRun) of(c.project)[target] = copy;
    return send(res, 200, { ok: true, file: target === 'workers' ? 'workers.yaml' : 'alba.yaml', changed: edits.map(e => e.path.join('.')), ...(body.dryRun ? { dryRun: true } : {}) }), true;
  }
  if (path === 'routing/migrate' && method === 'GET') {
    const files: RoutingMigration['files'] = [];
    for (const t of ['project', 'workers'] as const) {
      const v = of(c.project)[t];
      if (record(v.roles) && Object.keys(v.roles).length && !v.routing) files.push({ target: t, file: t === 'workers' ? 'workers.yaml' : 'alba.yaml', routing: { routes: Object.fromEntries(Object.entries(v.roles).map(([id, r]) => [id, { kinds: (r as Values).kinds ?? [] }])) }, yaml: 'routing:\n  routes: {}\n', notes: [] });
    }
    return send(res, 200, { project: c.project, files } satisfies RoutingMigration), true;
  }
  const fields = /^orders\/([^/]+)\/(fields|body)$/.exec(path);
  if (fields && method === 'POST') {
    if (fields[2] === 'body') return send(res, 200, { ok: true, file: `${decodeURIComponent(fields[1])}.md` }), true;
    if (body.title !== undefined && !String(body.title).trim()) return fail(res, 400, 'bad_request', 'The title cannot be empty.'), true;
    return send(res, 200, { tag: decodeURIComponent(fields[1]) }), true;
  }
  const remove = /^workers\/([^/]+)\/remove$/.exec(path);
  if (remove && method === 'POST') {
    const id = decodeURIComponent(remove[1]);
    if (id === 'codex') return fail(res, 400, 'bad_request', `${id} is still in use: route ${c.project}/gameplay names it.`), true;
    return send(res, 200, { ok: true, id, changed: [`workers.${id}`], file: 'workers.yaml', dryRun: false }), true;
  }
  return false;
}
