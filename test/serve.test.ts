import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadProject } from './state-helper.ts';
import { Orders } from '../src/orders/service.ts';
import { testStore } from './state-helper.ts';
import { acquireLock, lockFile, lockHolder } from '../src/serve/lock.ts';
import { startServe, type Serve } from '../src/serve/serve.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { openStream, tempOrders } from './helpers.ts';
import { readStateJson, writeStateFile } from '../src/orders/state-files.ts';
import { producerSession, producerSessionHeartbeatProblem, type SessionEngine, type SessionEvent } from '../src/producer/session.ts';

const BLOCK = '--- alba-report ---\n{"status":"ready","summary":"done","question":"","evidence":[],"commits":[]}\n--- end ---\n';

const started: Serve[] = [];
after(() => { for (const s of started) s.stop(); });

test('serve recovers a lost owner only on the next wake, sending one recovery handoff before cards', async () => {
  const { config } = project();
  config.producer.enabled = true;
  config.producer.session.enabled = true;
  config.producer.session.cli = process.execPath; // even a regression cannot launch a model
  const stale = { state: 'running', pid: 2147483000, turns: 2, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  writeStateFile(config, '_producer-session.json', JSON.stringify(stale));
  const probes = { now: () => new Date(), isAlive: () => false, tail: () => '', head: () => '', readText: () => undefined, fileTime: () => undefined, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: () => { throw new Error('No model or worker may start'); } } as unknown as Probes;
  const workers = validateWorkers({ workers: [{ id: 'fixture', engine: 'x', enabled: false }] }, 'w.yaml');
  let engineStarts = 0;
  const batches: string[][] = [];
  let finishRecovery!: (event: SessionEvent) => void;
  const result = new Promise<SessionEvent>(resolve => { finishRecovery = resolve; });
  const engine: SessionEngine = {
    async start() { engineStarts++; }, async sendBatch(messages) { batches.push(messages); },
    async *readEvents() { yield await result; await new Promise(() => {}); },
    async stop() {}, usage: () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
  };
  const manager = producerSession(config, new Orders(testStore(config.state_dir)), () => engine, probes);
  const serve = startServe({ projects: [config], workers, port: 0, probes, everyMinutes: 0, maxDispatch: 0, print: () => {}, reloadConfigs: false });
  started.push(serve);
  const status = () => manager.status();
  assert.equal(status().state, 'stopped');
  assert.equal(status().recovery?.cause, 'host-restart');
  assert.equal(engineStarts, 0);
  assert.equal(producerSessionHeartbeatProblem(config), undefined);
  serve.tickNow('schedule');
  assert.equal(engineStarts, 0);
  const tick = serve.board.ctx.snapshot().projects[0].tick;
  assert.ok(tick);
  assert.ok(!tick.problems.some(p => /session heartbeat is stale/.test(p.text)));
  const card = { id: 'question', key: 'question/DEMO', project: config.id, trigger: 'question', status: 'open' as const, revision: 1, openedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), facts: {}, card: { trigger: 'question', summary: 'Choose a layout', pointers: [], untrusted: [] } };
  await manager.onPass([card]);
  assert.equal(engineStarts, 1);
  assert.match(batches[0][0], /stopped unexpectedly/);
  assert.equal(batches.length, 1);
  assert.equal(status().ownerPid, process.pid);
  assert.ok(status().ownerStartedAt);
  finishRecovery({ type: 'result', text: 'Ready to read the open cases.' });
  for (let i = 0; i < 50 && batches.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(batches[1][0], /New or changed open producer cards/);
  assert.equal(engineStarts, 1);
  await manager.stop();
  writeStateFile(config, '_producer-session.json', JSON.stringify(stale));
  serve.tickNow('schedule');
  assert.equal(status().state, 'stopped');
  config.producer.session.enabled = false;
  writeStateFile(config, '_producer-session.json', JSON.stringify(stale));
  serve.tickNow('schedule');
  assert.equal(status().state, 'stopped');
  serve.stop();
  writeStateFile(config, '_producer-session.json', JSON.stringify(stale));
  const next = startServe({ projects: [config], workers, port: 0, probes, everyMinutes: 0, maxDispatch: 0, print: () => {}, reloadConfigs: false });
  started.push(next);
  assert.equal(status().state, 'stopped');
});

test('CLI session start with live serve uses its coordinator and creates no detached owner', async () => {
  const { config, file } = project();
  config.producer.enabled = true; config.producer.session.enabled = true;
  // The CLI reads the same enabled configuration as serve.
  writeFileSync(file, 'id: demo\nname: Demo\nroot: game\nwork_orders: orders\nstate_dir: state\nproducer:\n  enabled: true\n  session:\n    enabled: true\n');
  let starts = 0;
  const engine: SessionEngine = {
    async start() { starts++; }, async sendBatch() {}, async *readEvents() { await new Promise(() => {}); },
    async stop() {}, usage: () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
  };
  const manager = producerSession(config, new Orders(testStore(config.state_dir)), () => engine);
  const probes = { now: () => new Date(), isAlive: () => false, tail: () => '', head: () => '', readText: () => undefined, fileTime: () => undefined, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: () => { throw new Error('No detached worker'); } } as unknown as Probes;
  const serve = startServe({ projects: [config], workers: validateWorkers({ workers: [{ id: 'fixture', engine: 'x', enabled: false }] }, 'workers.yaml'), port: 0, probes, everyMinutes: 0, maxDispatch: 0, print: () => {}, reloadConfigs: false });
  started.push(serve);
  await new Promise<void>(resolve => serve.server.once('listening', resolve));
  assert.equal(lockHolder(config.state_dir)?.port, (serve.server.address() as AddressInfo).port);
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli', 'main.ts');
  for (let i = 0; i < 2; i++) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'producer', 'session', 'start', '--project', file], { encoding: 'utf8' });
    const status = JSON.parse(stdout);
    assert.equal(status.state, 'running'); assert.equal(status.ownerPid, process.pid); assert.equal(status.pid, undefined);
    assert.equal(status.ownerStartedAt, manager.status().ownerStartedAt);
  }
  assert.equal(starts, 1);
  await manager.stop();
  serve.stop();
});

