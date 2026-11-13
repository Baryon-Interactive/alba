import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { readInbox } from '../src/run/inbox.ts';
import { pickupOutbox, threadOf, unanswered } from '../src/run/messages.ts';
import { answerOrder } from '../src/run/answer.ts';
import { nudgeSentence } from '../src/run/nudge.ts';
import { pendingNotes, promptFor } from '../src/run/prompt.ts';
import { sayToOrder } from '../src/run/say.ts';
import { startRun } from '../src/run/launch.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { ready, tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WORKERS = {
  workers: [
    { id: 'coder', engine: 'x', on_limit: 'rotate', concurrency: 1, launch: { template: 'c1', program: 'coder', args: ['run', '{session_args}', '{prompt_file}'], session: { new: ['-s', '{session_id}'], resume: ['-r', '{session_id}'] } } },
  ],
};

test('a message without an open run waits in notes and the next prompt, without resetting review or monitoring', () => {
  const f = fixture(), workers = validateWorkers(WORKERS, 'w.yaml');
  f.orders.add({ tag: 'T1', title: 'A sample', kind: 'sim' });
  f.orders.runStart('T1', { worker: 'coder' }); f.orders.runEnd('T1'); f.orders.report('T1', ready);
  const result = sayToOrder({ project: f.project, orders: f.orders, workers, probes: probes() }, 'T1', 'Check the sample again');
  assert.match(result.message, /queued for the next run/);
  assert.equal(result.stage, 'awaiting-review');
  assert.match(promptFor(f.project.work_orders, f.orders.get('T1')), /Check the sample again/);
  f.orders.act('T1', 'rework', { note: 'Fix the sample' });
  assert.match(promptFor(f.project.work_orders, f.orders.get('T1')), /Check the sample again/);
  startRun({ project: f.project, orders: f.orders, workers, probes: probes() }, 'T1', 'coder');
  assert.match(readFileSync(f.orders.get('T1').runs.at(-1)!.prompt_file!, 'utf8'), /Check the sample again/);
});

test('a queued message preserves monitoring and reaches its resumed prompt', () => {
  const f = fixture(), workers = validateWorkers(WORKERS, 'w.yaml'), p = probes();
  const ctx = { project: f.project, orders: f.orders, workers, probes: p };
  f.orders.add({ tag: 'T1', title: 'A sample', kind: 'sim' }); f.orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'coder'); f.orders.runEnd('T1');
  f.orders.report('T1', { status: 'monitoring', summary: 'A sample job is running', evidence: [], commits: [], monitor: { check: ['sample-status'], done_when: { exit_code: 0 }, deadline_minutes: 30, note: 'Read the sample results.' } });
  assert.equal(sayToOrder(ctx, 'T1', 'Use the corrected source').stage, 'monitoring');
  f.orders.monitorResolved('T1', 'done', 'Finished', 'Read the results.');
  startRun(ctx, 'T1', 'coder');
  assert.match(readFileSync(f.orders.get('T1').runs.at(-1)!.prompt_file!, 'utf8'), /Use the corrected source/);
});

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
  return { orders, project };
}

function probes(over: Partial<Probes> = {}): Probes & { killed: number[]; spawned: string[][] } {
  const killed: number[] = [];
  const spawned: string[][] = [];
  return {
    now: () => new Date('2026-01-02T00:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined,
    kill(pid: number) { killed.push(pid); return [pid]; },
    spawnDetached(_program: string, args: string[]) { spawned.push(args); return 4242; },
    ...over,
    killed, spawned,
  };
}

test('a message is appended to the worktree inbox and excluded there, never by .gitignore', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const ctx = { project: f.project, orders: f.orders, workers, probes: probes() };
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' });
  f.orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'coder');
  const r = sayToOrder(ctx, 'T1', 'look at the doorway');
  assert.equal(r.restarted, false);
  assert.match(r.message, /Message left for T1/);
  const worktree = f.orders.get('T1').order.worktree!;
  const inbox = readInbox(worktree);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'cli');
  assert.equal(inbox[0].text, 'look at the doorway');
  assert.equal(inbox[0].seen, undefined);
  const exclude = execFileSync('git', ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
  assert.match(readFileSync(path.resolve(worktree, exclude), 'utf8'), /\.alba\/inbox\.md/);
  for (const file of [path.join(f.project.root, '.gitignore'), path.join(worktree, '.gitignore')]) {
    assert.equal(existsSync(file) && readFileSync(file, 'utf8').includes('.alba/inbox.md'), false);
  }
  assert.equal(/inbox/.test(git(worktree, 'status', '--short')), false);
  const ev = f.orders.store.events().find(e => e.type === 'message')!;
  assert.equal(ev.by, 'cli');
  assert.equal(ev.data!.text, 'look at the doorway');
  assert.equal(ev.data!.run, 'r1');
});

