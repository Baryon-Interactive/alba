import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { callProducerTool } from '../src/producer/mcp.ts';
import { ProducerSessionManager, producerSession, type SessionEngine, type SessionEvent, type SessionStartOptions } from '../src/producer/session.ts';
import { directorMessages, directionProposals, directionVersions, postDirectorMessage, standingDirection, updateDirectorMessage, validateFactCitations } from '../src/producer/conversation-state.ts';
import { intakeProducer, producerActions, producerAudit, setProducerPaused, createChatCase, producerAct, currentProducerActions } from '../src/producer/producer.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { producerWorkspace } from '../src/producer/workspace.ts';
import { startCoordinator } from '../src/serve/coordinator.ts';

class ChatEngine implements SessionEngine {
  options?: SessionStartOptions;
  starts = 0; stops = 0; messages: string[] = [];
  private events: SessionEvent[] = [];
  private waiting?: (event: SessionEvent) => void;
  reply?: (message: string) => void;
  async start(options: SessionStartOptions) { this.options = options; this.starts++; }
  async sendBatch(messages: string[]) { this.messages.push(...messages); for (const m of messages) this.reply?.(m); }
  emit(event: SessionEvent) { if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve(event); } else this.events.push(event); }
  async *readEvents(): AsyncIterable<SessionEvent> { for (;;) yield this.events.shift() ?? await new Promise<SessionEvent>(resolve => { this.waiting = resolve; }); }
  async stop() { this.stops++; }
  usage() { return { input_tokens: 10, output_tokens: 5, total_tokens: 15 }; }
  answer(text: string) { this.emit({ type: 'assistant', text }); this.emit({ type: 'result', text, usage: this.usage() }); }
}
// Normal chat assertions must not expire while fixtures persist state on a busy machine.
const projectOptions = (extra = {}) => ({ producer: { enabled: true, rules: [], budgets: {}, session: { enabled: false, max_turns: 4, timeout_ms: 30000 }, ...extra } });

test('fake-engine API transcript: question, accepted direction, accepted full draft and durable decisions', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions() });
  const p = f.board.ctx.projects[0];
  writeStateFile(p, '_producer-facts.json', JSON.stringify({ facts: [{ id: 'F:flow.wait.7d', value: 42 }] }));
  const engine = new ChatEngine();
  const manager = new ProducerSessionManager(p, f.orders, () => engine);
  let round = 0;
  engine.reply = () => {
    round++;
    if (round === 1) engine.answer('Waiting is 42% [F:flow.wait.7d].');
    if (round === 2) {
      callProducerTool(p, f.orders, 'producer_direction_propose', { priorities: 'Fix the build pipeline', stop: 'Pause cosmetic work', constraints: 'Keep existing caps', notes: 'Director requested focus.' });
      engine.answer('I propose this standing direction.');
    }
    if (round === 3) {
      const message = directorMessages(p).find(m => m.status === 'running')!;
      callProducerTool(p, f.orders, 'producer_act', { actions: [{ case: `chat/${message.id}`, kind: 'add-order', reason: 'Remove the build constraint', order: { tag: 'BUILD', title: 'Fix build pipeline', kind: 'tooling', needs: [], body: '# Fix build pipeline\n\n## Task\nMake builds reliable.\n\n## Acceptance\nA clean build completes.\n' } }] });
      engine.answer('The draft is ready for your review.');
    }
  };
  const ask = async (text: string) => {
    const posted = await f.write('/api/producer/chat', { project: p.id, text });
    assert.equal(posted.status, 202);
    await manager.processChat();
    return posted.body.id as string;
  };
  const questionId = await ask('What is blocking us?');
  assert.equal(directorMessages(p)[0].answer, 'Waiting is 42% [F:flow.wait.7d].');
  assert.deepEqual(directorMessages(p)[0].warnings, []);
  await ask('Focus on the build pipeline and pause cosmetic work.');
  const direction = directionProposals(p)[0];
  assert.equal(standingDirection(p).version, 0);
  const accepted = await f.write('/api/producer/direction', { project: p.id, proposalId: direction.id, accept: true });
  assert.equal(accepted.body.status, 'accepted');
  assert.equal(directionVersions(p).length, 1);
  assert.equal(standingDirection(p).priorities, 'Fix the build pipeline');
  const draftMessageId = await ask('Write an order to fix the build pipeline.');
  assert.ok(engine.messages[2].includes('Fix the build pipeline'));
  const action = producerActions(p)[0];
  assert.equal(action.status, 'would-do');
  assert.equal(action.messageId, draftMessageId);
  assert.equal(f.orders.all().length, 0);
  // Intake must leave proposals from conversations open while event cases change.
  intakeProducer(p, f.orders, { verify: false });
  const created = await f.write('/api/producer/actions', { project: p.id, actionId: action.id });
  assert.equal(created.body.status, 'done');
  assert.equal(f.orders.stage(f.orders.get('BUILD')).stage, 'draft');
  assert.equal(f.orders.get('BUILD').order.kind, 'tooling');
  assert.match(readFileSync(`${p.work_orders}/BUILD-fix-build-pipeline.md`, 'utf8'), /## Acceptance/);
  assert.ok(f.orders.store.events().some(e => e.data?.messageId === draftMessageId));
  const duplicate = await f.write('/api/producer/actions', { project: p.id, actionId: action.id });
  assert.equal(duplicate.body.status, 'done');
  assert.equal(f.orders.all().length, 1);
  const stored = await f.get(`/api/producer/chat?project=${p.id}`);
  assert.equal(stored.body.messages.find((m: { id: string }) => m.id === questionId).status, 'done');
  assert.equal(stored.body.actions[0].status, 'done');
  assert.equal(engine.starts, 3); assert.equal(engine.stops, 3);
});

