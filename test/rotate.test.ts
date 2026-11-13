import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { findFinishes, applyFinish } from '../src/run/finish.ts';
import { startRun } from '../src/run/launch.ts';
import { isLimitError, isTransientError } from '../src/run/transient.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { planTick, type TickInput, type TickOrder, type WorkerState } from '../src/tick/plan.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WORKERS = {
  workers: [
    { id: 'coder', engine: 'x', on_limit: 'rotate', concurrency: 1, launch: { template: 'c1', program: 'coder', args: ['run', '{session_args}', '{prompt_file}'], session: { new: ['-s', '{session_id}'], resume: ['-r', '{session_id}'] } } },
    { id: 'spare', engine: 'y', concurrency: 2, launch: { template: 's1', program: 'spare', args: ['run', '{session_args}', '{prompt_file}'], session: { new: ['-s', '{session_id}'], resume: ['-r', '{session_id}'] } } },
    { id: 'weak', engine: 'z', concurrency: 2, launch: { template: 'w1', program: 'weak', args: ['run', '{prompt_file}'] } },
    { id: 'rich', engine: 'p', paid: true, concurrency: 2, launch: { template: 'r1', program: 'rich', args: ['run', '{prompt_file}'] } },
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

function probes(over: Partial<Probes> = {}): Probes & { spawned: { program: string; args: string[] }[] } {
  const spawned: { program: string; args: string[] }[] = [];
  return { spawned, now: () => new Date('2026-01-01T00:30:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached(program: string, args: string[]) { spawned.push({ program, args }); return 4242; }, ...over } as Probes & { spawned: { program: string; args: string[] }[] };
}

test('a used-up window is told from a hiccup', () => {
  for (const line of ["You've hit your usage limit. Try again in 3 days.", 'Claude usage limit reached', 'Error: insufficient_quota', 'You exceeded your current quota, please check your plan', 'weekly limit reached, resets Monday'])
    assert.ok(isLimitError(line), line);
  for (const line of ['model at capacity, please retry', '429 Too Many Requests', 'all tests passed', 'limit of 3 retries is set'])
    assert.ok(!isLimitError(line), line);
  assert.ok(isTransientError('model at capacity'));
  assert.ok(!isTransientError("You've hit your usage limit"));           // not a hiccup: waiting a few minutes does not help
  assert.ok(!isLimitError('You hit your usage limit\n' + 'working on the task\n'.repeat(20)));    // in the middle of a long run it is not why it ended
});

test('on_limit is "wait" or "rotate"', () => {
  const bad = { workers: [{ id: 'a', engine: 'x', on_limit: 'sometimes' }] };
  assert.throws(() => validateWorkers(bad, 'w.yaml'), /on_limit/);
  const ok = validateWorkers(WORKERS, 'w.yaml');
  assert.deepEqual(ok.workers.map(w => w.on_limit), ['rotate', undefined, undefined, undefined]);
});

test('rotate_paid is stored only when true', () => {
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', rotate_paid: 'yes' }] }, 'w.yaml'), /rotate_paid/);
  assert.equal(validateWorkers({ workers: [{ id: 'a', engine: 'x', rotate_paid: false }] }, 'w.yaml').workers[0].rotate_paid, undefined);
  assert.equal(validateWorkers({ workers: [{ id: 'a', engine: 'x', rotate_paid: true }] }, 'w.yaml').workers[0].rotate_paid, true);
});

test('a worker set to rotate that hits a used-up window or a capacity error ends with outcome capacity and says which; set to wait it fails as before', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  f.orders.add({ tag: 'T1', title: 'x', kind: 'sim' }); f.orders.act('T1', 'queue');
  startRun({ project: f.project, orders: f.orders, workers, probes: probes() }, 'T1', 'coder');
  const quota = findFinishes(f.project, f.orders, probes({ tail: () => "You've hit your usage limit. Try again in 3 days." }), workers);
  assert.deepEqual(quota.map(x => [x.outcome, x.limit]), [['capacity', 'quota']]);
  const capacity = findFinishes(f.project, f.orders, probes({ tail: () => 'ERROR: model at capacity' }), workers);
  assert.deepEqual(capacity.map(x => [x.outcome, x.limit]), [['capacity', 'capacity']]);
  // without the setting (or without the workers file) a used-up window is a plain failure for a person to look at
  assert.deepEqual(findFinishes(f.project, f.orders, probes({ tail: () => "You've hit your usage limit." })).map(x => x.outcome), ['failed']);
  const waiting = validateWorkers({ workers: [{ ...WORKERS.workers[0], on_limit: 'wait' }] }, 'w.yaml');
  assert.deepEqual(findFinishes(f.project, f.orders, probes({ tail: () => "You've hit your usage limit." }), waiting).map(x => x.outcome), ['failed']);
  applyFinish(f.orders, quota[0]);
  assert.equal(f.orders.get('T1').runs[0].limit, 'quota');
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued');
});

const worker = (id: string, over: Record<string, unknown> = {}): WorkerState => ({
  config: { id, engine: 'x', paid: false, concurrency: 1, capabilities: [], cost: 'included', aliases: [], enabled: true, disabled_when: [], card_only: false, ...over } as WorkerState['config'], available: true, reasons: [], running: 0, runsToday: 0,
});
const input = (o: Partial<TickOrder>, workers: WorkerState[]): TickInput => ({
  now: new Date('2026-01-01T12:00:00Z'), activity: {}, caps: {}, reworkReserve: 1, alerts: [], workers,
  orders: [{ role: { id: 'sim', prefer: ['coder', 'rich', 'spare'], avoid: ['weak'] }, tag: 'T1', stage: 'queued', kind: 'sim', row: 1, rework: false, resume: true, endedWithoutReport: false, transientFailures: 1, lastRunEndedAt: '2026-01-01T11:59:00Z', rotate: { from: 'coder', reason: 'the model service was at capacity', allowPaid: false }, ...o }],
});

test('rotation obeys the same role preferences and avoid list, excludes exhausted supply and requires permission to spend', () => {
  const workers = [worker('coder'), worker('weak'), worker('rich', { cost: 'paid', paid: true }), worker('spare')];
  const r = planTick(input({}, workers));
  assert.deepEqual(r.moves.map(m => [m.tag, m.worker, m.mode, m.rotated?.from]), [['T1', 'spare', 'resume', 'coder']]);
  assert.match(r.moves[0].why!, /spare: role sim/);
  assert.deepEqual(r.heldBack, []);                                       // no backoff wait: the hand-over is at once
  // An order that may spend uses the role's earlier preference.
  assert.deepEqual(planTick(input({ rotate: { from: 'coder', reason: 'x', allowPaid: true } }, workers)).moves.map(m => m.worker), ['rich']);
  // nobody else to hand it to: the usual resume on the same worker, after the backoff
  const alone = planTick(input({ lastRunEndedAt: '2026-01-01T11:59:30Z' }, [worker('coder'), worker('weak')]));
  assert.deepEqual(alone.moves, []);
  assert.match(alone.heldBack[0].why, /resume 1 of 3 in 1 min/);
  // A qualifying hand-over target is busy: wait for it rather than the exhausted worker.
  const busy = planTick(input({ lastRunEndedAt: '2026-01-01T11:50:00Z' }, [worker('coder'), { ...worker('spare'), available: false, reasons: ['window full'] }]));
  assert.deepEqual(busy.moves, []);
  assert.match(busy.heldBack[0].why, /waiting for a hand-over target/);
});

test('rotation keeps the resolved role capability and only filters before its preference ranking', () => {
  const workers = [
    worker('coder', { capabilities: ['vision'] }),
    worker('preferred', { capabilities: ['shell'] }),
    worker('outsider', { capabilities: ['vision'] }),
    worker('fallback', { capabilities: ['vision'] }),
  ];
  const role = { id: 'visual', requires: ['vision'], prefer: ['coder', 'preferred', 'outsider'], only: ['coder', 'preferred', 'fallback'] };
  const report = planTick(input({ role }, workers));
  assert.deepEqual(report.moves.map(m => [m.worker, m.rotated?.from]), [['fallback', 'coder']]);
  assert.match(report.moves[0].why!, /role visual/);
  workers[3].config.capabilities = [];
  const noTarget = planTick(input({ role, lastRunEndedAt: '2026-01-01T11:59:30Z' }, workers));
  assert.deepEqual(noTarget.moves, []);
  assert.match(noTarget.heldBack[0].why, /resume 1 of 3 in 1 min/);
});

test('a handed-over order: the new worker starts a new session from a continuation file, and the prompt is only its path', () => {
  const f = fixture();
  const workers = validateWorkers(WORKERS, 'w.yaml');
  const p = probes({ tail: (file: string, n: number) => (existsSync(file) ? readFileSync(file, 'utf8').slice(-n) : '') });
  const ctx = { project: f.project, orders: f.orders, workers, probes: p };
  f.orders.add({ tag: 'T1', title: 'Make the thing', kind: 'sim' }); f.orders.act('T1', 'queue');
  f.orders.ask('T1', { text: 'Which palette?', options: [{ label: 'warm' }, { label: 'cold' }] });
  f.orders.pick('T1', f.orders.get('T1').questions![0].id, { choice: 1 });
  startRun(ctx, 'T1', 'coder');
  const doc = f.orders.get('T1');
  writeFileSync(path.join(doc.order.worktree!, 'part1.txt'), 'x');
  git(doc.order.worktree!, 'add', '.'); git(doc.order.worktree!, 'commit', '-q', '-m', 'T1: first half');
  const log = doc.runs[0].log!;
  writeFileSync(log, 'working\nworking\nERROR: model at capacity, please retry\n');
  f.orders.patchRun('T1', 'r1', { limit: 'capacity' });
  f.orders.runEnd('T1', 'capacity');
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued');
  const plan = tick(f.project, f.orders, workers, probes({ tail: () => '' }), { record: false }).report;
  assert.deepEqual(plan.moves.map(m => [m.worker, m.rotated?.from]), [['spare', 'coder']]);
  startRun({ ...ctx, probes: p }, 'T1', 'spare', { rotate: { from: 'coder', reason: 'the model service was at capacity' } });
  const run = f.orders.get('T1').runs[1];
  assert.deepEqual([run.worker, run.rotated?.from, run.attempt], ['spare', 'coder', 2]);
  assert.ok(run.handoff_file!.endsWith('T1-r2.handoff.md'));
  // The path of the continuation file, then only where the worker works.
  const prompt = readFileSync(run.prompt_file!, 'utf8');
  assert.ok(prompt.startsWith(`Read the UTF-8 file ${run.handoff_file} in full and follow it exactly.\n\n## Where you work\n\nYour working folder is `), prompt);
  assert.equal(prompt.split('\n').length, 6);
  const handoff = readFileSync(run.handoff_file!, 'utf8');
  assert.match(handoff, /could not go on because the model service was at capacity/);
  assert.match(handoff, /T1: first half/);                                  // what the branch holds
  assert.match(handoff, /Which palette\? -> option 1/);                     // what was asked and answered
  assert.match(handoff, /ERROR: model at capacity/);                        // the end of the log
  assert.match(handoff, /Read the UTF-8 file .*T1-x\.md in full/);          // the usual instructions follow
  assert.match(handoff, /alba-report/);
  assert.equal(run.session !== f.orders.get('T1').runs[0].session, true);   // a new conversation: the other engine cannot continue the first
  assert.deepEqual(p.spawned.at(-1)!.args.slice(0, 2), ['run', '-s']);
  const ev = f.orders.store.events().find(e => e.type === 'run-rotated')!;
  assert.deepEqual([ev.data!.from, ev.data!.to], ['coder', 'spare']);
});

test('a paid hand-over target that is busy makes the order wait, and one that is not allowed is not used', () => {
  const paidBusy = planTick(input({ rotate: { from: 'coder', reason: 'the model service was at capacity', allowPaid: true }, lastRunEndedAt: '2026-01-01T11:50:00Z' }, [worker('coder', { }), { ...worker('rich', { cost: 'paid', paid: true }), available: false, reasons: ['at its concurrency'] }]));
  assert.deepEqual(paidBusy.moves, []);
  assert.match(paidBusy.heldBack[0].why, /waiting for a hand-over target/);
  const kept = planTick(input({ rotate: { from: 'coder', reason: 'x', allowPaid: false }, lastRunEndedAt: '2026-01-01T10:00:00Z' }, [worker('coder', { }), worker('rich', { cost: 'paid', paid: true })]));
  assert.deepEqual(kept.moves.map(m => m.worker), ['coder']);
  assert.equal(kept.moves[0].rotated, undefined);
});

test('rotate_paid hands a capacity ending to a paid worker, and the run stores who paid', () => {
  const start = (rotatePaid: boolean) => {
    const f = fixture();
    const raw = { workers: WORKERS.workers.map(w => w.id === 'coder' ? { ...w, ...(rotatePaid ? { rotate_paid: true } : {}) } : w.id === 'spare' ? { ...w } : w) };
    const workers = validateWorkers({ ...raw, roles: { sim: { kinds: ['sim'], workers: { prefer: ['coder', 'rich'], avoid: ['weak', 'spare'] } } } }, 'w.yaml');
    const later = probes({ now: () => new Date('2026-01-02T00:00:00Z') });
    const ctx = { project: f.project, orders: f.orders, workers, probes: later };
    f.orders.add({ tag: 'T1', title: 'x', kind: 'sim' });
    f.orders.act('T1', 'queue');
    startRun(ctx, 'T1', 'coder');
    f.orders.runEnd('T1', 'capacity');
    const plan = tick(f.project, f.orders, workers, later, { record: false }).report;
    return { f, ctx, plan };
  };
  const off = start(false);
  assert.deepEqual(off.plan.moves.map(m => m.worker), ['coder']);
  assert.equal(off.plan.moves[0].rotated, undefined);
  const on = start(true);
  assert.deepEqual(on.plan.moves.map(m => [m.worker, m.rotated?.from]), [['rich', 'coder']]);
  startRun(on.ctx, 'T1', 'rich', { rotate: { from: 'coder', reason: 'the model service was at capacity' } });
  const run = on.f.orders.get('T1').runs[1];
  assert.equal(run.rotated?.paid, true);
  assert.match(run.rotated?.text ?? '', /handed over from coder to rich because coder was at capacity; rich is paid/);
  const ev = on.f.orders.store.events().find(e => e.type === 'run-rotated')!;
  assert.equal(ev.data!.paid, true);
  assert.equal(ev.data!.text, run.rotated?.text);
});
