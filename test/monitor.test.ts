import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { runMonitors } from '../src/monitor/monitor.ts';
import { parseReportBlock, validateReport } from '../src/orders/report.ts';
import { startRun } from '../src/run/launch.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { planTick, type TickInput, type TickOrder } from '../src/tick/plan.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const SPEC = { check: ['status.cmd', '--tag', 'T1'], done_when: { file_exists: 'out/build.done' }, fail_when: { output_matches: 'BUILD FAILED' }, deadline_minutes: 120, note: 'then read out/summary.txt' };
const monitoringBlock = (monitor: unknown) => `--- alba-report ---\n${JSON.stringify({ status: 'monitoring', summary: 'package build started', evidence: [], commits: ['abc1234'], monitor })}\n--- end ---\n`;

function fixture(extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  for (const tag of ['T1', 'T2', 'T3']) writeFileSync(path.join(workOrders, `${tag}-x.md`), `# ${tag}\nDo it.\n`);
  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main', ...extra },
  }, path.join(dir, 'alba.yaml'));
  return { orders, dir, root, project };
}

const workers = () => validateWorkers({ workers: [
  { id: 'coder', engine: 'x', concurrency: 1, launch: { template: 'coder-v1', program: 'coder', args: ['run', '{session_args}', '{prompt_file}'], session: { new: ['-s', '{session_id}'], resume: ['-r', '{session_id}'] } } },
  { id: 'other', engine: 'y', concurrency: 2, launch: { template: 'other-v1', program: 'other', args: ['run', '{prompt_file}'] } },
] }, 'w.yaml');

type Check = { code: number | null; output: string; timedOut: boolean; error?: string };

function probes(over: Partial<Probes> & { now?: () => Date } = {}): Probes & { spawned: { program: string; args: string[] }[]; checks: string[][] } {
  const spawned: { program: string; args: string[] }[] = [];
  const checks: string[][] = [];
  return {
    spawned, checks, now: () => new Date('2026-01-01T00:30:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined,
    spawnDetached(program, args) { spawned.push({ program, args }); return 4242; },
    ...over,
  } as Probes & { spawned: { program: string; args: string[] }[]; checks: string[][] };
}

/** An order whose worker ended its round with a monitoring report (a real run, so it has a session). */
function handedOver(f: ReturnType<typeof fixture>, spec: unknown = SPEC) {
  f.orders.add({ tag: 'T1', title: 'Do something', kind: 'sim' });
  f.orders.act('T1', 'queue');
  const ctx = { project: f.project, orders: f.orders, workers: workers(), probes: probes() };
  startRun(ctx, 'T1', 'coder');
  f.orders.runEnd('T1');
  f.orders.report('T1', parseReportBlock(monitoringBlock(spec)));
  return ctx;
}

test('a monitoring report needs a monitor, and only a monitoring report has one', () => {
  const ok = parseReportBlock(monitoringBlock(SPEC));
  assert.equal(ok.status, 'monitoring');
  assert.deepEqual(ok.monitor?.done_when, { file_exists: 'out/build.done' });
  assert.throws(() => validateReport({ status: 'monitoring', summary: 's' }), /needs a "monitor"/);
  assert.throws(() => validateReport({ status: 'ready', summary: 's', monitor: SPEC }), /only makes sense with status "monitoring"/);
  const bad = (m: Record<string, unknown>) => () => validateReport({ status: 'monitoring', summary: 's', monitor: { ...SPEC, ...m } });
  assert.throws(bad({ check: [] }), /monitor\.check/);
  assert.throws(bad({ done_when: undefined }), /done_when/);
  assert.throws(bad({ done_when: { exit_code: 0, file_exists: 'x' } }), /exactly one/);
  assert.throws(bad({ done_when: { output_matches: '(' } }), /not a valid regular expression/);
  assert.throws(bad({ deadline_minutes: 0 }), /deadline_minutes/);
  assert.throws(bad({ shell: 'x' }), /Unknown monitor field/);
});

test('monitoring: no run is open, the stage is monitoring, and the worker holds no slot', () => {
  const f = fixture();
  const ctx = handedOver(f);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'monitoring');
  const result = tick(f.project, f.orders, ctx.workers, probes(), { record: false });
  assert.equal(result.workers.find(w => w.config.id === 'coder')!.running, 0);
  assert.match(result.report.monitoring.map(m => m.text).join('\n'), /T1: monitoring, 0 checks/);
  assert.deepEqual(result.report.moves, []);
});

test('a check that says the same again is one event; the file appearing ends the monitor and queues the order again', () => {
  const f = fixture();
  handedOver(f);
  let present = false;
  const p = probes({ runCheck: (command: string[], cwd: string): Check => { p.checks.push([...command, cwd]); return { code: 0, output: 'building 40%', timedOut: false }; }, fileTime: () => (present ? '2026-01-01T12:00:00Z' : undefined) });
  for (let i = 0; i < 3; i++) assert.deepEqual(runMonitors(f.project, f.orders, p).resolved, []);
  assert.equal(f.orders.get('T1').monitor?.checks, 3);
  assert.equal(f.orders.store.events().filter(e => e.type === 'monitor-check').length, 1);
  assert.equal(p.checks.length, 3);
  assert.equal(p.checks[0][0], 'status.cmd');
  assert.equal(path.resolve(p.checks[0].at(-1)!), path.resolve(f.orders.get('T1').order.worktree!));
  present = true;
  const pass = runMonitors(f.project, f.orders, p);
  assert.deepEqual(pass.resolved, ['T1']);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued');
  const last = [...f.orders.get('T1').actions].pop()!;
  assert.equal(last.kind, 'monitor');
  assert.match(last.note!, /condition you gave for success was met/);
  assert.match(last.note!, /building 40%/);
  assert.match(last.note!, /then read out\/summary\.txt/);
  assert.equal(f.orders.get('T1').monitor?.resolved?.result, 'done');
  assert.ok(f.orders.store.events().some(e => e.type === 'monitor-end'));
});

