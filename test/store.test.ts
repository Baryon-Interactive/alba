import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FileStore, writeFileAtomic } from '../src/orders/store.ts';
import { tempOrders } from './helpers.ts';

test('state files are written through a temp file and leave nothing behind', () => {
  const { orders, dir } = tempOrders('files');
  const state = path.join(dir, 'state');
  orders.add({ tag: 'T1', title: 'one', kind: 'sim' });
  orders.act('T1', 'queue');
  assert.deepEqual(readdirSync(state).sort(), ['T1.json', 'events.jsonl']);
  assert.equal(JSON.parse(readFileSync(path.join(state, 'T1.json'), 'utf8')).actions.length, 1);
  assert.equal(orders.store.events({ tag: 'T1' }).length, 2);
});

test('a failed write keeps the old file and removes the temp file', () => {
  const { dir } = tempOrders('files');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'a.json');
  writeFileAtomic(file, '{"v":1}');
  // the destination is a directory, so the final rename fails
  const blocked = path.join(dir, 'b.json');
  mkdirSync(blocked);
  assert.throws(() => writeFileAtomic(blocked, 'x'));
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
  assert.equal(readFileSync(file, 'utf8'), '{"v":1}');
  writeFileAtomic(file, '{"v":2}');
  assert.equal(readFileSync(file, 'utf8'), '{"v":2}');
});

test('store: unsafe tags are refused, listing skips meta files, case-insensitive lookup', () => {
  const { orders, dir } = tempOrders('files');
  const store = new FileStore(path.join(dir, 'state'));
  assert.throws(() => store.read('../x'), /Invalid order tag/);
  orders.add({ tag: 'Ab1', title: 'x', kind: 'k' });
  orders.store.writeMeta('table', { a: 1 });
  assert.deepEqual(orders.store.tags(), ['Ab1']);
  assert.equal(orders.get('ab1').order.tag, 'Ab1');
  assert.throws(() => orders.add({ tag: 'AB1', title: 'y', kind: 'k' }), /already exists/);
  assert.ok(existsSync(path.join(dir, 'state', '_table.json')));
  writeFileSync(path.join(dir, 'state', 'stray.txt'), '');
  assert.deepEqual(orders.store.tags(), ['Ab1']);
});
