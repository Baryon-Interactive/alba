import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { parseStreamLog } from '../src/workers/adapters/stream.ts';
import { launchArgs } from '../src/run/prompt.ts';
import { isTransientError } from '../src/run/transient.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

test('stream log: a real run that was stopped at a command it may not run', () => {
  const log = parseStreamLog(fixture('grok-blocked.log'));
  assert.equal(log.sessionId, '01a1a171-f0d5-7470-bed6-da9198952072');
  assert.equal(log.stopReason, 'cancelled');
  assert.equal(log.turns, 2);
  assert.equal(log.blockedCommand, 'node --version');
  assert.ok(log.costUsd! > 0 && log.tokens! > 0);
  assert.deepEqual(log.errors, []);
});

test('stream log: a real run that ended normally, and a resume of a session that does not exist', () => {
  const done = parseStreamLog(fixture('grok-done.log'));
  assert.equal(done.stopReason, 'end_turn');
  assert.equal(done.blockedCommand, undefined);
  const missing = parseStreamLog(fixture('grok-resume-missing.log'));
  assert.equal(missing.events, 0);
  assert.match(missing.errors.at(-1)!, /Failed to restore session/);
  assert.ok(!isTransientError(missing.errors.join('\n')));   // a 404 is not worth waiting for
});

test('stream log: only error events and plain lines count as errors, so output that mentions 429 does not', () => {
  const text = [
    JSON.stringify({ type: 'tool_call_update', content: [{ type: 'content', content: { type: 'text', text: 'HTTP 429 in the test output' } }] }),
    JSON.stringify({ type: 'text', data: 'stream disconnected' }),
  ].join('\n');
  const log = parseStreamLog(text);
  assert.deepEqual(log.errors, []);
  // the shape of an error event is from the engine's documentation, not from a real incident
  const failed = parseStreamLog(`${text}\n${JSON.stringify({ type: 'error', message: 'request failed: 429 Too Many Requests' })}`);
  assert.ok(isTransientError(failed.errors.join('\n')));
  // a tail cut in the middle of a line is not read as a message
  assert.deepEqual(parseStreamLog('ext":"x"}\n' + JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 's1' }), { cut: true }).errors, []);
});

test('launch template: session arguments are new or resume, and must go with the {session_args} entry', () => {
  const file = validateWorkers({ workers: [{ id: 'g', engine: 'grok-cli', launch: { program: 'g', args: ['--cwd', '{cwd}', '{session_args}', '--prompt-file', '{prompt_file}'], session: { new: ['-s', '{session_id}'], resume: ['-r', '{session_id}'] } } }] }, 'w.yaml');
  const launch = file.workers[0].launch!;
  const values = { cwd: 'workspace/w', prompt_file: 'p.md', last_file: '', model: '', log: '', git_dir: '', worktree_git_dir: '', session_id: 'abc' };
  assert.deepEqual(launchArgs(launch, values, false), ['--cwd', 'workspace/w', '-s', 'abc', '--prompt-file', 'p.md']);
  assert.deepEqual(launchArgs(launch, values, true), ['--cwd', 'workspace/w', '-r', 'abc', '--prompt-file', 'p.md']);
  assert.throws(() => validateWorkers({ workers: [{ id: 'g', engine: 'e', launch: { program: 'g', args: ['{session_args}'] } }] }, 'w.yaml'), /go together/);
});

test('finish: a refused command stops the run as blocked and names the command; the session id is kept for resuming', () => {
  const { orders, dir } = tempOrders();
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: workOrders, state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Do something', kind: 'sim' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'g', extra: { pid: 4242, log: path.join(dir, 'T1.log'), session: 'preset-id' } });
  const probes = { fileTime: () => undefined, readText: () => undefined, isAlive: () => false, tail: () => fixture('grok-blocked.log') } as unknown as Probes;
  const [f] = findFinishes(project, orders, probes);
  assert.equal(f.outcome, 'failed');
  assert.equal(f.report?.status, 'blocked');
  assert.match(f.report!.summary, /node --version/);
  assert.match(f.report!.question!, /node --version/);
  assert.equal(f.session, '01a1a171-f0d5-7470-bed6-da9198952072');
  applyFinish(orders, f);
  const doc = orders.get('T1');
  assert.equal(doc.runs[0].session, '01a1a171-f0d5-7470-bed6-da9198952072');
  assert.equal(orders.stage(doc).stage, 'blocked');
});

test('finish: an engine without a final-message file has its last message read from the log, and saved where the order expects it', () => {
  const { orders, dir } = tempOrders();
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: workOrders, state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Do something', kind: 'sim' });
  orders.act('T1', 'queue');
  const lastFile = path.join(workOrders, 'T1.last.txt');
  orders.runStart('T1', { worker: 'g', extra: { pid: 4242, log: path.join(dir, 'T1.log'), last_file: lastFile } });
  const block = '--- alba-report ---\n{"status":"ready","summary":"README has the section","question":"","evidence":[],"commits":["abc1234"]}\n--- end ---';
  const events = [
    { type: 'text', data: 'Let me look first.' },
    { type: 'tool_call', toolCallId: 'c1', toolName: 'read_file' },
    ...('All done.\n\n' + block).match(/.{1,7}/gs)!.map(data => ({ type: 'text', data })),
    { type: 'end', stopReason: 'end_turn', sessionId: 's-1' },
  ].map(e => JSON.stringify(e)).join('\n');
  const probes = { fileTime: () => undefined, readText: () => undefined, isAlive: () => false, tail: () => events } as unknown as Probes;
  const [f] = findFinishes(project, orders, probes);
  assert.equal(f.outcome, 'completed');
  assert.equal(f.report?.summary, 'README has the section');
  applyFinish(orders, f);
  assert.match(readFileSync(lastFile, 'utf8'), /^All done\./);
  assert.ok(!readFileSync(lastFile, 'utf8').includes('Let me look first'));   // only what followed the last tool call
  assert.equal(orders.stage(orders.get('T1')).stage, 'awaiting-review');
});

test('stream log: a refused edit names the tool and the file (real line from a run whose edit rule was missing)', () => {
  const log = parseStreamLog('permission required: Edit `workspace/work\demo\README.md` was not run, as a headless run cannot ask for approval\n');
  assert.equal(log.blockedCommand, 'Edit workspace/work\demo\README.md');
});
