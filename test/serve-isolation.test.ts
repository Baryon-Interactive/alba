import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { Orders } from '../src/orders/service.ts';
import { producerSessionStatus } from '../src/producer/session.ts';
import { producerState } from '../src/producer/producer.ts';
import { lockHolder, acquireLock, lockFile } from '../src/serve/lock.ts';
import { startServe } from '../src/serve/serve.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { probes } from './isolation-probes.ts';
import { openStream } from './helpers.ts';
import { formToken } from '../src/web/auth.ts';
import { WorkerChannel } from '../src/serve/channel.ts';

function fixture() {
  mkdirSync('.alba', { recursive: true });
  const root = mkdtempSync(path.resolve('.alba/serve-isolation-'));
  return validateProject({ id: 'fixture', name: 'Fixture', root, work_orders: root, state_dir: path.join(root, 'state'), state: { backend: 'sqlite' } }, path.join(root, 'project.yaml'));
}

test('first producer/session reads remain WAL readers while another connection holds the writer lock', () => {
  const project = fixture();
  const writer = new SqliteStore(project.state_dir);
  const reader = stateStore(project) as SqliteStore;
  reader.db.exec('PRAGMA busy_timeout=20');
  writer.db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(reader.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    assert.deepEqual(producerState(project).cases, []);
    assert.equal(producerSessionStatus(project).state, 'disabled');
  } finally { writer.db.exec('ROLLBACK'); writer.close(); }
});

test('serve locks reject a reused live pid across boot and within the same boot', () => {
  const project = fixture(), state = project.state_dir;
  mkdirSync(state, { recursive: true });
  const started = Date.parse('2026-01-02T12:00:00Z');
  const info = { pid: 123, started: new Date(started).toISOString() };
  const write = () => writeFileSync(lockFile(state), JSON.stringify(info));
  write();
  assert.equal(lockHolder(state, () => true, { bootTime: () => started + 1000, processStartedAt: () => undefined }), undefined);
  write();
  const reused = { bootTime: () => started - 10000, processStartedAt: () => started + 1 };
  assert.equal(lockHolder(state, () => true, reused), undefined);
  const release = acquireLock(state, { pid: 456, started: new Date(started + 2000).toISOString() }, () => true, reused);
  release();
  write();
  assert.equal(lockHolder(state, () => true, { bootTime: () => started - 10000, processStartedAt: () => started - 1 })?.pid, 123);
  assert.equal(lockHolder(state, () => true, { bootTime: () => started - 10000, processStartedAt: () => undefined })?.pid, 123);
});

test('background ticks coalesce, preserve SSE, and share their writer with manual API ticks', async () => {
  const project = fixture();
  project.dispatch.min_free_ram_gb = 0;
  new Orders(stateStore(project)).add({ tag: 'T1', title: 'One', kind: 'code' });
  const workers = validateWorkers({ workers: [{ id: 'fixture', engine: 'x', enabled: false }] }, 'fixture.yaml');
  const messages: string[] = [];
  const serve = startServe({ projects: [project], workers, probes, probesModule: new URL('./isolation-probes.ts', import.meta.url).href, port: 0, everyMinutes: 0, maxDispatch: 0, print: line => messages.push(line), eventMs: 60_000, watchMs: 60_000, reloadConfigs: false });
  await new Promise<void>(resolve => serve.server.once('listening', resolve));
  const base = `http://127.0.0.1:${(serve.server.address() as { port: number }).port}`;
  const key = { 'x-alba-token': serve.board.ctx.token };
  const stream = await openStream(base, 'project=fixture', key);
  try {
    assert.equal((await stream.next()).event, 'hello');
    // Warm module startup independently of the responsiveness assertion.
    assert.equal((await fetch(base + '/api/projects', { headers: key })).status, 200);
    serve.tickNow('schedule'); serve.tickNow('event'); serve.tickNow('start');
    const start = performance.now();
    const session = await (await fetch(base + '/api/session', { headers: key })).json() as { eventLoopDelay: { p99Ms: number } };
    assert.ok(performance.now() - start < 200, 'HTTP must answer during the 200 ms fake gather');
    assert.ok(session.eventLoopDelay.p99Ms < 50);
    const manual = await fetch(base + '/api/tick', { method: 'POST', headers: { ...key, 'content-type': 'application/json' }, body: JSON.stringify({ project: 'fixture', real: true, maxDispatch: 0 }) });
    assert.equal(manual.status, 200, await manual.text());
    for (let i = 0; i < 20 && !messages.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(messages.length, 1, 'overlapping timer requests coalesce into one tick');
    let completed = false;
    for (let i = 0; i < 8 && !completed; i++) completed = (await stream.next()).event === 'tick.done';
    assert.ok(completed, 'completed worker ticks are published by the main hub');
    assert.ok(serve.board.ctx.tickResults?.fixture.report, 'completed tick facts reach the overview reader');
    const overview = await (await fetch(base + '/api/overview/all', { headers: key })).json() as { machine?: { minFreeRamGb?: number } };
    assert.equal(overview.machine?.minFreeRamGb, 0, 'completed tick facts retain overview machine limits');
    assert.equal((await fetch(base + '/api/projects', { headers: { ...key, origin: 'https://invalid.example' } })).status, 403);
    const legacy = await fetch(base + '/legacy/o/fixture/T1', { headers: key });
    assert.equal(legacy.status, 200);
    const html = await legacy.text();
    assert.match(html, /One/);
    // the page is rendered in the read worker: its forms carry the main server's form token, and never the key
    assert.ok(html.includes(formToken(serve.board.ctx.token)), 'legacy forms carry the main server form token');
    assert.ok(!html.includes(serve.board.ctx.token), 'the page holds no key');
  } finally { stream.close(); serve.stop(); }
});

test('a failed worker rejects queued and future requests instead of leaving HTTP callers waiting', async () => {
  const channel = new WorkerChannel(new URL('./missing-serve-worker.ts', import.meta.url), {});
  try {
    await assert.rejects(channel.call('read', {}), /Cannot find|not found/);
    await assert.rejects(channel.call('read', {}), /Cannot find|not found|exited/);
  } finally { await channel.close(); }
});
