import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject, validateProject } from './state-helper.ts';
import { parseReportBlock } from '../src/orders/report.ts';
import { acquireLeases, activeLeases, reconcileLeases, readLeases, releaseLease, resourceViews, startBlocked, usesOf, type StoredLease } from '../src/resources/leases.ts';
import { startRun } from '../src/run/launch.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { fixture as apiFixture } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { ready, tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const RESOURCES = { 'build-box': { slots: 1, note: 'the sim machine' }, 'perf-exclusive': { slots: 1, exclusive: true, blocks: ['ue'] }, 'package-lane': { slots: 2, match: 'package the build' } };

function fixture(resources: Record<string, unknown> = RESOURCES) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  for (const tag of ['A', 'B', 'C', 'D']) writeFileSync(path.join(workOrders, `${tag}-x.md`), `# ${tag}\nDo it.${tag === 'D' ? ' Then package the build for Windows.' : ''}\n`);
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), resources, dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  return { orders, dir, project };
}

const workers = () => validateWorkers({ workers: [{ id: 'coder', engine: 'x', concurrency: 5, launch: { template: 'c1', program: 'coder', args: ['run', '{prompt_file}'] } }] }, 'w.yaml');

function probes(over: Partial<Probes> = {}): Probes {
  return { now: () => new Date('2026-01-01T00:30:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => 4242, ...over } as Probes;
}

const add = (f: ReturnType<typeof fixture>, tag: string, over: { kind?: string; uses?: string[] } = {}) => { f.orders.add({ tag, title: `Order ${tag}`, kind: over.kind ?? 'sim', uses: over.uses }); f.orders.act(tag, 'queue'); };

test('resources in the project file are validated', () => {
  const { dir } = tempOrders();
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const write = (yaml: string) => { const f = path.join(dir, 'f.yaml'); writeFileSync(f, `id: d\nname: D\nroot: .\nwork_orders: orders\nstate_dir: s\n${yaml}`); return f; };
  const ok = loadProject(write('resources:\n  build-box: { slots: 3 }\n  perf: { slots: 1, exclusive: true, note: alone }\n'));
  assert.deepEqual(ok.resources!['build-box'], { slots: 3, exclusive: false, blocks: [], lease_minutes: 480 });
  assert.deepEqual([ok.resources!.perf.exclusive, ok.resources!.perf.note], [true, 'alone']);
  assert.throws(() => loadProject(write('resources:\n  x: { slots: 0 }\n')), /slots/);
  assert.throws(() => loadProject(write('resources:\n  x: { slots: 1, colour: red }\n')), /unknown key/);
  assert.throws(() => loadProject(write('resources:\n  x: { slots: 1, match: "(" }\n')), /regular expression/);
});

test('startBlocked: slots, planned orders, and the exclusive resource in both directions', () => {
  const resources = validateProject({ id: 'd', name: 'D', root: '.', work_orders: '.', state_dir: 's', resources: RESOURCES }, path.join(process.cwd(), 'f.yaml')).resources!;
  const lease = (resource: string, tag: string): StoredLease => ({ resource, tag, since: '2026-01-01T00:00:00Z', expires: '2026-01-01T08:00:00Z' });
  const want = (tag: string, kind: string, uses: string[] = []) => ({ tag, kind, uses });
  assert.equal(startBlocked(resources, [], [], want('A', 'sim', ['build-box'])), undefined);
  assert.match(startBlocked(resources, [lease('build-box', 'A')], [], want('B', 'sim', ['build-box']))!, /build-box is full \(1\/1, held by A\)/);
  assert.equal(startBlocked(resources, [lease('build-box', 'A')], [], want('A', 'sim', ['build-box'])), undefined);              // its own lease is not in its way
  assert.match(startBlocked(resources, [], [], want('B', 'sim', ['build-box']), [want('A', 'sim', ['build-box'])])!, /full/);    // planned in this pass counts
  assert.equal(startBlocked(resources, [lease('package-lane', 'A')], [], want('B', 'ue', ['package-lane'])), undefined);          // two slots
  assert.match(startBlocked(resources, [], [], want('B', 'sim', ['nowhere']))!, /does not declare/);
  // exclusive: it waits while a ue order runs, and keeps ue orders out while it is held
  assert.match(startBlocked(resources, [], [{ tag: 'U1', kind: 'ue' }], want('P', 'ue', ['perf-exclusive']))!, /exclusive and needs the machine to itself: ue orders are running \(U1\)/);
  assert.equal(startBlocked(resources, [], [{ tag: 'S1', kind: 'sim' }], want('P', 'sim', ['perf-exclusive'])), undefined);
  assert.match(startBlocked(resources, [lease('perf-exclusive', 'P')], [], want('U2', 'ue'))!, /perf-exclusive is exclusive and held by P: no ue order is started meanwhile/);
  assert.equal(startBlocked(resources, [lease('perf-exclusive', 'P')], [], want('S2', 'sim')), undefined);
});

test('a lease is taken when a run starts, blocks the next order, and is released when the run ends', () => {
  const f = fixture();
  add(f, 'A', { uses: ['build-box'] }); add(f, 'B', { uses: ['build-box'] });
  const ctx = { project: f.project, orders: f.orders, workers: workers(), probes: probes() };
  startRun(ctx, 'A', 'coder');
  assert.deepEqual(readLeases(f.project).map(l => [l.resource, l.tag, l.run]), [['build-box', 'A', 'r1']]);
  assert.ok(f.orders.store.events().some(e => e.type === 'lease-acquired' && e.tag === 'A'));
  // the next order is held back by the tick and refused by a direct start
  const plan = tick(f.project, f.orders, ctx.workers, probes(), { record: false }).report;
  assert.deepEqual(plan.moves, []);
  assert.match(plan.heldBack.find(h => h.tag === 'B')!.why, /resource build-box is full \(1\/1, held by A\)/);
  assert.throws(() => startRun(ctx, 'B', 'coder'), /B cannot start now: resource build-box is full/);
  const view = resourceViews(f.project, f.orders, new Date('2026-01-01T01:00:00Z')).find(r => r.name === 'build-box')!;
  assert.deepEqual([view.slots, view.used, view.leases[0].tag, view.leases[0].heldMinutes], [1, 1, 'A', 30]);
  // while A runs nothing is released
  assert.deepEqual(reconcileLeases(f.project, f.orders, probes().now()), []);
  f.orders.runEnd('A'); f.orders.report('A', ready);
  assert.equal(reconcileLeases(f.project, f.orders, probes().now()).length, 1);
  assert.deepEqual(readLeases(f.project), []);
  assert.ok(f.orders.store.events().some(e => e.type === 'lease-released' && e.tag === 'A'));
  assert.deepEqual(tick(f.project, f.orders, ctx.workers, probes(), { record: false }).report.moves.map(m => m.tag), ['B']);
  startRun(ctx, 'B', 'coder');
  assert.deepEqual(readLeases(f.project).map(l => l.tag), ['B']);
});

test('a lease stays while the order is monitored and while it waits to be continued, and goes when the continued run ends', () => {
  const f = fixture();
  add(f, 'A', { uses: ['build-box'] });
  const ctx = { project: f.project, orders: f.orders, workers: workers(), probes: probes() };
  startRun(ctx, 'A', 'coder');
  f.orders.runEnd('A');
  f.orders.report('A', parseReportBlock('--- alba-report ---\n{"status":"monitoring","summary":"s","monitor":{"check":["x"],"done_when":{"exit_code":0},"deadline_minutes":60}}\n--- end ---\n'));
  assert.equal(f.orders.stage(f.orders.get('A')).stage, 'monitoring');
  assert.deepEqual(reconcileLeases(f.project, f.orders, probes().now()), []);
  f.orders.monitorResolved('A', 'done', 'ok', 'it is over');
  assert.equal(f.orders.stage(f.orders.get('A')).stage, 'queued');
  assert.deepEqual(reconcileLeases(f.project, f.orders, probes().now()), []);           // still held: the build occupies the machine until A carries on
  add(f, 'B', { uses: ['build-box'] });
  assert.match(tick(f.project, f.orders, ctx.workers, probes(), { record: false }).report.heldBack.find(h => h.tag === 'B')!.why, /held by A/);
  startRun(ctx, 'A', 'coder');                                                         // continuing: it already holds the lease
  assert.equal(readLeases(f.project).length, 1);
  f.orders.runEnd('A'); f.orders.report('A', ready);
  assert.equal(reconcileLeases(f.project, f.orders, probes().now()).length, 1);
});

test('an expired lease is a problem until it is released; a person can take it back', () => {
  const f = fixture({ 'build-box': { slots: 1, lease_minutes: 60 } });
  add(f, 'A', { uses: ['build-box'] });
  const ctx = { project: f.project, orders: f.orders, workers: workers(), probes: probes() };
  startRun(ctx, 'A', 'coder');
  const late = probes({ now: () => new Date('2026-01-01T03:00:00Z') });
  const report = tick(f.project, f.orders, ctx.workers, late, { record: false }).report;
  const problem = report.problems.find(p => p.kind === 'lease-expired')!;
  assert.equal(problem.tag, 'A');
  assert.match(problem.text, /held build-box for \d+ min, longer than its lease \(60 min\)/);
  assert.equal(resourceViews(f.project, f.orders, late.now())[0].leases[0].expired, true);
  assert.equal(releaseLease(f.project, f.orders, 'build-box', 'a', 'a person took it back', late.now()), true);     // the tag is found whatever its case
  assert.equal(releaseLease(f.project, f.orders, 'build-box', 'A', 'again', late.now()), false);
  assert.deepEqual(tick(f.project, f.orders, ctx.workers, late, { record: false }).report.problems.filter(p => p.kind === 'lease-expired'), []);
});

test('uses come from the order, from a resource\'s match, and an order with none is never blocked', () => {
  const f = fixture();
  add(f, 'D');
  add(f, 'A');
  assert.deepEqual(usesOf(f.project, f.orders.get('D')), ['package-lane']);               // "package the build" is in its work-order text
  assert.deepEqual(usesOf(f.project, f.orders.get('A')), []);
  f.orders.update('A', { uses: ['build-box'] });
  assert.deepEqual(usesOf(f.project, f.orders.get('A')), ['build-box']);
  acquireLeases(f.project, f.orders, f.orders.get('A'), undefined, probes().now());
  assert.equal(activeLeases(f.project, f.orders).length, 0);                            // A is queued, not running: nothing needs the lease yet
});

test('alba resources, alba orders set --uses and alba leases release', () => {
  const { dir } = tempOrders();
  const file = projectDir(dir, 'resources:\n  build-box: { slots: 2, note: the sim machine }\n');
  assert.equal(alba(file, ['orders', 'add', 'A', '--title', 'x', '--kind', 'sim']).code, 0);
  const bad = alba(file, ['orders', 'set', 'A', '--uses', 'nowhere']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /does not declare the resource\(s\): nowhere. Declared: build-box/);
  const set = alba(file, ['orders', 'set', 'A', '--uses', 'build-box']);
  assert.match(set.out, /uses: - -> build-box/);
  const list = alba(file, ['resources']);
  assert.match(list.out, /build-box  0\/2  the sim machine/);
  assert.match(alba(file, ['leases', 'release', 'build-box', 'A']).out, /A holds no lease on build-box/);
});

test('API: GET /api/resources and POST /api/leases/release', async () => {
  const f = await apiFixture({ project: () => ({ resources: { 'build-box': { slots: 1 } } }) });
  f.orders.update('R1', { uses: ['build-box'] });
  // W1 has an open run in the fixture: give it the lease the way a start would
  f.orders.update('W1', { uses: ['build-box'] });
  acquireLeases(f.board.ctx.projects[0], f.orders, f.orders.get('W1'), 'r1', new Date());
  const list = (await f.get('/api/resources?project=demo')).body;
  assert.equal(list.resources[0].name, 'build-box');
  assert.deepEqual([list.resources[0].used, list.resources[0].leases[0].tag], [1, 'W1']);
  assert.equal((await f.get('/api/orders/W1')).body.order.uses[0], 'build-box');
  const bad = await f.write('/api/leases/release', { resource: 'nowhere', tag: 'W1' });
  assert.equal(bad.status, 404);
  const out = await f.write('/api/leases/release', { resource: 'build-box', tag: 'W1' });
  assert.equal(out.status, 200);
  assert.equal(out.body.released, true);
  assert.equal((await f.get('/api/resources?project=demo')).body.resources[0].used, 0);
});
