import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import type { Probes } from '../src/tick/gather.ts';
import { planTick, type TickInput, type TickOrder } from '../src/tick/plan.ts';
import { orderSpend, spendToday, usageOf } from '../src/usage/spend.ts';
import { parseUsage, withCost } from '../src/usage/usage.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { validateProject } from './state-helper.ts';
import { tempOrders } from './helpers.ts';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

test('usage: Codex prints a total only, Grok an end event with cost, OpenCode a step_finish with the split (all three from real runs)', () => {
  assert.deepEqual(parseUsage(fixture('codex-usage.log')), { source: 'codex-log', total_tokens: 23135 });
  const grok = parseUsage(fixture('grok-done.log'));
  assert.equal(grok.source, 'grok-end');
  assert.equal(grok.total_tokens, 19125);
  assert.equal(grok.input_tokens, 17225);
  assert.equal(grok.output_tokens, 236);
  assert.equal(grok.turns, 1);
  assert.equal(grok.cost_usd, 0.036698);
  assert.equal(grok.cost_estimated, undefined);
  const open = parseUsage(fixture('opencode-usage.log'));
  assert.deepEqual(open, { source: 'opencode-json', total_tokens: 10702, input_tokens: 4131, output_tokens: 6, cached_tokens: 6565, turns: 1, cost_usd: 0.009635 });
});

test('usage: steps add up, a log without numbers is unknown, and a cost is only ever an estimate when it comes from a price', () => {
  const step = (input: number, output: number) => JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', cost: 0.5, tokens: { input, output, reasoning: 2, cache: { read: 10, write: 0 } } } });
  const two = parseUsage([step(100, 5), 'plain line', step(200, 7)].join('\n'));
  assert.deepEqual([two.input_tokens, two.output_tokens, two.cached_tokens, two.total_tokens, two.turns, two.cost_usd], [300, 16, 20, 336, 2, 1]);
  assert.deepEqual(parseUsage('tokens used appears here but not as a section\nnothing else'), { source: 'unknown' });
  assert.deepEqual(parseUsage(''), { source: 'unknown' });
  // a price turns tokens into an estimate; the engine's own figure is never replaced
  const codex = parseUsage(fixture('codex-usage.log'));
  assert.deepEqual(withCost(codex, { per_mtok: 10 }), { ...codex, cost_usd: 0.23135, cost_estimated: true });
  assert.deepEqual(withCost(parseUsage(fixture('grok-done.log')), { per_mtok: 10 }).cost_estimated, undefined);
  assert.equal(withCost(codex, undefined).cost_usd, undefined);
  assert.equal(withCost({ source: 'unknown' }, { per_mtok: 10 }).cost_usd, undefined);   // nothing is guessed
  const split = withCost({ source: 'opencode-json', input_tokens: 1_000_000, output_tokens: 500_000, total_tokens: 1_500_000 }, { input_per_mtok: 2, output_per_mtok: 10 });
  assert.equal(split.cost_usd, 7);
});

test('workers file: price and daily cap are validated', () => {
  const ok = validateWorkers({ workers: [{ id: 'w', engine: 'e', price: { input_per_mtok: 1, output_per_mtok: 4 }, daily_cap_usd: 5 }] }, 'w.yaml').workers[0];
  assert.deepEqual([ok.price, ok.daily_cap_usd], [{ input_per_mtok: 1, output_per_mtok: 4 }, 5]);
  assert.throws(() => validateWorkers({ workers: [{ id: 'w', engine: 'e', price: { input_per_mtok: 1 } }] }, 'w.yaml'), /together/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'w', engine: 'e', price: { per_mtok: -1 } }] }, 'w.yaml'), />= 0/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'w', engine: 'e', daily_cap_usd: 'x' }] }, 'w.yaml'), /number/);
});

