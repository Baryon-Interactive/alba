import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { startRun } from '../src/run/launch.ts';
import { tick, type Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { ready, tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture() {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'R1-present.md'), '# R1\nPresentation.\n');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  const launch = (program: string) => ({ template: program, program, args: ['{prompt_file}'] });
  const workers = validateWorkers({ workers: [{ id: 'codex-paid', engine: 'codex-cli', launch: launch('codex') }, { id: 'claude-sonnet', engine: 'claude-cli', launch: launch('claude') }] }, 'w.yaml');
  const probes: Probes = {
    now: () => new Date('2026-01-01T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => 4242,
  };
  orders.add({ tag: 'R1', title: 'Presentation', kind: 'ue', worker: 'codex-paid' });
  orders.act('R1', 'queue');
  return { orders, project, workers, probes };
}

test('a person\'s run on another worker becomes the order\'s worker, so the tick sends the rework there too', () => {
  const f = fixture();
  startRun(f, 'R1', 'claude-sonnet', { explicitWorker: true });
  assert.equal(f.orders.get('R1').order.worker, 'claude-sonnet');
  assert.ok(f.orders.store.events({ tag: 'R1' }).some(e => e.type === 'worker-set' && e.data?.from === 'codex-paid' && e.data?.to === 'claude-sonnet'));
  f.orders.runEnd('R1'); f.orders.report('R1', ready);
  f.orders.act('R1', 'rework', { note: 'Brighter title card' });
  const plan = tick(f.project, f.orders, f.workers, f.probes, { record: false });
  assert.equal(plan.report.moves.find(m => m.tag === 'R1')?.worker, 'claude-sonnet');
});

test('queue on a held order releases it (and queues it when it had ended)', () => {
  const f = fixture();
  startRun(f, 'R1', 'codex-paid');
  f.orders.act('R1', 'hold');
  assert.equal(f.orders.stage(f.orders.get('R1')).stage, 'held');
  f.orders.act('R1', 'queue');
  assert.equal(f.orders.stage(f.orders.get('R1')).stage, 'queued');
  assert.equal(f.orders.get('R1').actions.at(-1)!.kind, 'release');
});
