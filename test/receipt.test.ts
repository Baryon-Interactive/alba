import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { parseProgress, readReceipt } from '../src/run/progress.ts';
import { startRun } from '../src/run/launch.ts';
import { summaryOf } from '../src/api/views.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const WORKERS = { workers: [{ id: 'coder', engine: 'x', concurrency: 1, launch: { template: 'c1', program: 'coder', args: ['run', '{prompt_file}'] } }] };
let START = '2026-01-01T00:30:00Z';       // set to the start of the run the fixture opens (the test clock moves a minute per call)

function fixture() {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-x.md'), '# T1\nDo it.\n');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main', stall_minutes: 120 } }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const at = { now: START };
  const probes = (over: Partial<Probes> = {}): Probes => ({ now: () => new Date(at.now), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined, spawnDetached: () => 4242, ...over }) as Probes;
  orders.add({ tag: 'T1', title: 'x', kind: 'sim' }); orders.act('T1', 'queue');
  startRun({ project, orders, workers, probes: probes() }, 'T1', 'coder');
  START = orders.get('T1').runs[0].started;
  at.now = START;
  return { orders, project, workers, at, probes };
}

test('the worker\'s step list is read as done, total and the step in hand', () => {
  const p = parseProgress(JSON.stringify({ plan: [{ step: 'read the order', status: 'done' }, { step: 'write the loader', status: 'doing' }, { step: 'test', status: 'todo' }], note: 'halfway' }), 'AT')!;
  assert.deepEqual([p.done, p.total, p.current, p.note, p.at], [1, 3, 'write the loader', 'halfway', 'AT']);
  assert.equal(parseProgress(JSON.stringify({ plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'todo' }] }), 'AT')!.current, 'b');   // no "doing": the first not done
  assert.equal(parseProgress('{"plan": [', 'AT'), undefined);                 // half-written file
  assert.equal(parseProgress('{"steps": []}', 'AT'), undefined);
  assert.equal(parseProgress('﻿{"plan":[]}', 'AT')!.total, 0);
});

test('no receipt and no commit after dispatch.start_receipt_minutes is a failed start, listed before the stall limit; a receipt or a commit clears it', () => {
  const f = fixture();
  const run = () => tick(f.project, f.orders, f.workers, f.probes(over.p), { record: false });
  const over: { p: Partial<Probes> } = { p: {} };
  const look = (minutes: number) => { f.at.now = new Date(Date.parse(START) + minutes * 60000).toISOString(); return run().report.problems.filter(p => p.kind === 'start-failed'); };
  assert.deepEqual(look(10), []);                                           // inside the 15 minutes
  const late = look(16);
  assert.equal(late.length, 1);                                             // stall_minutes is 120: this is much earlier
  assert.match(late[0].text, /T1: the run began 16 min ago and has written no start receipt/);
  assert.equal(run().report.problems.filter(p => p.kind === 'stalled').length, 0);
  // a receipt written after the start clears it
  const file = path.join(f.project.work_orders, 'T1.progress.json');
  writeFileSync(file, JSON.stringify({ plan: [{ step: 'a', status: 'doing' }, { step: 'b', status: 'todo' }] }));
  over.p = { fileTime: (x: string) => (x === file.replace(/\\/g, '/') || x === file ? new Date(Date.parse(START) + 2 * 60000).toISOString() : undefined), readText: (x: string) => (x === file ? JSON.stringify({ plan: [{ step: 'a', status: 'done' }, { step: 'b', status: 'doing' }, { step: 'c', status: 'todo' }] }) : undefined) };
  assert.deepEqual(look(16), []);
  const result = run();
  assert.deepEqual([result.activity.T1.progress?.done, result.activity.T1.progress?.total, result.activity.T1.progress?.current], [1, 3, 'b']);
  // a receipt left from an earlier run does not count for this one
  over.p = { fileTime: (x: string) => (x === file ? new Date(Date.parse(START) - 60 * 60000).toISOString() : undefined) };
  assert.equal(look(16).length, 1);
  // a commit since the start does, too
  over.p = { gitActivity: () => ({ lastCommitAt: new Date(Date.parse(START) + 5 * 60000).toISOString() }) };
  assert.deepEqual(look(16), []);
  // switched off by leaving the limit out is not possible, but a longer limit waits longer
  f.project.dispatch.start_receipt_minutes = 30;
  over.p = {};
  assert.deepEqual(look(16), []);
  assert.equal(look(31).length, 1);
});

test('the list view of a running order carries its steps', () => {
  const f = fixture();
  const file = path.join(f.project.work_orders, 'T1.progress.json');
  writeFileSync(file, '');
  const text = JSON.stringify({ plan: [{ step: 'a', status: 'done' }, { step: 'b', status: 'done' }, { step: 'c', status: 'doing' }] });
  const probes = f.probes({ fileTime: (x: string) => (x === file ? START : undefined), readText: (x: string) => (x === file ? text : undefined) });
  const result = tick(f.project, f.orders, f.workers, probes, { record: false });
  const doc = f.orders.get('T1');
  const summary = summaryOf(f.project, doc, f.orders.stage(doc), { probes, workers: f.workers } as never, result.activity.T1);
  assert.deepEqual([summary.progress?.done, summary.progress?.total, summary.progress?.current], [2, 3, 'c']);
});

test('a receipt only in the worktree counts as started and supplies the board steps; the newer copy wins', () => {
  const f = fixture();
  f.project.work_orders = path.join(f.project.root, 'work-orders');
  const tree = f.orders.get('T1').order.worktree!;
  const rootFile = path.join(f.project.work_orders, 'T1.progress.json');
  const treeFile = path.join(tree, 'work-orders', 'T1.progress.json');
  const recent = new Date(Date.parse(START) + 60000).toISOString();
  const text = JSON.stringify({ plan: [{ step: 'implement', status: 'doing' }] });
  f.at.now = new Date(Date.parse(START) + 16 * 60000).toISOString();
  const probes = f.probes({ fileTime: file => file === treeFile ? recent : undefined, readText: file => file === treeFile ? text : undefined });
  const result = tick(f.project, f.orders, f.workers, probes, { record: false });
  assert.equal(result.report.problems.some(p => p.kind === 'start-failed'), false);
  assert.equal(result.activity.T1.progress?.current, 'implement');
  assert.equal(readReceipt(f.project, f.probes({ fileTime: file => file === rootFile ? f.at.now : recent, readText: () => text }), 'T1', tree)?.at, f.at.now);
  // An external work-order folder must never be rebased into a worktree.
  f.project.work_orders = path.join(f.project.root, '..', 'external');
  const looked: string[] = [];
  readReceipt(f.project, f.probes({ fileTime: file => { looked.push(file); return undefined; } }), 'T1', tree);
  assert.deepEqual(looked, [path.join(f.project.work_orders, 'T1.progress.json')]);
});
