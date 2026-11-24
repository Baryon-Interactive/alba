import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { deliveredReport, handedIn, lingeringOf, reportInRunLog, stopLingeringRun } from '../src/run/lingering.ts';
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

function setup(extra: Record<string, unknown> = {}, events?: string) {
  const { orders, dir } = tempOrders();
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders, { recursive: true });
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: extra }, path.join(dir, 'alba.yaml'));
  const log = path.join(dir, 'T1-r1.log');
  copyFileSync(path.join(fixtures, 'lingering-tail.log'), log);
  // With `events`: an engine that prints JSON events to their own file (the log keeps its other output).
  const eventsFile = path.join(dir, 'T1-r1.events.jsonl');
  if (events !== undefined) { writeFileSync(log, 'Reading additional input from stdin...\n'); writeFileSync(eventsFile, events); }
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'x', concurrency: 2, launch: { template: 'c1', program: 'coder', args: ['{prompt_file}'] } }] }, 'w.yaml');
  orders.add({ tag: 'T1', title: 'Deliver and stay', kind: 'sim' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'coder', extra: { log, pid: 777, ...(events !== undefined ? { events_file: eventsFile } : {}) } });
  const clock = { now: new Date('2026-11-04T14:30:00Z'), written: '2026-11-04T13:50:03Z' };
  const killed: number[] = [], spared: number[] = [], launched: (string | undefined)[] = [];
  const probes = {
    killed, spared, launched, now: () => clock.now, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: (f: string) => (f === log || f === eventsFile ? clock.written : undefined), isAlive: (pid: number) => !killed.includes(pid),
    tail: (f: string, n: number) => readFileSync(f, 'utf8').slice(-n), readText: (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return undefined; } },
    kill: (pid: number) => { killed.push(pid); return [pid]; },
    stopTree: (pid: number, _at: string | undefined, options: { launchedAt?: string; spare?: number[] } = {}) => { killed.push(pid); spared.push(...(options.spare ?? [])); launched.push(options.launchedAt); return { stopped: [pid, 888, 889], leftRunning: options.spare ?? [] }; },
    spawnDetached: () => 4242,
  } as unknown as Probes & { killed: number[]; spared: number[]; launched: (string | undefined)[] };
  return { orders, project, workers, probes, clock, log, eventsFile };
}

/** `codex exec --json` events: work, the final message with its report block, then the end of the turn. */
const CODEX = [
  { type: 'thread.started', thread_id: 'th-1' },
  { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'git status', aggregated_output: '', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Four commits; working tree clean.\n\n--- alba-report ---\n{"status":"ready","summary":"separated figures, all checks pass","question":"","evidence":["artifacts/T1/verification.json"],"commits":["48d9c4b"]}\n--- end ---' } },
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } },
].map(e => JSON.stringify(e)).join('\n') + '\n';