test('outbox pickup waits for a person while the run stays open; reply and acknowledgement share ids', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const ctx = { project: f.project, orders: f.orders, workers, probes: probes() };
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' });
  f.orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'coder');
  const worktree = f.orders.get('T1').order.worktree!;
  const file = path.join(worktree, '.alba', 'outbox.jsonl');
  writeFileSync(file, JSON.stringify({ at: '2026-01-02T00:00:00Z', kind: 'question', text: 'Which door?', options: ['North', 'South'] }) + '\n' + '{"type":');
  pickupOutbox(f.orders, 'T1');
  pickupOutbox(f.orders, 'T1');
  let doc = f.orders.get('T1');
  assert.equal(doc.outbox?.length, 1);
  assert.equal(f.orders.stage(doc).stage, 'awaiting-user');
  assert.equal(doc.runs[0].ended, undefined);
  const id = doc.outbox![0].id;
  sayToOrder(ctx, 'T1', 'North', { reply: id });
  doc = f.orders.get('T1');
  assert.equal(f.orders.stage(doc).stage, 'running');
  assert.equal(doc.outbox?.[0].answered?.text, 'North');
  const msg = readInbox(worktree)[0];
  assert.equal(msg.reply, id);
  assert.ok(msg.id);
  assert.equal(msg.delivery, 'sent');
  writeFileSync(path.join(worktree, '.alba', 'inbox-ack'), msg.id + '\n');
  assert.equal(readInbox(worktree)[0].delivery, 'read');
  assert.equal(threadOf(doc).find(e => e.id === id)?.delivery, 'answered');
});

test('--restart stops only a process this run started, then carries the message in the continued session', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const started = f.orders;
  started.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' });
  started.act('T1', 'queue');
  const boot = probes();
  startRun({ project: f.project, orders: started, workers, probes: boot }, 'T1', 'coder');
  const run = started.get('T1').runs[0];
  assert.equal(run.pid, 4242);

  const foreign = probes({ isAlive: () => true, processStartedAt: () => new Date(Date.parse(run.started) + 10 * 60000).toISOString() });
  assert.throws(() => sayToOrder({ project: f.project, orders: started, workers, probes: foreign }, 'T1', 'change the door', { restart: true }), /Refusing to stop/);
  assert.deepEqual(foreign.killed, []);
  assert.equal(started.get('T1').runs[0].ended, undefined);

  const unread = probes({ isAlive: () => true, processStartedAt: () => undefined });
  assert.throws(() => sayToOrder({ project: f.project, orders: started, workers, probes: unread }, 'T1', 'change the door', { restart: true }), /Refusing to stop/);
  assert.deepEqual(unread.killed, []);

  const dead = probes({ isAlive: () => false });
  const quiet = sayToOrder({ project: f.project, orders: started, workers, probes: dead }, 'T1', 'the process was already gone', { restart: true });
  assert.deepEqual(dead.killed, []);
  assert.equal(quiet.restarted, true);
  assert.equal(quiet.started?.resumed, true);
  assert.equal(started.get('T1').runs[0].outcome, 'cancelled');
  assert.deepEqual(pendingNotes(started.get('T1')).map(n => n.text), ['the process was already gone']);
  const continued = readFileSync(started.get('T1').runs[1].prompt_file!, 'utf8');
  assert.match(continued, /the process was already gone/);
  assert.match(continued, /## Message/);
  assert.equal(/Read the UTF-8 file/.test(continued), false);
  assert.deepEqual(dead.spawned.at(-1)!.slice(0, 2), ['run', '-r']);
});

