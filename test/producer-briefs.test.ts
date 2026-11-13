import { zh as translated } from '../src/i18n-zh.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from '../src/config.ts';
import { Orders } from '../src/orders/service.ts';
import { stateStore } from '../src/orders/backend.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { buildBrief, briefDue, briefNumbers, notifyBrief, producerBriefs, scheduledBrief, validBriefProse, saveBriefReadings } from '../src/producer/briefs.ts';
import { ProducerSessionManager, type SessionEngine, type SessionEvent } from '../src/producer/session.ts';
import { fixtureBrief, fixtureNow, trustBriefFixture } from './fixtures/producer-trust-briefs.ts';
import { refreshAgreement, agreementRecords } from '../src/producer/trust.ts';
import { createChatCase, producerAct, producerActions, runProducerAction, rejectProducerAction } from '../src/producer/producer.ts';

function project(backend: 'files' | 'sqlite' = 'files') {
  const base = path.resolve('.alba/producer-trust-briefs-tests'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'fixture-'));
  mkdirSync(path.join(dir, 'orders')); mkdirSync(path.join(dir, 'state'));
  const p = validateProject({ id: 'fixture', name: 'Fixture', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), state: { backend }, producer: { enabled: true, brief: { every_minutes: 60, language: 'en' }, rules: [{ id: 'notes', instruction: 'Record notes', action: 'note', mode: 'propose' }], session: { enabled: true, max_turns: 40, timeout_ms: 100 } } }, path.join(dir, 'alba.yaml'));
  return { p, orders: new Orders(stateStore(p), () => fixtureNow) };
}

test('fixture day brief contains cited changes, running commit age, stalled work, slots, questions, old holds and constraint', () => {
  const en = fixtureBrief(), zh = fixtureBrief('zh');
  for (const text of ['merged: 1', 'delivered: 2', 'sent back: 1', 'failed: 1', 'dispatched: 3', 'held: 0', '120 minutes since last commit', 'Stalled orders: 1', 'code: 2 free', 'Questions: 1', 'Held orders older than three days: 1', 'Constraint:', 'New risks:']) assert.ok(en.text.includes(text), text);
  for (const [key, value] of [['merged', '1'], ['delivered', '2'], ['sent back', '1'], ['Stalled orders', '1']]) assert.ok(zh.text.includes(translated[key] + ': ' + value));
  for (const key of ['Free slots and dispatch blockers:', 'Waiting on a person:', 'Constraint', 'New risks:']) assert.ok(zh.text.includes(translated[key]));
  assert.ok(zh.text.includes(translated['{minutes} minutes since last commit'].replace('{minutes}', '120')));
  assert.deepEqual(briefNumbers(en.text), briefNumbers(zh.text));
  assert.ok(en.facts.every(f => f.id.startsWith('F:') && Array.isArray(f.sources)));
  assert.ok(en.facts.find(f => f.id === 'F:brief.changes.merged')!.sources[0].startsWith('event:'));
  const unknown = trustBriefFixture(); unknown.readings = undefined;
  assert.match(buildBrief(unknown).text, /last commit unavailable/);
});

test('unchanged state is one line; new events, commit, pending action and aging hold make it substantive again', () => {
  const input = trustBriefFixture(), previous = buildBrief(input);
  const quiet = buildBrief({ ...input, previous, now: '2026-01-03T01:00:00.000Z' });
  assert.equal(quiet.text, 'Nothing changed since the last brief.'); assert.equal(quiet.text.split('\n').length, 1);
  assert.equal(buildBrief({ ...input, previous, language: 'zh' }).text, translated["Nothing changed since the last brief."]);
  const changed = buildBrief({ ...input, previous, now: '2026-01-03T01:00:00.000Z', events: [...input.events, { at: '2026-01-03T00:30:00.000Z', tag: 'sample', type: 'action-hold' }] });
  assert.match(changed.text, /held: 1/); assert.match(changed.text, /merged: 0/);
  const progressed = trustBriefFixture(); progressed.readings!.activity.running.lastCommitAt = '2026-01-03T00:00:00.000Z';
  assert.match(buildBrief({ ...progressed, previous, now: '2026-01-03T01:00:00.000Z' }).text, /60 minutes since last commit/);
  const proposed = { id: 'new-card', caseId: 'sample', status: 'proposed', kind: 'note' } as ReturnType<typeof producerActions>[number];
  assert.match(buildBrief({ ...input, previous, actions: [proposed] }).text, /Cards: 1/);
  const beforeOldHold = buildBrief({ ...input, now: '2025-12-31T23:00:00.000Z' });
  assert.match(buildBrief({ ...input, previous: beforeOldHold }).text, /Held orders older than three days: 1/);
});

test('schedule supports intervals, UTC daily boundary and restart without duplicate briefs', async () => {
  const previous = fixtureBrief(), config = { every_minutes: 60, daily_at: '00:30', language: 'en' };
  assert.equal(briefDue(config, '2026-01-03T00:29:00Z', previous), false);
  assert.equal(briefDue(config, '2026-01-03T00:30:00Z', previous), true);
  assert.equal(briefDue({ ...config, daily_at: undefined }, '2026-01-03T01:00:00Z', previous), true);
  const { p, orders } = project();
  await scheduledBrief(p, orders, { now: fixtureNow });
  await scheduledBrief({ ...p }, new Orders(orders.store), { now: fixtureNow });
  assert.equal(producerBriefs(p).length, 1);
  await scheduledBrief(p, orders, { now: '2026-01-03T01:00:00Z' });
  assert.equal(producerBriefs(p).length, 2);
  assert.equal(producerBriefs(p)[0].text.split('\n').length, 1);
});

