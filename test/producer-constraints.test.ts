import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { computeFacts } from '../src/producer/facts/engine.ts';
import { findConstraint, normaliseError } from '../src/producer/facts/constraints.ts';
import { producerSnapshot } from '../src/producer/conversation-state.ts';
import { refreshFacts, readFacts } from '../src/producer/facts/snapshot.ts';
import { fixture } from './api-fixture.ts';
import { producerFactsFixture, NOW, hour } from './fixtures/producer-facts.ts';
import type { FactsSnapshot } from '../src/producer/facts/engine.ts';
import type { UsageRow } from '../src/usage/types.ts';
import type { OrderEvent } from '../src/orders/model.ts';

function neutral(): FactsSnapshot {
  const s = producerFactsFixture().snapshot;
  s.facts = s.facts.filter(f => !f.id.startsWith('F:constraint.'));
  for (const f of s.facts) {
    if (f.id.includes('.first_pass_yield.')) f.value = .8;
    if (f.id.includes('.acceptor_p90.')) f.value = 2;
  }
  const d = s.windows['7d'];
  d.causes.forEach(c => c.count = c.cause === 'result' ? 10 : 0);
  d.slots.forEach(c => c.monitoring = 0);
  d.cumulative.at(-1)!.stages = { ...d.cumulative[0].stages };
  return s;
}
function set(s: FactsSnapshot, metric: string, value: number | null) {
  s.facts.find(f => f.id === `F:kind.engine.${metric}.7d`)!.value = value;
}

test('environment share uses non-ready outcomes and strict threshold; other causes can opt in', () => {
  for (const [count, expected] of [[29, false], [30, false], [31, true]] as const) {
    const s = neutral();
    s.windows['7d'].causes.forEach(c => c.count = c.cause === 'environment' ? count : c.cause === 'result' ? 100 - count : 0);
    assert.equal(findConstraint(s).type === 'cause', expected);
    assert.equal(findConstraint(s, { cause_shares: { environment: .5 } }).type, 'none');
  }
  const s = neutral();
  assert.equal(findConstraint(s, { cause_shares: { result: .9 } }).type, 'cause');
});

test('monitoring uses mean occupied slots divided by cap, strict 40%, and overrides', () => {
  for (const [share, expected] of [[.39, 'none'], [.4, 'none'], [.41, 'monitoring']] as const) {
    const s = neutral(); s.windows['7d'].slots[0].monitoring = 3 * share;
    assert.equal(findConstraint(s).type, expected);
    assert.equal(findConstraint(s, { monitoring_cap_share: .5 }).type, 'none');
  }
  const s = neutral(); s.windows['7d'].slots[0].limit = 0; s.windows['7d'].slots[0].monitoring = 5;
  assert.equal(findConstraint(s).type, 'none');
});

test('acceptor p90 and first-pass yield have strict boundaries, null handling and overrides', () => {
  for (const [hours, type] of [[7.9, 'none'], [8, 'none'], [8.1, 'acceptor'], [null, 'none']] as const) {
    const s = neutral(); set(s, 'acceptor_p90', hours);
    assert.equal(findConstraint(s).type, type);
    assert.equal(findConstraint(s, { acceptor_p90_hours: 9 }).type, 'none');
  }
  for (const [yieldValue, type] of [[.59, 'yield'], [.6, 'none'], [.61, 'none'], [null, 'none']] as const) {
    const s = neutral(); set(s, 'first_pass_yield', yieldValue);
    assert.equal(findConstraint(s).type, type);
    assert.equal(findConstraint(s, { first_pass_yield_min: .5 }).type, 'none');
  }
});

test('largest growing queue share wins; static or shrinking queues cannot win', () => {
  const s = neutral(), d = s.windows['7d'];
  for (const f of s.facts.filter(f => f.id.includes('.stage.') && f.window === '7d')) f.value = f.id.includes('.queued.') ? 100 : f.id.includes('.acceptor.') ? 50 : 0;
  d.cumulative.at(-1)!.stages.queued = 3; d.cumulative.at(-1)!.stages.acceptor = 2;
  assert.equal(findConstraint(s).candidates[0].id, 'queue:queued');
  d.cumulative[0].stages.queued = 4;
  assert.equal(findConstraint(s).candidates[0].id, 'queue:acceptor');
  d.cumulative[0].stages.acceptor = 2;
  const card = findConstraint(s);
  assert.equal(card.title, 'no clear constraint');
  assert.equal(card.candidates.length, 2);
  assert.ok(Object.values(card.responses).every(Boolean));
  assert.equal(new Set(s.facts.map(f => f.id)).size, s.facts.length);
});