test('a run whose log ends with its report and has been quiet for 10 minutes is listed as delivered, and no longer as 2 hours without a commit', () => {
  const s = setup({ stall_minutes: 60 });
  const doc = () => s.orders.get('T1').runs[0];
  assert.deepEqual(lingeringOf(s.project, s.probes, doc()), { status: 'ready', summary: 'T1 finished: loader, checks and report are committed', quietMinutes: 40, ended: false });
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

test('a report at the end of the log that names another run is not this run handing in: it is neither delivered nor lingering', () => {
  const s = setup({ stall_minutes: 60 });
  const doc = () => s.orders.get('T1').runs[0];
  const withRun = (run: string) => writeFileSync(s.log, TAIL.replace('{"status":"ready"', `{"run":"${run}","status":"ready"`));
  withRun('T1/r0');                                                                             // the predecessor's report echoed back
  assert.equal(handedIn(s.probes, doc()), undefined);
  assert.equal(lingeringOf(s.project, s.probes, doc()), undefined);
  assert.deepEqual(tick(s.project, s.orders, s.workers, s.probes, { record: false }).report.problems.map(p => p.kind).filter(k => k === 'lingering'), []);
  withRun(`T1/${doc().id}`);                                                                    // its own run id, either form
  assert.equal(lingeringOf(s.project, s.probes, doc())?.status, 'ready');
  withRun(doc().id);
  assert.equal(lingeringOf(s.project, s.probes, doc())?.status, 'ready');
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

test('a Codex run that ended its turn with a report but whose process stays is stopped after 2 minutes, whatever on_lingering says, and its report recorded', () => {
  const s = setup({}, CODEX);
  const run = () => s.orders.get('T1').runs[0];
  s.clock.written = '2026-11-04T14:00:00Z';
  s.clock.now = new Date('2026-11-04T14:01:00Z');
  assert.deepEqual(handedIn(s.probes, run()), { status: 'ready', summary: 'separated figures, all checks pass', quietMinutes: 1, ended: true });   // what status shows
  assert.equal(lingeringOf(s.project, s.probes, run()), undefined);                            // 1 minute: not yet
  s.clock.now = new Date('2026-11-04T14:03:00Z');
  const problems = tick(s.project, s.orders, s.workers, s.probes, { record: false }).report.problems.filter(p => p.kind === 'lingering');
  assert.deepEqual(problems.map(p => p.ended), [true]);
  assert.match(problems[0].text, /T1: the worker ended its turn and handed in its report \(ready: separated figures, all checks pass\) but its process is still there after 3 min; it is stopped and the report read\./);
  const result = executeTick({ project: s.project, orders: s.orders, workers: s.workers, probes: s.probes }, { maxDispatch: 1 }).report;
  assert.deepEqual(s.probes.killed, [777]);                                                     // on_lingering is "report" (the default)
  const doc = s.orders.get('T1');
  assert.deepEqual([doc.runs[0].outcome, doc.reports.at(-1)!.status, doc.reports.at(-1)!.commits], ['completed', 'ready', ['48d9c4b']]);
  assert.equal(s.orders.stage(doc).stage, 'awaiting-review');
  assert.ok(result.done.some(d => /stopped the process of run r1/.test(d)));
  // Work after the final message (another command) is not the end of the turn.
  const busy = setup({}, CODEX.replace(/\{"type":"turn\.completed"[^\n]*\n$/, '') + JSON.stringify({ type: 'item.started', item: { id: 'i3', type: 'command_execution', command: 'sleep 1' } }) + '\n');
  busy.clock.written = '2026-11-04T14:00:00Z'; busy.clock.now = new Date('2026-11-04T14:03:00Z');
  assert.equal(handedIn(busy.probes, busy.orders.get('T1').runs[0]), undefined);
  // Claude's result event is no end: claude -p can start another turn for a background command, so the usual wait applies.
  const block = '--- alba-report ---\n{"status":"ready","summary":"s","evidence":[],"commits":[]}\n--- end ---';
  const claude = setup({}, [{ type: 'assistant', message: { content: [{ type: 'text', text: block }] } }, { type: 'result', subtype: 'success', result: block }].map(e => JSON.stringify(e)).join('\n') + '\n');
  claude.clock.written = '2026-11-04T14:00:00Z'; claude.clock.now = new Date('2026-11-04T14:03:00Z');
  assert.equal(handedIn(claude.probes, claude.orders.get('T1').runs[0])?.ended, false);
  assert.equal(lingeringOf(claude.project, claude.probes, claude.orders.get('T1').runs[0]), undefined);
  // The report is found in the log whether the process is alive or not (a run a person ends by hand).
  assert.equal(reportInRunLog(s.probes, run())?.report.summary, 'separated figures, all checks pass');
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

test('a lingering root stop records and reports a failed descendant listing', () => {
  const s = setup({ on_lingering: 'stop' });
  s.probes.stopTree = pid => ({ stopped: [pid], leftRunning: [], problem: 'listing' });
  assert.match(stopLingeringRun(s.orders, s.probes, 'T1'), /Could not list descendants.*may still be running/);
  assert.equal(s.orders.store.events().find(e => e.type === 'lingering-stopped')?.data?.problem, 'listing');
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

