import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { stateStore, closeStateStores } from '../src/orders/backend.ts';
import { appendStateFile } from '../src/orders/state-files.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { migrateState, exportState } from '../src/orders/state.ts';
import { Orders } from '../src/orders/service.ts';
import { validateProject } from '../src/config.ts';
import { readQuotaHistory, readTickQuotaHistory, tick, type Probes } from '../src/tick/gather.ts';
import { balanceDrop, type QuotaReading } from '../src/workers/quota.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { balanceChange, workersPage } from '../src/web/html.ts';
import { Hub } from '../src/api/hub.ts';
import { tmpDir } from './tmp.ts';

const dirs: string[] = [];
const tmp = () => { const dir = tmpDir('alba-quota-'); dirs.push(dir); return dir; };
after(() => { closeStateStores(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const reading = (n: number, source = 'q'): QuotaReading => ({ source, at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), ok: true, windows: [], entries: 1, balance: { raw: String(1000 - n), amount: 1000 - n } });
const jsonl = (values: QuotaReading[]) => values.map(q => JSON.stringify(q) + '\n').join('');

test('three recorded SQLite ticks insert 3 x n readings without touching metadata', () => {
  const dir = tmp();
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: dir, state: { backend: 'sqlite' } }, path.join(dir, 'alba.yaml'));
  const store = stateStore(project) as SqliteStore;
  store.writeMeta('sentinel', { keep: true });
  store.db.exec(`CREATE TRIGGER no_meta_insert BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'meta insert'); END;
    CREATE TRIGGER no_meta_update BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'meta update'); END;
    CREATE TRIGGER no_meta_delete BEFORE DELETE ON meta BEGIN SELECT RAISE(ABORT, 'meta delete'); END;`);
  const workers = validateWorkers({ workers: [{ id: 'a', engine: 'x', quota: 'q' }, { id: 'b', engine: 'x', quota: 'r' }], quota_sources: { q: { type: 'static', windows: [] }, r: { type: 'static', windows: [] } } }, 'workers.yaml');
  let n = 0;
  const probes = { now: () => new Date(reading(++n).at), worktrees: () => [] } as unknown as Probes;
  for (let i = 1; i <= 3; i++) {
    tick(project, new Orders(store), workers, probes, { record: true });
    assert.equal(store.counts()['quota-history'], i * 2);
  }
  assert.deepEqual(store.readMeta('sentinel'), { keep: true });
  assert.equal(store.counts().meta, 1);
  assert.equal(existsSync(path.join(dir, 'quota-history.jsonl')), false);
});

test('quota migrate, backup, export and re-import preserve readings and counts', () => {
  const dir = tmp();
  const values = [reading(1), reading(2, 'r'), reading(3)];
  writeFileSync(path.join(dir, 'quota-history.jsonl'), jsonl(values));
  assert.equal(migrateState(dir, { dryRun: true }).from['quota-history'], 3);
  assert.equal(existsSync(path.join(dir, 'state.sqlite')), false);
  const result = migrateState(dir);
  assert.deepEqual(result.from, result.to);
  assert.equal(result.to['quota-history'], 3);
  assert.equal(existsSync(path.join(dir, 'quota-history.jsonl')), false);
  assert.equal(readFileSync(path.join(result.backup!, 'quota-history.jsonl'), 'utf8'), jsonl(values));
  assert.deepEqual(readQuotaHistory(dir), values);
  const out = path.join(dir, 'export');
  assert.equal(exportState(dir, out)['quota-history'], 3);
  assert.equal(readFileSync(path.join(out, 'quota-history.jsonl'), 'utf8'), jsonl(values));
  assert.deepEqual(migrateState(out).to, result.to);
  assert.deepEqual(readQuotaHistory(out), values);
});

test('schema 3 upgrades the old quota metadata exactly once', () => {
  const dir = tmp();
  const values = [reading(1), reading(2)];
  const old = new DatabaseSync(path.join(dir, 'state.sqlite'));
  old.exec(`CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1), (2);
    CREATE TABLE meta(name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  old.prepare('INSERT INTO meta VALUES (?, ?)').run('file:quota-history.jsonl', JSON.stringify(jsonl(values)));
  old.close();
  for (let i = 0; i < 2; i++) {
    const store = new SqliteStore(dir);
    try {
      assert.deepEqual(store.allQuotaHistory(), values);
      assert.equal(store.readMeta('file:quota-history.jsonl'), undefined);
      assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all().map(r => r.version), [1, 2, 3, 4, 5, 6]);
    } finally { store.close(); }
  }
});

test('bounded SQL history preserves balance rules and legacy board after failures, duplicates and out-of-order times', () => {
  const dir = tmp();
  const project = { state_dir: dir, state: { backend: 'sqlite' as const } };
  const current = reading(3000);
  const values = [reading(0), reading(1600), reading(2000), ...Array.from({ length: 1000 }, (_, i) => ({ ...reading(2001 + i), ok: false })), reading(1600), reading(3001)];
  appendStateFile(project, 'quota-history.jsonl', jsonl(values));
  const bounded = readTickQuotaHistory(project, [current], current.at);
  assert.ok(bounded.length <= 26);
  assert.deepEqual(balanceDrop(bounded, current), balanceDrop(values, current));
  assert.deepEqual(balanceChange(bounded, current, current.at), balanceChange(values, current, current.at));
  const workers = validateWorkers({ workers: [{ id: 'a', engine: 'x', quota: 'q' }], quota_sources: { q: { type: 'command-json', command: ['unused'] } } }, 'workers.yaml');
  const snapshot = (history: QuotaReading[]) => ({ at: current.at, workersFile: workers, projects: [{ config: { ...project, id: 'demo' } as any, rows: [], orders: new Orders(stateStore(project)), quotas: [current], history }] });
  assert.equal(workersPage(snapshot(bounded)), workersPage(snapshot(values)));
  assert.deepEqual(readQuotaHistory(project, { source: 'q', limit: 7 }), values.slice(-7));
  assert.equal(readQuotaHistory(project).length, 500);
  assert.deepEqual(readQuotaHistory(project, { source: 'absent' }), []);
});

test('hub scans SQLite quota IDs in bounded batches without reading old history or metadata', () => {
  const dir = tmp();
  const store = stateStore({ state_dir: dir, state: { backend: 'sqlite' } }) as SqliteStore;
  store.appendQuotaReading(reading(0));
  const hub = new Hub([{ id: 'demo', stateDir: dir }], { resolveLog: () => undefined });
  store.readMeta = () => { throw new Error('metadata must not be read'); };
  store.allQuotaHistory = () => { throw new Error('old history must not be read'); };
  const published: QuotaReading[] = [];
  hub.publish = ((_project: string, name: string, data: any) => { assert.equal(name, 'quota'); published.push(...data.points); return 1; }) as typeof hub.publish;
  store.transaction(() => { for (let i = 1; i <= 1001; i++) store.appendQuotaReading(reading(i)); });
  hub.scan(); assert.equal(published.length, 500);
  hub.scan(); assert.equal(published.length, 1000);
  hub.scan(); assert.equal(published.length, 1001);
  hub.scan(); assert.equal(published.length, 1001);
  assert.equal(published[0].at, reading(1).at);
});
