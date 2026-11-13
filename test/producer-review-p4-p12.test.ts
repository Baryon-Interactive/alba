import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { validateProject } from './state-helper.ts';
import { planOrder } from '../src/orders/planned.ts';
import { readStateJson, writeStateFile } from '../src/orders/state-files.ts';
import { ACTIVE_CHAT } from '../src/producer/conversation-state.ts';
import { acceptDraft, planFingerprint } from '../src/producer/drafting.ts';
import { callProducerTool } from '../src/producer/mcp.ts';
import { createChatCase, intakeProducer, producerAct, producerActions, producerCases, runProducerAction, setProducerPaused, type ProducerAction, type ProducerCase } from '../src/producer/producer.ts';
import { ProducerSessionManager, compactSessionCard, producerAct as routerAct, producerSessionStatus, producerSessionTurns, type SessionEngine, type SessionEvent, type SessionStartOptions } from '../src/producer/session.ts';
import { emptyUsage } from '../src/producer/session-usage.ts';
import { pollProducerWorks, producerWorks, startProducerWork, type ProducerWork } from '../src/producer/work-sessions.ts';
import { startCoordinator } from '../src/serve/coordinator.ts';

class Engine implements SessionEngine {
  batches: string[][] = []; starts: SessionStartOptions[] = []; stops = 0;
  private queue: SessionEvent[] = []; private waiter?: (event: SessionEvent) => void;
  async start(options: SessionStartOptions) { this.starts.push(options); }
  async sendBatch(messages: string[]) { this.batches.push(messages); }
  emit(event: SessionEvent) { if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(event); } else this.queue.push(event); }
  async *readEvents(): AsyncIterable<SessionEvent> { for (;;) yield this.queue.shift() ?? await new Promise<SessionEvent>(r => { this.waiter = r; }); }
  async stop() { this.stops++; }
  usage() { return emptyUsage(); }
}
const settings = (producer: Record<string, unknown> = {}) => () => ({ producer: { enabled: true, rules: [], budgets: {}, session: { enabled: true, engine: 'claude', max_turns: 100 }, ...producer } });
const settle = () => new Promise(r => setTimeout(r, 30));
type Fixture = Awaited<ReturnType<typeof fixture>>;
const workProbes = (f: Fixture) => ({ ...f.board.ctx.probes, readText: (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } }, processStartedAt: () => '2026-01-01T00:00:00Z' });
function card(trigger: string, order?: string, key = `${trigger}/SAMPLE`): ProducerCase {
  return { id: key, key, project: 'demo', trigger, revision: 1, status: 'open', openedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...(order ? { order } : {}), facts: { run: 'run-1' }, card: { trigger, summary: 'Fixture card', stage: 'blocked', pointers: [], untrusted: [] } };
}
const finish = (run: ProducerWork, result: unknown) => writeFileSync(run.log, JSON.stringify({ type: 'result', result: `--- alba-producer-work ---\n${JSON.stringify(result)}\n--- end ---` }) + '\n');

test('P-4: an action filed under another case while a chat runs does not borrow its id, and a borrowed id runs nothing', async () => {
  const f = await fixture({ populate: false, project: settings() });
  const p = f.board.ctx.projects[0];
  f.orders.add({ tag: 'T1', title: 'Fixture', kind: 'docs' });
  writeStateFile(p, '_producer-cases.json', JSON.stringify([card('question', 'T1')]));
  const chat = createChatCase(p, 'message-1');
  writeStateFile(p, ACTIVE_CHAT, JSON.stringify('message-1'));
  // The note rule observes by default: a would-do.
  const other = producerAct(p, f.orders, 'question/SAMPLE', 'note', { note: 'A router note during the chat' });
  assert.equal(other.status, 'would-do'); assert.equal(other.messageId, undefined);
  assert.throws(() => runProducerAction(p, f.orders, other.id), /only observed/);
  const asked = producerAct(p, f.orders, chat.key, 'note', { note: 'The director asked for this', target: 'T1' });
  assert.equal(asked.messageId, 'message-1');
  assert.equal(runProducerAction(p, f.orders, asked.id).status, 'done');
  // A stored would-do carrying a chat id under a different case (written before this fix) stays unrunnable.
  const forged: ProducerAction = { ...other, id: 'forged', idempotencyKey: 'forged', messageId: 'message-1' };
  writeStateFile(p, '_producer-actions.json', JSON.stringify([...readStateJson<ProducerAction[]>(p, '_producer-actions.json', []), forged]));
  assert.throws(() => runProducerAction(p, f.orders, 'forged'), /only observed/);
  assert.equal(producerActions(p).find(a => a.id === 'forged')?.status, 'would-do');
});

