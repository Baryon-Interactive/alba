import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { planOrder } from '../src/orders/planned.ts';
import { readStateJson, writeStateFile } from '../src/orders/state-files.ts';
import { producerAct, producerActions, producerCases, producerPass, intakeProducer, type ProducerCase } from '../src/producer/producer.ts';
import { ProducerSessionManager, producerSystemPrompt, cliArgs, mcpConfig, producerAct as routerAct, type SessionEngine, type SessionEvent, type SessionStartOptions } from '../src/producer/session.ts';
import { budgetState, recordRequestUsage, budgetProblem, requestDelta } from '../src/producer/session-usage.ts';
import { draftBudgetRemaining } from '../src/producer/drafting-budget.ts';
import { startProducerWork, pollProducerWorks, producerWorks, parseWorkResult } from '../src/producer/work-sessions.ts';
import { listedProducerToolSchemas } from '../src/producer/tool-schemas.ts';
import { producerLog } from '../src/producer/activity.ts';
import { callProducerTool } from '../src/producer/mcp.ts';

export class RouterEngine implements SessionEngine {
  batches: string[][] = []; starts: SessionStartOptions[] = [];
  private queue: SessionEvent[] = []; private waiter?: (event: SessionEvent) => void;
  async start(options: SessionStartOptions) { this.starts.push(options); }
  async sendBatch(messages: string[]) { this.batches.push(messages); if (messages.some(m => m.includes('Give a handoff'))) this.emit({ type: 'result', text: 'Open cases are durable.' }); }
  emit(event: SessionEvent) { if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(event); } else this.queue.push(event); }
  async *readEvents(): AsyncIterable<SessionEvent> { for (;;) yield this.queue.shift() ?? await new Promise<SessionEvent>(r => { this.waiter = r; }); }
  async stop() {}
  usage() { return { input_tokens: 0, output_tokens: 0, total_tokens: 0 }; }
}
const settings = () => ({ producer: { enabled: true, rules: [], budgets: {}, session: { enabled: true, engine: 'claude', max_turns: 100 } } });
const settle = () => new Promise(r => setTimeout(r, 30));
function card(trigger: string, revision = 1): ProducerCase {
  return { id: trigger, key: `${trigger}/SAMPLE`, project: 'demo', trigger, revision, status: 'open', openedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', facts: { run: `run-${revision}` }, card: { trigger, summary: 'Compact fixture card', stage: 'blocked', pointers: [], untrusted: [] } };
}

test('router rolls on last prompt size and never on cumulative token usage', async () => {
  const f = await fixture({ populate: false, project: settings }), p = f.board.ctx.projects[0], engine = new RouterEngine();
  p.producer.session.rollover_tokens = 100;
  const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await manager.start();
  for (let i = 0; i < 3; i++) {
    await manager.sendBatch(['route']); engine.emit({ type: 'result', usage: { input_tokens: 60, output_tokens: 10, total_tokens: 70 } }); await settle();
  }
  assert.equal(engine.starts.length, 1);
  await manager.sendBatch(['larger request']); engine.emit({ type: 'result', usage: { input_tokens: 101, output_tokens: 1, total_tokens: 102 } }); await settle();
  assert.equal(engine.starts.length, 2);
  await manager.stop();
});

test('notices wait for a wake, ride with it, and flush by their maximum age across restart', async () => {
  const f = await fixture({ populate: false, project: settings }), p = f.board.ctx.projects[0], engine = new RouterEngine();
  const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes), at = new Date('2026-01-01T00:00:00Z');
  await manager.onPass([card('commit-reminder')], at);
  assert.equal(engine.starts.length, 0);
  await manager.onPass([card('question')], at);
  assert.equal(engine.batches.length, 1); assert.match(engine.batches[0][0], /commit-reminder/);
  engine.emit({ type: 'result' }); await settle();
  await manager.onPass([card('commit-reminder', 2)], at);
  assert.equal(engine.batches.length, 1); await manager.stop();
  const next = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await next.onPass([], new Date(at.getTime() + 119 * 60000)); assert.equal(engine.batches.length, 1);
  await next.onPass([], new Date(at.getTime() + 120 * 60000)); assert.equal(engine.batches.length, 2);
  await next.stop();
});