test('running session handles a chat once; partial answers stream before completion', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions({ session: { enabled: true, max_turns: 10, timeout_ms: 1000 } }) });
  const p = f.board.ctx.projects[0], engine = new ChatEngine();
  const manager = producerSession(p, f.orders, () => engine);
  await manager.start();
  postDirectorMessage(p, 'Explain the current situation.');
  engine.reply = () => { engine.emit({ type: 'stream_event', text: 'No ' }); };
  const job = manager.processChat();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(directorMessages(p)[0].answer, 'No ');
  assert.equal(directorMessages(p)[0].status, 'running');
  await manager.processChat();
  engine.emit({ type: 'stream_event', text: 'data.' });
  engine.emit({ type: 'assistant', text: 'No data.' });
  engine.emit({ type: 'result', text: 'No data.' });
  await job;
  assert.equal(directorMessages(p)[0].answer, 'No data.');
  assert.equal(engine.starts, 1); assert.equal(engine.messages.length, 1); assert.equal(engine.stops, 0);
  assert.match(engine.options!.systemPrompt, /language of their latest message/);
  await manager.stop();
});

test('chat timeout, failed result and exhausted budgets become stored errors', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions({ session: { enabled: false, max_turns: 3, timeout_ms: 1000 } }) });
  const p = f.board.ctx.projects[0], engine = new ChatEngine();
  const manager = new ProducerSessionManager(p, f.orders, () => engine);
  postDirectorMessage(p, 'A timed out request');
  await manager.processChat();
  assert.match(directorMessages(p)[0].error!, /timed out/);
  // The remaining scenarios test engine and budget errors, rather than a queue racing disk I/O.
  p.producer.session.timeout_ms = 5000;
  engine.reply = () => engine.emit({ type: 'result', text: 'Model unavailable', raw: { is_error: true } });
  postDirectorMessage(p, 'A failed request');
  await manager.processChat();
  assert.match(directorMessages(p)[1].error!, /Model unavailable/);
  p.producer.budgets.turns_per_hour = 2;
  postDirectorMessage(p, 'A refused request');
  await manager.processChat();
  assert.match(directorMessages(p)[2].error!, /budget/);
  assert.equal(engine.messages.length, 2);
  const queued = postDirectorMessage(p, 'An expired queued request');
  updateDirectorMessage(p, queued.id, { at: new Date(Date.now() - 10000).toISOString() });
  await manager.processChat();
  assert.match(directorMessages(p)[3].error!, /timed out waiting/);
  assert.equal(engine.messages.length, 2);
});

