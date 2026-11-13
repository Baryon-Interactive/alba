import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { startRun } from '../src/run/launch.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repository with three queued `ue` orders and a cap of two. */
function fixture(resources?: Record<string, unknown>) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  for (const tag of ['U1', 'U2', 'U3', 'S1']) {
    writeFileSync(path.join(workOrders, `${tag}-work.md`), `# ${tag}\nWork.\n`);
    orders.add({ tag, title: `Work ${tag}`, kind: tag.startsWith('U') ? 'ue' : 'sim', ...(resources && tag === 'U1' ? { uses: ['editor-build'] } : {}) });
    orders.act(tag, 'queue');
  }
  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main', caps: { ue: 2 } },
    ...(resources ? { resources } : {}),
  }, path.join(dir, 'alba.yaml'));
  return { orders, project };
}

const probes = (): Probes => ({
  now: () => new Date('2026-01-01T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
  fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined,
  spawnDetached: () => 4242,
});

const workers = () => validateWorkers({
  workers: [{ id: 'coder', engine: 'codex-cli', launch: { template: 'coder-v1', program: 'coder', args: ['exec', '-C', '{cwd}', '-o', '{last_file}', 'Read the UTF-8 file {prompt_file} in full and follow it exactly.'] } }],
}, 'w.yaml');

test('a person\'s start is refused while the kind cap is full, and --over-cap starts it anyway', () => {
  const { orders, project } = fixture();
  const ctx = { project, orders, workers: workers(), probes: probes() };
  startRun(ctx, 'U1', 'coder');
  startRun(ctx, 'U2', 'coder');
  assert.throws(() => startRun(ctx, 'U3', 'coder'), /U3 cannot start now: cap for "ue" is full \(2\/2: U1, U2\)\. .*--over-cap/);
  assert.throws(() => startRun(ctx, 'U3', 'coder', { dryRun: true }), /cap for "ue" is full/);
  // another kind is not held back
  assert.equal(startRun(ctx, 'S1', 'coder').mode, 'start');
  const over = startRun(ctx, 'U3', 'coder', { overCap: true });
  assert.ok(over.mode === 'start');
  assert.equal(over.run, 'r1');
  const prompt = readFileSync(orders.get('U3').runs[0].prompt_file!, 'utf8');
  assert.match(prompt, /## Slots this run holds/);
  assert.match(prompt, /holds a `ue` slot \(the project runs at most 2 `ue` orders at once; also running now: U1, U2\)/);
  assert.match(prompt, /started this run over the cap/);
});

test('the tick\'s own start is checked again with the rework reserve it planned, and no more', () => {
  const { orders, project } = fixture();
  const ctx = { project, orders, workers: workers(), probes: probes() };
  startRun(ctx, 'U1', 'coder');
  startRun(ctx, 'U2', 'coder');
  // A plan made before another start took the last slot no longer starts the order.
  assert.throws(() => startRun(ctx, 'U3', 'coder', { capsChecked: true }), /^Error: U3 cannot start now: cap for "ue" is full \(2\/2: U1, U2\)\.$/);
  assert.equal(orders.get('U3').runs.length, 0);
  assert.equal(startRun(ctx, 'U3', 'coder', { capsChecked: true, capReserve: 1 }).mode, 'start');
  assert.doesNotMatch(readFileSync(orders.get('U3').runs[0].prompt_file!, 'utf8'), /over the cap/);
});

test('the worker is told which slot and resources its run holds; an uncapped kind gets no section', () => {
  const { orders, project } = fixture({ 'editor-build': { slots: 3 } });
  const ctx = { project, orders, workers: workers(), probes: probes() };
  startRun(ctx, 'U1', 'coder');
  const prompt = readFileSync(orders.get('U1').runs[0].prompt_file!, 'utf8');
  assert.match(prompt, /holds a `ue` slot \(the project runs at most 2 `ue` orders at once\)\. Work that the order or its skills allow only to whoever holds the `ue` slot is yours/);
  assert.match(prompt, /holds the resource `editor-build`/);
  startRun(ctx, 'S1', 'coder');
  assert.doesNotMatch(readFileSync(orders.get('S1').runs[0].prompt_file!, 'utf8'), /Slots this run holds/);
});