test('--restart uses the recorded OS creation time and leaves the run open when a tree stop is refused', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' });
  f.orders.act('T1', 'queue');
  const at = '2026-01-02T00:00:01.123Z';
  startRun({ project: f.project, orders: f.orders, workers, probes: probes({ processStartedAt: () => at }) }, 'T1', 'coder');
  const run = f.orders.get('T1').runs[0];
  assert.equal(run.process_started_at, at);
  const refused = probes({ isAlive: () => true, processStartedAt: () => at, kill: () => [] });
  assert.throws(() => sayToOrder({ project: f.project, orders: f.orders, workers, probes: refused }, 'T1', 'change the door', { restart: true }), /Refusing to stop/);
  assert.equal(f.orders.get('T1').runs[0].ended, undefined);
  assert.deepEqual(refused.spawned, []);
  const reused = probes({ isAlive: () => true, processStartedAt: () => new Date(Date.parse(at) + 1).toISOString() });
  assert.throws(() => sayToOrder({ project: f.project, orders: f.orders, workers, probes: reused }, 'T1', 'change the door', { restart: true }), /Refusing to stop/);
  assert.deepEqual(reused.killed, []);
  const own = probes({ isAlive: () => true, processStartedAt: () => at });
  own.kill = (pid, expected) => { assert.deepEqual([pid, expected], [4242, at]); own.killed.push(pid); return [pid]; };
  const r = sayToOrder({ project: f.project, orders: f.orders, workers, probes: own }, 'T1', 'change the door', { restart: true });
  assert.deepEqual(own.killed, [4242]);
  assert.equal(r.restarted, true);
  assert.match(r.message, /session of run r1 continues as run r2/);
  assert.equal(f.orders.get('T1').runs[1].session, run.session);
  assert.deepEqual(pendingNotes(f.orders.get('T1')).map(n => n.kind), ['message']);
});

test('say refuses a message with no text, no worktree, or a process this tool did not start', () => {
  const { orders } = tempOrders();
  const project = { state_dir: '', work_orders: '' } as ReturnType<typeof validateProject>;
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const ctx = { project, orders, workers, probes: probes() };
  orders.add({ tag: 'T1', title: 't', kind: 'sim' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'coder' });
  assert.throws(() => sayToOrder(ctx, 'T1', '  '), /needs its text/);
  assert.throws(() => sayToOrder(ctx, 'T1', 'hello'), /no worktree/);
  assert.throws(() => sayToOrder(ctx, 'T1', 'hello', { restart: true }), /no process this tool started/);
  orders.runEnd('T1', 'cancelled');
  orders.runStart('T1', { worker: 'coder', extra: { pid: 99 } }, true);
  assert.throws(() => sayToOrder(ctx, 'T1', 'hello', { restart: true }), /no process this tool started/);
  assert.deepEqual(ctx.probes.killed, []);
});

test('a commit reminder is written once per period, and not when the tree is clean or the period is 0', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' });
  f.orders.act('T1', 'queue');
  startRun({ project: f.project, orders: f.orders, workers, probes: probes() }, 'T1', 'coder');
  const started = Date.parse(f.orders.get('T1').runs[0].started);
  const worktree = f.orders.get('T1').order.worktree!;
  let now = new Date(started + 20 * 60000);
  let dirty = 4;
  let lastCommitAt: string | undefined = new Date(started + 10 * 60000).toISOString();
  const p = probes({ now: () => now, gitActivity: () => ({ dirtyFiles: dirty, ...(lastCommitAt ? { lastCommitAt } : {}) }), isAlive: () => false });
  const run = (nudge: boolean) => tick(f.project, f.orders, workers, p, { record: false, nudge }).report;

  assert.equal(readInbox(worktree).length, 0);
  run(true);                                                       // a commit during the run is only 10 minutes ago
  assert.equal(readInbox(worktree).length, 0);

  lastCommitAt = undefined;
  now = new Date(started + 50 * 60000);
  const first = run(true);
  const inbox = readInbox(worktree);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'alba');
  assert.equal(inbox[0].text, nudgeSentence(4, 50));
  assert.equal(first.problems.some(x => x.kind === 'commit-nudge'), false);
  run(true);                                                       // the same period does not write again
  assert.equal(readInbox(worktree).length, 1);

  now = new Date(started + 95 * 60000);
  const second = run(true);
  assert.equal(readInbox(worktree).length, 2);
  assert.equal(readInbox(worktree)[1].text, nudgeSentence(4, 95));
  const problem = second.problems.find(x => x.kind === 'commit-nudge');
  assert.match(problem?.text ?? '', /T1: nudged twice to commit \(4 changed files, quiet for 95 min\)/);
  const seen = run(false);                                        // a dry run still reports the second nudge
  assert.equal(readInbox(worktree).length, 2);
  assert.equal(seen.problems.some(x => x.kind === 'commit-nudge'), true);

  dirty = 0;
  const clean = run(true);
  assert.equal(readInbox(worktree).length, 2);
  assert.equal(clean.problems.some(x => x.kind === 'commit-nudge'), false);

  const off = { ...f.project, dispatch: { ...f.project.dispatch, commit_nudge_minutes: 0 } };
  dirty = 4;
  now = new Date(started + 200 * 60000);
  tick(off, f.orders, workers, p, { record: false, nudge: true });
  assert.equal(readInbox(worktree).length, 2);
  const ev = f.orders.store.events().filter(e => e.type === 'commit-nudge');
  assert.equal(ev.length, 2);
});

