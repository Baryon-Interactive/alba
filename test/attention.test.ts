import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { attentionState } from '../src/api/attention.ts';
import { summaries, livenessOf } from '../src/api/views.ts';
import { initializeAttentionBaseline, saveAttentionMarks, attentionMarks } from '../src/orders/attention-store.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { Orders } from '../src/orders/service.ts';
import { FileStore } from '../src/orders/store.ts';
import { migrateState, exportState } from '../src/orders/state.ts';
import type { OrderDoc } from '../src/orders/model.ts';
import { fixture } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

test('run liveness distinguishes silence from a failed or unavailable probe', () => {
  assert.equal(livenessOf(false, 0), 'gone');
  assert.equal(livenessOf(false, 10), 'gone');
  assert.equal(livenessOf(true, 9), 'active');
  assert.equal(livenessOf(true, 10), 'quiet');
  assert.equal(livenessOf(undefined, 10), 'unverifiable');
  assert.equal(livenessOf(undefined, 9), 'active');
  assert.equal(livenessOf(undefined), 'active');
});

test('attention follows stage entries, run ends and unanswered questions across later edits', () => {
  const doc: OrderDoc = { version: 1, order: { tag: 'T1', title: 'Demo', kind: '', needs: [], created: at(0), updated: at(9) },
    runs: [{ seq: 1, id: 'r1', worker: 'demo', started: at(1) }], reports: [], actions: [] };
  assert.equal(attentionState(doc).unread, false);
  doc.reports.push({ seq: 2, at: at(2), status: 'ready', summary: 'Ready', evidence: [], commits: [] });
  doc.reports.push({ ...doc.reports[0], seq: 3, at: at(3) });
  assert.equal(attentionState(doc).attention?.at, at(2));
  assert.equal(attentionState(doc).attention?.reason, 'stage');
  doc.runs[0].ended = at(4);
  assert.equal(attentionState(doc).attention?.reason, 'run-ended');
  doc.outbox = [{ id: 'q1', kind: 'question', at: at(5), text: 'Which color?' }];
  assert.deepEqual(attentionState(doc).attention, { at: at(5), reason: 'question', text: 'Which color?' });
  doc.actions.push({ seq: 4, at: at(6), kind: 'answer' });
  assert.equal(attentionState(doc).attention?.at, at(4));
});

test('merging an order raises a new attention point after the last one was seen', () => {
  const doc: OrderDoc = { version: 1, order: { tag: 'T1', title: 'Demo', kind: '', needs: ['T0'], created: at(0), updated: at(9) },
    runs: [{ seq: 1, id: 'r1', worker: 'demo', started: at(1), ended: at(3) }],
    reports: [{ seq: 2, at: at(2), status: 'ready', summary: 'Ready', evidence: [], commits: [] }], actions: [] };
  const seen = { tag: 'T1', seen_at: at(3), muted: false };
  assert.equal(attentionState(doc, seen).unread, false, 'the review point was already seen');
  doc.actions.push({ seq: 3, at: at(5), kind: 'approve' });
  const merged = attentionState(doc, seen);
  assert.equal(merged.unread, true);
  assert.equal(merged.attention?.at, at(5));
  assert.equal(merged.attention?.reason, 'stage');
  // A lead closing the order as merged elsewhere counts the same.
  const elsewhere: OrderDoc = { ...doc, actions: [{ seq: 3, at: at(6), kind: 'merged-elsewhere', commit: 'abc1234' }] };
  assert.equal(attentionState(elsewhere, seen).attention?.at, at(6));
});

test('answering a live question preserves when the order entered awaiting-user', () => {
  const doc: OrderDoc = { version: 1, order: { tag: 'T1', title: 'Demo', kind: '', needs: [], created: at(0), updated: at(4) },
    runs: [{ seq: 1, id: 'r1', worker: 'demo', started: at(1) }], reports: [], actions: [],
    outbox: [{ id: 'q1', kind: 'question', at: at(2), text: 'Which palette?', answered: { id: 'a1', at: at(4), text: 'Warm' } }] };
  assert.deepEqual(attentionState(doc).attention, { at: at(2), reason: 'stage', text: 'Which palette?' });
});

