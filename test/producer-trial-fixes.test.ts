import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { validateProject } from './state-helper.ts';
import { planOrder } from '../src/orders/planned.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { intakeProducer, producerAct, producerCases, runProducerAction, type ProducerCase } from '../src/producer/producer.ts';
import { ProducerSessionManager, producerSystemPrompt } from '../src/producer/session.ts';
import { emptyUsage, addUsage, requestDelta } from '../src/producer/session-usage.ts';
import { startProducerWork, pollProducerWorks, producerWorks, workResult, workSystemPrompt, WORK_TIMEOUT_MINUTES } from '../src/producer/work-sessions.ts';
import { trimmedCase } from '../src/producer/mcp.ts';
import type { SessionEngine, SessionEvent } from '../src/producer/session.ts';

class RouterEngine implements SessionEngine {
  batches: string[][] = [];
  async start() {}
  async sendBatch(messages: string[]) { this.batches.push(messages); }
  async *readEvents(): AsyncIterable<SessionEvent> { await new Promise(() => {}); }
  async stop() {}
  usage() { return emptyUsage(); }
}

const settings = (producer: Record<string, unknown> = {}) => () => ({ producer: { enabled: true, rules: [{ id: 'draft', instruction: 'Draft', action: 'draft-order', mode: 'propose' }], budgets: {}, session: { enabled: true, engine: 'claude', max_turns: 100 }, ...producer } });
function card(trigger: string, order?: string): ProducerCase {
  return { id: `${trigger}-id`, key: `${trigger}/SAMPLE`, project: 'demo', trigger, revision: 1, status: 'open', openedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...(order ? { order } : {}), facts: { run: 'run-1' }, card: { trigger, summary: 'Fixture card', stage: 'blocked', pointers: [], untrusted: [] } };
}
const workProbes = (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.board.ctx.probes, readText: (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } }, processStartedAt: () => '2026-01-01T00:00:00Z' });

test('work sessions: 10 minutes by default or producer.session.work_timeout_minutes; a retry is told why the last try failed and what the router said', async () => {
  const f = await fixture({ populate: false, project: settings() });
  const p = f.board.ctx.projects[0], probes = workProbes(f);
  planOrder(p, f.orders, { tag: 'FIRST', title: 'Explain fixtures', kind: 'docs', needs: [], intent: 'Describe reproducible fixtures.' });
  const c = intakeProducer(p, f.orders, { verify: false }).find(c => c.order === 'FIRST')!;
  const first = startProducerWork(p, f.orders, c.key, 'draft', 'Keep it to the two fixture folders.', probes);
  assert.equal(first.timeoutMs, WORK_TIMEOUT_MINUTES * 60_000);
  assert.equal(first.brief, 'Keep it to the two fixture folders.');
  // the fixed task is the system prompt (identical for every draft), the prompt file holds only the case
  const spawned = f.spawned.at(-1)!.args;
  assert.equal(spawned[spawned.indexOf('--system-prompt') + 1], workSystemPrompt('draft'));
  assert.equal(spawned[spawned.indexOf('--setting-sources') + 1], 'user', 'the project settings (hooks) are not loaded');
  assert.ok(spawned.includes('--include-partial-messages'));
  assert.doesNotMatch(readFileSync(first.prompt, 'utf8'), /--- alba-producer-body ---/);
  // the router leaves a note, the try times out
  producerAct(p, f.orders, c.key, 'note', { note: 'Narrow it: only the acceptance list is missing.' });
  writeFileSync(first.log, '');
  pollProducerWorks(p, { ...probes, now: () => new Date(Date.parse(first.started) + WORK_TIMEOUT_MINUTES * 60_000 + 1) });
  assert.equal(producerWorks(p)[0].reason, 'Work session timed out.');
  const retry = startProducerWork(p, f.orders, c.key, 'draft', '', probes);
  assert.equal(retry.retryOf, first.id);
  const context = JSON.parse(readFileSync(retry.prompt, 'utf8').split('\n')[1]);
  assert.equal(context.previous_attempt.failed_because, 'Work session timed out.');
  assert.equal(context.previous_attempt.router_brief, 'Keep it to the two fixture folders.');
  assert.match(context.previous_attempt.router_note, /only the acceptance list/);
  assert.match(context.previous_attempt.advice, /Read less/);

  const g = await fixture({ populate: false, project: settings({ session: { enabled: true, engine: 'claude', max_turns: 100, work_timeout_minutes: 25 } }) });
  const q = g.board.ctx.projects[0];
  planOrder(q, g.orders, { tag: 'OTHER', title: 'Other', kind: 'docs', needs: [], intent: 'x' });
  const d = intakeProducer(q, g.orders, { verify: false }).find(c => c.order === 'OTHER')!;
  assert.equal(startProducerWork(q, g.orders, d.key, 'draft', '', workProbes(g)).timeoutMs, 25 * 60_000);
  assert.throws(() => validateProject({ id: 'x', name: 'x', root: g.root, work_orders: g.root, state_dir: g.dir, producer: { session: { work_timeout_minutes: 0 } } }, path.join(g.dir, 'alba.yaml')), /work_timeout_minutes/);
});

