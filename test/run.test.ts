import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { parseReportBlock } from '../src/orders/report.ts';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { startRun, trailingTransientFailures } from '../src/run/launch.ts';
import { buildPrompt, expandArgs } from '../src/run/prompt.ts';
import { approve } from '../src/run/review.ts';
import { backoffMinutes, isLostSessionError, isTransientError } from '../src/run/transient.ts';
import type { Run } from '../src/orders/model.ts';
import { baseRefOf, branchIsMerged, planWorktree } from '../src/run/worktree.ts';
import type { Probes } from '../src/tick/gather.ts';
import { planTick, type TickInput, type TickOrder } from '../src/tick/plan.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A real temporary repository plus a project configuration for it. */
function fixture(extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-do-something.md'), '# T1\nDo something.\n');
  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main', stall_minutes: 60, ...extra },
  }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Do something', kind: 'sim' });
  orders.act('T1', 'queue');
  return { orders, dir, root, project, workOrders };
}

function probes(over: Partial<Probes> = {}): Probes & { spawned: { program: string; args: string[]; cwd: string }[] } {
  const spawned: { program: string; args: string[]; cwd: string }[] = [];
  return {
    spawned, now: () => new Date('2026-01-01T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined,
    spawnDetached(program, args, options) { spawned.push({ program, args, cwd: options.cwd }); return 4242; },
    ...over,
  };
}

const workersFile = () => validateWorkers({
  workers: [
    { id: 'coder', engine: 'codex-cli', launch: { template: 'coder-v1', program: 'coder', args: ['exec', '-C', '{cwd}', '-o', '{last_file}', '-c', 'writable_roots=["{git_dir}"]', 'Read the UTF-8 file {prompt_file} in full and follow it exactly.'], env: { A: '1' } } },
    { id: 'editor', engine: 'claude-session' },
  ],
}, 'w.yaml');

test('report block: the new markers, an empty question, and ready leads to awaiting-review', () => {
  const text = 'Done.\n\n--- alba-report ---\n{"status":"ready","summary":"All good","question":"","evidence":["a.txt"],"commits":["abc1234"]}\n--- end ---\n';
  const r = parseReportBlock(text);
  assert.deepEqual(r, { status: 'ready', summary: 'All good', evidence: ['a.txt'], commits: ['abc1234'] });
  const { orders } = tempOrders();
  orders.add({ tag: 'T1', title: 't', kind: 'k' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'w' });
  orders.runEnd('T1');
  orders.report('T1', r);
  assert.equal(orders.stage(orders.get('T1')).stage, 'awaiting-review');
});

test('finish binds reports to the current run and only inherits files from a resumed run', () => {
  for (const [named, old, resumed, accepted] of [
    ['T1/r2', false, false, true], ['r1', false, false, false], [undefined, false, false, true],
    [undefined, true, false, false], ['r1', true, true, true], ['r1', false, true, false],
  ] as const) {
    const { orders, project } = fixture();
    const file = path.join(project.work_orders, 'T1.last.txt');
    const first = orders.runStart('T1', { worker: 'demo', session: 'prior', extra: { last_file: file } }).run;
    orders.runEnd('T1', 'capacity');
    const current = orders.runStart('T1', { worker: 'demo', session: resumed ? 'prior' : 'new', extra: { continuation: resumed, last_file: file, pid: 42 } }).run;
    const text = ['--- alba-report ---', JSON.stringify({ status: 'ready', summary: 'Done', run: named }), '--- end ---'].join('\n');
    const finish = findFinishes(project, orders, probes({
      fileTime: p => p === file ? old ? first.started : current.started : undefined,
      readText: p => p === file ? text : undefined,
    }))[0];
    applyFinish(orders, finish);
    assert.equal(finish.report?.status === 'ready', accepted);
    const rejected = orders.store.events({ tag: 'T1' }).filter(e => e.type === 'stale-report');
    assert.equal(rejected.length, accepted ? 0 : 1);
    if (!accepted) {
      assert.equal(finish.missing_report, true);
      assert.equal(rejected[0].data?.namedRun, named ?? null);
      assert.equal(rejected[0].data?.file, file);
    }
  }
});

test('finish recognises the resumed session id from the previous engine log', () => {
  const { orders, project } = fixture();
  const file = 'T1.last.txt';
  const previous = orders.runStart('T1', { worker: 'demo', extra: { log: 'prior.log', last_file: file } }).run;
  orders.runEnd('T1', 'capacity');
  const session = 'ae9a1111-1111-4111-8111-111111111111';
  orders.runStart('T1', { worker: 'demo', session, extra: { pid: 42, continuation: true, last_file: file } });
  const block = '--- alba-report ---\n{"run":"r1","status":"ready","summary":"Done"}\n--- end ---';
  const finish = findFinishes(project, orders, probes({
    fileTime: p => p === file ? previous.started : undefined,
    readText: p => p === file ? block : p === 'prior.log' ? `session id: ${session}` : undefined,
  }))[0];
  assert.equal(finish.report?.status, 'ready');
  assert.equal(finish.stale, undefined);
});

test('a finish collected before the next run cannot close that run or attach its delivery', () => {
  const { orders, project } = fixture();
  orders.runStart('T1', { worker: 'demo', extra: { pid: 42, log: 'r1.log' } });
  const block = '--- alba-report ---\n{"run":"r1","status":"ready","summary":"Done"}\n--- end ---';
  const finish = findFinishes(project, orders, probes({ tail: () => block }))[0];
  assert.equal(finish.report?.status, 'ready');
  orders.runEnd('T1', 'cancelled');
  orders.runStart('T1', { worker: 'demo' });
  applyFinish(orders, finish);
  assert.equal(orders.get('T1').runs.at(-1)?.ended, undefined);
  assert.deepEqual(orders.get('T1').reports, []);
});

test('a stale final log block follows missing-report handling', () => {
  const { orders, project } = fixture();
  orders.runStart('T1', { worker: 'demo' });
  orders.runEnd('T1', 'capacity');
  orders.runStart('T1', { worker: 'demo', extra: { pid: 42, log: 'r2.log' } });
  const block = '--- alba-report ---\n{"run":"r1","status":"ready","summary":"Done"}\n--- end ---';
  const finish = findFinishes(project, orders, probes({ tail: () => block }))[0];
  applyFinish(orders, finish);
  assert.equal(finish.missing_report, true);
  assert.equal(orders.get('T1').reports.some(r => r.status === 'ready'), false);
  assert.equal(orders.store.events({ tag: 'T1' }).find(e => e.type === 'stale-report')?.data?.file, 'r2.log');
});

test('transient errors are recognised and backed off 1, 5, 15 minutes, three times', () => {
  for (const line of ['ERROR: model at capacity, please retry', 'unexpected status 429 Too Many Requests', 'HTTP 503 Service Unavailable', 'stream disconnected before completion', 'read ECONNRESET', 'Reconnecting... 3/5'])
    assert.ok(isTransientError(line), line);
  for (const line of ['all tests passed in 1.5s (1429 ms)', 'wrote 5000 lines', 'error: file not found', 'usage limit reached for this plan'])
    assert.ok(!isTransientError(line), line);
  assert.ok(!isTransientError('ERROR rmcp::transport::worker: worker quit with fatal: error sending request for url (http://127.0.0.1:8080/mcp)'));
  // an error in the middle of a long run (followed by plenty of other output) is not why it ended
  assert.ok(!isTransientError('ERROR failed to refresh models: stream disconnected before completion\n' + 'working on the task\n'.repeat(20)));
  assert.deepEqual([1, 2, 3, 4].map(n => backoffMinutes(n)), [1, 5, 15, undefined]);
});

test('worker resume settings default, validate, and repeat the last backoff', () => {
  const defaults = validateWorkers({ workers: [{ id: 'a', engine: 'x' }] }, 'w.yaml').workers[0];
  assert.equal(defaults.max_resumes, 3);
  assert.deepEqual(defaults.resume_backoff_minutes, [1, 5, 15]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => backoffMinutes(n, 5, [2, 10])), [2, 10, 10, 10, 10, undefined]);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', max_resumes: -1 }] }, 'w.yaml'), /max_resumes.*0 to 50/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', max_resumes: 51 }] }, 'w.yaml'), /max_resumes.*0 to 50/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', resume_backoff_minutes: [] }] }, 'w.yaml'), /resume_backoff_minutes.*non-empty/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', resume_backoff_minutes: [2, 0] }] }, 'w.yaml'), /resume_backoff_minutes.*positive/);
});