function ended(over: Partial<Probes> = {}) {
  const { orders, dir } = tempOrders();
  mkdirSync(path.join(dir, 'orders'));
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'T1', kind: 'k', mandate: { spend_cap: 0.2 } });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'coder', extra: { pid: 4242, log: path.join(dir, 'T1-r1.log') } });
  const probes = { now: () => new Date('2026-01-01T12:00:00Z'), fileTime: () => '2026-01-01T11:00:00Z', readText: () => undefined, isAlive: () => false, tail: () => fixture('codex-usage.log'), head: (_f: string, n: number) => fixture('codex-usage.log').slice(0, n), ...over } as unknown as Probes;
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', price: { per_mtok: 10 }, daily_cap_usd: 0.2 }] }, 'w.yaml');
  return { orders, project, probes, workers };
}

test('finish: the usage and the Codex session id are read from the log and kept on the run', () => {
  const { orders, project, probes } = ended();
  const [f] = findFinishes(project, orders, probes);
  assert.deepEqual(f.usage, { source: 'codex-log', total_tokens: 23135 });
  assert.equal(f.session, '01a1a1e2-d9c2-72e1-a18a-0d741950269f');
  applyFinish(orders, f);
  const run = orders.get('T1').runs[0];
  assert.equal(run.usage?.total_tokens, 23135);
  assert.equal(run.session, '01a1a1e2-d9c2-72e1-a18a-0d741950269f');
});

test('spend: an order and a worker add up their runs, estimated from the price, and the tick stops at the caps', () => {
  const { orders, project, probes, workers } = ended();
  applyFinish(orders, findFinishes(project, orders, probes)[0]);
  const doc = orders.get('T1');
  const u = usageOf(doc.runs[0], workers.workers, probes);
  assert.deepEqual([u.cost_usd, u.cost_estimated], [0.23135, true]);
  const s = orderSpend(doc, workers.workers, probes);
  assert.deepEqual([s.total_tokens, s.cost_usd, s.estimated, s.runs_with_usage, s.runs_unknown, s.cap_usd, s.over_cap], [23135, 0.23135, true, 1, 0, 0.2, true]);
  assert.equal(spendToday(orders.all(), workers.workers, probes, new Date('2026-01-01T12:00:00Z')).get('coder'), 0.23135);
  // a run with no log, or an imported one, is unknown rather than zero
  orders.runStart('T1', { worker: 'coder' });
  orders.runEnd('T1');
  assert.equal(orderSpend(orders.get('T1'), workers.workers, probes).runs_unknown, 1);

  const order = (over: Partial<TickOrder>): TickOrder => ({ role: { id: 'default' }, tag: 'T1', stage: 'queued', kind: 'k', row: 1, rework: false, resume: false, endedWithoutReport: false, ...over });
  const input = (o: TickOrder, worker: Partial<TickInput['workers'][0]> = {}): TickInput => ({
    now: new Date('2026-01-01T12:00:00Z'), orders: [o], activity: {}, caps: {}, reworkReserve: 1, alerts: [],
    workers: [{ config: { id: 'w', engine: 'x', paid: false, concurrency: 1, capabilities: [], cost: 'included', aliases: [], enabled: true, disabled_when: [], card_only: false }, available: true, reasons: [], running: 0, runsToday: 0, ...worker }],
  });
  const fine = planTick(input(order({ spendCapUsd: 1, spentUsd: 0.5 })));
  assert.deepEqual(fine.moves.map(m => m.tag), ['T1']);
  const over = planTick(input(order({ spendCapUsd: 0.2, spentUsd: 0.23 })));
  assert.deepEqual(over.moves, []);
  assert.equal(over.problems[0].kind, 'spend');
  assert.match(over.problems[0].text, /T1: its runs cost \$0\.23, which reaches its spend cap of \$0\.2; it is not started again/);
  const day = planTick(input(order({}), { available: false, reasons: ['daily spend cap $5 reached ($5.2 today)'], overCap: true, spendTodayUsd: 5.2, config: { id: 'w', engine: 'x', paid: true, concurrency: 1, capabilities: [], cost: 'paid', aliases: [], enabled: true, disabled_when: [], card_only: false, daily_cap_usd: 5 } }));
  assert.deepEqual(day.moves, []);
  assert.ok(day.problems.some(p => p.kind === 'spend' && /daily spend cap of \$5 is reached/.test(p.text)));
});
