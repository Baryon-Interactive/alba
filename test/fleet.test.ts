import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { Orders } from '../src/orders/service.ts';
import { stateStore } from '../src/orders/backend.ts';
import { startRun } from '../src/run/launch.ts';
import { newFleetLock, peerRunning, useFleetLock, withFleetLock } from '../src/serve/fleet.ts';
import { tick, type Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';

const at = '2026-01-01T00:00:00Z';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Two projects served together that share one worker taking one run at a time. */
function twoProjects() {
  const { dir } = tempOrders();
  const make = (id: string) => {
    const root = path.join(dir, id);
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(root, 'a.txt'), 'a');
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first');
    const workOrders = path.join(dir, `${id}-orders`);
    mkdirSync(workOrders);
    writeFileSync(path.join(workOrders, `${id.toUpperCase()}1-work.md`), `# ${id}\nWork.\n`);
    const project = validateProject({ id, name: id, root, work_orders: workOrders, state_dir: path.join(dir, `${id}-state`), dispatch: { worktree_parent: path.join(dir, `${id}-trees`), base_ref: 'refs/heads/main' } }, path.join(dir, `${id}.yaml`));
    project.roles = { default: { sources: {} } };
    const orders = new Orders(stateStore(project), () => at, 'test');
    orders.add({ tag: `${id.toUpperCase()}1`, title: 'Work', kind: 'sim' });
    orders.act(`${id.toUpperCase()}1`, 'queue');
    return { project, orders };
  };
  const a = make('alpha'), b = make('beta');
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', concurrency: 1, launch: { program: 'coder', args: ['exec', '{prompt_file}'] } }] }, 'w.yaml');
  const probes = { now: () => new Date(at), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined,
    spawnDetached: () => 4242 } as unknown as Probes;
  return { a, b, workers, probes };
}

test('a worker shared by two projects takes one run at a time over both: the tick counts the other project\'s runs, and a start checks again', () => {
  const { a, b, workers, probes } = twoProjects();
  a.orders.runStart('ALPHA1', { worker: 'coder', extra: { pid: 77 } });
  assert.deepEqual([...peerRunning([a.project], workers)], [['coder', 1]]);
  const alone = tick(b.project, b.orders, workers, probes, { record: false });
  assert.deepEqual(alone.report.moves.map(m => m.worker), ['coder'], 'without the other project the worker looks free');
  const shared = tick(b.project, b.orders, workers, probes, { record: false, peers: peerRunning([a.project], workers) });
  assert.deepEqual(shared.report.moves, [], 'counting the other project the worker is full');
  assert.equal(shared.workers.find(w => w.config.id === 'coder')?.running, 1);
  // a start planned before the other project's run was recorded is refused when it records its own
  const ctx = { project: b.project, orders: b.orders, workers, probes, peers: () => peerRunning([a.project], workers) };
  assert.throws(() => startRun(ctx, 'BETA1', 'coder', { capsChecked: true }), /coder already has 1 run\(s\) open \(1 in other projects\), its concurrency is 1/);
  assert.equal(b.orders.get('BETA1').runs.length, 0);
  // a person who names the worker may still start it
  assert.equal(startRun(ctx, 'BETA1', 'coder', { explicitWorker: true }).mode, 'start');
  // once the other project's run ends, the slot is free again
  a.orders.runEnd('ALPHA1');
  assert.deepEqual([...peerRunning([a.project], workers)], []);
});

test('the fleet lock lets one thread at a time through, across worker threads', async () => {
  const buffer = newFleetLock();
  const counter = new Int32Array(new SharedArrayBuffer(8));
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    const lock = new Int32Array(workerData.buffer), counter = new Int32Array(workerData.counter);
    for (let i = 0; i < 200; i++) {
      while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) Atomics.wait(lock, 0, 1, 100);
      const inside = Atomics.add(counter, 1, 1);
      if (inside !== 0) Atomics.add(counter, 0, 1000000);
      Atomics.add(counter, 0, 1);
      Atomics.sub(counter, 1, 1);
      Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1);
    }
    parentPort.postMessage('done');`;
  useFleetLock(buffer);
  const threads = [0, 1, 2].map(() => new Worker(code, { eval: true, workerData: { buffer, counter: counter.buffer } }));
  for (let i = 0; i < 200; i++) withFleetLock(() => { const inside = Atomics.add(counter, 1, 1); if (inside !== 0) Atomics.add(counter, 0, 1000000); Atomics.add(counter, 0, 1); Atomics.sub(counter, 1, 1); });
  await Promise.all(threads.map(w => new Promise(resolve => w.once('message', resolve))));
  await Promise.all(threads.map(w => w.terminate()));
  useFleetLock(undefined);
  assert.equal(counter[0], 800, 'every pass counted once, never two inside at the same time');
});