function failures() {
  const f = producerFactsFixture();
  const orders = ['A1', 'B1'].map((tag, i) => {
    const d = structuredClone(f.orders[0]);
    d.order.tag = tag; d.actions = []; d.runs = [{ id: 'r1', seq: 1, worker: 'builder', started: hour(i), ended: hour(i + 1) }];
    d.reports = [{ seq: 2, run: 'r1', at: hour(i + 1), status: 'failed' as const, summary: `Build failed on ${path.posix.join(path.posix.sep, 'tmp', `job${i}`, 'out.log')} with exit 12`, commits: [], evidence: [] }];
    return d;
  });
  return { ...f, orders, events: [] as OrderEvent[] };
}
test('normalised failures recur across orders/runs; refreshes do not inflate counts; seven-day expiry', () => {
  const f = failures(), s = computeFacts(f), risk = s.analysis!.risks.find(r => r.type === 'failure')!;
  assert.equal(normaliseError(f.orders[0].reports[0].summary), normaliseError(f.orders[1].reports[0].summary));
  assert.equal(risk.count, 2); assert.equal(risk.firstSeen, hour(1)); assert.equal(risk.lastSeen, hour(2));
  assert.equal(computeFacts({ ...f, previous: s }).analysis!.risks.find(r => r.id === risk.id)!.count, 2);
  assert.equal(computeFacts({ ...f, now: hour(2 + 168), previous: s }).analysis!.risks.some(r => r.id === risk.id), false);
  assert.equal(computeFacts({ ...f, orders: [f.orders[0]] }).analysis!.risks.some(r => r.type === 'failure'), false);
  for (const r of s.analysis!.risks) assert.ok(r.factIds.every(id => s.facts.some(f => f.id === id)));
});

test('workers that loop are grouped by worker and deduplicated by run', () => {
  const f = failures(); f.orders.forEach(d => d.reports[0].summary = 'worker loop on repeated failed commands');
  const usage = f.orders.map(d => ({ order: d.order.tag, run: 'r1', worker: 'builder', at: hour(2), turn: 3, signals: [{ kind: 'failed-loop', turns: [1, 3] }] } as UsageRow));
  const s = computeFacts({ ...f, usage });
  const risk = s.analysis!.risks.find(r => r.type === 'loop')!;
  assert.equal(risk.count, 2); assert.equal(risk.firstSeen, hour(1)); assert.equal(risk.lastSeen, hour(2));
});

test('project token and currency budgets track burns, use run fallback and exclude future usage', () => {
  const f = failures();
  const row = { order: 'A1', run: 'r1', worker: 'builder', total_tokens: 60, estimate: 3, currency: 'USD', at: hour(2), turn: 1 } as UsageRow;
  const usage = [row, { ...row, total_tokens: 50, at: hour(3), turn: 2 }, { ...row, currency: 'EUR', total_tokens: 0, at: hour(4), turn: 3 }, { ...row, at: hour(30), turn: 4 }];
  const budget = { tokens_per_day: 100, tokens_per_order: 100, cost_per_day: 5 };
  const s = computeFacts({ ...f, usage, budget });
  const risks = s.analysis!.risks.filter(r => r.type === 'budget');
  assert.equal(risks.length, 3);
  assert.ok(risks.every(r => r.count === 1 && r.firstSeen === hour(3) && r.lastSeen === hour(3)));
  assert.ok(risks.every(r => r.factIds.every(id => s.facts.some(f => f.id === id))));
  assert.equal(computeFacts({ ...f, usage, budget: { tokens_per_day: 110, tokens_per_order: 110, cost_per_day: 6 } }).analysis!.risks.filter(r => r.type === 'budget').length, 0);
  f.orders[0].runs[0].usage = { source: 'codex-json', total_tokens: 120 };
  assert.equal(computeFacts({ ...f, budget }).analysis!.risks.filter(r => r.type === 'budget').length, 2);
  f.orders[0].runs[0].ended = undefined;
  const open = computeFacts({ ...f, budget });
  assert.equal(computeFacts({ ...f, budget, previous: open, now: hour(25) }).analysis!.risks.find(r => r.type === 'budget')!.lastSeen, hour(0));
});

