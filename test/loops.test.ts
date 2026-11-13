import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { findLoops, idleStretches, isLongCommand, parseActions } from '../src/run/loops.ts';
import { watchRun } from '../src/run/watch.ts';
import { executeTick } from '../src/tick/execute.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures');
const RULES = { repeat: 3, alternate: 6, longCommands: ['build_project.py', 'build-engine.py', 'simulate.sh', 'package', 'PackageTool'] };

const call = (id: string, command: string, exit: number, output = '') => [
  JSON.stringify({ type: 'tool_call', toolCallId: id, title: 'run_terminal_command', toolName: 'run_terminal_command', rawInput: { command }, status: 'pending' }),
  JSON.stringify({ type: 'tool_call_update', toolCallId: id, status: 'in_progress', rawOutput: { type: 'Bash', output_for_prompt: output, exit_code: exit, command } }),
].join('\n');

test('a Codex log: commands, results and errors; exit code 1 of a search is an answer, not a failure', () => {
  const p = parseActions(readFileSync(path.join(fixtures, 'loop-retry.log'), 'utf8'));
  assert.equal(p.format, 'codex');
  assert.equal(p.started, 8);
  assert.equal(p.actions.length, 7);                                // the last command has no result yet
  assert.equal(p.open, 'git log --oneline -3');
  const rg = p.actions.find(a => a.command.startsWith('rg '))!;
  assert.equal(rg.failed, false);                                   // `rg` found nothing: exit 1 is its answer
  const sim = p.actions.filter(a => a.command.includes('simulate.sh'));
  assert.equal(sim.length, 4);
  assert.ok(sim.every(a => a.failed));
  assert.equal(sim[1].error, 'scp: dest open "workspace/dev/tools/wt-t#.sh": failure');
  assert.equal(sim[1].error, sim[2].error);                         // the same error with the same numbers boiled away
  assert.equal(sim[3].error, 'scp: connection closed');
});

test('the same command failing four times in a row is a retry loop; known long commands still count there', () => {
  const p = parseActions(readFileSync(path.join(fixtures, 'loop-retry.log'), 'utf8'));
  const found = findLoops(p.actions, RULES);
  assert.deepEqual(found.map(f => [f.kind, f.count]), [['retry', 4]]);
  assert.match(found[0].text, /failed 4 times in a row: & 'workspace\/Program Files\\\\Git\\\\bin\\\\bash\.exe' tools\/remote\/simulate\.sh t3 --clean -> scp: connection closed/);
  assert.ok(isLongCommand(found[0].command!, RULES.longCommands));   // simulate.sh is a long command and the loop is found all the same
});

test('three identical failures are a repeat, with the command, the error and the count', () => {
  const same = [1, 2, 3].map(i => call(`c${i}`, 'python tools/gen.py --out a', 2, `Traceback (most recent call last):\nValueError: bad value ${i * 7}`)).join('\n');
  const p = parseActions(same);
  assert.equal(p.format, 'stream');
  const found = findLoops(p.actions, RULES);
  assert.deepEqual(found.map(f => [f.kind, f.count, f.command, f.error]), [['repeat', 3, 'python tools/gen.py --out a', 'valueerror: bad value #']]);
  assert.deepEqual(findLoops(parseActions(same.split('\n').slice(0, 4).join('\n')).actions, RULES), []);      // two are not enough
});

test('two commands taking turns for six rounds, mostly failing, are a loop; a build between edits is not', () => {
  const turns = (a: string, b: string, n: number, exit: (i: number) => number) => Array.from({ length: n }, (_, i) => call(`t${i}`, i % 2 === 0 ? a : b, exit(i), 'error: nope')).join('\n');
  const loop = findLoops(parseActions(turns('cargo test', 'git stash', 12, () => 1)).actions, RULES);
  const alt = loop.filter(f => f.kind === 'alternate');
  assert.deepEqual(alt.map(f => f.count), [6]);
  assert.match(alt[0].text, /cargo test <-> git stash/);
  assert.deepEqual(findLoops(parseActions(turns('cargo test', 'git stash', 10, () => 1)).actions, RULES).filter(f => f.kind === 'alternate'), []);            // five rounds
  assert.deepEqual(findLoops(parseActions(turns('cargo test', 'git stash', 12, i => (i % 2 === 0 ? 0 : 1))).actions, RULES).filter(f => f.kind === 'alternate'), []);   // only half of them fail: that is work, not a loop
  assert.deepEqual(findLoops(parseActions(turns('python tools/build_project.py', 'python tools/fix.py', 12, () => 1)).actions, RULES).filter(f => f.kind === 'alternate'), []);   // a long command is left out
});

test('OpenCode events: tool_use with its status and exit code', () => {
  const use = (id: string, command: string, exit: number) => JSON.stringify({ type: 'tool_use', timestamp: 1793717567185 + Number(id) * 1000, part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command }, output: 'boom: bad config', metadata: { exit } } } });
  const text = [JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }), ...[1, 2, 3, 4].map(i => use(String(i), 'make all', 2)), use('9', 'ls', 0)].join('\n');
  const p = parseActions(text);
  assert.equal(p.format, 'opencode');
  assert.equal(p.actions.length, 5);
  assert.equal(p.actions[0].at, 1793717568185);
  assert.deepEqual(findLoops(p.actions, RULES).map(f => [f.kind, f.count, f.command]), [['repeat', 4, 'make all']]);
});

