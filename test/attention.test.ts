import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { attentionState } from '../src/api/attention.ts';
import { livenessOf } from '../src/api/views.ts';
import { saveAttentionMarks, attentionMarks } from '../src/orders/attention-store.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { FileStore } from '../src/orders/store.ts';
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

for (const Store of [FileStore, SqliteStore]) test(`${Store.name} retains monotonic seen and mute after reopening`, () => {
  const dir = path.join(tempOrders().dir, 'marks');
  const first = new Store(dir);
  saveAttentionMarks(first, [{ tag: 'T1', seen_at: at(4) }, { tag: 'T1', muted: true }, { tag: 'T1', seen_at: at(1) }]);
  if (first instanceof SqliteStore) first.close();
  const reopened = new Store(dir);
  assert.deepEqual(attentionMarks(reopened).get('T1'), { tag: 'T1', seen_at: at(4), muted: true });
  if (reopened instanceof SqliteStore) reopened.close();
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