function project() {
  const { dir } = tempOrders();
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  mkdirSync(path.join(dir, 'game'), { recursive: true });
  writeFileSync(path.join(dir, 'workers.yaml'), 'workers:\n  - id: coder\n    engine: x\n');
  writeFileSync(path.join(dir, 'alba.yaml'), 'id: demo\nname: Demo\nroot: game\nwork_orders: orders\nstate_dir: state\n');
  return { dir, file: path.join(dir, 'alba.yaml'), config: loadProject(path.join(dir, 'alba.yaml')) };
}

test('serve keeps listening and logs a lock publication failure', async () => {
  const { config } = project();
  const probes = { now: () => new Date(), isAlive: () => false, tail: () => '', head: () => '', readText: () => undefined, fileTime: () => undefined, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: () => 1 } as unknown as Probes;
  const printed: string[] = [];
  const serve = startServe({ projects: [config], workers: validateWorkers({ workers: [{ id: 'fixture', engine: 'x', enabled: false }] }, 'workers.yaml'), port: 0, probes, everyMinutes: 0, maxDispatch: 0, print: line => printed.push(line), reloadConfigs: false });
  started.push(serve);
  const file = lockFile(config.state_dir), original = readFileSync(file, 'utf8');
  // An unreadable lock at publication time must not escape the listening callback.
  writeFileSync(file, 'invalid fixture lock');
  try {
    await new Promise<void>(resolve => serve.server.once('listening', resolve));
    assert.ok(printed.some(line => /serve lock port update failed/.test(line)));
    const response = await fetch(`http://127.0.0.1:${(serve.server.address() as AddressInfo).port}/api/session`, { headers: { 'x-alba-token': serve.board.ctx.token } });
    assert.equal(response.status, 200);
    assert.equal(readFileSync(file, 'utf8'), 'invalid fixture lock');
  } finally {
    writeFileSync(file, original);
    serve.stop();
  }
});

