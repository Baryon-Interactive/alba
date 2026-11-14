import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { Orders } from '../src/orders/service.ts';
import { stateStore } from '../src/orders/backend.ts';
import { tick, type Probes } from '../src/tick/gather.ts';
import { snapshotFromTicks } from '../src/web/snapshot.ts';
import { validateWorkers } from '../src/workers/config.ts';

test('the board view built from the last ticks reads orders now and counts open runs now, over every project shown', () => {
  const { dir } = tempOrders();
  const make = (id: string) => {
    mkdirSync(path.join(dir, id), { recursive: true });
    const project = validateProject({ id, name: id, root: dir, work_orders: path.join(dir, id), state_dir: path.join(dir, `${id}-state`) }, path.join(dir, `${id}.yaml`));
    return { project, orders: new Orders(stateStore(project)) };
  };
  const a = make('alpha'), b = make('beta');
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'x', concurrency: 2, launch: { program: 'coder', args: ['{prompt_file}'] } }] }, 'w.yaml');
  let freeRamCalls = 0;
  const probes = { now: () => new Date('2026-01-01T00:00:00Z'), runCommand: () => '[]', freeRamGb: () => { freeRamCalls++; return 32; }, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined } as unknown as Probes;
  const ticks = { alpha: tick(a.project, a.orders, workers, probes, { record: false }), beta: tick(b.project, b.orders, workers, probes, { record: false }) };
  // after those ticks: one order added in alpha, a run opened on coder in each project
  a.orders.add({ tag: 'A1', title: 'New', kind: 'sim' }); a.orders.act('A1', 'queue'); a.orders.runStart('A1', { worker: 'coder' });
  b.orders.add({ tag: 'B1', title: 'New', kind: 'sim' }); b.orders.act('B1', 'queue'); b.orders.runStart('B1', { worker: 'coder' });
  const snap = snapshotFromTicks([a.project, b.project], workers, ticks, probes);
  assert.deepEqual(snap.projects.map(p => p.rows.map(r => r.tag)), [['A1'], ['B1']]);
  for (const view of snap.projects) assert.equal(view.workers?.find(w => w.config.id === 'coder')?.running, 2, 'both projects\' runs count on the shared worker');
  assert.equal(ticks.alpha.workers.find(w => w.config.id === 'coder')?.running, 0, 'the tick result itself is not changed');
  assert.equal(snap.projects[0].tick, ticks.alpha.report);
  assert.ok(freeRamCalls >= 1);
});
