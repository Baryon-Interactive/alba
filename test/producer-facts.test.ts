import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeFacts, timeline, classifyCause } from '../src/producer/facts/engine.ts';
import { refreshFacts, FACTS_META } from '../src/producer/facts/snapshot.ts';
import { fixture } from './api-fixture.ts';
import { producerFactsFixture, hour, NOW } from './fixtures/producer-facts.ts';
import { validateRoles } from '../src/roles/config.ts';

test('fixture timeline, occupancy, causes, yield, cost and latency have known answers', () => {
  const f = producerFactsFixture(), s = f.snapshot;
  const value = (id: string) => s.facts.find(f => f.id === `F:${id}.24h`)?.value;
  assert.deepEqual(s.timelines[0].segments.filter(s => s.from !== s.to).map(s => [s.stage, (Date.parse(s.to) - Date.parse(s.from)) / 3_600_000]), [['working', 6], ['monitoring', 12], ['working', 2], ['acceptor', 2], ['done', 2]]);
  assert.equal(value('slot.engine.samples'), 144);
  assert.equal(value('slot.engine.working'), 50 / 24);
  assert.equal(value('slot.engine.monitoring'), .5);
  assert.equal(value('slot.engine.idle'), 10 / 24);
  assert.deepEqual(s.windows['24h'].slots[0].current, { working: 1, monitoring: 0, idle: 2 });
  for (const cause of ['environment', 'tool', 'capacity', 'specification', 'result', 'unclassified']) assert.equal(value(`cause.${cause}`), 1);
  assert.equal(s.windows['7d'].unclassified[0].tag, 'E6');
  assert.equal(value('kind.engine.first_pass_yield'), .5);
  assert.equal(value('kind.engine.rework_mean'), .5);
  assert.equal(value('kind.engine.acceptor_p50'), 2);
  assert.equal(value('kind.engine.acceptor_p90'), 2.8);
  assert.equal(value('kind.engine.cycle_p50'), 22.5);
  assert.equal(value('kind.engine.cycle_p85'), 22.85);
  assert.equal(value('kind.engine.throughput'), 2);
  assert.equal(value('kind.engine.wip'), 7);
  assert.equal(value('kind.engine.tokens_per_merged'), 150);
  assert.equal(value('kind.engine.tokens_not_merged'), 30);
  assert.equal(s.windows['24h'].routing[0].comparable, false);
  assert.equal(s.windows['24h'].aging[0].p85, 22.85);
  assert.equal(s.windows['7d'].slots[0].samples, 1008);
  assert.equal(new Set(s.facts.map(f => f.id)).size, s.facts.length);
  assert.ok(s.facts.every(f => f.unit && f.window && f.id.startsWith('F:')));
  assert.deepEqual(computeFacts(f), s);
});

test('holds restore queued state, cancelled is done, and future facts are excluded', () => {
  const f = producerFactsFixture(), d = structuredClone(f.orders[2]);
  d.runs = [];
  d.actions.push({ seq: 2, kind: 'hold', at: hour(6) }, { seq: 3, kind: 'release', at: hour(12) }, { seq: 4, kind: 'cancel', at: hour(18) }, { seq: 5, kind: 'queue', at: hour(30) });
  assert.deepEqual(timeline(d, [], NOW).segments.filter(s => s.from !== s.to).map(s => s.stage), ['queued', 'held', 'queued', 'done']);
  assert.equal(classifyCause('blocked'), 'unclassified');
  assert.equal(classifyCause('monitoring'), 'unclassified');
});

test('generic outcome rules classify causes while unknown summaries stay unknown', () => {
  const examples = {
    capacity: ['Usage quota exhausted; waiting for reset.', 'Rate limit reached for the next request.'],
    environment: ['Build failed: missing graphics dependencies.', 'Network failure interrupted the upload.', 'Runtime environment is unavailable.'],
    tool: ['Report block invalid; check the format.', 'The service is unavailable after retry.', 'Tool error; the run ended.'],
    specification: ['Waiting for approval of the colors.', 'Which option for the layout?', 'Waiting for an answer before changing the design.'],
    result: ['Audio acceptance thresholds exceeded.', 'Regression test failed; no delivery evidence.', 'The interaction remains unverified.', 'The output formula overflows.'],
    unclassified: ['Current progress committed.', 'An observation without a stated cause.', 'blocked'],
  };
  for (const [cause, summaries] of Object.entries(examples)) for (const summary of summaries) assert.equal(classifyCause(summary), cause, summary);
  // A concrete prerequisite failure takes precedence over a secondary incomplete acceptance.
  assert.equal(classifyCause('Missing runtime dependencies; acceptance incomplete.'), 'environment');
  assert.equal(classifyCause('Usage limit reached; verification incomplete.'), 'capacity');
  const f = producerFactsFixture();
  f.orders.find(d => d.order.tag === 'E6')!.reports[0].summary = 'Audio acceptance thresholds exceeded.';
  const s = computeFacts(f);
  assert.equal(s.windows['7d'].causes.find(c => c.cause === 'unclassified')!.count, 0);
  assert.equal(s.windows['7d'].causes.find(c => c.cause === 'result')!.count, 2);
});

