import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { detail } from '../src/api/views.ts';
import { loadProject, validateProject } from './state-helper.ts';
import { pendingNotes, promptFor } from '../src/run/prompt.ts';
import { startRun } from '../src/run/launch.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { alba, projectDir } from './cli-helper.ts';
import { ready, tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WORKERS = {
  workers: [
    { id: 'coder', engine: 'x', on_limit: 'rotate', concurrency: 1, launch: { template: 'c1', program: 'coder', args: ['run', '{session_args}', '{prompt_file}'], session: { new: ['-s', '{session_id}'], resume: ['-r', '{session_id}'] } } },
    { id: 'spare', engine: 'y', concurrency: 2, launch: { template: 's1', program: 'spare', args: ['run', '{session_args}', '{prompt_file}'], session: { new: ['-s', '{session_id}'], resume: ['-r', '{session_id}'] } } },
    { id: 'weak', engine: 'z', concurrency: 2, launch: { template: 'w1', program: 'weak', args: ['run', '{prompt_file}'] } },
  ],
};

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
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  return { orders, dir, project };
}

function probes(over: Partial<Probes> = {}): Probes {
  return { now: () => new Date('2026-01-02T00:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => 4242, ...over } as Probes;
}

test('a note survives a failed start, two capacity endings and a rotation, and is dropped after a completed run with a real report', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'T1', title: 't', kind: 'sim' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'w' });
  orders.report('T1', ready);
  orders.runEnd('T1', 'completed');
  orders.act('T1', 'rework', { note: 'keep the doorway' });
  orders.runStart('T1', { worker: 'w' });
  assert.equal(pendingNotes(orders.get('T1')).length, 1);          // an open run has not followed it
  orders.runEnd('T1', 'failed');
  assert.deepEqual(pendingNotes(orders.get('T1')).map(n => n.text), ['keep the doorway']);
  orders.runStart('T1', { worker: 'w' });
  orders.runEnd('T1', 'completed');
  orders.report('T1', { ...ready, source: 'inferred' });
  orders.report('T1', { ...ready, source: 'inferred-git' });
  assert.deepEqual(pendingNotes(orders.get('T1')).map(n => n.text), ['keep the doorway']);
  orders.report('T1', ready);
  assert.deepEqual(pendingNotes(orders.get('T1')), []);
  orders.act('T1', 'rework', { note: 'once more' });
  orders.runStart('T1', { worker: 'w' });
  orders.runEnd('T1', 'cancelled');
  assert.deepEqual(pendingNotes(orders.get('T1')), []);             // a person stopping the run follows notes already written
});

test('a rework note is handed on through two capacity endings and a rotation, then dropped by a real report', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const ctx = { project: f.project, orders: f.orders, workers, probes: probes() };
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' });
  f.orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'coder');
  f.orders.report('T1', ready);
  f.orders.runEnd('T1', 'completed');
  f.orders.act('T1', 'rework', { note: 'keep the doorway' });
  const sent = pendingNotes(f.orders.get('T1'))[0].at;

  startRun(ctx, 'T1', 'coder');
  f.orders.runEnd('T1', 'capacity');
  let prompt = promptFor(f.project.work_orders, f.orders.get('T1'));
  assert.match(prompt, /## Rework requested by the reviewer\n\nkeep the doorway/);
  assert.match(prompt, new RegExp(`Sent ${sent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));

  startRun(ctx, 'T1', 'coder');
  f.orders.runEnd('T1', 'capacity');
  prompt = promptFor(f.project.work_orders, f.orders.get('T1'));
  assert.match(prompt, /keep the doorway/);
  assert.equal(f.orders.get('T1').runs.at(-1)!.note, 'keep the doorway');

  const plan = tick(f.project, f.orders, workers, probes(), { record: false }).report;
  assert.deepEqual(plan.moves.map(m => [m.worker, m.rotated?.from]), [['spare', 'coder']]);
  startRun(ctx, 'T1', 'spare', { rotate: { from: 'coder', reason: 'the model service was at capacity' } });
  const handed = f.orders.get('T1').runs.at(-1)!;
  assert.equal(handed.note, 'keep the doorway');
  assert.match(readFileSync(handed.handoff_file!, 'utf8'), /keep the doorway/);
  assert.equal(pendingNotes(f.orders.get('T1')).length, 1);         // the new run is still open

  f.orders.runEnd('T1', 'completed');
  f.orders.report('T1', { ...ready, source: 'inferred' });
  const view = detail({ config: f.project, orders: f.orders }, 'T1', { probes: probes(), workers });
  assert.deepEqual(view.pendingNotes.map(n => n.text), ['keep the doorway']);
  f.orders.report('T1', ready);
  assert.deepEqual(pendingNotes(f.orders.get('T1')), []);
  assert.deepEqual(detail({ config: f.project, orders: f.orders }, 'T1', { probes: probes(), workers }).pendingNotes, []);
});

test('two rework notes stay in order, oldest first, with their times', () => {
  const { orders, dir } = tempOrders();
  const file = projectDir(dir);
  writeFileSync(path.join(dir, 'orders', 'T1-x.md'), '# T1\nDo it.\n');
  orders.add({ tag: 'T1', title: 'Two notes', kind: 'sim' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'w' });
  orders.report('T1', ready);
  orders.runEnd('T1', 'completed');
  orders.act('T1', 'rework', { note: 'first note', force: true });
  orders.act('T1', 'rework', { note: 'second note', force: true });
  const notes = pendingNotes(orders.get('T1'));
  assert.deepEqual(notes.map(n => n.text), ['first note', 'second note']);
  assert.ok(notes[0].at < notes[1].at);
  const prompt = promptFor(path.join(dir, 'orders'), orders.get('T1'));
  assert.match(prompt, /## Notes still waiting/);
  assert.ok(prompt.indexOf(`### ${notes[0].at} — rework`) < prompt.indexOf('first note'));
  assert.ok(prompt.indexOf('first note') < prompt.indexOf(`### ${notes[1].at} — rework`));
  assert.ok(prompt.indexOf(`### ${notes[1].at} — rework`) < prompt.indexOf('second note'));
  const started = orders.runStart('T1', { worker: 'w' });
  assert.equal(started.run.note, 'first note\n\nsecond note');
  orders.runEnd('T1', 'capacity');
  assert.equal(orders.runStart('T1', { worker: 'other' }).run.note, 'first note\n\nsecond note');

  const shown = alba(file, ['orders', 'show', 'T1']);
  assert.equal(shown.code, 0);
  const section = shown.out.split('Notes still waiting:')[1]?.split('Actions:')[0] ?? '';
  assert.match(section, /first note/);
  assert.ok(section.indexOf(notes[0].at) < section.indexOf('first note'));
  assert.ok(section.indexOf('first note') < section.indexOf(notes[1].at));
  assert.ok(section.indexOf(notes[1].at) < section.indexOf('second note'));
  const cfg = loadProject(file);
  const view = detail({ config: cfg, orders }, 'T1', { probes: probes() });
  assert.deepEqual(view.pendingNotes.map(n => [n.kind, n.text, n.at]), notes.map(n => [n.kind, n.text, n.at]));
  assert.equal(existsSync(path.join(dir, 'orders', 'T1-x.md')), true);
});
