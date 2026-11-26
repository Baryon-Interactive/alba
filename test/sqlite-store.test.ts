import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { Orders } from '../src/orders/service.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { StaleWrite, type OrderStore } from '../src/orders/store.ts';
import { tmpDir } from './tmp.ts';

test('sqlite detects stale writes and preserves the winning document', () => {
  const dir = tmpDir('alba-sqlite-');
  const a = new SqliteStore(dir);
  const b = new SqliteStore(dir);
  try {
    new Orders(a).add({ tag: 'T1', title: 'one', kind: 'sim' });
    const first = a.read('T1')!;
    const second = b.read('T1')!;
    first.order.title = 'changed';
    a.write(first);
    second.order.kind = 'art';
    assert.throws(() => b.write(second), StaleWrite);
    assert.equal(b.read('T1')!.order.title, 'changed');
    assert.deepEqual(a.db.prepare('SELECT version FROM schema_version').all().map(r => r.version), [1, 2, 3, 4, 5, 6]);
    assert.equal(a.events({ tag: 'T1', limit: 1 }).length, 1);
  } finally { b.close(); a.close(); }
});

test('Orders retries the original update after a concurrent write', () => {
  const dir = tmpDir('alba-retry-');
  const a = new SqliteStore(dir);
  const b = new SqliteStore(dir);
  let once = true;
  const hooked = new Proxy(a, {
    get(target, property) {
      if (property === 'read') return (tag: string) => {
        const doc = target.read(tag);
        if (once && doc) { once = false; new Orders(b).update('T1', { kind: 'art' }); }
        return doc;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as OrderStore;
  try {
    new Orders(a).add({ tag: 'T1', title: 'one', kind: 'sim' });
    once = true;
    const changed = new Orders(hooked).update('T1', { title: 'changed' });
    assert.equal(changed.order.title, 'changed');
    assert.equal(changed.order.kind, 'art');
  } finally { b.close(); a.close(); }
});

test('Orders revalidates an action after a concurrent cancellation', () => {
  const dir = tmpDir('alba-retry-action-');
  const a = new SqliteStore(dir);
  const b = new SqliteStore(dir);
  let once = true;
  let stale = undefined as ReturnType<SqliteStore['read']>;
  const hooked = new Proxy(a, {
    get(target, property) {
      if (property === 'read') return (tag: string) => {
        if (once && stale) { once = false; return stale; }
        return target.read(tag);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as OrderStore;
  try {
    new Orders(a).add({ tag: 'T1', title: 'one', kind: 'sim' });
    new Orders(a).report('T1', { status: 'ready', summary: 'ready', evidence: [], commits: [] });
    stale = a.read('T1');
    new Orders(b).act('T1', 'cancel');
    once = true;
    assert.throws(() => new Orders(hooked).act('T1', 'approve'), /cannot approve/);
    assert.equal(new Orders(a).stage(new Orders(a).get('T1')).stage, 'cancelled');
  } finally { b.close(); a.close(); }
});