test('a run starts with an empty inbox, excluded from git, so reading it never fails', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const ctx = { project: f.project, orders: f.orders, workers, probes: probes() };
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' });
  f.orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'coder');
  const worktree = f.orders.get('T1').order.worktree!;
  assert.equal(existsSync(path.join(worktree, '.alba', 'inbox.md')), true);
  assert.equal(readInbox(worktree).length, 0);
  assert.equal(/inbox/.test(git(worktree, 'status', '--short')), false);
});

// Codex picks its own thread id: the template's `new` does not pass {session_id}.
const CODEX = { workers: [
  { id: 'codex', engine: 'codex-cli', concurrency: 2, launch: { template: 'cx', program: 'codex', args: ['exec', '{session_args}', '-o', '{last_file}', 'Read {prompt_file}'], session: { new: ['-C', '{cwd}'], resume: ['resume', '{session_id}'] } } },
  { id: 'other', engine: 'codex-cli', concurrency: 2, launch: { template: 'cx2', program: 'codex', args: ['exec', '{session_args}', 'Read {prompt_file}'], session: { new: ['-C', '{cwd}'], resume: ['resume', '{session_id}'] } } },
] };
const files = (): Partial<Probes> => ({ readText: (f: string) => existsSync(f) ? readFileSync(f, 'utf8') : undefined, tail: (f: string) => existsSync(f) ? readFileSync(f, 'utf8') : '' });

test('Codex: a run stopped by a person is resumed under the thread id Codex reported, never an id the tool made up', async () => {
  const { findFinishes } = await import('../src/run/finish.ts');
  const f = fixture(), workers = validateWorkers(CODEX, 'w.yaml'), p = probes(files());
  const ctx = { project: f.project, orders: f.orders, workers, probes: p };
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' }); f.orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'codex');
  const r1 = f.orders.get('T1').runs[0];
  assert.equal(r1.session, undefined, 'no invented id on a new Codex session');
  writeFileSync(r1.events_file!, JSON.stringify({ type: 'thread.started', thread_id: 'thread-real' }) + '\n' + JSON.stringify({ type: 'turn.started' }) + '\n');
  // stopped 24 s later by `say --restart`: the run is closed before its end is read
  const r = sayToOrder(ctx, 'T1', 'You are taking over: only step 1.', { restart: true });
  assert.equal(r.started?.resumed, true);
  assert.deepEqual(p.spawned.at(-1)!.slice(0, 4), ['exec', '--json', 'resume', 'thread-real']);
  assert.equal(f.orders.get('T1').runs[1].session, 'thread-real');

  // the resume fails anyway (the rollout is gone): a lost session, the next start is fresh and carries the message and the order
  const r2 = f.orders.get('T1').runs[1];
  writeFileSync(r2.log!, 'Error: thread/resume: thread/resume failed: no rollout found for thread id thread-real (code -32600)\n');
  const [end] = findFinishes(f.project, f.orders, p, workers);
  assert.equal(end.outcome, 'capacity'); assert.equal(end.lost_session, true);
  const { applyFinish } = await import('../src/run/finish.ts');
  applyFinish(f.orders, end, f.project);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued', 'the next tick starts it again');
  startRun(ctx, 'T1', 'codex');
  const r3 = f.orders.get('T1').runs[2];
  assert.equal(p.spawned.at(-1)!.includes('resume'), false);
  assert.equal(r3.session, undefined);
  const prompt = readFileSync(r3.prompt_file!, 'utf8');
  assert.match(prompt, /only step 1/); assert.match(prompt, /T1-x\.md/);
});