test('notification receives exact UTF-8 text on stdin and never in argv, without a shell', async () => {
  const { p } = project(), output = path.join(p.root, 'hook.json'), text = 'Brief résumé 42 [F:sample] & $(no execution)';
  const script = 'let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>require("node:fs").writeFileSync(process.argv[1],JSON.stringify({text,args:process.argv.slice(2)})))';
  await notifyBrief([process.execPath, '-e', script, output], text, p.root);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { text, args: [] });
  await assert.rejects(notifyBrief([process.execPath, '-e', 'process.exit(2)'], text, p.root), /exited with 2/);
});

class BriefEngine implements SessionEngine {
  queue: SessionEvent[] = []; waiting?: (event: SessionEvent) => void; sends = 0;
  answer = '';
  async start() { /* fake */ }
  async sendBatch() { this.sends++; const e = { type: 'result', text: this.answer, usage: { total_tokens: 5 } }; if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve(e); } else this.queue.push(e); }
  async *readEvents(): AsyncIterable<SessionEvent> { for (;;) yield this.queue.shift() ?? await new Promise<SessionEvent>(resolve => { this.waiting = resolve; }); }
  async stop() { /* no real process */ }
  usage() { return { input_tokens: 2, output_tokens: 3, total_tokens: 5 }; }
}

test('fake session rewrites only within budget and prose retains numbers and citations', async () => {
  const { p, orders } = project();
  const input = trustBriefFixture();
  orders.store.writeMeta('producer-facts', input.snapshot);
  saveBriefReadings(p, input.readings!);
  const engine = new BriefEngine(), manager = new ProducerSessionManager(p, orders, () => engine);
  await manager.start();
  const draft = buildBrief({ ...input, orders: [], events: [], direction: { version: 0, at: '', priorities: '', stop: '', constraints: '', notes: '' } });
  engine.answer = draft.skeleton.replace('Changes since the last brief:', 'Latest changes:');
  const brief = await scheduledBrief(p, orders, { now: fixtureNow, rewrite: (text, language) => manager.rewriteBrief(text, language) });
  assert.equal(brief?.rewritten, true); assert.equal(engine.sends, 1);
  assert.ok(briefNumbers(brief!.text).every(n => briefNumbers(brief!.skeleton).includes(n)));
  assert.equal(validBriefProse(draft.skeleton, `${draft.skeleton}\nInvented 999999`), false);
  assert.equal(validBriefProse(draft.skeleton, draft.skeleton.replace('[F:brief.changes.merged]', '[F:invented]')), false);
  p.producer.budgets.turns_per_hour = 1;
  assert.equal(await manager.rewriteBrief(draft.skeleton, 'en'), undefined); assert.equal(engine.sends, 1);
  await manager.stop();
});

for (const backend of ['files', 'sqlite'] as const) test(`durable trust and briefs through ${backend} state; no real engine`, async () => {
  const { p, orders } = project(backend), c = createChatCase(p, 'fixture-message');
  const action = producerAct(p, orders, c.id, 'note', { note: 'original', now: new Date() });
  assert.equal(agreementRecords(p).notes.length, 1);
  runProducerAction(p, orders, action.id, { note: 'edited' });
  const other = producerAct(p, orders, c.id, 'note', { note: 'another' }); rejectProducerAction(p, other.id);
  refreshAgreement(p, producerActions(p), [], [], new Date().toISOString());
  assert.deepEqual(agreementRecords(p).notes.map(r => r.outcome), ['edited', 'rejected']);
  p.producer.rules.push({ id: 'drafts', instruction: 'Suggest follow-up work', action: 'add-order', mode: 'observe' });
  assert.throws(() => producerAct(p, orders, c.id, 'add-order', { note: 'obsolete-tag-only' }), /complete draft/);
  const observed = producerAct(p, orders, c.id, 'add-order', { order: { tag: 'planned', title: 'New plan', kind: 'follow-up', needs: [], body: '# New plan\n\n## Acceptance\n- The plan is complete.\n' }, now: new Date(fixtureNow) });
  assert.equal(observed.status, 'would-do'); assert.equal(agreementRecords(p).drafts[0].order, 'planned');
  orders.add({ tag: 'planned', title: 'New plan', kind: 'follow-up', needs: [] });
  refreshAgreement(p, producerActions(p), orders.all(), orders.store.events(), fixtureNow);
  assert.equal(agreementRecords(p).drafts[0].outcome, 'accepted');
  const brief = await scheduledBrief(p, orders, { now: fixtureNow });
  assert.equal(producerBriefs({ ...p })[0].text, brief!.text);
});

test('trust and brief configuration rejects invalid shapes and supports thresholds and argv', () => {
  const { p } = project();
  const base = { id: 'fixture', name: 'Fixture', root: p.root, work_orders: p.work_orders, state_dir: p.state_dir };
  for (const producer of [{ trust: { min_cases: 0 } }, { trust: { raise_rate: 2 } }, { trust: { lower_rate: .95 } }, { trust: { wrong: 1 } }, { brief: { every_minutes: 0, language: 'en' } }, { brief: { every_minutes: 60, language: 'en', command: 'shell text' } }, { brief: { every_minutes: 60, language: 'en', daily_at: '25:00' } }]) assert.throws(() => validateProject({ ...base, producer }, p.file));
});