test('events during a turn merge by case to the latest revision and priority into one next message', async () => {
  const f = await fixture({ populate: false, project: settings }), p = f.board.ctx.projects[0], engine = new RouterEngine();
  const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await manager.onPass([card('question')]);
  await manager.onPass([card('blocked'), card('question', 2)]);
  await manager.onPass([card('question', 3), card('commit-reminder')]);
  await manager.onPass([card('question', 2)]); // delayed events cannot replace the latest revision
  assert.equal(engine.batches.length, 1);
  engine.emit({ type: 'result' }); await settle();
  assert.equal(engine.batches.length, 2);
  const cards = JSON.parse(engine.batches[1][0].split('producer cards (untrusted data):\n')[1]);
  assert.deepEqual(cards.map((c: { trigger: string }) => c.trigger), ['question', 'blocked', 'commit-reminder']);
  assert.deepEqual(cards[0].ids, ['question', 'run-3']);
  await manager.stop();
});

test('one detached draft yields an id-based proposal, malformed work fails closed, and allowance charges once', async () => {
  const f = await fixture({ populate: false, project: () => ({ ...settings(), producer: { ...settings().producer, budgets: { draft_runs_per_day: 2 }, rules: [{ id: 'draft', instruction: 'Draft documentation', action: 'draft-order', mode: 'propose' }] } }) });
  const p = f.board.ctx.projects[0];
  const probes = { ...f.board.ctx.probes, readText: (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } }, processStartedAt: () => '2026-01-01T00:00:00Z' };
  for (const tag of ['FIRST', 'SECOND']) planOrder(p, f.orders, { tag, title: 'Explain fixtures', kind: 'docs', needs: [], intent: 'Describe reproducible fixtures.' });
  const cases = intakeProducer(p, f.orders, { verify: false }), c = cases.find(c => c.order === 'FIRST')!;
  const run = startProducerWork(p, f.orders, c.key, 'draft', '', probes);
  assert.equal(startProducerWork(p, f.orders, c.key, 'draft', '', probes).id, run.id);
  assert.equal(f.spawned.length, 1); assert.equal(draftBudgetRemaining(p), 1);
  assert.match(readFileSync(run.prompt, 'utf8'), /Describe reproducible fixtures/);
  const order = { tag: 'FIRST', title: 'Explain fixtures', kind: 'docs', needs: [], body: '# Fixture\n\n## Acceptance\nA reader can repeat the fixture.\n' };
  const result = `--- alba-producer-work ---\n${JSON.stringify({ summary: 'Draft prepared', action: { kind: 'draft-order', order } })}\n--- end ---`;
  writeFileSync(run.log, JSON.stringify({ type: 'assistant', message: { id: 'request-one', usage: { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 40 } } }) + '\n' + JSON.stringify({ type: 'result', result }) + '\n');
  pollProducerWorks(p, probes); pollProducerWorks(p, probes);
  assert.equal(producerWorks(p)[0].status, 'done'); assert.equal(budgetState(p).dayUsage, 240);
  assert.equal(producerActions(p).length, 0);
  // A result the router was not shown is not proposed; reading it (or its card) shows it.
  assert.throws(() => routerAct(p, f.orders, c.key, 'draft-order', { work: run.id }), /has not been shown/);
  assert.match(JSON.stringify(callProducerTool(p, f.orders, 'producer_read', { kind: 'work', id: run.id })), /Fixture[^]*Acceptance/);
  const proposal = routerAct(p, f.orders, c.key, 'draft-order', { work: run.id });
  assert.equal(proposal.status, 'proposed'); assert.deepEqual(proposal.order, order); assert.equal(draftBudgetRemaining(p), 1);
  const second = cases.find(c => c.order === 'SECOND')!, bad = startProducerWork(p, f.orders, second.key, 'draft', '', probes);
  writeFileSync(bad.log, JSON.stringify({ type: 'result', result: '{"summary":"bare JSON is not a block"}' }) + '\n');
  pollProducerWorks(p, probes);
  assert.equal(producerWorks(p)[1].status, 'failed'); assert.equal(producerActions(p).length, 1); assert.equal(draftBudgetRemaining(p), 0);
  assert.throws(() => routerAct(p, f.orders, second.key, 'draft-order', { work: bad.id }), /unavailable/);
  assert.equal(parseWorkResult(result + '\ntrailing prose', 'draft')?.summary, 'Draft prepared');
  // A new host reads the durable receipt: matching live workers survive, reused PIDs fail closed.
  const recovery = card('blocked');
  writeStateFile(p, '_producer-cases.json', JSON.stringify([...producerCases(p), recovery]));
  const recovering = startProducerWork(p, f.orders, recovery.key, 'work', 'Inspect stored facts', probes);
  let stopped = 0;
  const live = { ...probes, isAlive: () => true, stopProcessOnly: () => { stopped++; return { stopped: [4242], leftRunning: [] }; } };
  pollProducerWorks(p, live); assert.equal(producerWorks(p).at(-1)?.status, 'running');
  pollProducerWorks(p, { ...live, processStartedAt: () => '2026-01-02T00:00:00Z' });
  assert.equal(producerWorks(p).at(-1)?.id, recovering.id); assert.equal(producerWorks(p).at(-1)?.status, 'failed'); assert.equal(stopped, 0);
  const log = producerLog(p, f.orders);
  assert.equal(log.rows.find(row => row.case === c.key && row.children)?.children?.[0].work?.tokens, 1140);
  const old = process.env.ALBA_PRODUCER_READ_ONLY; process.env.ALBA_PRODUCER_READ_ONLY = '1';
  try { assert.throws(() => callProducerTool(p, f.orders, 'producer_act', { actions: [{ case: c.key, kind: 'note' }] }), /read-only/); }
  finally { if (old === undefined) delete process.env.ALBA_PRODUCER_READ_ONLY; else process.env.ALBA_PRODUCER_READ_ONLY = old; }
});