test('usage turns replace run totals without double counting; worker rework follows delivery owner', () => {
  const f = producerFactsFixture();
  f.orders[1].runs[1].worker = 'finisher';
  const s = computeFacts({ ...f, usage: [{ order: 'A1', run: 'r1', at: hour(4), total_tokens: 10 } as never] });
  assert.equal(s.facts.find(f => f.id === 'F:kind.engine.tokens_per_merged.24h')?.value, 135);
  assert.equal(s.windows['24h'].routing.find(r => r.worker === 'builder')?.rework, .5);
  assert.equal(s.windows['24h'].routing.find(r => r.worker === 'finisher')?.rework, 0);
  assert.equal(s.windows['24h'].routing.find(r => r.worker === 'finisher')?.yield, 1);
});

test('API reads only stored snapshot, including before first tick; refresh is throttled for five minutes', async () => {
  const f = await fixture({ populate: false });
  assert.equal((await f.get('/api/p/demo/producer/facts')).body.snapshot, null);
  const project = f.board.ctx.projects[0];
  f.board.hub.stop();
  const expected = producerFactsFixture().snapshot;
  f.orders.store.writeMeta(FACTS_META, expected);
  // All heavy reads fail if the endpoint accidentally starts computation.
  const originalAll = f.orders.store.all, originalEvents = f.orders.store.events;
  f.orders.store.all = () => { throw new Error('must not read orders'); };
  f.orders.store.events = () => { throw new Error('must not read events'); };
  try {
    const response = await f.get('/api/p/demo/producer/facts');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { project: 'demo', snapshot: expected });
    refreshFacts(project, new Date(Date.parse(NOW) + 299_999));
  } finally { f.orders.store.all = originalAll; f.orders.store.events = originalEvents; }
  assert.deepEqual(f.orders.store.readMeta(FACTS_META), expected);
  refreshFacts(project, new Date(Date.parse(NOW) + 300_000));
  assert.equal((f.orders.store.readMeta(FACTS_META) as typeof expected).at, '2026-11-08T00:05:00.000Z');
  assert.equal((await f.get('/api/p/missing/producer/facts')).status, 404);
});

test('routing counts decisions on older runs, requires five decided orders, and escapes dotted IDs', () => {
  const f = producerFactsFixture();
  const orders = Array.from({ length: 5 }, (_, i) => {
    const d = structuredClone(f.orders[0]);
    d.order.tag = `S${i}`;
    d.order.created = hour(-200);
    d.order.kind = 'engine.build';
    d.order.heavy = 'shared';
    d.runs = [d.runs[1]];
    d.runs[0].worker = 'worker.one';
    d.runs[0].started = hour(-2);
    d.reports = [d.reports[1]];
    d.actions = [d.actions[0], d.actions[2]];
    return d;
  });
  const s = computeFacts({ ...f, orders, events: [], caps: { shared: 5 } });
  assert.equal(s.windows['24h'].routing[0].runs, 0);
  assert.equal(s.windows['24h'].routing[0].orders, 5);
  assert.equal(s.windows['24h'].routing[0].comparable, true);
  assert.equal(s.windows['24h'].routing[0].yield, 1);
  assert.equal(s.facts.find(f => f.id === 'F:routing.worker%2Eone.engine%2Ebuild.decided_orders.24h')?.value, 5);
  assert.equal(s.windows['24h'].slots[0].working, 5 * 20 / 24);
  assert.equal(s.windows['24h'].causes.reduce((n, c) => n + c.count, 0), 0);
});

test('role facts report current supply constraints and queue time clipped to each window', () => {
  const f = producerFactsFixture(), queued = structuredClone(f.orders[2]);
  queued.runs = []; queued.order.created = hour(-10); queued.actions = [{ seq: 1, kind: 'queue', at: hour(-10) }];
  const roleDefinitions = validateRoles({ 'build-role': { kinds: ['engine'] }, default: {} }, 'fixture.yaml');
  const snapshot = computeFacts({ ...f, orders: [queued], events: [], roleDefinitions, roleAvailability: [{ id: 'build-role', qualifying: [] }, { id: 'default', qualifying: ['text'] }] });
  const value = (id: string) => snapshot.facts.find(f => f.id === `F:${id}`)?.value;
  assert.equal(value('role.build-role.qualifying_workers.24h'), 0);
  assert.equal(value('role.build-role.no_qualifying_worker.24h'), 1);
  assert.equal(value('role.default.no_qualifying_worker.24h'), 0);
  assert.equal(value('role.build-role.queue_hours.24h'), 24);
  assert.equal(value('role.build-role.queue_wait_p50.7d'), 34);
  const empty = computeFacts({ ...f, orders: [], events: [], roleDefinitions, roleAvailability: [{ id: 'build-role', qualifying: [] }] });
  assert.equal(empty.analysis?.constraint.type, 'role');
  assert.match(empty.analysis!.constraint.title, /build-role/);
});