test('fail_when, the deadline and a folder that is not allowed each end the monitor', () => {
  const failed = fixture();
  handedOver(failed);
  runMonitors(failed.project, failed.orders, probes({ runCheck: (): Check => ({ code: 1, output: 'x\nBUILD FAILED: link error', timedOut: false }) }));
  assert.equal(failed.orders.get('T1').monitor?.resolved?.result, 'failed');
  assert.match([...failed.orders.get('T1').actions].pop()!.note!, /link error/);

  const late = fixture();
  handedOver(late);
  const early = probes({ runCheck: (): Check => ({ code: 0, output: 'still going', timedOut: false }), now: () => new Date(Date.parse(late.orders.get('T1').monitor!.deadline) - 60000) });
  assert.deepEqual(runMonitors(late.project, late.orders, early).resolved, []);
  const over = probes({ runCheck: (): Check => ({ code: 0, output: 'still going', timedOut: false }), now: () => new Date(Date.parse(late.orders.get('T1').monitor!.deadline) + 1000) });
  assert.deepEqual(runMonitors(late.project, late.orders, over).resolved, ['T1']);
  assert.equal(late.orders.get('T1').monitor?.resolved?.result, 'deadline');
  assert.match([...late.orders.get('T1').actions].pop()!.note!, /120 minutes/);

  const outside = fixture();
  handedOver(outside, { ...SPEC, cwd: '../../elsewhere' });
  let ran = false;
  const refused = runMonitors(outside.project, outside.orders, probes({ runCheck: (): Check => { ran = true; return { code: 0, output: '', timedOut: false }; } }));
  assert.equal(ran, false);
  assert.deepEqual(refused.resolved, ['T1']);
  assert.equal(outside.orders.get('T1').monitor?.resolved?.result, 'refused');
  // the project can allow a folder
  const allowed = fixture({ monitor_dirs: ['elsewhere'] });
  handedOver(allowed, { ...SPEC, cwd: '../../elsewhere' });
  assert.equal(runMonitors(allowed.project, allowed.orders, probes({ runCheck: (): Check => ({ code: 0, output: '', timedOut: false }) })).resolved.length, 0);
});

test('a continuation goes before new orders and reworks, to the same worker, in the same session, and does not count as a run of the day', () => {
  const order = (over: Partial<TickOrder>): TickOrder => ({ role: { id: 'default' }, tag: 'A', stage: 'queued', kind: 'sim', row: 1, rework: false, resume: false, endedWithoutReport: false, ...over });
  const worker = (id: string, over = {}) => ({ config: { id, engine: 'x', paid: false, concurrency: 1, capabilities: [], cost: 'included' as const, aliases: [], enabled: true, disabled_when: [], card_only: false, ...over }, available: true, reasons: [], running: 0, runsToday: 0 });
  const input = (orders: TickOrder[]): TickInput => ({ now: new Date('2026-01-01T12:00:00Z'), orders, activity: {}, caps: {}, reworkReserve: 1, alerts: [], workers: [worker('coder', { }), worker('other', { concurrency: 2 })] });
  const r = planTick(input([order({ tag: 'N1', row: 1 }), order({ tag: 'R1', row: 2, rework: true }), order({ tag: 'M1', row: 3, monitorResume: true, resumeWorker: 'coder' })]));
  assert.equal(r.moves[0].tag, 'M1');
  assert.equal(r.moves[0].worker, 'coder');             // `other` has the better fit, but the same worker carries on
  assert.equal(r.moves[0].mode, 'resume');
  assert.deepEqual(r.moves.slice(1).map(m => m.tag).sort(), ['N1', 'R1']);

  const f = fixture();
  const ctx = handedOver(f);
  runMonitors(f.project, f.orders, probes({ runCheck: (): Check => ({ code: 0, output: 'done', timedOut: false }), fileTime: () => '2026-01-01T12:00:00Z' }));
  const p = probes();
  const real = tick(f.project, f.orders, ctx.workers, p, { record: false });
  assert.deepEqual(real.report.moves.map(m => [m.tag, m.mode, m.worker]), [['T1', 'resume', 'coder']]);
  startRun({ ...ctx, probes: p }, 'T1', 'coder');
  const run = f.orders.get('T1').runs[1];
  assert.equal(run.monitor, true);
  assert.equal(run.session, f.orders.get('T1').runs[0].session);       // the same conversation
  assert.deepEqual(p.spawned[0].args.slice(0, 3), ['run', '-r', run.session]);
  const prompt = readFileSync(run.prompt_file!, 'utf8');
  assert.match(prompt, /long job you handed to the monitor is over/);
  assert.match(prompt, /then read out\/summary\.txt/);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'running');
  f.orders.runEnd('T1');
  const after = tick(f.project, f.orders, ctx.workers, p, { record: false });
  assert.equal(after.workers.find(w => w.config.id === 'coder')!.runsToday, 1);   // the first run counts, the continuation does not
});

test('a person can still hold or cancel an order that is being monitored', () => {
  const f = fixture();
  handedOver(f);
  f.orders.act('T1', 'hold');
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'held');
  f.orders.act('T1', 'release');
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'monitoring');
  f.orders.act('T1', 'cancel');
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'cancelled');
  assert.deepEqual(runMonitors(f.project, f.orders, probes({ runCheck: (): Check => ({ code: 0, output: '', timedOut: false }) })).resolved, []);
});