test('custom worker resume limit allows five capacity retries and fails the sixth', () => {
  const { orders, project } = fixture();
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', max_resumes: 5, resume_backoff_minutes: [2, 10], launch: { program: 'coder', args: ['{prompt_file}'] } }] }, 'w.yaml');
  const ctx = { project, orders, workers, probes: probes() };
  startRun(ctx, 'T1', 'coder');
  for (let i = 0; i < 5; i++) {
    const finish = findFinishes(project, orders, probes({ tail: () => 'ERROR: model at capacity' }), workers)[0];
    assert.equal(finish.outcome, 'capacity');
    applyFinish(orders, finish);
    startRun(ctx, 'T1', 'coder');
  }
  const sixth = findFinishes(project, orders, probes({ tail: () => 'ERROR: model at capacity' }), workers)[0];
  assert.equal(sixth.outcome, 'failed');
});

test('a non-capacity ending resets the per-worker capacity count', () => {
  const run = (seq: number, outcome: Run['outcome']): Run => ({ id: `r${seq}`, seq, worker: 'a', started: '2026-01-01T00:00:00Z', ended: '2026-01-01T00:01:00Z', outcome });
  assert.equal(trailingTransientFailures([run(1, 'capacity'), run(2, 'failed'), run(3, 'capacity')], 'a'), 1);
  assert.equal(trailingTransientFailures([run(1, 'capacity'), run(2, 'capacity')], 'b'), 0);
});

