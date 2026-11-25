import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { tempOrders } from './helpers.ts';
import { startRun } from '../src/run/launch.ts';
import { findFinishes, LAUNCH_GRACE_MINUTES } from '../src/run/finish.ts';
import { launchedWithin, runProcessMatches, stopProcessTreeVerified, terminateThenKill, type ProcessInfo } from '../src/run/kill-tree.ts';
import { acquireLeases, readLeases, reconcileLeases } from '../src/resources/leases.ts';
import { bindEditor, dropEditor, editorPortProblem, editorSlots, reconcileEditors, takeEditor, type EditorSlot } from '../src/editors/pool.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { Orders } from '../src/orders/service.ts';
import { capacityUsage } from '../src/tick/capacity.ts';
import { planTick, type TickInput, type TickOrder } from '../src/tick/plan.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers, type WorkerConfig } from '../src/workers/config.ts';
import { removeTreeSync } from '../src/fs/remove-tree.mjs';
import { tmpDir } from './tmp.ts';

const repo = pathToFileURL(path.resolve(import.meta.dirname, '..') + '/').href;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repository with queued `ue` orders U1..U3 (cap 2) and S1 (`sim`); `extra` goes into the project. */
function fixture(extra: Record<string, unknown> = {}, uses?: string[]) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  for (const tag of ['U1', 'U2', 'U3', 'S1']) {
    writeFileSync(path.join(workOrders, `${tag}-work.md`), `# ${tag}\nWork.\n`);
    orders.add({ tag, title: `Work ${tag}`, kind: tag.startsWith('U') ? 'ue' : 'sim', ...(uses ? { uses } : {}) });
    orders.act(tag, 'queue');
  }
  const { dispatch, ...rest } = extra as { dispatch?: Record<string, unknown> };
  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main', caps: { ue: 2 }, ...dispatch }, ...rest,
  }, path.join(dir, 'alba.yaml'));
  return { orders, project, dir };
}

