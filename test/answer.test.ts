import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { answerOrder } from '../src/run/answer.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const QUESTION = 'Should the table use 12 or 16 columns?';

/** An order whose first run (by `worker`, session `s-1`) ended with a question. */
function asked(worker = 'resumable') {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-table.md'), '# T1\nBuild the table.\n');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Table', kind: 'k' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker, session: 's-1', extra: { template: worker, session: 's-1' } });
  orders.runEnd('T1');
  orders.report('T1', { status: 'waiting', summary: 'need a decision', question: QUESTION, evidence: [], commits: [] });
  const spawned: { program: string; args: string[] }[] = [];
  const probes = {
    now: () => new Date('2026-01-01T12:00:00Z'), spawnDetached: (program: string, args: string[]) => { spawned.push({ program, args }); return 4242; },
    fileTime: () => undefined, readText: () => undefined, tail: () => '', isAlive: () => false, worktrees: () => [], gitActivity: () => ({}), runCommand: () => '[]', freeRamGb: () => 32,
  } as unknown as Probes;
  const workers = validateWorkers({
    workers: [
      // the Codex shape: `exec resume <id>` has no -C or -s, so those go only with a new session
      { id: 'resumable', engine: 'codex-cli', launch: { program: 'coder', args: ['exec', '{session_args}', '-o', '{last_file}', 'Read the UTF-8 file {prompt_file} in full and follow it exactly.'], session: { new: ['-C', '{cwd}'], resume: ['resume', '{session_id}'] } } },
      { id: 'plain', engine: 'other-cli', launch: { program: 'plain', args: ['run', '-C', '{cwd}', '{prompt_file}'] } },
      { id: 'editor', engine: 'claude-session' },
    ],
  }, 'w.yaml');
  return { orders, project, probes, workers, spawned, ctx: { project, orders, workers, probes } };
}

test('answer: an engine that can continue its conversation is resumed with only the answer in the prompt', () => {
  const { orders, ctx, spawned } = asked('resumable');
  assert.equal(orders.stage(orders.get('T1')).stage, 'awaiting-user');
  const r = answerOrder(ctx, 'T1', '16 columns, the map needs it');
  assert.equal(r.started?.resumed, true);
  assert.equal(r.stage, 'running');
  assert.match(r.message, /session of run r1 continues as run r2/);
  assert.deepEqual(spawned[0].args.slice(0, 4), ['exec', '--json', 'resume', 's-1']);
  assert.ok(!spawned[0].args.includes('-C'));
  const doc = orders.get('T1');
  assert.equal(doc.runs[1].note, '16 columns, the map needs it');
  assert.equal(doc.runs[1].session, 's-1');
  assert.equal(doc.actions.at(-1)?.kind, 'answer');
  const prompt = readFileSync(doc.runs[1].prompt_file!, 'utf8');
  assert.match(prompt, /You asked: Should the table use 12 or 16 columns\?/);
  assert.match(prompt, /16 columns, the map needs it/);
  assert.match(prompt, /alba-report/);
  assert.ok(!/Read the UTF-8 file/.test(prompt));       // the conversation already has the order
});

test('answer: an engine without sessions gets a new run whose prompt carries the question and the answer', () => {
  const { orders, ctx, spawned } = asked('plain');
  const r = answerOrder(ctx, 'T1', 'use 12');
  assert.equal(r.started?.resumed, false);
  assert.match(r.message, /new session/);
  assert.deepEqual(spawned[0].args.slice(0, 2), ['run', '-C']);
  const prompt = readFileSync(orders.get('T1').runs[1].prompt_file!, 'utf8');
  assert.match(prompt, /Read the UTF-8 file .*T1-table\.md/);
  assert.match(prompt, /## Answer to your question\n\nYou asked: Should the table use 12 or 16 columns\?\n\nuse 12/);
});

test('answer: a full kind cap records the answer and leaves the order queued', () => {
  const { orders, project, probes, workers, spawned } = asked('plain');
  project.dispatch.caps = { k: 0 };
  const r = answerOrder({ project, orders, workers, probes }, 'T1', 'use 12');
  assert.equal(r.stage, 'queued');
  assert.match(r.message, /waiting for a free slot/);
  assert.equal(spawned.length, 0);
  assert.equal(orders.stage(orders.get('T1')).stage, 'queued');
});

test('answer: a worker the tool cannot start keeps the answer for the next round; an answer needs text and a question to answer', () => {
  const { orders, ctx, spawned } = asked('editor');
  const r = answerOrder(ctx, 'T1', 'use 12');
  assert.equal(r.started, undefined);
  assert.equal(r.stage, 'queued');
  assert.equal(spawned.length, 0);
  assert.equal(orders.get('T1').actions.at(-1)?.note, 'use 12');
  // answered once: it is queued now, not waiting for an answer
  assert.throws(() => answerOrder(ctx, 'T1', 'again'), /cannot answer an order that is queued/);
  const fresh = asked('plain');
  assert.throws(() => answerOrder(fresh.ctx, 'T1', '  '), /needs its text/);
  fresh.orders.act('T1', 'cancel');
  assert.throws(() => answerOrder(fresh.ctx, 'T1', 'x'), /cannot answer an order that is cancelled/);
});