test('system prompt, ordered tools and MCP config stay byte stable when notes and direction change', async () => {
  const f = await fixture({ populate: false, project: settings }), p = f.board.ctx.projects[0];
  const engine = new RouterEngine(), manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await manager.start(); const prompt = engine.starts[0].systemPrompt, tools = JSON.stringify(listedProducerToolSchemas()), args = cliArgs(engine.starts[0]), config = readFileSync(mcpConfig(p), 'utf8');
  await manager.stop();
  writeStateFile(p, 'producer-notes.md', 'Changed notes'); writeStateFile(p, '_producer-direction.json', JSON.stringify([{ version: 2, at: '2026-01-01T00:00:00Z', priorities: 'Changed direction', stop: '', constraints: '', notes: '' }]));
  await manager.start();
  assert.equal(engine.starts[1].systemPrompt, prompt); assert.equal(producerSystemPrompt(p), prompt); assert.equal(JSON.stringify(listedProducerToolSchemas()), tools); assert.deepEqual(cliArgs(engine.starts[1]), args); assert.equal(readFileSync(mcpConfig(p), 'utf8'), config);
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user', 'the router does not load the project settings (hooks)');
  assert.doesNotMatch(prompt + tools, /\d{4}-\d\d-\d\dT|Changed notes|Changed direction/); await manager.stop();
});