test('Codex: queueing the order again after a failed resume, or naming another worker, starts a fresh session', () => {
  for (const how of ['queue', 'other worker'] as const) {
    const f = fixture(), workers = validateWorkers(CODEX, 'w.yaml'), p = probes(files());
    const ctx = { project: f.project, orders: f.orders, workers, probes: p };
    f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' }); f.orders.act('T1', 'queue');
    startRun(ctx, 'T1', 'codex');
    writeFileSync(f.orders.get('T1').runs[0].events_file!, JSON.stringify({ type: 'thread.started', thread_id: 'thread-real' }) + '\n');
    sayToOrder(ctx, 'T1', 'Narrow the scope.', { restart: true });
    // the resumed run fails without a lost-session error (as recorded before this fix: "ended without a report block")
    f.orders.runEnd('T1', 'failed'); f.orders.report('T1', { status: 'failed', summary: 'the worker process ended without a report block', evidence: [], commits: [] });
    f.orders.act('T1', 'queue');
    startRun(ctx, 'T1', how === 'queue' ? 'codex' : 'other', { explicitWorker: true });
    assert.equal(p.spawned.at(-1)!.includes('resume'), false, how);
    assert.match(readFileSync(f.orders.get('T1').runs[2].prompt_file!, 'utf8'), /Narrow the scope/, how);
  }
});

test('outbox: notes and blockers do not stop a running order; a later entry clears a blocker; a BOM or a missing time is read', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const ctx = { project: f.project, orders: f.orders, workers, probes: probes() };
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' });
  f.orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'coder');
  const worktree = f.orders.get('T1').order.worktree!;
  const file = path.join(worktree, '.alba', 'outbox.jsonl');
  // Windows PowerShell writes a byte order mark; this worker also left out the time.
  writeFileSync(file, '﻿' + JSON.stringify({ kind: 'note', text: 'Started; reading the order.' }) + '\n' + JSON.stringify({ at: '2025-01-01T00:00:00Z', kind: 'blocker', text: 'No UE slot, so no build yet.' }) + '\n');
  pickupOutbox(f.orders, 'T1');
  let doc = f.orders.get('T1');
  assert.equal(doc.outbox?.length, 2);
  assert.ok(doc.outbox![0].received && Number.isFinite(Date.parse(doc.outbox![0].at)));
  assert.equal(f.orders.stage(doc).stage, 'running');
  assert.deepEqual(unanswered(doc).map(e => e.kind), ['blocker']);
  writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ at: '2025-01-01T00:05:00Z', kind: 'note', text: 'Slot assigned, building now.' }) + '\n');
  pickupOutbox(f.orders, 'T1');
  doc = f.orders.get('T1');
  assert.deepEqual(unanswered(doc), []);
  assert.equal(f.orders.stage(doc).stage, 'running');
});

test('alba answer to a question the open run wrote goes to its inbox as the reply, without queueing the order', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const ctx = { project: f.project, orders: f.orders, workers, probes: probes() };
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' });
  f.orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'coder');
  const worktree = f.orders.get('T1').order.worktree!;
  // The worker's clock is ahead: its time must not hide the answer.
  writeFileSync(path.join(worktree, '.alba', 'outbox.jsonl'), JSON.stringify({ at: '2099-01-01T00:00:00Z', kind: 'question', text: 'Which door?', options: ['North', 'South'] }) + '\n');
  pickupOutbox(f.orders, 'T1');
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'awaiting-user');
  const r = answerOrder(ctx, 'T1', 'and keep it open', { choice: 2 });
  assert.match(r.message, /Answer sent to the open run of T1 \(reply to: Which door\?\)/);
  const doc = f.orders.get('T1');
  assert.equal(f.orders.stage(doc).stage, 'running');
  assert.equal(doc.runs.length, 1);
  assert.ok(!doc.actions.some(a => a.kind === 'answer'));
  const msg = readInbox(worktree)[0];
  assert.equal(msg.reply, doc.outbox![0].id);
  assert.match(msg.text, /Chosen: option 2, South\.\n\nand keep it open/);
});
