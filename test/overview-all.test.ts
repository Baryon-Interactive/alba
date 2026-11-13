import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overviewAll } from '../src/api/overview-all.ts';
import { fixture } from './api-fixture.ts';
import { Orders } from '../src/orders/service.ts';
import { stateStore } from '../src/orders/backend.ts';

test('overview API counts two running and four monitoring jobs against kind and heavy caps', async () => {
  const f = await fixture({ populate: false, second: true, project: () => ({
    dispatch: { caps: { ue: 6, core: 8, sim: 2 } },
    kinds: { ue: { description: 'Engine work', match: ['Engine work'] } },
  }) });
  for (let i = 0; i < 6; i++) {
    const tag = `E${i}`;
    f.orders.add({ tag, title: 'Engine work', kind: i === 5 ? 'task' : 'ue', heavy: 'core' });
    f.orders.act(tag, 'queue');
    f.orders.runStart(tag, { worker: 'coder' });
    if (i >= 2) {
      f.orders.runEnd(tag, 'completed');
      f.orders.report(tag, { status: 'monitoring', summary: 'Build underway', evidence: [], commits: [], monitor: {
        check: ['node', '--version'], cwd: '.', done_when: { file_exists: 'build.done' }, deadline_minutes: 60,
      } });
    }
  }
  f.orders.add({ tag: 'Q1', title: 'Queued work', kind: 'ue', heavy: 'core' });
  f.orders.act('Q1', 'queue');
  const expected = { ue: { used: 6, cap: 6, monitoring: 4 }, core: { used: 6, cap: 8, monitoring: 4 }, sim: { used: 0, cap: 2, monitoring: 0 } };
  const aggregate = await f.get('/api/overview/all');
  assert.equal(aggregate.status, 200);
  assert.deepEqual(aggregate.body.projects.find((p: any) => p.project === 'demo').capacity, expected);
  assert.deepEqual(aggregate.body.projects.find((p: any) => p.project === 'other').capacity, {});
  const result = await f.get('/api/p/demo/overview');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.capacity, expected);
  assert.equal(result.body.stages.running, 2);
  assert.equal(result.body.stages.monitoring, 4);
  assert.equal(result.body.running.count, 2);
  f.orders.act('E5', 'hold');
  const held = await f.get('/api/p/demo/overview');
  assert.deepEqual(held.body.capacity.ue, { used: 5, cap: 6, monitoring: 3 });
});

test('aggregate counts match drill-through lists and shared workers appear once for two projects without probes', async () => {
  const f = await fixture({ second: true });
  const other = new Orders(stateStore(f.board.ctx.projects[1]));
  other.add({ tag: 'X1', title: 'Other live work', kind: 'sim' }); other.act('X1', 'queue'); other.runStart('X1', { worker: 'coder' });
  f.board.ctx.snapshot();
  f.board.invalidate();
  const fail = () => { throw new Error('aggregate must not probe'); };
  for (const key of ['isAlive', 'gitActivity', 'freeRamGb', 'runCommand', 'worktrees', 'tail', 'readText', 'fileTime'] as const) f.board.ctx.probes[key] = fail as never;
  const result = await f.get('/api/overview/all');
  assert.equal(result.status, 200);
  const o = result.body;
  assert.equal(o.projects.length, 2);
  assert.equal(o.workers.items.filter((w: any) => w.id === 'coder').length, 1);
  assert.equal(o.workers.items.find((w: any) => w.id === 'coder').running, 2);
  assert.equal(o.workers.items.find((w: any) => w.id === 'coder').available, false);
  for (const block of [o.live, o.workers, o.recentMerges, ...o.attention]) assert.equal(block.count, block.items.length);
  for (const p of o.projects) {
    for (const block of [p.needsYou, p.running, p.problems, p.pendingQuotes]) assert.equal(block.count, block.items.length);
    assert.equal(p.total, Object.values(p.stages).reduce((a: any, b: any) => a + b, 0));
  }
  assert.equal(o.attention.find((g: any) => g.kind === 'answer').items[0].tag, 'Q1');
  assert.equal(o.attention.find((g: any) => g.kind === 'review').items[0].tag, 'R1');
});

test('14 UTC days use approval/rework and run end times; queue latency uses first queue and nearest-rank p95', async () => {
  const f = await fixture({ populate: false, second: true });
  let time = '2026-06-01T00:00:00Z';
  const orders = new Orders(f.orders.store, () => time);
  for (const [tag, end] of [['A', '2026-06-02T00:00:00Z'], ['B', '2026-06-04T00:00:00Z']]) {
    time = '2026-06-01T00:00:00Z';
    orders.add({ tag, title: tag, kind: 'sim' }); orders.act(tag, 'queue'); orders.runStart(tag, { worker: 'coder' });
    time = end; orders.runEnd(tag, 'completed');
    orders.report(tag, { status: 'ready', summary: tag, evidence: [], commits: [] }); orders.act(tag, 'approve');
  }
  time = '2026-06-03T12:00:00Z';
  orders.add({ tag: 'C', title: 'retry', kind: 'sim' }); orders.act('C', 'queue'); orders.runStart('C', { worker: 'coder' });
  orders.runEnd('C', 'failed'); orders.report('C', { status: 'failed', summary: 'retry', evidence: [], commits: [] }); orders.act('C', 'rework', { note: 'retry' });
  const snap = f.board.ctx.snapshot();
  const o = overviewAll(snap, f.board.ctx.workers, undefined, undefined, new Date('2026-06-14T12:00:00Z'));
  assert.equal(o.days.length, 14);
  assert.deepEqual(o.days[0], { day: '2026-06-01', merges: {}, endings: {}, reworks: 0 });
  assert.deepEqual(o.days[1].merges, { demo: 1 });
  assert.deepEqual(o.days[1].endings, { completed: 1 });
  assert.equal(o.days[2].reworks, 1);
  assert.deepEqual(o.days[2].endings, { failed: 1 });
  assert.deepEqual(o.projects[0].mergesPerDay, o.days.map(d => d.merges.demo ?? 0));
  assert.equal(o.metrics.runSuccessRate, 2 / 3);
  assert.equal(o.metrics.reworksPerMerge, .5);
  assert.equal(o.metrics.medianLeadHours, 48);
  assert.equal(o.metrics.p95LeadHours, 72);
  assert.equal(o.metrics.merges7d, 0);
  const later = overviewAll(snap, f.board.ctx.workers, undefined, undefined, new Date('2026-07-01T00:00:00Z'));
  assert.equal(later.metrics.runSuccessRate, undefined);
  assert.equal(later.metrics.medianLeadHours, undefined);
  assert.equal(later.recentMerges.count, 2);
});
