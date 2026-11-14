import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { loadProject } from './state-helper.ts';
import { loadWorkers } from '../src/workers/config.ts';

/** A fixture whose project and workers files exist on disk, so that the console can edit them. */
async function onDisk(populate = true) {
  const f = await fixture({ populate });
  const file = f.board.ctx.projects[0].file;
  writeFileSync(file, [
    '# the demo project',
    'id: demo', 'name: Demo', `root: ${JSON.stringify(f.root)}`, `work_orders: ${JSON.stringify(path.join(f.root, 'orders'))}`, `state_dir: ${JSON.stringify(path.join(f.dir, 'state'))}`,
    'dispatch:', '  caps: { sim: 2 }   # two at a time', `  worktree_parent: ${JSON.stringify(f.dir)}`, '  base_ref: refs/heads/main',
    'resources:', '  gpu: { slots: 1 }', '',
  ].join('\n'));
  f.board.ctx.projects[0] = loadProject(file);
  const workersFile = path.join(f.dir, 'workers.yaml');
  writeFileSync(workersFile, [
    'workers:',
    '  - id: coder', '    engine: x', '    aliases: [Coder]', '    launch: { program: coder, args: [run, "{prompt_file}"] }',
    '  - id: spare', '    engine: x', '    launch: { program: spare, args: ["{prompt_file}"] }',
    '  - id: editor', '    engine: claude-session',
    'routing:', '  groups:', '    main: [coder, "*"]', '  routes:', '    sim: { kinds: [sim], group: main }', '    default: { group: main }', '',
  ].join('\n'));
  f.board.ctx.workers = loadWorkers(workersFile);
  return { ...f, file, workersFile };
}

