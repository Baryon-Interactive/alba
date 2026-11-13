import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { Orders } from '../src/orders/service.ts';

test('holding closes a record without a process and cancels a verified live process only', () => {
  const f = tempOrders(), stopped: number[] = [], at = '2026-01-01T00:00:00Z';
  const orders = new Orders(f.orders.store, () => at, 'test', () => at, { alive: () => true, stop: pid => { stopped.push(pid); return { stopped: [pid], leftRunning: [] }; } });
  orders.add({ tag: 'SAMPLE', title: 'Sample', kind: 'code' });
  orders.runStart('SAMPLE', { worker: 'builder', extra: { pid: 123, process_started_at: at } });
  orders.act('SAMPLE', 'hold');
  const doc = orders.get('SAMPLE');
  assert.equal(orders.stage(doc).stage, 'held'); assert.ok(doc.runs[0].ended); assert.equal(doc.runs[0].outcome, 'cancelled'); assert.deepEqual(stopped, [123]);
  orders.add({ tag: 'OTHER', title: 'Other sample', kind: 'code' });
  orders.runStart('OTHER', { worker: 'builder', extra: { pid: 456, process_started_at: '2025-01-01T00:00:00Z' } });
  assert.throws(() => orders.act('OTHER', 'hold'), /cannot be verified/);
  assert.equal(orders.get('OTHER').runs[0].ended, undefined); assert.deepEqual(stopped, [123]);
});
