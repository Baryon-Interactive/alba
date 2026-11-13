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

test('<TAG>.last.txt and <TAG>.progress.json in a work-order folder inside the repository stay out of git and out of the merge\'s way', () => {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  const workOrders = path.join(root, 'work-orders');
  mkdirSync(workOrders, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(workOrders, 'T1-work.md'), '# T1\nWork.\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
  }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Work', kind: 'sim' });
  orders.act('T1', 'queue');
  const probes: Probes = {
    now: () => new Date('2026-01-01T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined, spawnDetached: () => 4242,
  };
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', launch: { template: 'c', program: 'coder', args: ['{prompt_file}'] } }] }, 'w.yaml');
  const r = startRun({ project, orders, workers, probes }, 'T1', 'coder');
  assert.ok(r.mode === 'start');
  // What alba and the worker leave in the main checkout's work-order folder.
  writeFileSync(path.join(workOrders, 'T1.last.txt'), 'final message');
  writeFileSync(path.join(workOrders, 'T1.progress.json'), '{"plan":[]}');
  assert.equal(git(root, 'status', '--porcelain'), '');
  // A worker that commits everything: its own progress file is not taken, so the branch carries only the work.
  writeFileSync(path.join(r.cwd, 'work-orders', 'T1.progress.json'), '{"plan":[{"step":"a","status":"done"}]}');
  writeFileSync(path.join(r.cwd, 'b.txt'), 'b');
  git(r.cwd, 'add', '-A');
  git(r.cwd, 'commit', '-q', '-m', 'work');
  assert.deepEqual(git(r.cwd, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['b.txt']);
  // A branch from before (it committed its progress file): the merge goes through over the ignored copy.
  git(r.cwd, 'add', '-f', 'work-orders/T1.progress.json');
  git(r.cwd, 'commit', '-q', '-m', 'progress');
  git(root, 'merge', '-q', '--no-edit', r.branch);
  assert.match(readFileSync(path.join(workOrders, 'T1.progress.json'), 'utf8'), /"done"/);
  assert.equal(readFileSync(path.join(workOrders, 'T1.last.txt'), 'utf8'), 'final message');
});
