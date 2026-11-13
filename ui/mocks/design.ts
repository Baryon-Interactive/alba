import type { ServerResponse } from 'node:http';
import { seedDesign } from '../src/mocks/design-data.ts';
import { idOf, kinds, type ChangeSet, type DesignBundle, type Entity } from '../src/lib/design.ts';

const libraries = new Map<string, DesignBundle>();
export function handleDesign({ path, method, url, body, project, res, send, fail }: {
  path: string; method: string; url: URL; body: { changeset?: ChangeSet; dryRun?: boolean; targets?: string[] }; project: string; res: ServerResponse;
  send: (res: ServerResponse, status: number, body: unknown) => void; fail: (res: ServerResponse, status: number, code: string, message: string) => void;
}) {
  if (!libraries.has(project)) libraries.set(project, seedDesign());
  const data = libraries.get(project)!;
  if (method === 'POST' && path === 'design/measure') {
    if (!body.targets?.length) return fail(res, 400, 'bad_request', 'Choose a target.');
    const results = body.targets.map(id => {
      const target = data.target.find(t => t.id === id);
      if (!target?.measure) return { target: id, status: 'waiting', reason: 'No structured measure is configured.' };
      const at = new Date().toISOString(), value = target.last_value ?? target.min ?? target.max ?? 0, before = structuredClone(target);
      Object.assign(target, { last_value: value, measured_at: at, measured_commit: 'd4e5f6a', version: target.version + 1, updated: at, evidence: [{ kind: 'file', ref: '.alba/design/measurements/mock.log' }] });
      const last = { target: id, at, commit: 'd4e5f6a', status: 'ok' as const, value, log: '.alba/design/measurements/mock.log', definition: '' };
      data.measurements = [...(data.measurements ?? []).filter(v => v.target !== id), { target: id, due: false, running: false, last }];
      data.history.push({ id: data.history.length + 1, at, kind: 'target', entity: id, op: 'update', before, after: structuredClone(target), by: 'measure', order: null, decision: null, changeset: 'mock-measure' });
      return { target: id, status: 'ok', value, log: last.log };
    });
    return send(res, 200, results);
  }
  if (method === 'GET') {
    if (path === 'design/export') return send(res, 200, data);
    if (path === 'design' && url.searchParams.get('query') === 'stale-systems') return send(res, 200, [{ system: 'GLD', orders: ['AR1'], unknown_orders: [] }]);
    if (path.startsWith('design/show/')) {
      const id = decodeURIComponent(path.slice('design/show/'.length));
      const row = kinds.flatMap(k => data[k].filter(r => idOf(k, r) === id))[0];
      return row ? send(res, 200, row) : fail(res, 404, 'not_found', 'No such design entity.');
    }
  }
  if (method === 'POST' && path === 'design/changesets') {
    const set = body.changeset;
    if (!set?.title || !set.changes?.length) return fail(res, 400, 'bad_request', 'A change set needs a title and changes.');
    const next = structuredClone(data);
    for (const c of set.changes) {
      if (!kinds.includes(c.kind)) return fail(res, 400, 'bad_request', 'Unknown entity kind.');
      const rows = next[c.kind] as Entity[];
      const index = rows.findIndex(r => idOf(c.kind, r) === c.id), before = rows[index];
      if ((c.op === 'create' && before) || before && c.base_version !== before.version) return fail(res, 409, 'conflict', `Conflict on ${c.id}: current version ${before.version}.`);
      if (c.op !== 'create' && !before) return fail(res, 404, 'not_found', 'No such design entity.');
      const after = { ...before, ...c.fields, version: (before?.version ?? 0) + 1, updated: new Date().toISOString(), ...(c.op === 'retire' ? { status: 'retired' } : {}) } as Entity;
      if (index < 0) rows.push(after); else rows[index] = after;
      next.history.push({ id: next.history.length + 1, at: after.updated, kind: c.kind, entity: c.id, op: c.op, before: before ?? null, after, by: 'web', order: set.order ?? null, decision: set.decision ?? null, changeset: 'mock-change' });
    }
    if (!body.dryRun) libraries.set(project, next);
    return send(res, 200, { applied: !body.dryRun, dryRun: !!body.dryRun, changeset: 'mock-change', changes: set.changes.length, warnings: [] });
  }
  return fail(res, 404, 'not_found', 'No such mock design route.');
}