test('the timestamped lines of a Codex log show a long stretch with no new command, and which command was open', () => {
  const text = readFileSync(path.join(fixtures, 'loop-long-build.log'), 'utf8');
  const gaps = idleStretches(text, 20);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].command, /build_project\.py --package/);
  assert.equal(gaps[0].minutes, 29);
  assert.deepEqual(idleStretches(text, 45), []);
});

function projectOn(dir: string, extra: Record<string, unknown> = {}) {
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders, { recursive: true });
  return validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { loop_idle_minutes: 45, ...extra } }, path.join(dir, 'alba.yaml'));
}

function probesAt(clock: { now: Date }, over: Partial<Probes> = {}): Probes & { killed: number[] } {
  const killed: number[] = [];
  return { killed, now: () => clock.now, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return undefined; } }, spawnDetached: () => 1, kill: (pid: number) => { killed.push(pid); return [pid]; }, ...over } as Probes & { killed: number[] };
}

test('idling: the log grows for 45 minutes with no new command and no commit; an open long command or a commit says it is fine', () => {
  const { orders, dir } = tempOrders();
  const project = projectOn(dir, { long_commands: ['build_project.py'] });
  const log = path.join(dir, 'run.log');
  const full = readFileSync(path.join(fixtures, 'loop-long-build.log'), 'utf8');
  const quiet = (s: string) => s.replace('python tools/build_project.py --package --package-dir workspace/Builds/Game/T7', 'python tools/inspect_menus.py --walk workspace/Builds/Game/T7');                  // the open command is no longer a known long command
  const cutAt = full.indexOf('2026-11-04T04:29:54');
  const grow = '2026-11-04T04:40:00.000000Z ERROR codex_core::util: OutputTextDelta without active item\n'.repeat(20);
  orders.add({ tag: 'T7', title: 't', kind: 'ue' });
  orders.act('T7', 'queue');
  const { run } = orders.runStart('T7', { worker: 'coder', extra: { log, pid: 99 } });
  const clock = { now: new Date('2026-01-01T10:00:00Z') };
  const p = probesAt(clock);
  const look = (text: string, lastCommitAt?: string) => { writeFileSync(log, text); return watchRun(project, p, { tag: 'T7', run: orders.get('T7').runs[0], lastCommitAt }, { record: true }); };
  // first look: nothing is known yet
  assert.deepEqual(look(quiet(full.slice(0, cutAt))), []);
  clock.now = new Date('2026-01-01T10:30:00Z');
  assert.deepEqual(look(quiet(full) + grow), []);                                       // 30 minutes is not 45
  clock.now = new Date('2026-01-01T10:50:00Z');
  const idle = look(quiet(full) + grow);
  assert.deepEqual(idle.map(f => [f.kind, f.count]), [['idle', 50]]);
  assert.match(idle[0].text, /grew by \d+ KB in 50 min with no new command and no commit/);
  assert.equal(look(quiet(full) + grow, '2026-01-01T10:40:00Z').length, 0);              // a commit since the last new command
  assert.equal(look(full + grow).length, 0);                                             // the same log, but the open command is a package build: waiting, not idling
  assert.equal(look(quiet(full)).length, 0);                                             // the log did not grow
  assert.ok(run.id);
});

test('the tick lists a looping run as a problem with its evidence; on_loop stop ends it and says why', () => {
  const { orders, dir } = tempOrders();
  const project = projectOn(dir, { on_loop: 'stop' });
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  const log = path.join(dir, 'T3-r1.log');
  copyFileSync(path.join(fixtures, 'loop-retry.log'), log);
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'x', concurrency: 2, launch: { template: 'c1', program: 'coder', args: ['{prompt_file}'] } }] }, 'w.yaml');
  orders.add({ tag: 'T3', title: 'Retry forever', kind: 'sim' });
  orders.act('T3', 'queue');
  orders.runStart('T3', { worker: 'coder', extra: { log, pid: 4321 } });
  const clock = { now: new Date('2026-01-01T10:00:00Z') };
  const p = probesAt(clock);
  const dry = tick(project, orders, workers, p, { record: false }).report;
  const problem = dry.problems.find(x => x.kind === 'looping')!;
  assert.equal(problem.tag, 'T3');
  assert.match(problem.text, /T3: the run is going round in circles: the same command failed 4 times in a row/);
  assert.deepEqual(problem.evidence!.filter(e => /^(times|times)/.test(e)), ['times: 4']);
  assert.ok(problem.evidence!.some(e => e.startsWith('command: ') && e.includes('simulate.sh')));
  assert.ok(problem.evidence!.some(e => e.startsWith('error: scp: connection closed')));
  assert.equal(orders.stage(orders.get('T3')).stage, 'running');                        // a dry run touches nothing
  // report (the default): the run goes on
  const reportOnly = projectOn(dir);
  executeTick({ project: reportOnly, orders, workers, probes: p }, { maxDispatch: 1 });
  assert.equal(orders.stage(orders.get('T3')).stage, 'running');
  assert.deepEqual(p.killed, []);
  // stop: the process is killed, the run ends as stalled, and a failed report says why
  const real = executeTick({ project, orders, workers, probes: p }, { maxDispatch: 1 }).report;
  assert.deepEqual(p.killed, [4321]);
  assert.equal(orders.get('T3').runs[0].outcome, 'stalled');
  assert.equal(orders.stage(orders.get('T3')).stage, 'failed');
  assert.match(orders.get('T3').reports.at(-1)!.summary, /stopped by alba: the run was going round in circles \(command: .*simulate\.sh/);
  assert.ok(real.done.some(d => /T3: stopped run r1/.test(d)));
  assert.ok(orders.store.events().some(e => e.type === 'loop-stopped'));
});