const probes = (over: Partial<Probes> = {}): Probes & { killed: unknown[][] } => {
  const killed: unknown[][] = [];
  return {
    killed, now: () => new Date('2026-01-01T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined,
    spawnDetached: () => 4242, kill: (...args: unknown[]) => { killed.push(args); return [4242]; }, ...over,
  };
};

const workers = () => validateWorkers({
  workers: [{ id: 'coder', engine: 'codex-cli', launch: { template: 'coder-v1', program: 'coder', args: ['exec', '-C', '{cwd}', '-o', '{last_file}', 'Read the UTF-8 file {prompt_file} in full and follow it exactly.'] } }],
}, 'w.yaml');

/** A script another process runs: it opens a run of `tag` (and takes its leases) on the same state, as a concurrent start does. */
function concurrentStart(dir: string): string {
  const file = path.join(dir, 'concurrent-start.mjs');
  writeFileSync(file, `
const [repo, projectJson, tag] = process.argv.slice(2);
const { Orders } = await import(new URL('src/orders/service.ts', repo));
const { stateStore } = await import(new URL('src/orders/backend.ts', repo));
const { stateTransaction } = await import(new URL('src/orders/state-files.ts', repo));
const { acquireLeases } = await import(new URL('src/resources/leases.ts', repo));
const project = JSON.parse(projectJson);
const orders = new Orders(stateStore(project));
try {
  stateTransaction(project, () => { const { run } = orders.runStart(tag, { worker: 'coder' }); if (project.resources) acquireLeases(project, orders, orders.get(tag), run.id, new Date()); });
  process.stdout.write('started');
} catch (e) { process.stdout.write('refused: ' + e.message); }
`);
  return file;
}

test('R-2: a start whose cap slot another start took meanwhile is refused when the run is recorded, and nothing is written', () => {
  const { orders, project, dir } = fixture();
  const script = concurrentStart(dir);
  // U3's provision step (after the first check, before the run is recorded) lets another process start U2: the last `ue` slot.
  project.dispatch.provision = [process.execPath, script, repo, JSON.stringify({ state_dir: project.state_dir, state: project.state, work_orders: project.work_orders }), 'U2'];
  const ctx = { project, orders, workers: workers(), probes: probes() };
  startRun(ctx, 'U1', 'coder', { capsChecked: true });
  assert.throws(() => startRun(ctx, 'U3', 'coder', { capsChecked: true }), /U3 cannot start now: cap for "ue" is full \(2\/2: U1, U2\)/);
  assert.equal(orders.get('U2').runs.length, 1);
  assert.equal(orders.get('U3').runs.length, 0);
  assert.equal(orders.get('U3').order.branch, undefined, 'the order is not changed either');
  assert.equal(orders.all().filter(d => d.runs.some(r => !r.ended)).length, 2);
});

test('R-2: the resource check and the lease are taken with the run record, before the process is spawned', () => {
  const { orders, project } = fixture({ resources: { disk: { slots: 1 } } }, ['disk']);
  let leasesAtSpawn: string[] = [];
  const ctx = { project, orders, workers: workers(), probes: probes({ spawnDetached: () => { leasesAtSpawn = readLeases(project).map(l => `${l.tag}:${l.resource}:${l.run}`); return 4242; } }) };
  startRun(ctx, 'S1', 'coder');
  assert.deepEqual(leasesAtSpawn, ['S1:disk:r1']);
  assert.throws(() => startRun(ctx, 'U1', 'coder'), /U1 cannot start now: resource disk is full \(1\/1, held by S1\)/);
});

test('R-3: a step after the spawn that fails stops the process, ends the run as failed and gives its leases back', () => {
  const { orders, project } = fixture({ resources: { disk: { slots: 1 } } }, ['disk']);
  const p = probes({ processStartedAt: () => { throw new Error('state busy'); } });
  assert.throws(() => startRun({ project, orders, workers: workers(), probes: p }, 'S1', 'coder'), /state busy/);
  const run = orders.get('S1').runs[0];
  assert.equal(run.outcome, 'failed');
  assert.deepEqual(p.killed, [[4242, undefined, run.started]], 'the whole tree, identified by the run\'s launch window');
  assert.deepEqual(readLeases(project), []);
});

test('R-3: an open run Alba started that never got a pid ends after the grace period; a run a person opened by hand does not', () => {
  const { orders, project } = fixture();
  const opened = orders.runStart('S1', { worker: 'coder', extra: { prompt_file: 'p.md', log: 'l.log' } }).run;
  orders.runStart('U1', { worker: 'coder' });
  const at = (minutes: number) => probes({ now: () => new Date(Date.parse(opened.started) + minutes * 60000) });
  assert.deepEqual(findFinishes(project, orders, at(LAUNCH_GRACE_MINUTES - 1)), []);
  const ended = findFinishes(project, orders, at(LAUNCH_GRACE_MINUTES + 1));
  assert.deepEqual(ended.map(f => [f.tag, f.run, f.outcome, f.report?.status]), [['S1', 'r1', 'failed', 'failed']]);
  assert.match(ended[0].why, /no process was recorded for the run within 10 min of its start/);
});

test('R-3/R-7: a live pid created outside the run\'s launch window is not its process (the pid was reused), so the run ends', () => {
  const { orders, project } = fixture();
  const run = orders.runStart('S1', { worker: 'coder', extra: { pid: 777, log: 'l.log', prompt_file: 'p.md' } }).run;
  const later = (ms: number) => probes({ processStartedAt: () => new Date(Date.parse(run.started) + ms).toISOString() });
  assert.deepEqual(findFinishes(project, orders, later(5000)), []);
  assert.deepEqual(findFinishes(project, orders, later(3600_000)).map(f => f.tag), ['S1']);
});

test('R-6: reconciling leases is one transaction: a start of the same order meanwhile waits and is never released from under it', () => {
  const { orders, project, dir } = fixture({ resources: { disk: { slots: 2 } } }, ['disk']);
  const first = orders.runStart('S1', { worker: 'coder' }).run;
  acquireLeases(project, orders, orders.get('S1'), first.id, new Date());
  orders.runEnd('S1');
  const script = concurrentStart(dir);
  const all = orders.all.bind(orders);
  let raced = '';
  // The first read of the orders inside the reconcile: another process tries to start S1 right then.
  (orders as unknown as { all: () => ReturnType<Orders['all']> }).all = () => {
    if (!raced) raced = spawnSync(process.execPath, [script, repo, JSON.stringify({ state_dir: project.state_dir, state: project.state, work_orders: project.work_orders, resources: project.resources }), 'S1'], { encoding: 'utf8', timeout: 60000 }).stdout || 'no answer';
    return all();
  };
  assert.deepEqual(reconcileLeases(project, orders, new Date()), ['S1: released disk (the order is no longer running)']);
  assert.match(raced, /^refused: /, 'the other start waited for the state lock and gave up');
  const doc = orders.get('S1');
  assert.equal(doc.runs.some(r => !r.ended), false);
  assert.deepEqual(readLeases(project), []);
  // Had it started, its run would hold its lease: an open run never loses it.
  const again = orders.runStart('S1', { worker: 'coder' }).run;
  acquireLeases(project, orders, orders.get('S1'), again.id, new Date());
  assert.deepEqual(reconcileLeases(project, orders, new Date()), []);
  assert.deepEqual(readLeases(project).map(l => `${l.tag}:${l.run}`), ['S1:r2']);
});

function editorProject(dir: string, ports: Record<string, number[]>) {
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  mkdirSync(path.join(dir, 'repo'), { recursive: true });
  return validateProject({
    id: 'demo', name: 'Demo', root: path.join(dir, 'repo'), work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
    editors: { 'ue-editor': { program: 'ue', args: ['{worktree}', '-ModelContextProtocolPort={port}'], url: 'http://127.0.0.1:{port}/mcp', machines: Object.fromEntries(Object.entries(ports).map(([m, p]) => [m, { ports: p }])) } },
  }, path.join(dir, 'alba.yaml'));
}

test('R-6: a slot being released keeps its port; a new start of the same order takes another, and only the released slot goes', () => {
  const { orders, dir } = tempOrders();
  const project = editorProject(dir, { local: [8101, 8102] });
  const pool = project.editors!['ue-editor'];
  orders.add({ tag: 'MAP1', title: 'Map', kind: 'code', uses: ['ue-editor'] });
  const tree = path.join(dir, 'tree');
  const old: EditorSlot = { pool: 'ue-editor', machine: 'local', port: 8101, tag: 'MAP1', run: 'r1', since: '2026-01-01T00:00:00.000Z', url: 'http://127.0.0.1:8101/mcp', log: 'x', releasing: '2026-01-01T00:05:00.000Z', stop_failed: '2026-01-01T00:05:00.000Z' };
  writeStateFile(project, '_editors.json', JSON.stringify([old]));
  const taken = takeEditor(project, orders, orders.get('MAP1'), pool, 'local', { localWorktree: tree, worktree: tree }, new Date('2026-01-01T00:06:00Z'));
  assert.equal(taken.slot.port, 8102, 'the port of the slot being released is still busy');
  orders.runStart('MAP1', { worker: 'coder' }); orders.runEnd('MAP1'); const open = orders.runStart('MAP1', { worker: 'coder' }).run;
  bindEditor(project, 'MAP1', 'ue-editor', open.id);
  assert.deepEqual(editorSlots(project).map(s => [s.port, s.run]), [[8101, 'r1'], [8102, 'r2']]);
  // The old slot's editor is gone now (no spec, no ssh: nothing to stop): only that slot is given back.
  reconcileEditors(project, orders);
  assert.deepEqual(editorSlots(project).map(s => [s.port, s.run]), [[8102, 'r2']]);
  // A slot being released is not dropped by a start that gives its own slot back.
  writeStateFile(project, '_editors.json', JSON.stringify([...editorSlots(project), { ...old, port: 8101 }]));
  dropEditor(project, 'MAP1', 'ue-editor');
  assert.deepEqual(editorSlots(project).map(s => s.port), [8101]);
});

test('R-7: without a recorded creation time a run\'s process is told by its launch window; a hold stops it then', () => {
  const started = '2026-01-01T00:00:00.000Z';
  const plus = (ms: number) => new Date(Date.parse(started) + ms).toISOString();
  assert.equal(launchedWithin(plus(3000), started), true);
  assert.equal(launchedWithin(plus(-60_000), started), false);
  assert.equal(launchedWithin(plus(3600_000), started), false);
  assert.equal(runProcessMatches(plus(3000), plus(3000), started), true);
  assert.equal(runProcessMatches(plus(3001), plus(3000), started), false, 'a recorded creation time is exact');
  assert.equal(runProcessMatches(undefined, undefined, started), false);
  for (const [actual, held] of [[plus(20_000), true], [plus(3600_000), false]] as const) {
    const f = tempOrders(), calls: unknown[][] = [];
    const orders = new Orders(f.orders.store, () => started, 'test', () => actual, { alive: () => true, stop: (pid, at, options) => { calls.push([pid, at, options]); return { stopped: [pid], leftRunning: [] }; } });
    orders.add({ tag: 'SAMPLE', title: 'Sample', kind: 'code' });
    orders.runStart('SAMPLE', { worker: 'builder', extra: { pid: 123 } });
    if (held) {
      orders.act('SAMPLE', 'hold');
      assert.equal(orders.get('SAMPLE').runs[0].outcome, 'cancelled');
      assert.deepEqual(calls, [[123, undefined, { launchedAt: started }]]);
    } else {
      assert.throws(() => orders.act('SAMPLE', 'hold'), /cannot be verified/);
      assert.deepEqual(calls, []);
    }
  }
});

test('R-7/R-9: a real process tree is stopped by its launch window, except a spared child and what is under it', async () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (what: () => boolean, ms = 20000) => { const until = Date.now() + ms; while (!what() && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return what(); };
  const launchedAt = new Date(Date.now() - 1000).toISOString();
  const parent = spawn(process.execPath, ['-e', `const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true }); console.log(c.pid); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let child = 0, output = '';
  parent.stdout!.on('data', chunk => { output += chunk; });
  try {
    assert.ok(await waitFor(() => /^\d+\s/.test(output)), 'the stand-in worker starts its job');
    child = Number(output.trim());
    assert.deepEqual(stopProcessTreeVerified(parent.pid!, undefined, { launchedAt: new Date(Date.now() - 3600_000).toISOString() }), { stopped: [], leftRunning: [] }, 'outside the launch window: not this run\'s process');
    const result = stopProcessTreeVerified(parent.pid!, undefined, { launchedAt, spare: [child] });
    assert.ok(result.stopped.includes(parent.pid!));
    assert.equal(result.stopped.includes(child), false);
    assert.ok(result.leftRunning.includes(child), 'the spared job (and what Windows started under it) is left running');
    assert.ok(await waitFor(() => !alive(parent.pid!)), 'the worker ends');
    assert.ok(alive(child), 'the spared job runs on');
  } finally {
    try { parent.kill(); } catch { /* gone */ }
    if (child) try { process.kill(child); } catch { /* gone */ }
  }
});

test('R-10: posix stop sends SIGTERM, then SIGKILL to what is still the same process after the grace period', () => {
  const p = (pid: number, at: string): ProcessInfo => ({ pid, parentPid: 1, createdAt: at });
  const ignores = p(10, '2026-01-01T00:00:00.000Z'), obeys = p(11, '2026-01-01T00:00:01.000Z'), gone = p(12, '2026-01-01T00:00:02.000Z');
  let clock = 0;
  const live = new Set([10, 11]);
  const signals: string[] = [];
  const deps = {
    snapshot: () => [ignores, obeys, gone].filter(x => live.has(x.pid)),
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); if (signal === 'SIGKILL' || pid === 11) live.delete(pid); },
    sleep: (ms: number) => { clock += ms; },
    now: () => clock,
  };
  assert.deepEqual(terminateThenKill([ignores, obeys, gone], deps, 1000), [10, 11]);
  assert.deepEqual(signals, ['10:SIGTERM', '11:SIGTERM', '10:SIGKILL']);
  assert.ok(clock >= 1000);
  // A pid that now belongs to another process is never signalled.
  signals.length = 0; live.add(10);
  assert.deepEqual(terminateThenKill([p(10, '2026-01-01T09:00:00.000Z')], deps, 1000), []);
  assert.deepEqual(signals, []);
});

test('R-11: the machine lock is taken over from a holder whose file was never finished or whose pid was reused, never from a live one', () => {
  const helper = fileURLToPath(new URL('../src/run/lock-helper.mjs', import.meta.url));
  const dir = tmpDir('alba-lock-');
  try {
    const env = { ...process.env, ALBA_LOCK_DIR: dir };
    const lock = path.join(dir, 'capture.lock');
    const run = (wait = '1') => spawnSync(process.execPath, [helper, 'capture', '--wait-minutes', wait, '--', process.execPath, '-e', 'process.exit(0)'], { env, encoding: 'utf8', timeout: 60000 });
    // A file its writer never finished (empty), left for longer than 10 s.
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.equal(run().status, 0);
    // A live pid (this test's own process) that started long after the holder named in the file: the pid was reused.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), started: '2000-01-01T00:00:00.000Z', token: 'x', cwd: 'gone', since: new Date(Date.now() - 120_000).toISOString() }));
    assert.equal(run().status, 0);
    // A live holder that is who it says it is keeps the lock: the waiter gives up (exit 75).
    const ours = new Date(Date.now() - process.uptime() * 1000).toISOString();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), started: ours, token: 'y', cwd: 'here', since: new Date(Date.now() - 120_000).toISOString() }));
    const waited = run('0.05');
    assert.equal(waited.status, 75);
    assert.match(waited.stderr, /waiting for the "capture" lock, held by pid \d+ in here/);
    assert.match(readFileSync(lock, 'utf8'), /"token":"y"/, 'the live holder\'s lock is left alone');
  } finally { removeTreeSync(dir); }
});

test('R-12: an order whose kind is also its heavy class holds one slot; editor ports are counted on the run\'s machine', () => {
  assert.deepEqual(capacityUsage([{ stage: 'running', kind: 'ue', heavy: 'ue' }], { ue: 2 }), { ue: { used: 1, cap: 2, monitoring: 0 } });
  const NOW = new Date('2026-01-01T12:00:00Z');
  const config = (id: string, host?: string): WorkerConfig => ({ id, engine: 'codex-cli', paid: false, concurrency: 4, capabilities: [], cost: 'included', aliases: [], enabled: true, disabled_when: [], card_only: false, ...(host ? { host } : {}), launch: { id, program: 'codex', args: ['{prompt_file}'], env: {}, env_unset: [] } });
  const order = (tag: string, over: Partial<TickOrder> = {}): TickOrder => ({ role: { id: 'default' }, tag, stage: 'queued', kind: 'ue', heavy: 'ue', row: Number(tag.replace(/\D/g, '')), rework: false, resume: false, endedWithoutReport: false, ...over });
  const input = (over: Partial<TickInput>): TickInput => ({ now: NOW, orders: [], activity: {}, workers: [{ config: config('w1'), available: true, reasons: [], running: 0, runsToday: 0 }], caps: { ue: 2 }, reworkReserve: 1, alerts: [], ...over });
  // One running ue order (kind and heavy class both ue) leaves one slot.
  const one = planTick(input({ orders: [order('R1', { stage: 'running' }), order('Q1'), order('Q2')] }));
  assert.deepEqual(one.moves.map(m => m.tag), ['Q1']);
  assert.match(one.heldBack[0].why, /cap for "ue" is full \(2\/2\)/);
  // The pool has one port on pc-a (taken) and two on pc-b: a worker on pc-a waits, one on pc-b starts two.
  const editorPorts = { 'ue-editor': { 'pc-a': { ports: 1, taken: ['OLD'] }, 'pc-b': { ports: 2, taken: [] } } };
  const orders = [order('Q1', { kind: 'code', heavy: undefined, editorPool: 'ue-editor' }), order('Q2', { kind: 'code', heavy: undefined, editorPool: 'ue-editor' }), order('Q3', { kind: 'code', heavy: undefined, editorPool: 'ue-editor' })];
  const onA = planTick(input({ orders, caps: {}, editorPorts, workerMachines: { w1: 'pc-a' } }));
  assert.deepEqual(onA.moves, []);
  assert.match(onA.heldBack[0].why, /every ue-editor port on pc-a is taken \(OLD\)/);
  const onB = planTick(input({ orders, caps: {}, editorPorts, workerMachines: { w1: 'pc-b' } }));
  assert.deepEqual(onB.moves.map(m => m.tag), ['Q1', 'Q2']);
  assert.match(onB.heldBack[0].why, /every ue-editor port on pc-b is taken \(2 planned in this pass\)/);
  // A person's start is refused before anything is made when the run's machine has no free port.
  const { orders: store, dir } = tempOrders();
  const project = editorProject(dir, { local: [8101], other: [8201] });
  store.add({ tag: 'MAP1', title: 'Map', kind: 'code', uses: ['ue-editor'] });
  writeStateFile(project, '_editors.json', JSON.stringify([{ pool: 'ue-editor', machine: 'local', port: 8101, tag: 'OLD', run: 'r1', since: '2026-01-01T00:00:00.000Z', url: 'u', log: 'l' }]));
  assert.match(editorPortProblem(editorSlots(project), 'MAP1', project.editors!['ue-editor'], 'local')!, /every ue-editor port on local is taken \(8101 OLD\)/);
  assert.equal(editorPortProblem(editorSlots(project), 'MAP1', project.editors!['ue-editor'], 'other'), undefined);
  assert.equal(editorPortProblem(editorSlots(project), 'OLD', project.editors!['ue-editor'], 'local'), undefined, 'an order keeps the port it holds');
});

