import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { deliveredReport, lingeringOf, stopLingeringRun } from '../src/run/lingering.ts';
import { executeTick } from '../src/tick/execute.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { FETCH_FORBIDDEN_PORTS, freePort } from '../src/web/port.ts';
import { tempOrders } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures');
const TAIL = readFileSync(path.join(fixtures, 'lingering-tail.log'), 'utf8');

test('a report block at the end of the log is a delivery; the example in the footer, or a block in the middle of other work, is not', () => {
  const r = deliveredReport(TAIL)!;
  assert.deepEqual([r.status, r.summary, r.commits], ['ready', 'T1 finished: loader, checks and report are committed', ['5e1c2a7', 'b04d9e1']]);
  // the prompt printed back carries the example block of the footer
  const example = 'prompt:\n--- alba-report ---\n{"status":"ready","summary":"one sentence","question":"","evidence":["path/to/proof"],"commits":["abc1234"]}\n--- end ---\n';
  assert.equal(deliveredReport(example), undefined);
  // a real block followed by more work (a long stretch of output) is not the end of the log
  assert.equal(deliveredReport(TAIL + 'x'.repeat(5000)), undefined);
  assert.equal(deliveredReport('working\nworking\n'), undefined);
  // a block that is not valid is no delivery (the normal end of run reports it as invalid)
  assert.equal(deliveredReport('--- alba-report ---\n{"status":"maybe"}\n--- end ---\n'), undefined);
  // engines that print JSON events: the text of the final message counts
  const block = ['Done.', '--- alba-report ---', '{"status":"ready","summary":"s","evidence":[],"commits":[]}', '--- end ---', ''].join('\n');
  const event = JSON.stringify({ type: 'text', data: block });
  assert.equal(deliveredReport(event + '\n' + JSON.stringify({ type: 'end', stopReason: 'end_turn' }))?.summary, 's');
});

function setup(extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders, { recursive: true });
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: extra }, path.join(dir, 'alba.yaml'));
  const log = path.join(dir, 'T1-r1.log');
  copyFileSync(path.join(fixtures, 'lingering-tail.log'), log);
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'x', concurrency: 2, launch: { template: 'c1', program: 'coder', args: ['{prompt_file}'] } }] }, 'w.yaml');
  orders.add({ tag: 'T1', title: 'Deliver and stay', kind: 'sim' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'coder', extra: { log, pid: 777 } });
  const clock = { now: new Date('2026-11-04T14:30:00Z'), written: '2026-11-04T13:50:03Z' };
  const killed: number[] = [], spared: number[] = [], launched: (string | undefined)[] = [];
  const probes = {
    killed, spared, launched, now: () => clock.now, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: (f: string) => (f === log ? clock.written : undefined), isAlive: (pid: number) => !killed.includes(pid),
    tail: (f: string, n: number) => readFileSync(f, 'utf8').slice(-n), readText: (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return undefined; } },
    kill: (pid: number) => { killed.push(pid); return [pid]; },
    stopTree: (pid: number, _at: string | undefined, options: { launchedAt?: string; spare?: number[] } = {}) => { killed.push(pid); spared.push(...(options.spare ?? [])); launched.push(options.launchedAt); return { stopped: [pid, 888, 889], leftRunning: options.spare ?? [] }; },
    spawnDetached: () => 4242,
  } as unknown as Probes & { killed: number[]; spared: number[]; launched: (string | undefined)[] };
  return { orders, project, workers, probes, clock, log };
}

test('a run whose log ends with its report and has been quiet for 10 minutes is listed as delivered, and no longer as 2 hours without a commit', () => {
  const s = setup({ stall_minutes: 60 });
  const doc = () => s.orders.get('T1').runs[0];
  assert.deepEqual(lingeringOf(s.project, s.probes, doc()), { status: 'ready', summary: 'T1 finished: loader, checks and report are committed', quietMinutes: 40 });
  s.clock.now = new Date('2026-11-04T13:55:00Z');                                              // 5 minutes after the last output: too early
  assert.equal(lingeringOf(s.project, s.probes, doc()), undefined);
  s.clock.now = new Date('2026-11-04T14:30:00Z');
  const problems = tick(s.project, s.orders, s.workers, s.probes, { record: false }).report.problems;
  assert.deepEqual(problems.map(p => p.kind), ['lingering']);                                   // not "stalled" as well
  assert.match(problems[0].text, /T1: the run has already handed in its report \(ready: T1 finished: loader, checks and report are committed\) but its process is still there; the log has been quiet for 40 min\./);
  // a log that is still growing is not quiet
  s.clock.written = '2026-11-04T14:25:00Z';
  assert.equal(lingeringOf(s.project, s.probes, doc()), undefined);
  // a process that is gone is an ended run, read the usual way
  s.clock.written = '2026-11-04T13:50:03Z';
  s.probes.killed.push(777);
  assert.equal(lingeringOf(s.project, s.probes, doc()), undefined);
});