test('director chat retries a failed session immediately before its automatic retry deadline', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions({ session: { enabled: true, max_turns: 4, timeout_ms: 1000 } }) });
  const p = f.board.ctx.projects[0], engine = new ChatEngine();
  const manager = new ProducerSessionManager(p, f.orders, () => engine);
  const retryAt = new Date(Date.now() + 30 * 60_000).toISOString();
  writeStateFile(p, '_producer-session.json', JSON.stringify({ state: 'error', lastError: 'Fixture engine unavailable', errorAt: new Date().toISOString(), retryAt, turns: 0, usage: engine.usage() }));
  // Automatic work still waits, but a new human message requests an immediate attempt.
  await manager.start();
  assert.equal(engine.starts, 0);
  engine.reply = () => engine.answer('The engine is available again.');
  postDirectorMessage(p, 'Please try again now.');
  await manager.processChat();
  assert.ok(Date.now() < Date.parse(retryAt));
  assert.equal(engine.starts, 1);
  assert.equal(engine.stops, 1);
  assert.equal(directorMessages(p)[0].status, 'done');
  assert.equal(directorMessages(p)[0].answer, 'The engine is available again.');
  assert.equal(manager.status().retryAt, undefined);
});

test('proposal decisions enforce pause/current policy and persist reject; auto actions report done', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions() });
  const p = f.board.ctx.projects[0], engine = new ChatEngine();
  const manager = new ProducerSessionManager(p, f.orders, () => engine);
  engine.reply = () => {
    const m = directorMessages(p).find(m => m.status === 'running')!;
    callProducerTool(p, f.orders, 'producer_act', { actions: [{ case: `chat/${m.id}`, kind: 'note', note: m.text }] });
    engine.answer('Proposed.');
  };
  for (const text of ['reject', 'pause', 'policy', 'auto']) {
    if (text === 'auto') p.producer.rules = [{ id: 'notes', action: 'note', instruction: 'Record notes', mode: 'auto' }];
    const m = postDirectorMessage(p, text); await manager.processChat();
    const a = producerActions(p).find(a => a.messageId === m.id)!;
    if (text === 'auto') { assert.equal(a.status, 'done'); continue; }
    if (text === 'pause') setProducerPaused(p, true);
    if (text === 'policy') p.producer.rules = [{ id: 'notes', action: 'note', instruction: 'Do not record notes', mode: 'off' }];
    const response = await f.write('/api/producer/actions', { project: p.id, actionId: a.id, reject: text === 'reject', reason: text === 'reject' ? 'Already handled' : undefined });
    assert.equal(response.body.status, text === 'reject' ? 'rejected' : 'refused');
    if (text === 'reject') assert.equal(response.body.rejectionReason, 'Already handled');
    setProducerPaused(p, false); p.producer.rules = [];
  }
  assert.ok(producerAudit(p).some(line => line.includes('rejected')));
});