test('a draft returns its body as plain Markdown after the final block; quotes and backslashes survive; a JSON body still works', () => {
  const body = '# T1 Fix "paths"\n\nUse Engine\\Bin and `a\\b`.\n\n## Acceptance\n- "quoted" lines {braces} stay\n';
  const text = `Done.\n--- alba-producer-work ---\n{"summary":"Drafted","action":{"kind":"draft-order","order":{"tag":"T1","title":"Fix","kind":"docs","needs":[]}}}\n--- end ---\n--- alba-producer-body ---\n${body}--- end body ---\n`;
  const result = workResult(text, 'draft');
  assert.equal(result.error, undefined);
  assert.equal(result.result?.action?.order?.body, body);
  assert.equal(workResult(text.replace(/\n/g, '\r\n'), 'draft').result?.action?.order?.body, body, 'CRLF output');
  const old = `--- alba-producer-work ---\n${JSON.stringify({ summary: 'x', action: { kind: 'draft-order', order: { tag: 'T1', title: 'Fix', kind: 'docs', needs: [], body } } })}\n--- end ---`;
  assert.equal(workResult(old, 'draft').result?.action?.order?.body, body);
  assert.match(workResult(text.replace(/--- alba-producer-body ---[^]*--- end body ---\n/, ''), 'draft').error ?? '', /body is required/);
  // project templates number their sections; the live drafts of the trial wrote "## 4. Acceptance"
  for (const heading of ['## 4. Acceptance', '## 4. Acceptance criteria (the acceptor tests each one)', '### Acceptance', '## 4) Acceptance'])
    assert.equal(workResult(text.replace('## Acceptance', heading), 'draft').error, undefined, heading);
  assert.match(workResult(text.replace('## Acceptance', '## Acceptability'), 'draft').error ?? '', /Acceptance/);
});

test('a review only comments: accept and rework results are refused, a note or finding passes; producer.reviews: false turns reviews off', async () => {
  const done = (action: unknown) => `--- alba-producer-work ---\n${JSON.stringify({ summary: 'Reviewed', finding: 'D3 missing', ...(action ? { action } : {}) })}\n--- end ---`;
  assert.match(workResult(done({ kind: 'rework', note: 'finish D3' }), 'review').error ?? '', /review returns a finding/);
  assert.match(workResult(done({ kind: 'accept' }), 'review').error ?? '', /review returns a finding/);
  assert.equal(workResult(done({ kind: 'note', note: 'D3 missing' }), 'review').result?.finding, 'D3 missing');
  assert.equal(workResult(done(undefined), 'review').result?.summary, 'Reviewed');
  assert.match(workSystemPrompt('review'), /comment only/);

  const f = await fixture({ populate: false, project: settings({ reviews: false }) });
  const p = f.board.ctx.projects[0], engine = new RouterEngine(), delivery = card('delivery', 'R1'), question = card('question');
  writeStateFile(p, '_producer-cases.json', JSON.stringify([delivery, question]));
  assert.throws(() => startProducerWork(p, f.orders, delivery.key, 'review', '', workProbes(f)), /reviews are off/);
  const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await manager.onPass([delivery, question]);
  assert.doesNotMatch(engine.batches[0][0], /delivery/); assert.match(engine.batches[0][0], /question/);
  await manager.stop();
  assert.throws(() => validateProject({ id: 'x', name: 'x', root: f.root, work_orders: f.root, state_dir: f.dir, producer: { reviews: 'no' } }, path.join(f.dir, 'alba.yaml')), /producer.reviews/);
});

