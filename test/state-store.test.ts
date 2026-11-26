import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Orders } from '../src/orders/service.ts';
import { FileStore } from '../src/orders/store.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { checkState, exportState, migrateState } from '../src/orders/state.ts';
import { tmpDir } from './tmp.ts';

function tmp(): string { return tmpDir('alba-state-'); }

test('migrate imports files, preserves equality, and export round-trips', () => {
  const dir = tmp();
  const files = new Orders(new FileStore(dir));
  files.add({ tag: 'T1', title: 'one', kind: 'sim' });
  files.act('T1', 'queue');
  files.store.writeMeta('table', { fingerprint: 'x' });
  const before = files.store.read('T1');
  const migrated = migrateState(dir);
  assert.equal(migrated.from.orders, 1);
  const sqlite = new SqliteStore(dir);
  try { assert.deepEqual(sqlite.read('T1'), before); } finally { sqlite.close(); }
  const out = path.join(dir, 'exported');
  assert.equal(exportState(dir, out).orders, 1);
  assert.deepEqual(new FileStore(out).read('T1'), before);
  assert.deepEqual(checkState(dir), { ok: true, orders: 1, events: 2, meta: 1, 'quota-history': 0, integrity: 'ok' });
});

test('migrate refuses a live serve lock', () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'serve.lock'), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  assert.throws(() => migrateState(dir), /holds/);
});

test('migration dry-run does not create a database and export can be re-imported', () => {
  const dir = tmp();
  const files = new Orders(new FileStore(dir));
  files.add({ tag: 'T1', title: 'one', kind: 'sim' });
  const preview = migrateState(dir, { dryRun: true });
  assert.equal(preview.from.orders, 1);
  assert.equal(existsSync(path.join(dir, 'state.sqlite')), false);
  const migrated = migrateState(dir);
  const out = path.join(dir, 'roundtrip');
  exportState(dir, out);
  const imported = new FileStore(out);
  const sqlite = new SqliteStore(dir);
  try { assert.deepEqual(imported.read('T1'), sqlite.read('T1')); } finally { sqlite.close(); }
  assert.match(readFileSync(path.join(out, 'events.jsonl'), 'utf8'), /order-added/);
  assert.ok(migrated.backup);
});

test('schema migration is recorded once', () => {
  const dir = tmp();
  const a = new SqliteStore(dir); a.close();
  const b = new SqliteStore(dir);
  assert.deepEqual(b.db.prepare('SELECT version FROM schema_version').all().map(row => row.version), [1, 2, 3, 4, 5, 6]);
  b.close();
  assert.ok(existsSync(path.join(dir, 'state.sqlite')));
});