test('direction retains versions, rejects stale edits and unknown fact ids are flagged', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions() });
  const p = f.board.ctx.projects[0], engine = new ChatEngine();
  const manager = new ProducerSessionManager(p, f.orders, () => engine);
  engine.reply = () => {
    for (const priorities of ['Builds', 'Polish']) callProducerTool(p, f.orders, 'producer_direction_propose', { priorities, stop: '', constraints: '', notes: '' });
    engine.answer('There are 99 items [F:unknown].');
  };
  postDirectorMessage(p, 'Change direction'); await manager.processChat();
  assert.match(directorMessages(p)[0].warnings.join(' '), /Unknown fact id/);
  let proposals = directionProposals(p);
  await f.write('/api/producer/direction', { project: p.id, proposalId: proposals[0].id, accept: true });
  const stale = await f.write('/api/producer/direction', { project: p.id, proposalId: proposals[1].id, accept: true });
  assert.equal(stale.body.status, 'refused');
  postDirectorMessage(p, 'Change again'); await manager.processChat();
  proposals = directionProposals(p);
  await f.write('/api/producer/direction', { project: p.id, proposalId: proposals[2].id, accept: false });
  await f.write('/api/producer/direction', { project: p.id, proposalId: proposals[3].id, accept: true });
  assert.deepEqual(directionVersions(p).map(v => v.version), [1, 2]);
  assert.equal(directionVersions(p)[0].priorities, 'Builds');
  assert.equal(standingDirection(p).priorities, 'Polish');
  assert.deepEqual(validateFactCitations('The number is not available.', []), []);
  assert.match(validateFactCitations('There are 42 items.', []).join(' '), /Uncited/);
});

test('serve processes queued messages in the background and SSE delivers stored partial replies', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions({ session: { enabled: false, max_turns: 4, timeout_ms: 2000 } }) });
  const p = f.board.ctx.projects[0], engine = new ChatEngine();
  producerSession(p, f.orders, () => engine);
  const coordinator = startCoordinator({ projects: [p], probes: f.board.ctx.probes, workers: f.board.ctx.workers!, everyMinutes: 0, maxDispatch: 0, print: () => {}, port: 0, eventMs: 100000, watchMs: 100000, reloadConfigs: false }, f.board);
  const abort = new AbortController();
  try {
    const response = await fetch(`${f.base}/api/producer/chat/stream?project=${p.id}`, { signal: abort.signal, headers: { 'x-alba-token': f.token } });
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"messages":\[\]/);
    const posted = await f.write('/api/producer/chat', { project: p.id, text: 'Start a background turn' });
    assert.equal(posted.status, 202);
    assert.equal(posted.body.status, 'queued');
    for (let i = 0; i < 100 && !engine.messages.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(engine.messages.length, 1);
    // HTTP remains responsive while the fake model has not completed.
    assert.equal((await f.get('/api/session')).status, 200);
    engine.emit({ type: 'stream_event', text: 'Partial reply' });
    let chunk = '';
    while (!chunk.includes('Partial reply')) chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /"status":"running"/);
    engine.emit({ type: 'result', text: 'Partial reply' });
    for (let i = 0; i < 100 && directorMessages(p)[0].status !== 'done'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(directorMessages(p)[0].status, 'done');
    await reader.cancel();
  } finally { abort.abort(); await coordinator.stop(); }
});

test('chat can reprioritize and queue a draft using ordinary services without dispatching it', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions() });
  const p = f.board.ctx.projects[0], engine = new ChatEngine();
  f.orders.add({ tag: 'TASK', title: 'A draft', kind: 'tooling' });
  const manager = new ProducerSessionManager(p, f.orders, () => engine);
  engine.reply = () => {
    const m = directorMessages(p).find(m => m.status === 'running')!;
    callProducerTool(p, f.orders, 'producer_act', { actions: [
      { case: `chat/${m.id}`, kind: 'reprioritize', target: 'TASK', priority: 50, needs: ['BASE'] },
      { case: `chat/${m.id}`, kind: 'queue', target: 'TASK' },
    ] });
    engine.answer('Review the proposed dependency and queue changes.');
  };
  postDirectorMessage(p, 'Queue TASK after BASE'); await manager.processChat();
  for (const a of producerActions(p)) {
    const response = await f.write('/api/producer/actions', { project: p.id, actionId: a.id });
    if (response.body.status === 'superseded') {
      const c = createChatCase(p, 'fresh');
      const fresh = producerAct(p, f.orders, c.id, a.kind, { target: 'TASK', priority: a.priority, needs: a.needs });
      // Observe actions require explicit chat provenance for acceptance.
      writeStateFile(p, '_producer-actions.json', JSON.stringify(producerActions(p).map(row => row.id === fresh.id ? { ...row, messageId: 'fresh' } : row)));
      assert.equal((await f.write('/api/producer/actions', { project: p.id, actionId: fresh.id })).body.status, 'done');
    } else assert.equal(response.body.status, 'done');
  }
  assert.equal(f.orders.get('TASK').order.priority, 50);
  assert.deepEqual(f.orders.get('TASK').order.needs, ['BASE']);
  assert.equal(f.orders.stage(f.orders.get('TASK')).stage, 'waiting-needs');
  assert.equal(f.spawned.length, 0);
});

