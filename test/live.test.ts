import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LiveFold, LiveRuns, liveSummary } from '../src/run/live.ts';
import { isTransientError, isLimitError } from '../src/run/transient.ts';
import { parseActions } from '../src/run/loops.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { planTick } from '../src/tick/plan.ts';
import { projectDir, alba } from './cli-helper.ts';
import { loadProject } from './state-helper.ts';
import { Orders } from '../src/orders/service.ts';
import { stateStore } from '../src/orders/backend.ts';
import { mkdirSync } from 'node:fs';
import { tmpDir } from './tmp.ts';

const at = '2026-01-01T00:00:00.000Z';
const events = [
  { type: 'turn.started', alba_at: at },
  { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Checking the build.\nDetails retained.' }, alba_at: at },
  { type: 'item.updated', item: { type: 'todo_list', items: [{ text: 'Build', completed: false }] }, alba_at: at },
  { type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'package game' }, alba_at: at },
  { type: 'future.event', item: { type: 'future_item' }, alba_at: at },
];
test('folds synthetic Codex events, bounded failed output, unknown items, usage and long commands', () => {
  const fold = new LiveFold(['package']);
  for (const e of events) fold.event(e, at);
  assert.equal(fold.view(new Date('2026-01-01T00:10:00Z')).phase, 'waiting_long_command');
  assert.equal(fold.view(new Date('2026-01-01T00:10:00Z')).current?.elapsed_seconds, 600);
  assert.equal(fold.state.plan?.current, 'Build');
  fold.event({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'package game', exit_code: 2, aggregated_output: Array.from({ length: 30 }, (_, i) => `error ${i}`).join('\n') }, alba_at: '2026-01-01T00:10:00Z' }, at);
  fold.event({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/game.ts', kind: 'update' }] } }, at);
  fold.event({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 } }, at);
  const s = fold.view(new Date('2026-01-01T00:10:00Z'));
  assert.equal(s.messages[0].text, 'Checking the build.\nDetails retained.');
  assert.equal(s.recent.find(a => a.output_tail)?.output_tail?.split('\n').length, 20);
  assert.equal(s.usage.input_tokens, 100);
  assert.equal(s.usage.turns, 1);
  assert.deepEqual(liveSummary(s).files_changed, ['src/game.ts']);
  assert.equal(liveSummary(s).long_command_minutes, 10);
  assert.equal(liveSummary(s).failed_commands, 1);
});

test('incremental byte offsets preserve a truncated UTF-8 last line and rebuild after restart', t => {
  const tmp = tempOrders();
  const cfg = validateProject({ id: 'demo', name: 'Demo', root: '.', work_orders: '.', state_dir: 'state' }, path.join(tmp.dir, 'alba.yaml'));
  const file = path.join(tmp.dir, 'run.events.jsonl');
  writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n' + '{"type":"item.completed","item":{"type":"agent_message","text":"');
  const run = { id: 'r1', seq: 1, worker: 'coder', started: at, events_file: file };
  const reader = new LiveRuns();
  assert.equal(reader.read(cfg, 'A', run, systemProbes).messages.length, 1);
  appendFileSync(file, 'Hello"}}\n');
  assert.equal(reader.read(cfg, 'A', run, systemProbes).messages.at(-1)?.text, 'Hello');
  assert.equal(reader.read(cfg, 'A', run, systemProbes).messages.length, 2);
  assert.equal(new LiveRuns().read(cfg, 'A', run, systemProbes).messages.length, 2);
});

test('JSON errors classify transient and quota failures; command events drive loops', () => {
  assert.equal(isTransientError('{"type":"error","message":"HTTP 503 Service Unavailable"}'), true);
  assert.equal(isTransientError('{"type":"turn.failed","error":{"message":"stream disconnected"}}'), true);
  assert.equal(isLimitError('{"type":"error","message":"quota exhausted"}'), true);
  const parsed = parseActions(events.map(e => JSON.stringify(e)).join('\n'));
  assert.equal(parsed.format, 'codex-json');
  assert.equal(parsed.open, 'package game');
});

test('an active configured long command never becomes a stall, even past the old timeout', () => {
  const r = planTick({ now: new Date('2026-01-02T00:00:00Z'), orders: [{ tag: 'A', stage: 'running', kind: 'sim', row: 0, rework: false, resume: false, endedWithoutReport: false, runStartedAt: at }], activity: { A: { worktree: '.', lastCommitAt: at, logAt: at, openCommand: 'package game', waitingLong: true } }, workers: [], caps: {}, reworkReserve: 0, stallMinutes: 10, startReceiptMinutes: 15, longCommandMinutes: 30, alerts: [] });
  assert.equal(r.problems.some(p => p.kind === 'stalled' || p.kind === 'start-failed'), false);
  assert.equal(r.waiting.length, 1);
});

test('status reads two projects and reports run usage and questions as JSON', () => {
  const dir = tmpDir('alba-status-');
  const paths = ['alpha', 'beta'].map((name, i) => {
    const folder = path.join(dir, name); mkdirSync(folder);
    const file = projectDir(folder);
    writeFileSync(file, `id: ${name}\nname: ${name}\nroot: .\nwork_orders: orders\nstate_dir: state\n`);
    const project = loadProject(file), orders = new Orders(stateStore(project));
    orders.add({ tag: `A${i}`, title: name, kind: 'sim' }); orders.act(`A${i}`, 'queue');
    const { run } = orders.runStart(`A${i}`, { worker: `worker${i}` });
    const eventFile = path.join(folder, 'events.jsonl');
    writeFileSync(eventFile, [JSON.stringify({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'package game' }, alba_at: at }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 }, alba_at: at })].join('\n') + '\n');
    orders.patchRun(`A${i}`, run.id, { events_file: eventFile });
    orders.receiveOutbox(`A${i}`, { id: `out-${i}`, at, kind: 'question', text: 'Choose?' });
    return file;
  });
  const result = alba(paths[0], ['status', '--project', paths[1], '--json']);
  assert.equal(result.code, 0, result.err);
  const rows = JSON.parse(result.out);
  assert.deepEqual(rows.map((r: any) => r.project), ['alpha', 'beta']);
  assert.deepEqual(rows.map((r: any) => r.tokens), [120, 120]);
  assert.equal(rows[0].unanswered[0].text, 'Choose?');
  assert.equal(rows[1].current.command, 'package game');
});

test('a run question answered with an answer action no longer holds the order at awaiting-user', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'Q9', title: 'asks', kind: 'sim' }); orders.act('Q9', 'queue');
  orders.runStart('Q9', { worker: 'coder' });
  orders.receiveOutbox('Q9', { id: 'out-q9', at: '2026-01-01T08:00:00+08:00', kind: 'question', text: 'Fix the mappings myself?' }); // a run's own offset; this is 00:00 UTC
  assert.equal(orders.stage(orders.get('Q9')).stage, 'awaiting-user');
  orders.act('Q9', 'answer', { note: 'Yes, fix them.' });
  assert.equal(orders.stage(orders.get('Q9')).stage, 'running');
});
