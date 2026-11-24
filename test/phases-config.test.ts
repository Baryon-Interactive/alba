import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { phasePrompt } from '../src/run/phase.ts';
import { draftPreview } from '../src/producer/drafting.ts';
import { orderPhases } from '../src/orders/phases.ts';
import { validateReport } from '../src/orders/report.ts';
import { tempOrders } from './helpers.ts';
import { alba, projectDir } from './cli-helper.ts';
import { validateProject } from '../src/config.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { verifierArgs } from '../src/review/independent.ts';
import { validatePhaseWorkers } from '../src/orders/phase-config.ts';

const base = { id: 'sample', name: 'Sample', root: '.', work_orders: '.', state_dir: '.' };
const plan = { id: 'inspect', mode: 'read-only', role: 'reader' };
const write = { id: 'build', mode: 'write' };
const config = (list: unknown[]) => validateProject({ ...base, phases: { code: list } }, 'project.yaml');

test('orders add and set expose the per-order opt-out through the CLI', () => {
  const { dir, orders } = tempOrders();
  const project = projectDir(dir, 'phases:\n  code:\n    - { id: inspect, mode: read-only }\n    - { id: build, mode: write }\n');
  const run = (...args: string[]) => {
    const result = alba(project, ['orders', ...args]);
    assert.equal(result.code, 0, result.err);
    return result.out;
  };
  run('add', 'LOOKUP', '--title', 'Check lookup', '--kind', 'code', '--phases', 'none');
  assert.equal(orders.get('LOOKUP').order.phases, 'none');
  run('add', 'STORE', '--title', 'Check store', '--kind', 'code');
  assert.match(run('show', 'STORE'), /inspect 1\/2.*build 2\/2/);
  writeFileSync(path.join(dir, 'orders', 'STORE-cache.md'), '# Check store');
  const prompt = alba(project, ['prompt', 'STORE']);
  assert.equal(prompt.code, 0, prompt.err);
  assert.match(prompt.out, /read-only planning phase/);
  run('set', 'STORE', '--phases', 'none');
  assert.equal(orders.get('STORE').order.phases, 'none');
});

test('phase lists require unique ids and exactly one final write phase', () => {
  assert.deepEqual(config([plan, write]).phases?.code, [plan, write]);
  for (const list of [[write], [write, plan], [plan, write, write], [plan, plan, write], [{ ...plan, id: '2' }, write]]) {
    assert.throws(() => config(list), /phase/);
  }
});

test('resuming a planner keeps the restricted arguments of each engine', () => {
  for (const engine of ['codex-cli', 'claude-cli']) {
    const worker = validateWorkers({ workers: [{ id: 'reader', engine }] }, 'workers.yaml').workers[0];
    const original = verifierArgs(worker, '.', 'Read', 'last.txt', ['sample']);
    const resumed = verifierArgs(worker, '.', 'Read', 'last.txt', ['sample'], 'saved-session');
    const flag = engine === 'codex-cli' ? 'resume' : '--resume';
    const index = resumed.indexOf(flag);
    assert.deepEqual(resumed.splice(index, 2), [flag, 'saved-session']);
    assert.deepEqual(resumed, original);
  }
});

test('restarting the second read-only phase retains only the earlier guidance', () => {
  const { orders } = tempOrders();
  const project = config([plan, { id: 'refine', mode: 'read-only' }, write]);
  const tag = 'CACHE';
  orders.add({ tag, kind: 'code', title: 'Cache keys' });
  orders.act(tag, 'queue');
  for (const [phase, next] of [['inspect', 'refine'], ['refine', 'build'], ['build', undefined]]) {
    orders.runStart(tag, { worker: 'reader', extra: { phase, next_phase: next, final_phase: !next } });
    orders.runEnd(tag);
    orders.report(tag, { status: 'ready', summary: 'Checked', evidence: [], commits: [], ...(next ? { plan: phase } : {}) });
  }
  const handoff = phasePrompt(orderPhases(project, orders.get(tag)));
  assert.match(handoff, /Plan from phase refine/);
  assert.doesNotMatch(handoff, /Plan from phase inspect/);
  orders.act(tag, 'rework', { phase: 'refine', note: 'Refine the key' });
  const state = orderPhases(project, orders.get(tag))!;
  assert.equal(state.current.id, 'refine');
  assert.equal(state.planOf(state.list[0])?.text, 'inspect');
  assert.equal(state.planOf(state.list[1]), undefined);
});

test('plans have a UTF-8 byte limit independent of the one-line summary', () => {
  const text = '\u{1F4C4}'.repeat(6 * 1024);
  const input = { status: 'ready', summary: 'Plan prepared', plan: text };
  assert.equal(validateReport(input).plan, text);
  assert.throws(() => validateReport({ ...input, plan: text + 'x' }), /24 KiB/);
});

test('a phase role must admit a worker that can enforce read-only execution', () => {
  const project = config([plan, write]);
  const workers = validateWorkers({ workers: [
    { id: 'local', engine: 'script' },
    { id: 'reader', engine: 'claude-cli', launch: { program: 'fake', args: ['{prompt_file}'] } },
  ], roles: { reader: { workers: { only: ['local'] } } } }, 'workers.yaml');
  assert.throws(() => validatePhaseWorkers(project, workers), /read-only/);
  workers.roles!.reader.workers!.only = ['reader'];
  validatePhaseWorkers(project, workers);
  const { orders } = tempOrders();
  orders.add({ tag: 'KEY', title: 'Cache key', kind: 'code', worker: 'local', planned: true });
  const preview = draftPreview(project, orders, { tag: 'KEY', title: 'Cache key', kind: 'code', body: 'Check the key.', needs: [] },
    workers.workers.map(config => ({ config, available: true, running: 0, runsToday: 0, reasons: [] })), workers);
  assert.equal(preview.route.chosen, 'reader');
});
