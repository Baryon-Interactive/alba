import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { ACTIVITY_NOW, seedProducerActivity } from './fixtures/producer-activity.ts';
import { producerLog } from '../src/producer/activity.ts';
import { activityLine, activityVerb, verificationClaim } from '../src/producer/activity-format.ts';
import { readStateFile, writeStateFile } from '../src/orders/state-files.ts';
import { alba, projectDir } from './cli-helper.ts';
import { loadProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { selectTestBackend } from './state-helper.ts';
import { producerSessionHeartbeatProblem } from '../src/producer/session.ts';

const options = { populate: false, project: () => ({ producer: { enabled: true, rules: [{ id: 'review', action: 'accept', mode: 'auto', instruction: 'Review stored delivery evidence' }], budgets: { turns_per_hour: 20, usage_per_day: 100000, review_runs_per_day: 10, draft_runs_per_day: 5 }, round: { enabled: true, every_minutes: 60 } } }) };
test('log route merges audit events and actions once, newest first, without changing state', async () => {
  const f = await fixture(options), p = f.board.ctx.projects[0];
  seedProducerActivity(p, f.orders); f.board.hub.stop();
  const before = readStateFile(p, 'producer-audit.jsonl');
  const response = await f.get('/api/producer/log?project=demo');
  assert.equal(response.status, 200);
  const log = response.body;
  assert.equal(log.rows.length, 35); // 36 actions minus 6 hidden superseded + 5 audit events
  assert.deepEqual(log.rows.map((r: { at: string }) => Date.parse(r.at)), log.rows.map((r: { at: string }) => Date.parse(r.at)).sort((a: number, b: number) => b - a));
  assert.equal(log.rows.filter((r: { id: string }) => r.id === 'action-00').length, 1);
  for (const kind of ['pause', 'resume', 'budget-exhausted', 'session-start', 'session-stop']) assert.ok(log.rows.some((r: { kind: string }) => r.kind === kind));
  assert.equal(log.rows[0].claim, true);
  assert.equal(log.rows[0].acceptance.designStep.status, 'passed');
  assert.match(log.rows[0].acceptance.merge, /^[a-f\d]{40}$/);
  assert.equal(readStateFile(p, 'producer-audit.jsonl'), before);
  assert.equal(f.spawned.length, 0);
  assert.equal((await f.get('/api/producer/log?project=missing')).status, 404);
  assert.equal((await f.get('/api/producer/log?project=demo&since=nonsense')).status, 400);
});
test('route filters kind, order, status, autonomous and superseded; preserves UTC timestamps for browser local days', async () => {
  const f = await fixture(options), p = f.board.ctx.projects[0]; seedProducerActivity(p, f.orders);
  const get = async (q: string) => (await f.get(`/api/producer/log?project=demo&${q}`)).body.rows;
  assert.equal((await get('superseded=true')).length, 41);
  assert.ok((await get('kind=accept')).every((r: { kind: string }) => r.kind === 'accept'));
  assert.equal((await get('order=DEMO1')).length, 1);
  assert.ok((await get('status=failed')).every((r: { status: string }) => r.status === 'failed'));
  assert.equal((await get('status=superseded')).length, 6);
  const auto = await get('autonomous=true'); assert.equal(auto.length, 12);
  assert.ok(auto.every((r: { mode: string; status: string }) => r.mode === 'auto' && ['done', 'failed'].includes(r.status)));
  const a = await get('since=2026-06-18T00:00:00Z'), b = await get(`since=${encodeURIComponent('2026-06-18T08:00:00+08:00')}`);
  assert.deepEqual(a, b);
  assert.ok(a.every((r: { at: string }) => r.at.endsWith('Z')));
  assert.ok((await get('superseded=true')).some((r: { at: string }) => r.at.startsWith('2026-06-17')));
});
test('log reads current state without deleting or overwriting it', async () => {
  const f = await fixture(options), p = f.board.ctx.projects[0]; f.board.hub.stop();
  const legacy = {
    '_producer-actions.json': JSON.stringify([{ id: 'legacy-action', caseId: 'legacy-case', kind: 'rework', mode: 'auto', status: 'done', at: ACTIVITY_NOW, note: 'Verified the synthetic sample', ruleId: 'review', policyVersion: 'synthetic-policy' }]),
    '_producer-cases.json': '[]',
    '_producer-session-budget.json': JSON.stringify({ hour: ACTIVITY_NOW.slice(0, 13), hourTurns: 3, day: ACTIVITY_NOW.slice(0, 10), dayUsage: 20 }),
    'producer-audit.jsonl': JSON.stringify({ kind: 'pause', at: ACTIVITY_NOW }) + '\n',
  };
  for (const [name, value] of Object.entries(legacy)) writeStateFile(p, name, value);
  const rows = (await f.get('/api/producer/log?project=demo')).body.rows;
  assert.equal(rows.length, 2); assert.ok(rows.find((r: { id: string; claim: boolean }) => r.id === 'legacy-action' && r.claim));
  assert.equal(producerLog(p, f.orders, {}, new Date(ACTIVITY_NOW)).now.budgets[0].used, 3);
  for (const [name, value] of Object.entries(legacy)) {
    assert.equal(readStateFile(p, name), value);
  }
});
test('Now reads active case, schedule and each budget with UTC reset boundaries; stale counters reset', async () => {
  const f = await fixture(options), p = f.board.ctx.projects[0]; seedProducerActivity(p, f.orders);
  const now = producerLog(p, f.orders, {}, new Date(ACTIVITY_NOW)).now;
  assert.equal(now.state, 'thinking'); assert.equal(now.cases[0].order, 'DEMO3');
  assert.equal(now.nextRoundAt, '2026-06-18T11:00:00.000Z');
  assert.deepEqual(now.budgets.map(b => b.used), [7, 18000, 0, 2, 0]);
  assert.equal(now.budgets[0].resetsAt, '2026-06-18T11:00:00.000Z');
  assert.equal(now.budgets[1].resetsAt, '2026-06-19T00:00:00.000Z');
  assert.deepEqual(producerLog(p, f.orders, {}, new Date('2026-06-19T00:00:00Z')).now.budgets.map(b => b.used), [0, 0, 0, 0, 0]);
  writeStateFile(p, '_producer-session.json', JSON.stringify({ state: 'paused', budgetUntil: '2026-06-19T00:00:00Z', lastError: 'Budget reached' }));
  assert.equal(producerLog(p, f.orders, {}, new Date(ACTIVITY_NOW)).now.state, 'budget-exhausted');
  assert.equal(producerLog(p, f.orders, {}, new Date('2026-06-19T00:01:00Z')).now.state, 'idle');
  writeStateFile(p, '_producer-paused.json', 'true');
  assert.equal(producerLog(p, f.orders, {}, new Date(ACTIVITY_NOW)).now.state, 'paused');
});

test('never-started producer is idle without a heartbeat warning; an explicit stop stays stopped', async () => {
  const f = await fixture(options), p = f.board.ctx.projects[0]; f.board.hub.stop();
  p.producer.session.enabled = true;
  assert.equal(producerLog(p, f.orders).now.state, 'idle');
  assert.equal(producerSessionHeartbeatProblem(p), undefined);
  writeStateFile(p, '_producer-session.json', JSON.stringify({ state: 'stopped', turns: 0, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }));
  assert.equal(producerLog(p, f.orders).now.state, 'stopped');
  assert.match(producerSessionHeartbeatProblem(p)!, /heartbeat is stale/);
});
test('Now shows host recovery or the retry deadline while preserving the engine error', async () => {
  const f = await fixture(options), p = f.board.ctx.projects[0];
  p.producer.session.enabled = true;
  writeStateFile(p, '_producer-session.json', JSON.stringify({ state: 'stopped', recovery: { cause: 'host-restart', at: ACTIVITY_NOW, note: 'Lost host' }, lastHeartbeat: '2026-01-01T00:00:00Z' }));
  const recovering = producerLog(p, f.orders).now;
  assert.equal(recovering.state, 'recovering');
  assert.equal(recovering.reason, 'Recovering after host restart');
  assert.equal(producerSessionHeartbeatProblem(p), undefined);
  const retryAt = '2026-06-18T11:30:00.000Z';
  writeStateFile(p, '_producer-session.json', JSON.stringify({ state: 'error', lastError: 'MCP init failed', retryAt }));
  const failed = producerLog(p, f.orders).now;
  assert.equal(failed.state, 'error'); assert.equal(failed.reason, 'MCP init failed'); assert.equal(failed.retryAt, retryAt);
  assert.match(producerSessionHeartbeatProblem(p)!, /will retry at/);
});
test('claim detection marks English and Chinese verification claims only on acceptance/rework', () => {
  for (const text of ['spot check of 25 entries', 'SPOT-CHECKED', 'sampled the rows', 'verified all items', 'spot checked: zero errors', 'verification complete']) assert.equal(verificationClaim('accept', text), true, text);
  assert.equal(verificationClaim('rework', 'Sampled and found errors'), true);
  assert.equal(verificationClaim('accept', 'Ready to merge'), false);
  assert.equal(verificationClaim('note', 'verified'), false);
  assert.equal(activityVerb({ kind: 'accept', status: 'failed' }), 'failed');
  assert.equal(activityVerb({ kind: 'accept', status: 'refused' }), 'refused');
});
test('CLI log matches API rows and shared plain words, with since and no intake side effects', async () => {
  const f = await fixture({ populate: false });
  const file = projectDir(f.dir, 'producer:\n  enabled: true\n  rules: []\n');
  selectTestBackend(file);
  const p = loadProject(file), orders = new Orders(stateStore(p)); seedProducerActivity(p, orders);
  const before = readStateFile(p, '_producer-cases.json'), expected = producerLog(p, orders, { since: '2026-06-18T00:00:00Z' }).rows;
  const args = ['producer', 'log', '--since', '2026-06-18T00:00:00Z'];
  const json = alba(file, [...args, '--json']); assert.equal(json.code, 0, json.err); assert.deepEqual(JSON.parse(json.out).rows, JSON.parse(JSON.stringify(expected)));
  const plain = alba(file, args); assert.equal(plain.code, 0, plain.err); assert.equal(plain.out, expected.map(r => activityLine(r)).join('\n'));
  assert.equal(readStateFile(p, '_producer-cases.json'), before);
  assert.notEqual(alba(file, ['producer', 'log', '--since', 'invalid']).code, 0);
});
