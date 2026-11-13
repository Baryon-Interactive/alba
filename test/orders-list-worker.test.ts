import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentWorker } from '../src/cli/main.ts';
import { tempOrders } from './helpers.ts';

test('orders list shows who has the order now: the open run, the pinned next worker, the newest run, then the order\'s own', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'T1', title: 'Work', kind: 'ue', worker: 'codex-official' });
  assert.equal(currentWorker(orders.get('T1')), 'codex-official');
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'grok-cli' });
  assert.equal(currentWorker(orders.get('T1')), 'grok-cli');
  orders.runEnd('T1', 'failed');
  assert.equal(currentWorker(orders.get('T1')), 'grok-cli');
});