test('MCP exposes absent snapshots explicitly and reads optional goals and standing direction', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions() });
  const p = f.board.ctx.projects[0];
  assert.deepEqual(callProducerTool(p, f.orders, 'producer_read', { kind: 'facts' }), { available: false, page: 0, pages: 1, text: '' });
  for (const kind of ['constraint', 'goals']) assert.deepEqual(callProducerTool(p, f.orders, 'producer_read', { kind }), { available: false, value: null });
  writeStateFile(p, 'goals.md', '# Milestone\nA clean build');
  assert.deepEqual(callProducerTool(p, f.orders, 'producer_read', { kind: 'goals' }), { available: true, value: '# Milestone\nA clean build' });
  assert.deepEqual(callProducerTool(p, f.orders, 'producer_read', { kind: 'direction' }), { available: true, value: standingDirection(p) });
});

test('citation checker ignores structural and contextual numbers in prose', () => {
  const text = '# Phase 4\n1. **TASK42** is queued.\n2. Read `42 items` and commit a1b2c3d.\n- **failed/TASK42/r7**\nOn 2026-11-08 at 12:30:00, check again.\nDate 2026-11-8 at  12:30.\nThe director asked about 17 orders.\nThe director mentioned three times.\n```ts\nconst count = 500;\n```';
  assert.deepEqual(validateFactCitations(text, [], { director: 'Check 17 orders; three times.', keys: ['failed/TASK42/r7'] }), []);
  assert.equal(validateFactCitations('There are 42 orders.\nThere are 5 more questions.', []).length, 2);
  assert.deepEqual(validateFactCitations('There are 42 orders [F:kind.tools.wip.7d].', ['F:kind.tools.wip.7d']), []);
});

test('only text after the last tool call is the answer; earlier narration is durable', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions() });
  const p = f.board.ctx.projects[0], engine = new ChatEngine();
  const manager = new ProducerSessionManager(p, f.orders, () => engine);
  engine.reply = () => {
    engine.emit({ type: 'assistant', text: 'Let me read more pages.' });
    engine.emit({ type: 'assistant', raw: { message: { content: [
      { type: 'tool_use', id: 'read', name: 'producer_read', input: { kind: 'orders', page: 3 } },
      { type: 'text', text: 'Checking the stored facts next.' },
      { type: 'tool_use', id: 'facts', name: 'producer_read', input: { kind: 'facts' } },
      { type: 'text', text: '**Ready** for review.' },
    ] } } });
    engine.emit({ type: 'user', raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Read page.' }] } } });
    engine.emit({ type: 'result', text: 'Ignored aggregate narration.' });
  };
  postDirectorMessage(p, 'Review'); await manager.processChat();
  const m = directorMessages(p)[0];
  assert.equal(m.answer, '**Ready** for review.');
  assert.deepEqual(m.narration, ['Let me read more pages.', 'Checking the stored facts next.']);
  assert.equal(m.tools?.[0].result, 'Read page.');
});