test('lock: one holder per state folder; a lock of a dead process is taken over; giving it back removes it', () => {
  const { dir } = tempOrders();
  const state = path.join(dir, 'state');
  const alive = new Set([100, 200]);
  const isAlive = (pid: number) => alive.has(pid);
  assert.equal(lockHolder(state, isAlive), undefined);
  const release = acquireLock(state, { pid: 100, started: 't1' }, isAlive);
  assert.equal(lockHolder(state, isAlive)?.pid, 100);
  assert.throws(() => acquireLock(state, { pid: 200, started: 't2' }, isAlive), /already served by alba serve \(pid 100, since t1\)/);
  release();
  assert.ok(!existsSync(lockFile(state)));
  // a crashed serve leaves its file behind: the next one takes over
  acquireLock(state, { pid: 100, started: 't1' }, isAlive);
  alive.delete(100);
  assert.equal(lockHolder(state, isAlive), undefined);
  const again = acquireLock(state, { pid: 200, started: 't3' }, isAlive);
  assert.equal(lockHolder(state, isAlive)?.pid, 200);
  again();
  // giving back a lock that someone else took over does not remove theirs
  const mine = acquireLock(state, { pid: 100, started: 't4' }, () => false);
  const theirs = acquireLock(state, { pid: 200, started: 't5' }, () => false);
  mine();
  assert.ok(existsSync(lockFile(state)));
  theirs();
});

test('a scheduled tick finds the lock, records one line and skips; without a lock it runs', () => {
  const { dir, file } = project();
  const main = path.join(import.meta.dirname, '..', 'src', 'cli', 'main.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', main, '--project', file, '--workers', path.join(dir, 'workers.yaml'), ...args], { encoding: 'utf8' });
  writeFileSync(path.join(dir, 'state-lock-holder'), '');
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  writeFileSync(lockFile(path.join(dir, 'state')), JSON.stringify({ pid: process.pid, started: 'now' }));   // this test process is alive
  const skipped = run('tick');
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /tick skipped: alba serve \(pid \d+\) holds this state folder/);
  const events = testStore(path.join(dir, 'state')).events();
  assert.deepEqual(events.map(e => [e.tag, e.type]), [['*', 'tick-skipped']]);
  // a dry run is not a tick that writes: it goes ahead
  assert.match(run('tick', '--dry-run').stdout, /alba tick \(dry run\)/);
  writeFileSync(lockFile(path.join(dir, 'state')), JSON.stringify({ pid: 2147483000, started: 'long ago' }));    // a process that is not there
  assert.match(run('tick').stdout, /alba tick/);
  assert.ok(!/skipped/.test(run('tick').stdout));
});

test('serve: two serves cannot share a state folder; the second one can start after the first stopped', () => {
  const { config } = project();
  const probes = { now: () => new Date(), isAlive: () => false, tail: () => '', head: () => '', readText: () => undefined, fileTime: () => undefined, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: () => 1 } as unknown as Probes;
  const options = { projects: [config], workers: validateWorkers({ workers: [{ id: 'coder', engine: 'x' }] }, 'w.yaml'), port: 0, probes, everyMinutes: 0, maxDispatch: 1, print: () => {} };
  const first = startServe(options);
  started.push(first);
  assert.throws(() => startServe(options), /already served by alba serve/);
  assert.ok(existsSync(lockFile(config.state_dir)));
  first.stop();
  assert.ok(!existsSync(lockFile(config.state_dir)));
  const second = startServe(options);
  started.push(second);
});