test('a producer rework is always a proposal and never targets a running or held order; a planned order is explained, not dispatched', async () => {
  const f = await fixture({ project: settings({ rules: [{ id: 'redo', instruction: 'Rework', action: 'rework', mode: 'auto' }, { id: 'go', instruction: 'Start', action: 'dispatch', mode: 'propose' }] }) });
  const p = f.board.ctx.projects[0];
  const running = f.orders.all().find(d => f.orders.stage(d).stage === 'running')!.order.tag;
  const c = card('failed', running);
  writeStateFile(p, '_producer-cases.json', JSON.stringify([c]));
  const refused = producerAct(p, f.orders, c.key, 'rework', { note: 'finish D3' });
  assert.equal(refused.status, 'refused'); assert.match(refused.refusal ?? '', /never sends a running or held order back/);
  // an idle order: still only proposed although the rule says auto; the click is the acceptance
  const idle = f.orders.all().find(d => !['running', 'held', 'merged', 'cancelled', 'planned'].includes(f.orders.stage(d).stage))!.order.tag;
  const other = card('blocked', idle);
  writeStateFile(p, '_producer-cases.json', JSON.stringify([c, other]));
  const proposed = producerAct(p, f.orders, other.key, 'rework', { note: 'narrow the scope' });
  assert.equal(proposed.status, 'proposed'); assert.equal(proposed.mode, 'propose');
  // the order is put on hold before the person clicks: the click is refused
  f.orders.act(idle, 'hold');
  const clicked = runProducerAction(p, f.orders, proposed.id);
  assert.notEqual(clicked.status, 'done'); assert.equal(f.orders.stage(f.orders.get(idle)).stage, 'held');

  planOrder(p, f.orders, { tag: 'PLAN1', title: 'Later', kind: 'docs', needs: [], intent: 'Do it later.' });
  const chat = card('director-message', 'PLAN1');
  writeStateFile(p, '_producer-cases.json', JSON.stringify([chat]));
  const dispatch = producerAct(p, f.orders, chat.key, 'dispatch', { target: 'PLAN1' });
  assert.equal(dispatch.status, 'refused');
  assert.match(dispatch.refusal ?? '', /PLAN1 is only planned.*draft it first.*producer_draft on case draft\/PLAN1/);
  assert.match(producerSystemPrompt(p), /planned order has no body yet/);
  assert.match(producerSystemPrompt(p), /never targets a running or held order/);
});

test('goal cards reach the router only while draft-from-goal proposes or acts; case reads carry rule and gap ids, not their texts', async () => {
  for (const [mode, sent] of [['observe', false], ['off', false], ['propose', true]] as const) {
    const f = await fixture({ populate: false, project: settings({ rules: [{ id: 'draft-from-goal', instruction: 'Goals', action: 'draft-order', mode }] }) });
    const p = f.board.ctx.projects[0], engine = new RouterEngine(), goal = card('gap-unowned'), question = card('question');
    writeStateFile(p, '_producer-cases.json', JSON.stringify([goal, question]));
    const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
    await manager.onPass([goal, question]);
    assert.equal(/gap-unowned/.test(engine.batches[0][0]), sent, mode);
    await manager.stop();
  }
  const rules = Array.from({ length: 20 }, (_, i) => ({ id: `R${i}`, text: 'A long rule text '.repeat(20), system: 'MAP' }));
  const goal = { ...card('target-unmeasured'), facts: { goal: 'MAP-T1', milestone: 'M1', system: { code: 'MAP', name: 'Map', description: 'x'.repeat(2000) }, rules, gaps: [{ id: 'G1', text: 'y'.repeat(500) }], target: { id: 'MAP-T1' } } };
  const trimmed = trimmedCase(goal);
  assert.deepEqual(trimmed.facts.rules, rules.map(r => r.id));
  assert.deepEqual(trimmed.facts.gaps, ['G1']);
  assert.deepEqual(trimmed.facts.system, { code: 'MAP', name: 'Map' });
  assert.ok(JSON.stringify(trimmed).length < JSON.stringify(goal).length / 5);
  const question = card('question');
  assert.equal(trimmedCase(question), question);
});

test('Claude usage: the final message_delta counts, not the provisional message_start (output tokens included); without stream events the assistant usage counts once', () => {
  const meter = (lines: unknown[]) => { const totals = new Map(), sum = emptyUsage(); for (const l of lines) { const d = requestDelta(l as Record<string, unknown>, totals); if (d) addUsage(sum, d.usage); } return sum; };
  // A gateway that puts an estimate into message_start: 10030 uncached, then bills 3673 uncached and 412 output.
  const start = { cache_creation_input_tokens: 5400, cache_read_input_tokens: 5400, input_tokens: 10030, output_tokens: 1 };
  const streamed = meter([
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: start } } },
    { type: 'assistant', message: { id: 'm1', usage: start, content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', message: { id: 'm1', usage: start, content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 3673, cache_read_input_tokens: 5400, cache_creation_input_tokens: 5400, output_tokens: 412, credit_unit: 'credit' } } },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', usage: { input_tokens: 2, cache_read_input_tokens: 14000, cache_creation_input_tokens: 300, output_tokens: 1 } } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 90 } } },
    { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  assert.deepEqual([streamed.uncached_input_tokens, streamed.cache_read_input_tokens, streamed.cache_creation_input_tokens, streamed.output_tokens], [3675, 19400, 5700, 502]);
  const plain = meter([
    { type: 'assistant', message: { id: 'a1', usage: { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 40 } } },
    { type: 'assistant', message: { id: 'a1', usage: { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 40 } } },
  ]);
  assert.deepEqual([plain.uncached_input_tokens, plain.cache_read_input_tokens, plain.output_tokens], [100, 1000, 40]);
});
