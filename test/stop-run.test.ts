import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { alba, projectDir } from './cli-helper.ts';
import { Orders } from '../src/orders/service.ts';
import { validateProject } from '../src/config.ts';
import { startRun } from '../src/run/launch.ts';
import { humanAction, stopRun } from '../src/service/actions.ts';
import { actionsFor } from '../src/api/views.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { systemProbes, type Probes } from '../src/tick/gather.ts';

const at = '2026-01-01T00:00:00Z';
/** Orders whose process stop is recorded instead of done. */
function withStops() {
  const f = tempOrders(), stopped: number[] = [];
  const orders = new Orders(f.orders.store, () => at, 'test', () => at, { alive: () => true, stop: pid => { stopped.push(pid); return { stopped: [pid], leftRunning: [] }; } });
  return { ...f, orders, stopped };
}

test('stop ends the open run, holds the order and refuses an order without an open run', () => {
  const { orders, stopped } = withStops();
  orders.add({ tag: 'A1', title: 'Sample', kind: 'code' });
  orders.act('A1', 'queue');
  assert.throws(() => stopRun(orders, 'A1'), /has no open run to stop/);
  orders.runStart('A1', { worker: 'codex', extra: { pid: 321, process_started_at: at } });
  stopRun(orders, 'A1', 'moving to the paid worker');
  const doc = orders.get('A1');
  assert.equal(orders.stage(doc).stage, 'held');
  assert.equal(doc.runs[0].outcome, 'cancelled');
  assert.deepEqual(stopped, [321]);
  assert.equal(doc.actions.at(-1)!.note, 'moving to the paid worker');
  // the board offers stop only while a run is open, and run on a held order
  assert.ok(actionsFor('running', { workers: { workers: [], quota_sources: {}, file: '' } } as never).allowed.includes('stop'));
  assert.ok(actionsFor('held', { workers: { workers: [], quota_sources: {}, file: '' } } as never).allowed.includes('run'));
  assert.ok(!actionsFor('queued', { workers: { workers: [], quota_sources: {}, file: '' } } as never).allowed.includes('stop'));
});