test('the tick holds a resume back until its backoff has passed', () => {
  const order = (over: Partial<TickOrder>): TickOrder => ({ role: { id: 'default' }, tag: 'T1', stage: 'queued', kind: 'sim', row: 1, rework: false, resume: true, endedWithoutReport: false, transientFailures: 2, lastRunEndedAt: '2026-01-01T11:58:00Z', ...over });
  const input = (o: TickOrder): TickInput => ({
    now: new Date('2026-01-01T12:00:00Z'), orders: [o], activity: {}, caps: {}, reworkReserve: 1, alerts: [],
    workers: [{ config: { id: 'w', engine: 'x', paid: false, concurrency: 1, capabilities: [], cost: 'included', aliases: [], enabled: true, disabled_when: [], card_only: false }, available: true, reasons: [], running: 0, runsToday: 0 }],
  });
  const early = planTick(input(order({})));       // 2 failures: wait 5 minutes, only 2 have passed
  assert.deepEqual(early.moves, []);
  assert.match(early.heldBack[0].why, /resume 2 of 3 in 3 min/);
  const due = planTick(input(order({ lastRunEndedAt: '2026-01-01T11:54:00Z' })));
  assert.deepEqual(due.moves.map(m => [m.tag, m.mode]), [['T1', 'resume']]);
});

