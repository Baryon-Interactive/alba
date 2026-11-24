import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProject } from '../src/config.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { validatePhaseWorkers } from '../src/orders/phase-config.ts';

const base = { id: 'sample', name: 'Sample', root: '.', work_orders: '.', state_dir: '.' };
const plan = { id: 'inspect', mode: 'read-only', role: 'reader' };
const write = { id: 'build', mode: 'write' };
const config = (list: unknown[]) => validateProject({ ...base, phases: { code: list } }, 'project.yaml');

test('phase lists require unique ids and exactly one final write phase', () => {
  assert.deepEqual(config([plan, write]).phases?.code, [plan, write]);
  for (const list of [[write], [write, plan], [plan, write, write], [plan, plan, write], [{ ...plan, id: '2' }, write]]) {
    assert.throws(() => config(list), /phase/);
  }
});

test('a phase role must admit a worker that can enforce read-only execution', () => {
  const project = config([plan, write]);
  const workers = validateWorkers({ workers: [{ id: 'local', engine: 'script' }], roles: { reader: {} } }, 'workers.yaml');
  assert.throws(() => validatePhaseWorkers(project, workers), /read-only/);
});