test('lingering_minutes changes the wait; report (default) changes nothing, stop ends this run\'s process tree and records its report', () => {
  const s = setup({ lingering_minutes: 60 });
  s.clock.now = new Date('2026-11-04T14:30:00Z');
  assert.deepEqual(tick(s.project, s.orders, s.workers, s.probes, { record: false }).report.problems.map(p => p.kind).filter(k => k !== 'start-failed'), []);   // 40 minutes is not 60
  const quick = setup();
  executeTick({ project: quick.project, orders: quick.orders, workers: quick.workers, probes: quick.probes }, { maxDispatch: 1 });
  assert.deepEqual(quick.probes.killed, []);                                                    // report only
  assert.equal(quick.orders.stage(quick.orders.get('T1')).stage, 'running');
  const stop = setup({ on_lingering: 'stop' });
  const result = executeTick({ project: stop.project, orders: stop.orders, workers: stop.workers, probes: stop.probes }, { maxDispatch: 1 }).report;
  assert.deepEqual(stop.probes.killed, [777]);
  const doc = stop.orders.get('T1');
  assert.equal(doc.runs[0].outcome, 'completed');
  assert.deepEqual([doc.reports.at(-1)!.status, doc.reports.at(-1)!.commits], ['ready', ['5e1c2a7', 'b04d9e1']]);   // read from the log: no final-message file was there
  assert.equal(stop.orders.stage(doc).stage, 'awaiting-review');
  assert.ok(result.done.some(d => /stopped the process of run r1 \(its report was already in the log\)/.test(d)));
  assert.ok(result.done.some(d => /recorded the end of run r1 of T1: completed, ready \(process ended, report block read from the log\)/.test(d)));
  assert.ok(stop.orders.store.events().some(e => e.type === 'lingering-stopped'));
  // The whole tree goes (the recorded pid is often a wrapper with the worker under it); nothing was handed to the monitor, so nothing is spared.
  assert.deepEqual(stop.orders.store.events().find(e => e.type === 'lingering-stopped')?.data?.stopped, [777, 888, 889]);
  assert.deepEqual(stop.orders.store.events().find(e => e.type === 'lingering-stopped')?.data?.left_running, []);
  assert.deepEqual(stop.probes.spared, []);
  assert.deepEqual(stop.probes.launched, [doc.runs[0].started]);
});

test('a lingering stop spares the job its delivered report hands to the monitor, with what is under it', () => {
  const s = setup({ on_lingering: 'stop' });
  const monitored = '--- alba-report ---\n{"status":"monitoring","summary":"the soak test runs on","evidence":[],"commits":[],"monitor":{"pid":4321,"check":["node","check.mjs"],"done_when":{"exit_code":0},"deadline_minutes":60}}\n--- end ---\n';
  const text = readFileSync(s.log, 'utf8');
  writeFileSync(s.log, text.slice(0, text.indexOf('--- alba-report ---')) + monitored);
  assert.match(stopLingeringRun(s.orders, s.probes, 'T1'), /stopped the process of run r1/);
  assert.deepEqual(s.probes.spared, [4321]);
  assert.deepEqual(s.orders.store.events().find(e => e.type === 'lingering-stopped')?.data?.left_running, [4321]);
});

test('a refused lingering stop leaves the run open and never falls back to another stop', () => {
  const s = setup({ on_lingering: 'stop' });
  s.probes.stopTree = () => ({ stopped: [], leftRunning: [] });
  assert.match(stopLingeringRun(s.orders, s.probes, 'T1'), /Refusing to stop/);
  assert.deepEqual(s.probes.killed, []);
  assert.equal(s.orders.get('T1').runs[0].ended, undefined);
  assert.equal(s.orders.store.events().some(e => e.type === 'lingering-stopped'), false);
  delete s.probes.stopTree;
  assert.match(stopLingeringRun(s.orders, s.probes, 'T1'), /Refusing to stop/);
  assert.deepEqual(s.probes.killed, []);
});

test('the two settings are checked', () => {
  const { dir } = tempOrders();
  const make = (dispatch: Record<string, unknown>) => validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 's'), dispatch }, path.join(dir, 'f.yaml'));
  assert.deepEqual([make({}).dispatch.on_lingering, make({}).dispatch.lingering_minutes], ['report', 10]);
  assert.equal(make({ on_lingering: 'stop', lingering_minutes: 3 }).dispatch.on_lingering, 'stop');
  assert.throws(() => make({ on_lingering: 'kill' }), /on_lingering/);
  assert.throws(() => make({ lingering_minutes: 0 }), /lingering_minutes/);
});

test('a free port for the interface is never one that fetch refuses', async () => {
  assert.ok(FETCH_FORBIDDEN_PORTS.has(6000) && FETCH_FORBIDDEN_PORTS.has(10080) && !FETCH_FORBIDDEN_PORTS.has(8080));
  for (let i = 0; i < 20; i++) assert.ok(!FETCH_FORBIDDEN_PORTS.has(await freePort('127.0.0.1')));
});