test('cancelling a running order stops a verified process; an unverified one is left alone as before', () => {
  const { orders, stopped } = withStops();
  orders.add({ tag: 'C1', title: 'Sample', kind: 'code' }); orders.act('C1', 'queue');
  orders.runStart('C1', { worker: 'codex', extra: { pid: 11, process_started_at: at } });
  humanAction({} as never, orders, 'C1', 'cancel');
  assert.deepEqual(stopped, [11]);
  assert.equal(orders.get('C1').runs[0].outcome, 'cancelled');
  orders.add({ tag: 'C2', title: 'Sample', kind: 'code' }); orders.act('C2', 'queue');
  orders.runStart('C2', { worker: 'codex', extra: { pid: 12, process_started_at: '2025-01-01T00:00:00Z' } });
  humanAction({} as never, orders, 'C2', 'cancel');
  assert.deepEqual(stopped, [11]);
  assert.equal(orders.stage(orders.get('C2')).stage, 'cancelled');
  assert.equal(orders.get('C2').runs[0].ended, undefined, 'its end is recorded when the process ends');
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function runFixture() {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-do-something.md'), '# T1\nDo something.\n');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Do something', kind: 'sim' });
  orders.act('T1', 'queue');
  const spawned: string[] = [];
  const probes = { now: () => new Date(at), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined,
    spawnDetached(program: string) { spawned.push(program); return 4242; } } as unknown as Probes;
  const workers = validateWorkers({ workers: [
    { id: 'coder', engine: 'codex-cli', launch: { program: 'coder', args: ['exec', '{prompt_file}'] } },
    { id: 'paid', engine: 'codex-cli', launch: { program: 'paid-coder', args: ['exec', '{prompt_file}'] } },
  ] }, 'w.yaml');
  project.roles = { default: { sources: {} } };
  return { orders, project, ctx: { project, orders, workers, probes }, spawned };
}

test('a held order starts on the worker a person names, with the release written together with the run', () => {
  const { orders, ctx, spawned } = runFixture();
  orders.act('T1', 'hold');
  assert.throws(() => startRun(ctx, 'T1', undefined), /is held; start it on a worker you name/);
  assert.throws(() => startRun(ctx, 'T1', 'paid'), /is held/, 'a worker routing picked does not start a held order');
  const r = startRun(ctx, 'T1', 'paid', { explicitWorker: true });
  assert.equal(r.mode, 'start');
  assert.deepEqual(spawned, ['paid-coder']);
  const doc = orders.get('T1');
  assert.equal(orders.stage(doc).stage, 'running');
  assert.deepEqual(doc.actions.map(a => a.kind), ['queue', 'hold', 'release']);
  assert.ok(doc.actions.at(-1)!.seq < doc.runs[0].seq);
  const started = orders.store.events({ tag: 'T1', limit: 5 }).find(e => e.type === 'run-start');
  assert.equal(started?.data?.released, true);
  assert.equal(orders.store.events({ tag: 'T1', limit: 10 }).some(e => e.type === 'action-release'), false, 'no separate release a tick could act on');

  // stopped, then moved to the other worker in one step
  orders.runEnd('T1', 'cancelled');
  orders.act('T1', 'hold');
  startRun(ctx, 'T1', 'coder', { explicitWorker: true });
  assert.equal(orders.get('T1').runs.at(-1)!.worker, 'coder');
});

test('a held order that ended failed is queued again when started; one under review is not started', () => {
  const { orders, ctx } = runFixture();
  orders.runStart('T1', { worker: 'coder' }); orders.runEnd('T1', 'failed');
  orders.report('T1', { status: 'failed', summary: 'broke', evidence: [], commits: [] });
  orders.act('T1', 'hold');
  startRun(ctx, 'T1', 'paid', { explicitWorker: true });
  assert.deepEqual(orders.get('T1').actions.slice(-2).map(a => a.kind), ['release', 'queue']);
  orders.runEnd('T1', 'completed');
  orders.report('T1', { status: 'ready', summary: 'done', evidence: [], commits: [] });
  orders.act('T1', 'hold');
  assert.throws(() => startRun(ctx, 'T1', 'paid', { explicitWorker: true }), /held over a awaiting-review order/);
});

test('orders run-end --outcome cancelled holds the order instead of handing it back to the next tick', () => {
  const dir = tempOrders().dir, project = projectDir(dir);
  writeFileSync(path.join(dir, 'orders', 'A1-sample.md'), '# A1\n');
  assert.equal(alba(project, ['orders', 'add', 'A1', '--title', 'Sample', '--kind', 'code', '--queue']).code, 0);
  assert.equal(alba(project, ['orders', 'run-start', 'A1', '--worker', 'codex']).code, 0);
  const ended = alba(project, ['orders', 'run-end', 'A1', '--outcome', 'cancelled']);
  assert.equal(ended.code, 0, ended.err);
  assert.match(ended.out, /^A1: held\nHeld so that no tick starts it again/);
  assert.equal(alba(project, ['orders', 'run-start', 'A1', '--worker', 'codex']).code, 1, 'a held order does not start by itself');
  assert.equal(alba(project, ['orders', 'act', 'A1', 'release']).code, 0);
  assert.equal(alba(project, ['orders', 'run-start', 'A1', '--worker', 'codex']).code, 0);
  assert.match(alba(project, ['orders', 'run-end', 'A1', '--outcome', 'failed']).out, /^A1: (queued|idle)$/, 'other outcomes are unchanged');
  const stop = alba(project, ['stop', 'A1']);
  assert.notEqual(stop.code, 0);
  assert.match(stop.err, /has no open run to stop/);
  assert.equal(alba(project, ['orders', 'run-start', 'A1', '--worker', 'codex']).code, 0);
  const stopped = alba(project, ['stop', 'A1', '--note', 'moving it']);
  assert.equal(stopped.code, 0, stopped.err);
  assert.match(stopped.out, /^A1: held\nStopped run r3\./);
});

test('stop ends the recorded process and every process under it', { skip: process.platform !== 'win32' ? 'Uses Windows process creation times like the other native tree tests.' : false }, async () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // a wrapper (like src/run/capture.mjs) that starts a worker (like codex), which starts its own child
  const wrapper = spawn(process.execPath, ['-e', `const { spawn } = require('child_process');
    const worker = spawn(process.execPath, ['-e', "const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); console.log(c.pid); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    worker.stdout.on('data', d => console.log(worker.pid + ' ' + String(d).trim())); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const pids = await new Promise<number[]>(resolve => wrapper.stdout!.on('data', d => resolve(String(d).trim().split(/\s+/).map(Number))));
  try {
    const startedAt = systemProbes.processStartedAt!(wrapper.pid!);
    assert.ok(startedAt);
    const f = tempOrders();
    const orders = new Orders(f.orders.store);
    orders.add({ tag: 'K1', title: 'Kill tree', kind: 'code' }); orders.act('K1', 'queue');
    orders.runStart('K1', { worker: 'codex', extra: { pid: wrapper.pid!, process_started_at: startedAt } });
    stopRun(orders, 'K1');
    const gone = async (pid: number) => { for (let i = 0; i < 100 && alive(pid); i++) await new Promise(r => setTimeout(r, 100)); return !alive(pid); };
    for (const pid of [wrapper.pid!, ...pids]) assert.ok(await gone(pid), `process ${pid} still runs`);
    assert.equal(orders.stage(orders.get('K1')).stage, 'held');
  } finally {
    for (const pid of [wrapper.pid!, ...pids]) { try { process.kill(pid); } catch { /* gone */ } }
  }
});

test('a project file may set the review default for orders that do not say', () => {
  const dir = tempOrders().dir, project = projectDir(dir, 'review: manual\n');
  assert.equal(alba(project, ['orders', 'add', 'R1', '--title', 'Sample', '--kind', 'code']).code, 0);
  assert.equal(alba(project, ['orders', 'add', 'R2', '--title', 'Sample', '--kind', 'code', '--review', 'auto']).code, 0);
  const rows = JSON.parse(alba(project, ['orders', 'list', '--json']).out) as { tag: string; review: string }[];
  assert.deepEqual(rows.map(r => `${r.tag}:${r.review}`).sort(), ['R1:manual', 'R2:auto']);
  const bad = projectDir(path.join(dir, 'bad'), 'review: sometimes\n');
  assert.match(alba(bad, ['orders', 'list']).err, /"review" must be manual or auto/);
});