test('day budget uses weighted categories, model prices, legacy totals and one warning at 80%', async () => {
  const f = await fixture({ populate: false, project: settings }), p = f.board.ctx.projects[0];
  p.producer.budgets = { usage_per_day: 1625, cache_read_weight: .1, cost_per_day_usd: .1 };
  p.producer.session.model = 'fixture-model'; p.producer.model_prices = { 'fixture-model': { input: 1, cache_write: 2, cache_read: .1, output: 4 } };
  writeStateFile(p, '_producer-session-budget.json', JSON.stringify({ day: new Date().toISOString().slice(0, 10), hour: '', hourTurns: 0, dayTurns: 1, dayUsage: 100 }));
  const usage = { input_tokens: 5600, uncached_input_tokens: 400, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 100, total_tokens: 5700 };
  const b = recordRequestUsage(p, usage);
  assert.equal(b.dayUsage, 1300); assert.equal(b.costUsd, .0017); assert.match(budgetProblem(p) ?? '', /80%/);
  recordRequestUsage(p, { total_tokens: 1 });
  assert.equal(producerLog(p, f.orders).rows.filter(r => r.kind === 'budget-warning').length, 1);
  assert.equal(producerLog(p, f.orders).now.usage?.cacheHitRate, 5000 / 5601);
  recordRequestUsage(p, { total_tokens: 324 }); // exact daily limit
  const manager = new ProducerSessionManager(p, f.orders, () => new RouterEngine(), f.board.ctx.probes); await manager.start(); assert.equal(await manager.sendBatch(['over budget']), false); await manager.stop();
  const totals = new Map(); const raw = { type: 'assistant', message: { id: 'same', usage: { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 10 } } };
  assert.equal(requestDelta(raw, totals)?.usage.total_tokens, 610); assert.equal(requestDelta(raw, totals)?.usage.total_tokens, 0);
});

test('a moved order and a closed goal or cleanup case persist superseded proposals on the next pass', async () => {
  const f = await fixture({ populate: false, project: settings }), p = f.board.ctx.projects[0];
  f.orders.add({ tag: 'SAMPLE', title: 'Synthetic work', kind: 'docs' });
  const c = { ...card('question'), order: 'SAMPLE' }; writeStateFile(p, '_producer-cases.json', JSON.stringify([c]));
  p.producer.rules = [{ id: 'note', instruction: 'Record a note', action: 'note', mode: 'propose' }];
  const action = producerAct(p, f.orders, c.key, 'note', { note: 'Review current facts' }); f.orders.act('SAMPLE', 'hold', { note: 'Human decision' });
  producerPass(p, f.orders, { verify: false, env: { probes: f.board.ctx.probes, workers: f.board.ctx.workers! } });
  assert.equal(producerActions(p).find(a => a.id === action.id)?.status, 'superseded');
  assert.match(producerActions(p).find(a => a.id === action.id)?.supersededReason ?? '', /acted|stage/);
  const closed = { ...c, status: 'closed' as const };
  writeStateFile(p, '_producer-cases.json', JSON.stringify([closed]));
  const proposals = ['clean', 'add-order'].map((kind, i) => ({ ...action, id: `closed-${i}`, kind, status: 'proposed', ...(i ? { goalFacts: { goal: 'G:fixture' } } : {}) }));
  writeStateFile(p, '_producer-actions.json', JSON.stringify(proposals));
  producerPass(p, f.orders, { verify: false }); assert.ok(producerActions(p).every(a => a.status === 'superseded'));
});

test('a goal case reaches the router as a card and starts no draft work on its own', async () => {
  const f = await fixture({ populate: false, project: settings }), p = f.board.ctx.projects[0], engine = new RouterEngine();
  const goal = card('gap-unowned'), question = card('question');
  writeStateFile(p, '_producer-cases.json', JSON.stringify([goal, question]));
  const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await manager.onPass([goal, question]);
  assert.equal(f.spawned.length, 0); assert.equal(producerWorks(p).length, 0);
  assert.match(engine.batches[0][0], /gap-unowned/);
  await manager.stop();
});