test('workspace and chat use stable paging, omit analysis and keep all pending cards', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions() });
  const p = f.board.ctx.projects[0];
  for (let i = 0; i < 160; i++) f.orders.add({ tag: `DEMO${i}`, title: 'Fixture', kind: 'tooling' });
  const sample = createChatCase(p, 'fixture');
  writeStateFile(p, '_producer-cases.json', JSON.stringify(Array.from({ length: 160 }, (_, i) => ({ ...sample, id: `case${i}`, key: `delivery/DEMO${i}`, trigger: 'delivery', order: `DEMO${i}` }))));
  for (let i = 0; i < 65; i++) postDirectorMessage(p, `Message ${i}`);
  const started = performance.now();
  producerWorkspace(p, f.orders);
  assert.ok(performance.now() - started < 1000, '160-order workspace read must complete under one second');
  const first = await f.get(`/api/producer/workspace?project=${p.id}`);
  assert.equal(first.body.messages.length, 30); assert.equal(first.body.snapshot, undefined);
  const cursor = first.body.nextCursor;
  postDirectorMessage(p, 'New message');
  const second = await f.get(`/api/producer/chat?project=${p.id}&before=${cursor}`);
  assert.equal(second.body.messages.length, 30);
  assert.equal(second.body.messages.at(-1).text, 'Message 34');
  const third = await f.get(`/api/producer/chat?project=${p.id}&before=${second.body.nextCursor}`);
  assert.equal(third.body.messages.length, 5); assert.equal(third.body.nextCursor, undefined);
  assert.equal((await f.get(`/api/producer/analysis?project=${p.id}`)).status, 200);
  await f.write('/api/producer/chat/stop', { project: p.id });
  assert.ok(directorMessages(p).every(m => m.status === 'error'));
});

test('edited proposal notes are persisted before execution and stop cancels a running turn', async () => {
  const f = await fixture({ populate: false, project: () => projectOptions({ rules: [{ id: 'notes', action: 'note', instruction: 'Record notes', mode: 'propose' }] }) });
  const p = f.board.ctx.projects[0], engine = new ChatEngine();
  const manager = producerSession(p, f.orders, () => engine);
  const message = postDirectorMessage(p, 'Record a note');
  const c = createChatCase(p, message.id);
  const a = producerAct(p, f.orders, c.id, 'note', { note: 'Original' });
  const edited = await f.write('/api/producer/actions', { project: p.id, actionId: a.id, note: 'Edited by director' });
  assert.equal(edited.body.status, 'done'); assert.equal(edited.body.note, 'Edited by director');
  assert.equal(edited.body.decision.outcome, 'edited');
  const job = manager.processChat();
  for (let i = 0; i < 100 && !engine.messages.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(directorMessages(p)[0].status, 'running');
  assert.equal((await f.write('/api/producer/chat/stop', { project: p.id })).status, 200);
  await job;
  assert.equal(directorMessages(p)[0].status, 'error'); assert.equal(engine.stops, 1);
});

for (const reason of ['person', 'stage', 'run'] as const) test(`superseded proposal: ${reason}, visible and refused at execution`, async () => {
  const f = await fixture({ populate: false, project: () => projectOptions({ rules: [{ id: 'hold', action: 'hold', instruction: 'Hold', mode: 'propose' }] }) });
  const p = f.board.ctx.projects[0];
  f.orders.add({ tag: 'DEMO1', title: 'Fixture', kind: 'tooling' });
  const c = createChatCase(p, 'fixture');
  const a = producerAct(p, f.orders, c.id, 'hold', { target: 'DEMO1' });
  if (reason === 'person') f.orders.act('DEMO1', 'queue');
  if (reason === 'stage') f.orders.report('DEMO1', { status: 'blocked', summary: 'Blocked', evidence: [], commits: [] });
  if (reason === 'run') f.orders.runStart('DEMO1', { worker: 'fixture' });
  const current = currentProducerActions(p, f.orders).find(row => row.id === a.id)!;
  assert.equal(current.status, 'superseded');
  assert.match(current.supersededReason!, reason === 'person' ? /person/ : reason === 'stage' ? /stage/ : /newer run/);
  const response = await f.write('/api/producer/actions', { project: p.id, actionId: a.id });
  assert.equal(response.body.status, 'superseded');
  assert.ok(!f.orders.get('DEMO1').actions.some(a => a.kind === 'hold'));
});