test('aging requires a positive kind p85; records retain first seen and expire after resolution', () => {
  const f = producerFactsFixture(); f.orders[2].order.created = hour(-24);
  const s = computeFacts(f), risk = s.analysis!.risks.find(r => r.id === 'aging:C1')!;
  assert.ok(risk); assert.equal(risk.count, 1);
  const later = computeFacts({ ...f, now: hour(25), previous: s });
  assert.equal(later.analysis!.risks.find(r => r.id === risk.id)!.firstSeen, NOW);
  f.orders[2].actions.push({ seq: 9, at: hour(25), kind: 'cancel' });
  const resolved = computeFacts({ ...f, now: hour(26), previous: later });
  assert.equal(resolved.analysis!.risks.find(r => r.id === risk.id)!.lastSeen, hour(25));
  assert.ok(resolved.analysis!.risks.every(r => r.factIds.every(id => resolved.facts.some(f => f.id === id))));
  assert.equal(computeFacts({ ...f, now: hour(25 + 168), previous: resolved }).analysis!.risks.some(r => r.id === risk.id), false);
  f.orders[2].actions.push({ seq: 10, at: hour(26), kind: 'queue' });
  assert.equal(computeFacts({ ...f, now: hour(27), previous: resolved }).analysis!.risks.find(r => r.id === risk.id)!.count, 2);
  const noSample = failures(); noSample.orders[0].order.kind = '';
  const missing = computeFacts(noSample);
  assert.ok(missing.windows['7d'].aging.every(a => a.p85 === null && a.ratio === null));
  assert.equal(missing.analysis!.risks.some(r => r.type === 'aging'), false);
  const zeroCycle = failures();
  zeroCycle.orders[0].runs = []; zeroCycle.orders[0].reports = [];
  zeroCycle.orders[0].actions = [{ seq: 1, kind: 'approve', imported: true, at: hour(0) }];
  assert.ok(computeFacts(zeroCycle).windows['7d'].aging.every(a => a.p85 === null && a.ratio === null));
});

test('event-only approvals/cancellations and backdated imported sequence numbers replay chronologically', () => {
  const f = failures(), d = f.orders[0]; d.reports = []; d.runs = [];
  d.actions = [{ seq: 1, at: hour(20), kind: 'approve', imported: true }];
  f.events = [{ tag: d.order.tag, at: hour(0), type: 'action-queue' }];
  let s = computeFacts(f);
  assert.equal(s.timelines[0].segments.at(-1)!.stage, 'done');
  assert.equal(s.windows['7d'].aging.some(a => a.tag === d.order.tag), false);
  d.actions = [];
  f.events.push({ tag: d.order.tag, at: hour(21), type: 'action-approve', by: 'sync' });
  s = computeFacts(f);
  assert.equal(s.timelines[0].segments.at(-1)!.status, 'merged');
  assert.equal(s.facts.find(f => f.id === 'F:kind.engine.throughput.7d')!.value, 1 / 7);
  f.events[1].type = 'action-cancel';
  assert.equal(computeFacts(f).timelines[0].segments.at(-1)!.status, 'cancelled');
});

test('constraint configuration validates unknown keys, finite values and ratio bounds', () => {
  const raw = { id: 'demo', name: 'Demo', root: '.', work_orders: '.', state_dir: '.alba/test-constraints' };
  const config = (constraints: unknown) => validateProject({ ...raw, producer: { constraints } }, 'fixture.yaml');
  assert.deepEqual(config({ cause_shares: { environment: .2, tool: .5 }, acceptor_p90_hours: 4, first_pass_yield_min: .7, monitoring_cap_share: .3 }).producer.constraints?.cause_shares, { environment: .2, tool: .5 });
  for (const bad of [null, [], 1, { unknown: 1 }, { cause_shares: { typo: .2 } }, { cause_shares: { tool: 1.1 } }, { cause_shares: [] }, { monitoring_cap_share: -1 }, { monitoring_cap_share: NaN }, { acceptor_p90_hours: Infinity }, { first_pass_yield_min: 1.1 }, { acceptor_p90_hours: '8' }]) assert.throws(() => config(bad), /producer.constraints/);
});

test('refresh stores L2 alongside facts and the chat/MCP constraint reader uses that exact card', async () => {
  const f = await fixture({ populate: false, project: () => ({ producer: { constraints: { acceptor_p90_hours: 4 } } }) });
  f.board.hub.stop();
  refreshFacts(f.board.ctx.projects[0], new Date(NOW));
  const s = readFacts(f.board.ctx.projects[0])!;
  assert.ok(s.analysis); assert.deepEqual(producerSnapshot(f.board.ctx.projects[0], 'constraint'), s.analysis.constraint);
  assert.deepEqual((await f.get('/api/p/demo/producer/facts')).body.snapshot.analysis, s.analysis);
});