test('serve: when the process of a run ends its end is recorded at once and a tick follows soon', async () => {
  const { dir, config } = project();
  const orders = new Orders(testStore(config.state_dir));
  orders.add({ tag: 'T1', title: 'Thing', kind: 'k' });
  orders.act('T1', 'queue');
  const last = path.join(dir, 'orders', 'T1.last.txt');
  orders.runStart('T1', { worker: 'coder', extra: { pid: 4242, log: path.join(dir, 'T1.log'), last_file: last } });
  let alive = true;
  const printed: string[] = [];
  const probes = {
    now: () => new Date(), isAlive: () => alive, tail: () => '', head: () => '', readText: (f: string) => (f === last ? BLOCK : undefined), fileTime: (f: string) => (f === last ? new Date(Date.now() + 5000).toISOString() : undefined),
    runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: () => 1,
  } as unknown as Probes;
  const serve = startServe({ projects: [config], workers: validateWorkers({ workers: [{ id: 'coder', engine: 'x' }] }, 'w.yaml'), port: 0, probes, everyMinutes: 0, maxDispatch: 1, print: l => printed.push(l), watchMs: 20, followUpMs: 60 });
  started.push(serve);
  await new Promise<void>(resolve => serve.server.once('listening', resolve));
  const s = await openStream(`http://127.0.0.1:${(serve.server.address() as AddressInfo).port}`, 'project=demo', { 'x-alba-token': serve.board.ctx.token });
  assert.equal((await s.next()).event, 'hello');
  assert.equal(new Orders(testStore(config.state_dir)).stage(new Orders(testStore(config.state_dir)).get('T1')).stage, 'running');

  alive = false;
  const names: string[] = [];
  let tickSource = '';
  for (let i = 0; i < 8 && !tickSource; i++) {
    const m = await s.next(5000);
    names.push(m.event);
    if (m.event === 'tick.done') tickSource = m.data.source;
  }
  assert.ok(names.indexOf('run.end') >= 0 && names.indexOf('run.end') < names.indexOf('tick.done'), names.join(','));   // the end is recorded before the tick
  assert.equal(tickSource, 'finish');
  const fresh = new Orders(testStore(config.state_dir));
  assert.equal(fresh.stage(fresh.get('T1')).stage, 'awaiting-review');
  assert.equal(fresh.store.events({ tag: 'T1' }).find(e => e.type === 'run-end')?.by, 'serve');
  assert.ok(printed.some(l => /T1: run r1 ended: completed/.test(l)));
  s.close();
});

test('foreground ticks flush durable run events before publishing completion without a watcher turn', async () => {
  const { dir, config } = project();
  const orders = new Orders(testStore(config.state_dir));
  orders.add({ tag: 'T1', title: 'Thing', kind: 'k' }); orders.act('T1', 'queue');
  const last = path.join(dir, 'orders', 'T1.last.txt');
  orders.runStart('T1', { worker: 'coder', extra: { pid: 4242, last_file: last } });
  let alive = true;
  const probes = { now: () => new Date(), isAlive: () => alive, tail: () => '', head: () => '',
    readText: (file: string) => file === last ? BLOCK : undefined,
    fileTime: (file: string) => file === last ? new Date(Date.now() + 5000).toISOString() : undefined,
    runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: () => 1,
  } as unknown as Probes;
  const serve = startServe({ projects: [config], workers: validateWorkers({ workers: [{ id: 'coder', engine: 'x' }] }, 'w.yaml'),
    port: 0, probes, everyMinutes: 0, maxDispatch: 0, print: () => {}, watchMs: 60000, eventMs: 60000, hubCheckMs: 60000 });
  started.push(serve);
  await new Promise<void>(resolve => serve.server.once('listening', resolve));
  const stream = await openStream(`http://127.0.0.1:${(serve.server.address() as AddressInfo).port}`, 'project=demo', { 'x-alba-token': serve.board.ctx.token });
  assert.equal((await stream.next()).event, 'hello');
  try {
    alive = false;
    assert.equal(serve.recordEnds(), 1);
    serve.tickNow('finish'); // Synchronous: no watcher or polling callback has run between these calls.
    const events: string[] = [];
    for (let i = 0; i < 8 && !events.includes('tick.done'); i++) events.push((await stream.next(5000)).event);
    assert.ok(events.includes('run.end'), events.join(','));
    assert.ok(events.indexOf('run.end') < events.indexOf('tick.done'), events.join(','));
  } finally { stream.close(); }
});
