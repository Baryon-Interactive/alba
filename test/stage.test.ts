import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action, Order, Report, Run } from '../src/orders/model.ts';
import { actionProblem, stageOf } from '../src/orders/stage.ts';
import { ready, tempOrders } from './helpers.ts';

const order = (needs: string[] = []): Order => ({ tag: 'T1', title: 't', kind: 'sim', needs, created: '', updated: '' });
const act = (seq: number, kind: Action['kind']): Action => ({ seq, at: '', kind });
const run = (seq: number, ended?: Run['outcome']): Run => ({ id: `r${seq}`, seq, worker: 'w', started: '', ...(ended ? { ended: 'x', outcome: ended } : {}) });
const rep = (seq: number, status: Report['status'], question?: string): Report => ({ seq, at: '', status, summary: 's', ...(question ? { question } : {}), evidence: [], commits: [] });
const none = new Set<string>();

test('stage table: every row', () => {
  assert.equal(stageOf(order(), [], [], [act(1, 'queue'), act(2, 'cancel')], none), 'cancelled');
  assert.equal(stageOf(order(), [], [], [act(1, 'approve')], none), 'merged');
  assert.equal(stageOf(order(), [run(1)], [rep(2, 'ready')], [act(3, 'hold')], none), 'held');
  assert.equal(stageOf(order(), [run(1)], [rep(2, 'waiting', 'which one?')], [], none), 'awaiting-user');
  assert.equal(stageOf(order(), [run(1, 'completed')], [rep(2, 'ready')], [], none), 'awaiting-review');
  assert.equal(stageOf(order(), [run(1)], [rep(2, 'blocked')], [], none), 'blocked');
  assert.equal(stageOf(order(), [run(1)], [rep(2, 'failed')], [], none), 'failed');
  assert.equal(stageOf(order(), [run(1)], [rep(2, 'dropped')], [], none), 'dropped');
  assert.equal(stageOf(order(), [run(1)], [rep(2, 'progress')], [], none), 'running');
  assert.equal(stageOf(order(), [run(1, 'completed')], [], [], none), 'idle');
  assert.equal(stageOf(order(), [run(1)], [rep(2, 'waiting')], [], none), 'running');
  assert.equal(stageOf(order(), [run(1, 'completed')], [rep(2, 'waiting')], [], none), 'idle');
  assert.equal(stageOf(order(['A']), [], [], [act(1, 'queue')], none), 'waiting-needs');
  assert.equal(stageOf(order(['A']), [], [], [act(1, 'queue')], new Set(['A'])), 'queued');
  assert.equal(stageOf(order(), [], [], [], none), 'draft');
});

test('stage: facts after a report or a person make it stale; rows are ordered', () => {
  // a person reworked after the ready report: back to queued, the old report no longer counts
  assert.equal(stageOf(order(), [run(1, 'completed')], [rep(2, 'ready')], [act(3, 'rework')], none), 'queued');
  // a new run after a blocked report: running again
  assert.equal(stageOf(order(), [run(1, 'failed'), run(3)], [rep(2, 'blocked')], [], none), 'running');
  // an interrupted run (capacity) while queued: ready to resume
  assert.equal(stageOf(order(), [run(2, 'capacity')], [], [act(1, 'queue')], none), 'queued');
  // release returns to the underlying stage; cancel then queue revives
  assert.equal(stageOf(order(), [], [], [act(1, 'queue'), act(2, 'hold'), act(3, 'release')], none), 'queued');
  assert.equal(stageOf(order(), [], [], [act(1, 'cancel'), act(2, 'queue')], none), 'queued');
  // cancelled beats everything; merged beats held
  assert.equal(stageOf(order(), [run(1)], [rep(2, 'ready')], [act(3, 'cancel')], none), 'cancelled');
  assert.equal(stageOf(order(), [], [], [act(1, 'hold'), act(2, 'approve')], none), 'merged');
});

test('illegal human actions are refused', () => {
  assert.match(actionProblem('merged', 'rework') ?? '', /cannot rework an order that is merged/);
  assert.ok(actionProblem('draft', 'approve'));
  assert.ok(actionProblem('queued', 'release'));
  assert.ok(actionProblem('merged', 'cancel'));
  assert.ok(actionProblem('held', 'hold'));
  assert.equal(actionProblem('awaiting-review', 'approve'), undefined);
  assert.equal(actionProblem('held', 'release'), undefined);
  const { orders } = tempOrders();
  orders.add({ tag: 'T1', title: 't', kind: 'sim' });
  assert.throws(() => orders.act('T1', 'approve'), /cannot approve an order that is draft/);
  orders.act('T1', 'queue');
  assert.throws(() => orders.act('T1', 'rework', { note: 'x' }), /cannot rework/);
});

test('full flow: queue, run, report, rework note, approve', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'T1', title: 't', kind: 'sim' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'w1' });
  assert.equal(orders.stage(orders.get('T1')).stage, 'running');
  assert.throws(() => orders.runStart('T1', { worker: 'w2' }), /already has an open run/);
  orders.report('T1', ready);
  orders.runEnd('T1');
  assert.equal(orders.stage(orders.get('T1')).stage, 'awaiting-review');
  assert.throws(() => orders.act('T1', 'rework'), /needs a note/);
  orders.act('T1', 'rework', { note: 'fix the edge case' });
  const { run } = orders.runStart('T1', { worker: 'w1' });
  assert.equal(run.note, 'fix the edge case');
  orders.runEnd('T1');
  orders.report('T1', ready);
  orders.act('T1', 'approve');
  assert.equal(orders.stage(orders.get('T1')).stage, 'merged');
  assert.throws(() => orders.act('T1', 'rework', { note: 'again' }), /merged/);
  assert.ok(orders.store.events({ tag: 'T1' }).length >= 9);
});

test('ready lists only queued orders whose needs are all merged', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'A1', title: 'a', kind: 'sim' });
  orders.add({ tag: 'B1', title: 'b', kind: 'sim', needs: ['A1'] });
  orders.add({ tag: 'C1', title: 'c', kind: 'sim', needs: ['A1', 'A2'] });
  orders.add({ tag: 'A2', title: 'a2', kind: 'sim' });
  for (const tag of ['B1', 'C1']) orders.act(tag, 'queue');
  assert.deepEqual(orders.ready().map(d => d.order.tag), []);
  orders.act('A1', 'queue'); orders.runStart('A1', { worker: 'w' }); orders.runEnd('A1'); orders.report('A1', ready); orders.act('A1', 'approve');
  assert.deepEqual(orders.ready().map(d => d.order.tag), ['B1']);
  orders.act('A2', 'queue'); orders.act('A2', 'cancel');
  assert.deepEqual(orders.ready().map(d => d.order.tag), ['B1']);
  orders.act('A2', 'queue'); orders.runStart('A2', { worker: 'w' }); orders.runEnd('A2'); orders.report('A2', ready); orders.act('A2', 'approve');
  assert.deepEqual(orders.ready().map(d => d.order.tag).sort(), ['B1', 'C1']);
});
