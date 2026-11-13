import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { sendJson } from '../src/web/response.ts';
import { fixture } from './api-fixture.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { writeStateFile } from '../src/orders/state-files.ts';

test('JSON compression negotiates encoding and weak validators return an empty 304', async () => {
  const value = { text: 'Repeated fixture content. '.repeat(200) };
  const server = createServer((_req, res) => sendJson(res, 200, value));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const get = (headers: Record<string, string>) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
  try {
    const plain = await get({});
    assert.match(String(plain.headers.etag), /^W\//);
    const gzip = await get({ 'accept-encoding': 'gzip' });
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(gunzipSync(gzip.body).toString()), value);
    const br = await get({ 'accept-encoding': 'gzip;q=0.5, br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.deepEqual(JSON.parse(brotliDecompressSync(br.body).toString()), value);
    assert.equal(br.headers.etag, plain.headers.etag);
    const unchanged = await get({ 'if-none-match': String(plain.headers.etag), 'accept-encoding': 'gzip' });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body.length, 0);
    assert.match(String(unchanged.headers.vary), /Accept-Encoding/);
    assert.equal((await get({ 'accept-encoding': 'br;q=0,gzip;q=0' })).headers['content-encoding'], undefined);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('order lists omit report payloads while detail retains the full report', async () => {
  const f = await fixture();
  f.orders.runEnd('W1');
  f.orders.report('W1', { status: 'monitoring', summary: 'Fixture monitor', evidence: [], commits: [], monitor: { check: ['fixture-check'], done_when: { file_exists: 'done.txt' }, deadline_minutes: 60 } });
  const list = await f.get('/api/orders?project=demo');
  assert.equal(list.status, 200);
  const text = JSON.stringify(list.body);
  assert.doesNotMatch(text, /"report"|"reports"|"routing"|"spend"|"live"/);
  assert.equal(list.body.items.find((item: { tag: string }) => item.tag === 'W1').monitor.spec, undefined);
  assert.equal((await f.get('/api/orders/W1?project=demo')).body.monitor.spec.check[0], 'fixture-check');
  const detail = await f.get('/api/orders/R1?project=demo');
  assert.equal(detail.status, 200);
  assert.match(JSON.stringify(detail.body), /did it/);
  assert.ok(list.body.items.every((item: { tag: string; title: string; stage: string }) => item.tag && item.title && item.stage));
});

test('projects cache refreshes immediately after an external order write and board invalidation', async t => {
  const f = await fixture({ populate: false });
  f.board.hub.stop(); // This test triggers the same invalidation explicitly, without the polling timer.
  const now = Date.now();
  t.mock.method(Date, 'now', () => now); // Keep every read inside the cache TTL.
  const initial = await f.get('/api/projects');
  assert.equal(initial.body[0].orderCount, 0);
  f.orders.add({ tag: 'A1', title: 'External order', kind: 'task' });
  f.orders.act('A1', 'queue');
  assert.deepEqual((await f.get('/api/projects')).body, initial.body);
  f.board.invalidate();
  const refreshed = await f.get('/api/projects');
  assert.equal(refreshed.body[0].orderCount, 1);
  assert.equal(refreshed.body[0].stages.queued, 1);
  f.orders.act('A1', 'hold');
  f.board.invalidate();
  const held = await f.get('/api/projects');
  assert.equal(held.body[0].stages.held, 1);
  assert.equal(held.body[0].stages.queued, undefined);
});

test('a new WAL reader opens and reads while another connection holds the writer lock', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'alba-reader-'));
  const writer = new SqliteStore(folder);
  writer.db.exec('BEGIN IMMEDIATE');
  let reader: SqliteStore | undefined;
  try {
    const start = performance.now();
    reader = new SqliteStore(folder);
    assert.ok(performance.now() - start < 300);
    assert.deepEqual(reader.all(), []);
    assert.equal(reader.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(reader.db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
  } finally { reader?.close(); writer.db.exec('ROLLBACK'); writer.close(); }
});

test('producer history and decisions are bounded pages without losing open cases or ledger entries', async () => {
  const f = await fixture({ populate: false, project: dir => {
    const ledger = path.join(dir, 'decisions.md');
    writeFileSync(ledger, '| ID | Text |\n| --- | --- |\n' + Array.from({ length: 150 }, (_, i) => `| D${i + 1} | ${'Fixture explanation. '.repeat(100)} |\n`).join(''));
    return { decisions: { file: ledger, all_tables: true, id_column: 1, text_column: 2 } };
  } });
  const at = new Date().toISOString();
  writeStateFile(path.join(f.dir, 'state'), '_producer-cases.json', JSON.stringify(Array.from({ length: 150 }, (_, i) => ({ id: `case-${i}`, key: `case-${i}`, project: 'demo', trigger: 'delivery', status: i < 6 ? 'open' : 'closed', revision: 1, openedAt: at, updatedAt: at, facts: { detail: 'Fixture evidence. '.repeat(100) }, card: { trigger: 'delivery', summary: 'Fixture summary. '.repeat(100), pointers: [], untrusted: [] } }))));
  const producer = (await f.get('/api/producer')).body;
  assert.ok(Buffer.byteLength(JSON.stringify(producer)) <= 60_000);
  assert.equal(producer.caseCount, 150);
  assert.equal(producer.cases.filter((c: { status: string }) => c.status === 'open').length, 6);
  assert.ok(producer.cases.filter((c: { status: string }) => c.status === 'closed').every((c: { facts: object; card: { summary: string } }) => !Object.keys(c.facts).length && c.card.summary.length <= 160));
  const next = (await f.get(`/api/producer?cursor=${producer.nextCursor}`)).body;
  assert.equal(new Set([...producer.cases, ...next.cases].map(c => c.id)).size, 150);
  writeStateFile(path.join(f.dir, 'state'), '_producer-actions.json', JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: `action-${i}`, at, status: 'would-do' }))));
  assert.equal((await f.get('/api/producer')).body.wouldDo.length, 50); // preserve the page's existing visible history
  let decisions = (await f.get('/api/decisions')).body;
  assert.ok(Buffer.byteLength(JSON.stringify(decisions)) <= 50_000);
  assert.equal(decisions.count, 150);
  const ids = new Set<string>(decisions.items.map((d: { id: string }) => d.id));
  while (decisions.nextCursor) {
    decisions = (await f.get(`/api/decisions?cursor=${decisions.nextCursor}`)).body;
    for (const entry of decisions.items) { assert.ok(!ids.has(entry.id)); ids.add(entry.id); }
  }
  assert.equal(ids.size, 150);
});

test('hashed static assets are compressed, immutable, and support HEAD', async () => {
  const uiDir = mkdtempSync(path.join(tmpdir(), 'alba-static-'));
  mkdirSync(path.join(uiDir, 'assets'));
  writeFileSync(path.join(uiDir, 'assets', 'index-abcdefgh.js'), 'export const value = 1;\n'.repeat(200));
  const f = await fixture({ populate: false, uiDir });
  const response = await fetch(`${f.base}/assets/index-abcdefgh.js`, { headers: { 'accept-encoding': 'gzip', connection: 'close' } });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.match(response.headers.get('cache-control')!, /immutable/);
  assert.match(await response.text(), /export const value/);
  const head = await fetch(`${f.base}/assets/index-abcdefgh.js`, { method: 'HEAD', headers: { 'accept-encoding': 'gzip', connection: 'close' } });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