test('config: reads the editable sections as written, edits several keys in one write with comments kept, and refuses other keys and broken results', async () => {
  const f = await onDisk(false);
  const seen = (await f.get('/api/config?project=demo')).body;
  assert.deepEqual(seen.values.dispatch, { caps: { sim: 2 } });
  assert.deepEqual(seen.values.resources, { gpu: { slots: 1 } });
  assert.ok(seen.editable.includes('dispatch.caps') && !seen.editable.includes('id'));

  const out = await f.write('/api/config', { project: 'demo', edits: [{ path: ['dispatch', 'caps', 'sim'], value: 3 }, { path: ['resources', 'editor'], value: { slots: 2 } }] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.changed.sort(), ['dispatch.caps.sim', 'resources.editor']);
  const text = readFileSync(f.file, 'utf8');
  assert.match(text, /# the demo project/);
  assert.match(text, /# two at a time/);
  assert.ok(out.body.backup && existsSync(out.body.backup));
  assert.equal(f.board.ctx.projects[0].dispatch.caps.sim, 3);
  assert.equal(f.board.ctx.projects[0].resources?.editor?.slots, 2);
  assert.ok(f.orders.store.events().some(e => e.type === 'config.edited'));

  assert.equal((await f.write('/api/config', { project: 'demo', edits: [{ path: ['id'], value: 'other' }] })).status, 400);
  assert.equal((await f.write('/api/config', { project: 'demo', edits: [{ path: ['dispatch', 'state_dir'], value: 'x' }] })).status, 400);
  const broken = await f.write('/api/config', { project: 'demo', edits: [{ path: ['dispatch', 'on_loop'], value: 'explode' }] });
  assert.equal(broken.status, 400);
  assert.match(JSON.stringify(broken.body), /on_loop/);
  assert.doesNotMatch(readFileSync(f.file, 'utf8'), /explode/);
  // a dry run checks and writes nothing
  const dry = await f.write('/api/config', { project: 'demo', dryRun: true, edits: [{ path: ['dispatch', 'caps', 'sim'], value: 9 }] });
  assert.deepEqual([dry.status, dry.body.dryRun], [200, true]);
  assert.equal(loadProject(f.file).dispatch.caps.sim, 3);
});

test('config: routing in the workers file is edited with its groups checked against the workers and the projects that use it', async () => {
  const f = await onDisk(false);
  const ok = await f.write('/api/config', { project: 'demo', target: 'workers', edits: [{ path: ['routing', 'groups', 'main'], value: ['spare', 'coder'] }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(f.board.ctx.workers?.worker_groups?.main, ['spare', 'coder']);
  const unknown = await f.write('/api/config', { project: 'demo', target: 'workers', edits: [{ path: ['routing', 'groups', 'main'], value: ['nobody'] }] });
  assert.equal(unknown.status, 400);
  assert.match(JSON.stringify(unknown.body), /nobody/);
  const missingGroup = await f.write('/api/config', { project: 'demo', target: 'workers', edits: [{ path: ['routing', 'routes', 'sim', 'group'], value: 'cheap' }] });
  assert.equal(missingGroup.status, 400);
  // renaming a group and the routes that use it in one request
  const renamed = await f.write('/api/config', { project: 'demo', target: 'workers', edits: [
    { path: ['routing', 'groups', 'main'] }, { path: ['routing', 'groups', 'core'], value: ['coder', '*'] },
    { path: ['routing', 'routes', 'sim', 'group'], value: 'core' }, { path: ['routing', 'routes', 'default', 'group'], value: 'core' },
  ] });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual(Object.keys(f.board.ctx.workers?.worker_groups ?? {}), ['core']);
  const mig = (await f.get('/api/routing/migrate?project=demo')).body; assert.equal(mig.files.length, 0, JSON.stringify(mig).slice(0, 400));
});

test('orders: fields can be changed after an order is made, with the same checks as the command line; the body is replaced unless it changed meanwhile', async () => {
  const f = await onDisk();
  const set = await f.write('/api/orders/D1/fields', { project: 'demo', title: 'A better title', priority: 5, worker: 'spare', review: 'manual', check: 'none', tags: ['ui'], uses: ['gpu'] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const o = f.orders.get('D1').order;
  assert.deepEqual([o.title, o.priority, o.worker, o.review, o.check, o.tags, o.uses], ['A better title', 5, 'spare', 'manual', 'none', ['ui'], ['gpu']]);
  assert.ok(f.orders.store.events().some(e => e.type === 'worker-set' && e.tag === 'D1'));
  const cleared = await f.write('/api/orders/D1/fields', { project: 'demo', worker: null, priority: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual([f.orders.get('D1').order.worker, f.orders.get('D1').order.priority], [undefined, undefined]);
  for (const bad of [{ worker: 'nobody' }, { uses: ['tape'] }, { needs: ['ZZ9'] }, { title: '' }, { priority: 1.5 }, { review: 'later' }, {}]) {
    assert.equal((await f.write('/api/orders/D1/fields', { project: 'demo', ...bad })).status, 400, JSON.stringify(bad));
  }

  const file = path.join(f.root, 'orders', 'R1-review.md');
  const before = readFileSync(file, 'utf8');
  const stale = await f.write('/api/orders/R1/body', { project: 'demo', text: '# R1\nNew text.\n', expected: 'something else' });
  assert.equal(stale.status, 400);
  assert.equal(readFileSync(file, 'utf8'), before);
  const ok = await f.write('/api/orders/R1/body', { project: 'demo', text: '# R1\nNew text.\n', expected: before });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(readFileSync(file, 'utf8'), '# R1\nNew text.\n');
  assert.ok(f.orders.store.events().some(e => e.type === 'order-body-edited'));
});

test('workers: a worker that nothing uses can be removed; one with an open run, a pinned order or a route naming it cannot', async () => {
  const f = await onDisk();
  const busy = await f.write('/api/workers/coder/remove', { project: 'demo' });
  assert.equal(busy.status, 400);
  assert.match(JSON.stringify(busy.body), /W1 runs on it/);
  const gone = await f.write('/api/workers/spare/remove', { project: 'demo' });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(f.board.ctx.workers?.workers.some(w => w.id === 'spare'), false);
  assert.doesNotMatch(readFileSync(f.workersFile, 'utf8'), /id: spare/);
});