test('the tick uses the resumed worker limit and repeated backoff', () => {
  const order: TickOrder = { role: { id: 'default' }, tag: 'T1', stage: 'queued', kind: 'sim', row: 1, rework: false, resume: true, resumeWorker: 'w', endedWithoutReport: false, transientFailures: 4, lastRunEndedAt: '2026-01-01T11:58:00Z' };
  const worker = { id: 'w', engine: 'x', paid: false, concurrency: 1, capabilities: [], cost: 'included' as const, aliases: [], enabled: true, disabled_when: [], card_only: false, max_resumes: 5, resume_backoff_minutes: [2, 10] };
  const input: TickInput = { now: new Date('2026-01-01T12:00:00Z'), orders: [order], activity: {}, caps: {}, reworkReserve: 1, alerts: [], workers: [{ config: worker, available: true, reasons: [], running: 0, runsToday: 0 }] };
  const early = planTick(input);
  assert.deepEqual(early.moves, []);
  assert.match(early.heldBack[0].why, /resume 4 of 5 in 8 min/);
  const due = planTick({ ...input, now: new Date('2026-01-01T12:10:00Z') });
  assert.deepEqual(due.moves.map(m => [m.tag, m.mode, m.worker]), [['T1', 'resume', 'w']]);
});

test('lost conversations resume with a fresh session and stop after three retries', () => {
  const endings = [
    'ERROR: {"error":{"message":"Cannot prove ownership of opaque conversation state; start a new conversation or resend complete plaintext history","code":"CLIENT_TOOL_CONTINUATION_UNAVAILABLE"}}',
    'ERROR: Unrecognized conversation state; start a new conversation',
  ];
  for (const ending of endings) { assert.ok(isLostSessionError(ending)); assert.ok(isTransientError(ending)); }
  assert.ok(!isLostSessionError('conversation state is available'));
  const { orders, project } = fixture();
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', launch: { program: 'coder', args: ['{session_args}', '{prompt_file}'], session: { new: ['new', '{session_id}'], resume: ['resume', '{session_id}'] } } }] }, 'w.yaml');
  const p = probes();
  const ctx = { project, orders, workers, probes: p };
  orders.act('T1', 'message', { note: 'Keep this note', force: true });
  startRun(ctx, 'T1', 'coder');
  for (let i = 0; i < 3; i++) {
    const finish = findFinishes(project, orders, probes({ tail: () => endings[i % 2] }))[0];
    assert.equal(finish.outcome, 'capacity');
    applyFinish(orders, finish);
    const previous = orders.get('T1').runs[i];
    const next = startRun(ctx, 'T1', 'coder');
    assert.equal(next.mode === 'start' && next.resumed, false);
    assert.equal(p.spawned[i + 1].args[0], 'new');
    const run = orders.get('T1').runs[i + 1];
    assert.notEqual(run.session, previous.session);
    assert.equal(run.resume_reason, 'resumed as a new session: the service lost the conversation');
    const prompt = readFileSync(run.prompt_file!, 'utf8');
    assert.match(prompt, /Recovery note/);
    assert.match(prompt, /Keep this note/);
  }
  const last = findFinishes(project, orders, probes({ tail: () => endings[0] }))[0];
  assert.equal(last.outcome, 'failed');
  applyFinish(orders, last);
  assert.equal(orders.stage(orders.get('T1')).stage, 'failed');
});

test('isLostSessionError recognizes wider Claude Code and API lost-session patterns without false positives', () => {
  const lostCases = [
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid conversation history"}}',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.4: text content blocks must not be empty"}}',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.12.content: all messages must have non-empty content"}}',
    'API Error: 400 {"error":{"message":"message at position 7 content must not be empty"}}',
    'No conversation found with session ID: 00000000-0000-4000-8000-000000000001',
    '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: 00000000-0000-4000-8000-000000000001"]}',
    'Error: session transcript file not found at sess.jsonl',
    'Error: ENOENT: no such file or directory, open "sessions/transcript.jsonl"',
    'Error: missing transcript file for session abc-123',
  ];
  for (const sample of lostCases) {
    assert.ok(isLostSessionError(sample), `expected lost session for: ${sample}`);
    assert.ok(isTransientError(sample), `expected transient error for: ${sample}`);
  }

  const unrelatedCases = [
    'conversation state is available',
    'Error: ENOENT: no such file or directory, open "src/index.ts"',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be greater than 0"}}',
    'ValidationError: title field must not be empty',
    'TypeError: Cannot read properties of undefined (reading "messages")',
    'AuthError: session token expired, please sign in again',
  ];
  for (const sample of unrelatedCases) {
    assert.ok(!isLostSessionError(sample), `did not expect lost session for: ${sample}`);
  }
});

