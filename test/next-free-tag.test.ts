import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextFreeTag } from '../src/orders/service.ts';
import { tempOrders } from './helpers.ts';

test('the next free tag: one past the highest number, the next letter, or a number for a bare tag', () => {
  assert.equal(nextFreeTag('FACT1', ['FACT1', 'FACT2', 'FACT3', 'FIRE2']), 'FACT4');
  assert.equal(nextFreeTag('fact2', ['FACT1', 'FACT2']), 'fact3');
  assert.equal(nextFreeTag('REN2A', ['REN2A', 'REN2B', 'REN3']), 'REN2C');
  assert.equal(nextFreeTag('INTRO', ['INTRO', 'INTRO2']), 'INTRO3');
  assert.equal(nextFreeTag('A.1', ['A.1', 'A.2']), 'A.3');
});

test('orders add on a taken tag says its stage and the next free tag', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'FACT1', title: 'Facts', kind: 'content' });
  orders.add({ tag: 'FACT2', title: 'Facts', kind: 'content' });
  orders.act('FACT2', 'cancel');
  assert.throws(() => orders.add({ tag: 'fact2', title: 'Again', kind: 'content' }), /Order "FACT2" already exists \(cancelled; a merged or cancelled order keeps its tag\)\. The next free tag like it is fact3\./);
});