for (const Store of [FileStore, SqliteStore]) test(`${Store.name} retains monotonic seen and mute after reopening`, () => {
  const dir = path.join(tempOrders().dir, 'marks');
  const first = new Store(dir);
  saveAttentionMarks(first, [{ tag: 'T1', seen_at: at(4) }, { tag: 'T1', muted: true }, { tag: 'T1', seen_at: at(1) }]);
  if (first instanceof SqliteStore) first.close();
  const reopened = new Store(dir);
  assert.deepEqual(attentionMarks(reopened).get('T1'), { tag: 'T1', seen_at: at(4), muted: true });
  if (reopened instanceof SqliteStore) reopened.close();
});

for (const Store of [FileStore, SqliteStore]) test(`${Store.name} views use a fixed baseline for historical merges`, async () => {
  let now = new Date(at(1));
  const f = await fixture({ populate: false, now: () => now });
  const store = new Store(path.join(f.dir, 'history'));
  const orders = new Orders(store, () => now.toISOString());
  const view = { config: f.board.ctx.projects[0], orders };
  const unread = () => summaries(view, { probes: f.board.ctx.probes }, true).filter(o => o.unread).map(o => o.tag);
  const merge = (tag: string) => {
    orders.add({ tag, title: 'Demo', kind: 'docs' });
    orders.act(tag, 'merged-elsewhere', { commit: 'abc1234' });
  };
  try {
    for (let i = 1; i <= 5; i++) merge(`T${i}`);
    assert.equal(unread().length, 5);
    initializeAttentionBaseline(store, now);
    assert.deepEqual(unread(), []);
    now = new Date(at(2));
    merge('T6');
    initializeAttentionBaseline(store, new Date(at(3)));
    assert.deepEqual(unread(), ['T6']);
  } finally { if (store instanceof SqliteStore) store.close(); }
});

test('migration and export preserve read and mute marks', () => {
  const { dir, orders } = tempOrders('files');
  const state = path.join(dir, 'state');
  saveAttentionMarks(orders.store, [{ tag: 'T1', seen_at: at(1) }, { tag: 'T2', muted: true }]);
  const marks = attentionMarks(orders.store);
  migrateState(state);
  const sql = new SqliteStore(state);
  assert.deepEqual(attentionMarks(sql), marks);
  sql.close();
  const out = path.join(dir, 'export');
  exportState(state, out);
  assert.deepEqual(attentionMarks(new FileStore(out)), marks);
});

test('attention routes validate batches before marking and acknowledge current points', async () => {
  const f = await fixture();
  const write = (route: string, body: object) => f.write('/api/' + route, { project: 'demo', ...body });
  for (const route of ['orders/missing/seen', 'orders/missing/mute']) assert.equal((await write(route, { at: at(0), muted: true })).status, 404);
  assert.equal((await write('seen', { tags: ['R1', 'missing'] })).status, 404);
  const read = async (tag: string) => (await f.get('/api/orders/' + tag)).body;
  assert.equal((await read('R1')).unread, true);
  assert.equal((await write('orders/R1/mute', { muted: true })).status, 200);
  assert.equal((await read('R1')).muted, true);
  assert.equal((await write('seen', { tags: ['R1'] })).status, 200);
  assert.equal((await read('R1')).unread, false);
  assert.equal((await read('Q1')).unread, true);
  assert.equal((await write('seen', {})).status, 200);
  const q = await read('Q1');
  assert.equal(q.seen, q.attention.at);
  assert.equal(q.unread, false);
});

test('run detail and list expose the slot range computed for launch', async () => {
  const f = await fixture({ project: () => ({ dispatch: { port_base: 8100, port_block: 5 } }) });
  const doc = f.orders.get('W1');
  doc.runs[0].slot = 2;
  f.orders.store.write(doc);
  const detail = (await f.get('/api/orders/W1')).body;
  const list = (await f.get('/api/runs')).body;
  assert.deepEqual(detail.runs[0].ports, { first: 8110, last: 8114 });
  assert.deepEqual(list.items.find((run: { tag: string }) => run.tag === 'W1').ports, detail.runs[0].ports);
});