test('worktree path and branch: from the base branch, never a remote ref', () => {
  const { project } = fixture();
  const plan = planWorktree(project, { tag: 'T1' });
  assert.equal(path.basename(plan.path), 'demo-t1');
  assert.equal(plan.branch, 'demo-t1');
  assert.equal(plan.baseRef, 'refs/heads/main');
  assert.equal(planWorktree(project, { tag: 'T1', branch: 'custom' }).branch, 'custom');
  assert.equal(baseRefOf({ ...project, dispatch: { ...project.dispatch, base_ref: 'main' } }), 'refs/heads/main');
  assert.throws(() => baseRefOf({ ...project, dispatch: { ...project.dispatch, base_ref: 'origin/main' } }), /not a remote-tracking ref/);
});

test('run: creates the worktree and starts the worker; the command line is not stored; card-only workers are not started', () => {
  const { orders, project } = fixture({ provision: ['git', 'status'] });
  const at = '2026-01-01T12:00:01.123Z';
  const p = probes({ processStartedAt: pid => { assert.equal(pid, 4242); return at; } });
  const ctx = { project, orders, workers: workersFile(), probes: p };
  const r = startRun(ctx, 'T1', 'coder');
  assert.equal(r.mode, 'start');
  assert.ok(existsSync(path.join(project.state_dir, 'runs', 'T1-r1.prompt.md')));
  assert.equal(git(planWorktree(project, { tag: 'T1' }).path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'demo-t1');
  assert.equal(p.spawned.length, 1);
  assert.equal(p.spawned[0].args[1], '--json');
  assert.equal(p.spawned[0].args[2], '-C');
  assert.match(p.spawned[0].args[3], /demo-t1$/);
  assert.match(p.spawned[0].args[p.spawned[0].args.length - 1], /T1-r1\.prompt\.md in full and follow it exactly\.$/);
  const doc = orders.get('T1');
  assert.equal(doc.runs[0].pid, 4242);
  assert.equal(doc.runs[0].process_started_at, at);
  assert.equal(doc.runs[0].template, 'coder-v1');
  assert.equal(JSON.stringify(doc).includes('writable_roots'), false);       // no command line anywhere in the state
  assert.equal(orders.stage(doc).stage, 'running');
  assert.equal(doc.order.branch, 'demo-t1');
  // the prompt points at the order file and carries the footer
  const prompt = readFileSync(path.join(project.state_dir, 'runs', 'T1-r1.prompt.md'), 'utf8');
  assert.match(prompt, /^Read the UTF-8 file .*T1-do-something\.md in full and follow it exactly\./);
  assert.match(prompt, /--- alba-report ---/);
  assert.ok(!prompt.includes('Recovery note'));
  // a queued order on a card-only worker is not started
  orders.add({ tag: 'T2', title: 'x', kind: 'k' }); orders.act('T2', 'queue');
  const card = startRun(ctx, 'T2', 'editor');
  assert.equal(card.mode, 'card');
  assert.equal(p.spawned.length, 1);
  assert.throws(() => startRun(ctx, 'T1', 'coder'), /only a queued order/);
});

test('finishing runs: report block, transient error with backoff and a limit, plain failure', () => {
  const { orders, project } = fixture();
  const ctx = { project, orders, workers: workersFile(), probes: probes() };
  startRun(ctx, 'T1', 'coder');
  const run = orders.get('T1').runs[0];
  const at = (iso: string) => (file: string) => (file === run.last_file ? iso : undefined);
  // 1. a report block written after the run started
  const block = '\n--- alba-report ---\n{"status":"ready","summary":"ok","evidence":[],"commits":["abc"]}\n--- end ---\n';
  let f = findFinishes(project, orders, probes({ fileTime: at('2026-01-02T00:00:00Z'), readText: () => block }));
  assert.deepEqual(f.map(x => [x.outcome, x.report?.status]), [['completed', 'ready']]);
  // an old final-message file from an earlier run is ignored
  f = findFinishes(project, orders, probes({ fileTime: at('2000-01-01T00:00:00Z'), readText: () => block }));
  assert.equal(f[0].outcome, 'failed');
  // 2. a transient error in the log: resume, no report
  f = findFinishes(project, orders, probes({ tail: () => 'ERROR: model at capacity' }));
  assert.deepEqual(f.map(x => [x.outcome, x.report]), [['capacity', undefined]]);
  // process still alive: nothing to record
  assert.deepEqual(findFinishes(project, orders, probes({ isAlive: () => true })), []);
  // apply the transient end and resume: the second run knows it is attempt 2 and gets the recovery note
  applyFinish(orders, f[0]);
  assert.equal(orders.stage(orders.get('T1')).stage, 'queued');
  assert.equal(trailingTransientFailures(orders.get('T1').runs), 1);
  startRun(ctx, 'T1', 'coder');
  assert.equal(orders.get('T1').runs[1].attempt, 2);
  assert.match(readFileSync(path.join(project.state_dir, 'runs', 'T1-r2.prompt.md'), 'utf8'), /Recovery note/);
  // the fourth transient failure in a row gives up and waits for a person
  for (let i = 0; i < 2; i++) { applyFinish(orders, findFinishes(project, orders, probes({ tail: () => '429' }))[0]); startRun(ctx, 'T1', 'coder'); }
  const last = findFinishes(project, orders, probes({ tail: () => '429' }))[0];
  assert.equal(last.outcome, 'failed');
  applyFinish(orders, last);
  assert.equal(orders.stage(orders.get('T1')).stage, 'failed');
  // 3. a plain failure
  assert.match(findFinishes(project, orders, probes()).length === 0 ? 'none' : 'some', /none/);   // nothing open any more
});

test('invalid report blocks bounce once, then a second invalid delivery fails', () => {
  const { orders, project } = fixture();
  const ctx = { project, orders, workers: workersFile(), probes: probes() };
  startRun(ctx, 'T1', 'coder');
  const bad = '--- alba-report ---\n{"status":"needs_review","summary":"done"}\n--- end ---\n';
  const current = (file: string) => file === orders.get('T1').runs[0].last_file ? '2026-01-01T12:01:00Z' : undefined;
  const first = findFinishes(project, orders, probes({ fileTime: current, readText: () => bad }))[0];
  assert.equal(first.outcome, 'completed');
  assert.match(first.bounce?.prompt ?? '', /Allowed status values: progress, waiting, ready, blocked, failed, dropped/);
  assert.match(first.bounce?.prompt ?? '', /Do not redo the work: check `git log` and print only the report block/);
  applyFinish(orders, first, project);
  assert.equal(orders.store.events({ tag: 'T1' }).filter(e => e.type === 'report-bounced').length, 1);
  assert.equal(orders.stage(orders.get('T1')).stage, 'queued');
  startRun(ctx, 'T1', 'coder');
  const second = findFinishes(project, orders, probes({ fileTime: () => '2026-01-01T12:02:00Z', readText: () => bad }))[0];
  assert.equal(second.outcome, 'failed');
  assert.equal(second.bounce, undefined);
});

test('a missing report block with a final agent message bounces once', () => {
  const { orders, project } = fixture();
  const ctx = { project, orders, workers: workersFile(), probes: probes() };
  startRun(ctx, 'T1', 'coder');
  const log = '{"type":"item.completed","item":{"type":"agent_message","text":"The work is complete."}}\n';
  const finish = findFinishes(project, orders, probes({ tail: () => log }))[0];
  assert.equal(finish.outcome, 'completed');
  assert.equal(finish.bounce?.final_message, true);
  applyFinish(orders, finish, project);
  assert.equal(orders.store.events({ tag: 'T1' }).filter(e => e.type === 'report-bounced').length, 1);
});

test('review approve: only after the branch is merged, then the accept file is written', () => {
  const { orders, project, workOrders, root } = fixture();
  const ctx = { project, orders, workers: workersFile(), probes: probes() };
  startRun(ctx, 'T1', 'coder');
  const wt = orders.get('T1').order.worktree!;
  writeFileSync(path.join(wt, 'CHANGELOG.md'), 'x');
  git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'work');
  applyFinish(orders, { tag: 'T1', run: 'r1', outcome: 'completed', report: { status: 'ready', summary: 'did it', evidence: [], commits: [] }, why: '' });
  assert.equal(orders.stage(orders.get('T1')).stage, 'awaiting-review');
  assert.equal(branchIsMerged(project, 'demo-t1'), false);
  assert.throws(() => approve(project, orders, 'T1'), /not in main yet/);
  assert.equal(orders.stage(orders.get('T1')).stage, 'awaiting-review');
  assert.equal(existsSync(path.join(workOrders, 'T1.accept.md')), false);
  git(root, 'merge', '--ff-only', 'demo-t1');
  const r = approve(project, orders, 'T1', 'looks fine');
  assert.equal(orders.stage(orders.get('T1')).stage, 'merged');
  assert.match(readFileSync(path.join(workOrders, 'T1.accept.md'), 'utf8'), /# T1 acceptance[\s\S]*did it/);
  assert.match(r.accept, /no accept command/);
});

test('review approve: a failing accept command stops it', () => {
  const { orders, project } = fixture({ accept_command: ['git', 'no-such-subcommand'] });
  const ctx = { project, orders, workers: workersFile(), probes: probes() };
  startRun(ctx, 'T1', 'coder');
  applyFinish(orders, { tag: 'T1', run: 'r1', outcome: 'completed', report: { status: 'ready', summary: 's', evidence: [], commits: [] }, why: '' });
  assert.throws(() => approve(project, orders, 'T1'), /accept command failed/);
  assert.equal(orders.stage(orders.get('T1')).stage, 'awaiting-review');
});

test('review approve: failed delivery needs an override note and records the override', () => {
  const { orders, project, root } = fixture();
  const ctx = { project, orders, workers: workersFile(), probes: probes() };
  startRun(ctx, 'T1', 'coder');
  const worktree = orders.get('T1').order.worktree!;
  writeFileSync(path.join(worktree, 'result.txt'), 'done\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'work');
  applyFinish(orders, { tag: 'T1', run: 'r1', outcome: 'completed', report: { status: 'failed', summary: 'worker reported a failure', evidence: [], commits: [] }, why: '' });
  git(root, 'merge', '--ff-only', 'demo-t1');
  assert.throws(() => approve(project, orders, 'T1'), /--override/);
  assert.throws(() => approve(project, orders, 'T1', 'too short', undefined, true), /at least 10 characters/);
  approve(project, orders, 'T1', 'reviewed failed delivery', undefined, true);
  assert.equal(orders.stage(orders.get('T1')).stage, 'merged');
  assert.equal(orders.get('T1').actions.at(-1)?.override, true);
});

test('prompt and launch template details', () => {
  assert.deepEqual(expandArgs(['-C', '{cwd}', 'x'], { cwd: '/w' }), ['-C', '/w', 'x']);
  assert.throws(() => expandArgs(['{nope}'], {}), /Unknown placeholder/);
  const p = buildPrompt({ orderFile: '/o/T1-x.md', rework: 'Fix the edge case', recovery: true });
  assert.match(p, /Rework requested by the reviewer[\s\S]*Fix the edge case[\s\S]*Recovery note[\s\S]*alba-report/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', launch: { program: 'p', args: ['{bogus}'] } }] }, 'w.yaml'), /unknown placeholder/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', launch: { args: [] } }] }, 'w.yaml'), /"program" is required/);
  assert.throws(() => validateProject({ id: 'd', name: 'D', root: '.', work_orders: '.', state_dir: 's', dispatch: { merge: 'auto' } }, 'f.yaml'), /must be "manual"/);
});