test('P-5: accepting or sending back a delivery needs its finished review, under any case; a work result is proposed only after the router was shown it', async () => {
  const f = await fixture({ populate: false, project: settings({ rules: [{ id: 'accept', instruction: 'Accept', action: 'accept', mode: 'propose' }, { id: 'note', instruction: 'Note', action: 'note', mode: 'propose' }] }) });
  const p = f.board.ctx.projects[0], probes = workProbes(f);
  f.orders.add({ tag: 'R1', title: 'Delivery', kind: 'docs' });
  writeFileSync(path.join(p.work_orders, 'R1-delivery.md'), '# R1\n\n## Acceptance\n- done\n');
  f.orders.act('R1', 'queue'); f.orders.runStart('R1', { worker: 'coder' });
  f.orders.report('R1', { status: 'ready', summary: 'Done', evidence: [], commits: [] }); f.orders.runEnd('R1');
  const delivery = intakeProducer(p, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
  assert.ok(delivery);
  writeStateFile(p, '_producer-cases.json', JSON.stringify([...producerCases(p), card('question', 'R1')]));
  // The old guard looked at the case only: a proposal filed under another case of the same order went through.
  assert.throws(() => routerAct(p, f.orders, 'question/SAMPLE', 'accept', { target: 'R1' }), /needs its finished delivery review/);
  assert.throws(() => routerAct(p, f.orders, delivery.key, 'rework', { note: 'Redo it' }), /needs its finished delivery review/);
  const review = startProducerWork(p, f.orders, delivery.key, 'review', '', probes);
  finish(review, { summary: 'Reviewed', finding: 'Acceptance item 1 is met.', action: { kind: 'note', note: 'Looks complete' } });
  pollProducerWorks(p, probes);
  assert.equal(producerWorks(p)[0].status, 'done');
  assert.throws(() => routerAct(p, f.orders, 'question/SAMPLE', 'accept', { target: 'R1' }), /add work: /);
  assert.throws(() => routerAct(p, f.orders, 'question/SAMPLE', 'accept', { target: 'R1', work: review.id }), /has not been shown/);
  assert.throws(() => routerAct(p, f.orders, delivery.key, 'note', { work: review.id }), /has not been shown/);
  // The card carries the finding and the proposed action; reading the work shows it too.
  const shown = compactSessionCard(producerCases(p).find(c => c.key === delivery.key)!, p);
  assert.match(JSON.stringify(shown.work), /Acceptance item 1 is met/); assert.ok(shown.may.some(m => m.startsWith('producer_act:accept|')));
  assert.match(JSON.stringify(callProducerTool(p, f.orders, 'producer_read', { kind: 'work', id: review.id })), /Looks complete/);
  const accept = routerAct(p, f.orders, 'question/SAMPLE', 'accept', { target: 'R1', work: review.id });
  assert.equal(accept.status, 'proposed'); assert.equal(accept.source, `work/${review.id}`);
  assert.equal(routerAct(p, f.orders, delivery.key, 'note', { work: review.id }).note, 'Looks complete');
  // producer.reviews: false leaves the delivery to a person.
  p.producer.reviews = false;
  assert.throws(() => routerAct(p, f.orders, delivery.key, 'accept', { work: review.id }), /reviews are off/);
});

test('P-5: a card with a finished result marks it shown once it is sent', async () => {
  const f = await fixture({ populate: false, project: settings({ rules: [{ id: 'note', instruction: 'Note', action: 'note', mode: 'propose' }] }) });
  const p = f.board.ctx.projects[0], probes = workProbes(f), engine = new Engine();
  const blocked = card('blocked');
  writeStateFile(p, '_producer-cases.json', JSON.stringify([blocked]));
  const run = startProducerWork(p, f.orders, blocked.key, 'work', 'Inspect it', probes);
  finish(run, { summary: 'Findings', finding: 'Stored facts agree', action: { kind: 'note', note: 'All good' } });
  pollProducerWorks(p, probes);
  const manager = new ProducerSessionManager(p, f.orders, () => engine, probes);
  await manager.onPass([blocked]);
  assert.match(engine.batches[0][0], /Stored facts agree/);
  assert.ok(producerWorks(p)[0].shownAt);
  assert.equal(routerAct(p, f.orders, blocked.key, 'note', { work: run.id }).status, 'proposed');
  await manager.stop();
});

test('P-6: detached work is reconciled by serve while the router session is off', async () => {
  const f = await fixture({ populate: false, project: () => ({ producer: { enabled: true, rules: [], budgets: {}, session: { enabled: false, max_turns: 4 } } }) });
  const p = f.board.ctx.projects[0], probes = workProbes(f);
  planOrder(p, f.orders, { tag: 'DOC1', title: 'Docs', kind: 'docs', needs: [], intent: 'Write it.' });
  const c = intakeProducer(p, f.orders, { verify: false }).find(c => c.order === 'DOC1')!;
  // A person's "draft again" starts work with no router session.
  const run = startProducerWork(p, f.orders, c.key, 'draft', '', probes);
  writeFileSync(run.log, JSON.stringify({ type: 'assistant', message: { id: 'req-1', usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n' + JSON.stringify({ type: 'result', result: '--- alba-producer-work ---\n{"summary":"x","action":{"kind":"draft-order","order":{"tag":"DOC1","title":"Docs","kind":"docs","needs":[]}}}\n--- end ---\n--- alba-producer-body ---\n# DOC1\n\n## Acceptance\n- done\n--- end body ---' }) + '\n');
  assert.equal(producerWorks(p)[0].status, 'running');
  const coordinator = startCoordinator({ projects: [p], probes, workers: f.board.ctx.workers!, everyMinutes: 0, maxDispatch: 0, print: () => {}, port: 0, eventMs: 100000, watchMs: 100000, reloadConfigs: false }, f.board);
  try {
    assert.equal(producerWorks(p)[0].status, 'done');
    assert.equal(producerWorks(p)[0].usage.total_tokens, 15);
  } finally { await coordinator.stop(); }
});

test('P-7: a router turn that never ends is failed and the session starts again with a recovery note', async () => {
  const f = await fixture({ populate: false, project: settings() });
  const p = f.board.ctx.projects[0], engine = new Engine();
  p.producer.session.turn_timeout_minutes = 5;
  const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await manager.onPass([card('question')]);
  assert.equal(engine.batches.length, 1);
  // Still inside the limit: nothing happens and the next card waits.
  await manager.onPass([card('blocked')], new Date(Date.now() + 4 * 60_000));
  assert.equal(engine.batches.length, 1); assert.equal(engine.stops, 0);
  await manager.onPass([card('blocked')], new Date(Date.now() + 6 * 60_000));
  assert.equal(engine.stops, 1); assert.equal(engine.starts.length, 2);
  assert.match(producerSessionTurns(p)[0].error ?? '', /longer than 5 minutes/);
  assert.match(engine.batches.at(-1)![0], /did not finish within 5 minutes/);
  assert.match(readFileSync(path.join(p.state_dir, 'producer-audit.jsonl'), 'utf8'), /session-turn-timeout/);
  // After the recovery turn the waiting card goes out, and the card of the failed turn is unsent again.
  engine.emit({ type: 'result', text: 'Read the open cases.' }); await settle();
  assert.match(engine.batches.at(-1)![0], /blocked\/SAMPLE/);
  engine.emit({ type: 'result' }); await settle();
  await manager.onPass([card('question')]);
  assert.match(engine.batches.at(-1)![0], /question\/SAMPLE/);
  await manager.stop();
  assert.throws(() => validateProject({ id: 'x', name: 'x', root: f.root, work_orders: f.root, state_dir: f.dir, producer: { session: { turn_timeout_minutes: 0 } } }, path.join(f.dir, 'alba.yaml')), /turn_timeout_minutes/);
});

test('P-8: with a daily cost cap, a model without a price sends nothing and starts no work', async () => {
  const f = await fixture({ populate: false, project: settings({ budgets: { cost_per_day_usd: 1 } }) });
  const p = f.board.ctx.projects[0], engine = new Engine();
  p.producer.session.model = 'unpriced-model';
  writeStateFile(p, '_producer-cases.json', JSON.stringify([card('blocked')]));
  const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await manager.start();
  assert.equal(await manager.sendBatch(['route']), false); assert.equal(engine.batches.length, 0);
  assert.match(producerSessionStatus(p).lastError ?? '', /unpriced-model has no producer.model_prices/);
  assert.throws(() => startProducerWork(p, f.orders, 'blocked/SAMPLE', 'work', 'x', workProbes(f)), /model_prices/);
  p.producer.model_prices = { 'unpriced-model': { input: 1, cache_read: .1, cache_write: 1, output: 4 } };
  assert.equal(await manager.sendBatch(['route']), true);
  await manager.stop();
});

test('P-9: a paused producer starts no session and sends no router turn', async () => {
  const f = await fixture({ populate: false, project: settings() });
  const p = f.board.ctx.projects[0], engine = new Engine();
  const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  setProducerPaused(p, true);
  await manager.onPass([card('question')]);
  assert.equal(engine.starts.length, 0); assert.equal(engine.batches.length, 0);
  await manager.start();
  assert.equal(await manager.sendBatch(['brief']), false); assert.equal(engine.batches.length, 0);
  assert.match(producerSessionStatus(p).lastError ?? '', /paused/);
  setProducerPaused(p, false);
  await manager.onPass([card('question')]);
  assert.equal(engine.batches.length, 1); assert.match(engine.batches[0][0], /question/);
  await manager.stop();
});

test('P-10: detached work sessions are capped by producer.session.max_work_sessions', async () => {
  const f = await fixture({ populate: false, project: settings() });
  const p = f.board.ctx.projects[0], probes = workProbes(f);
  p.producer.session.max_work_sessions = 1;
  writeStateFile(p, '_producer-cases.json', JSON.stringify([card('blocked', undefined, 'blocked/A'), card('failed', undefined, 'failed/B')]));
  const first = startProducerWork(p, f.orders, 'blocked/A', 'work', 'one', probes);
  assert.throws(() => startProducerWork(p, f.orders, 'failed/B', 'work', 'two', probes), /max_work_sessions: 1/);
  assert.equal(f.spawned.length, 1);
  finish(first, { summary: 'Done', finding: 'ok' }); pollProducerWorks(p, probes);
  assert.equal(startProducerWork(p, f.orders, 'failed/B', 'work', 'two', probes).status, 'running');
  assert.throws(() => validateProject({ id: 'x', name: 'x', root: f.root, work_orders: f.root, state_dir: f.dir, producer: { session: { max_work_sessions: 'many' } } }, path.join(f.dir, 'alba.yaml')), /max_work_sessions/);
});

test('P-11: reprioritize never drops an open dependency or makes a cycle', async () => {
  const f = await fixture({ populate: false, project: settings({ rules: [{ id: 'prio', instruction: 'Reorder', action: 'reprioritize', mode: 'propose' }] }) });
  const p = f.board.ctx.projects[0];
  f.orders.add({ tag: 'B1', title: 'Base', kind: 'docs' });
  f.orders.add({ tag: 'C1', title: 'Other', kind: 'docs' });
  f.orders.add({ tag: 'A1', title: 'Top', kind: 'docs', needs: ['B1'] });
  f.orders.add({ tag: 'D1', title: 'Later', kind: 'docs', needs: ['A1'] });
  writeStateFile(p, '_producer-cases.json', JSON.stringify([card('blocked', 'A1')]));
  const act = (needs: string[], note: string) => producerAct(p, f.orders, 'blocked/SAMPLE', 'reprioritize', { needs, priority: 5, note });
  assert.match(act([], 'drop').refusal ?? '', /A1 still depends on B1/);
  // A need that names no order yet only makes A1 wait.
  assert.equal(act(['B1', 'NOPE9'], 'unknown').status, 'proposed');
  assert.match(act(['B1', 'D1'], 'cycle').refusal ?? '', /depend on itself/);
  const ok = act(['B1', 'C1'], 'add');
  assert.equal(ok.status, 'proposed');
  // Checked again when a person runs it: a stored proposal that drops B1 fails without changing the order.
  const stale: ProducerAction = { ...ok, id: 'stale', idempotencyKey: 'stale', needs: [] };
  writeStateFile(p, '_producer-actions.json', JSON.stringify([...readStateJson<ProducerAction[]>(p, '_producer-actions.json', []), stale]));
  const ran = runProducerAction(p, f.orders, 'stale');
  assert.equal(ran.status, 'failed'); assert.match(ran.refusal ?? '', /still depends on B1/);
  assert.deepEqual(f.orders.get('A1').order.needs, ['B1']);
  assert.equal(runProducerAction(p, f.orders, ok.id).status, 'done');
  assert.deepEqual(f.orders.get('A1').order.needs, ['B1', 'C1']); assert.equal(f.orders.get('A1').order.priority, 5);
});

test('P-12: accepting a draft keeps the worker a person chose; a draft worker hint only fills an empty one', async () => {
  const f = await fixture({ populate: false, project: settings() });
  const p = f.board.ctx.projects[0];
  const body = '# Doc\n\n## Acceptance\n- done\n';
  planOrder(p, f.orders, { tag: 'PIN1', title: 'Pinned', kind: 'docs', needs: [], intent: 'Write it.' });
  f.orders.update('PIN1', { worker: 'artist' });
  acceptDraft(p, f.orders, { tag: 'PIN1', title: 'Pinned', kind: 'docs', needs: [], body }, planFingerprint(f.orders.get('PIN1')));
  assert.equal(f.orders.get('PIN1').order.worker, 'artist');
  planOrder(p, f.orders, { tag: 'PIN2', title: 'Pinned too', kind: 'docs', needs: [], intent: 'Write it.' });
  f.orders.update('PIN2', { worker: 'artist' });
  acceptDraft(p, f.orders, { tag: 'PIN2', title: 'Pinned too', kind: 'docs', needs: [], body, worker: 'coder' }, planFingerprint(f.orders.get('PIN2')));
  assert.equal(f.orders.get('PIN2').order.worker, 'artist');
  planOrder(p, f.orders, { tag: 'FREE1', title: 'Free', kind: 'docs', needs: [], intent: 'Write it.' });
  acceptDraft(p, f.orders, { tag: 'FREE1', title: 'Free', kind: 'docs', needs: [], body, worker: 'coder' }, planFingerprint(f.orders.get('FREE1')));
  assert.equal(f.orders.get('FREE1').order.worker, 'coder');
});
