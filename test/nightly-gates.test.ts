import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture as apiFixture } from './api-fixture.ts';
import { stringify } from 'yaml';
import { validateProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { gatesConfig, type NightlyGate } from '../src/gates/config.ts';
import { cancelNightlyRuns, nightlyWindow, runNightlyGates } from '../src/gates/runner.ts';
import { yieldDecision } from '../src/gates/priority.ts';
import { knownStartedAt, primeStartedAt, resetStartedAtCache } from '../src/monitor/process.ts';
import { gatesState, gatesStatus } from '../src/gates/state.ts';
import { producerCases, intakeProducer } from '../src/producer/producer.ts';
import { producerLog } from '../src/producer/activity.ts';
import { acceptanceLeaseActive, acquireAcceptanceResources, acquireLeases, activeLeases, ensureOwnStartedAt, leaseProcessIdentity, readLeases, releaseAcceptanceResources, startBlocked, occupants, type StoredLease } from '../src/resources/leases.ts';
import { stateTransaction, writeStateFile } from '../src/orders/state-files.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { gateCommand } from '../src/gates/command.ts';
import { alba } from './cli-helper.ts';
import { createBoard } from '../src/web/server.ts';
import { startCoordinator } from '../src/serve/coordinator.ts';
import { validateWorkers } from '../src/workers/config.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';

const gate = (name = 'reference', script = 'console.log("ok")', extra: Partial<NightlyGate> = {}): NightlyGate => ({ name, argv: [process.execPath, '-e', script], timeout_minutes: 1, ...extra });
async function until(check: () => boolean, message = 'async state ready') {
  const end = Date.now() + 20_000;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), message);
}
function fixture(backend: 'sqlite' | 'files' = 'sqlite', gates = [gate()]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-nightly-')), root = path.join(dir, 'game'), file = path.join(dir, 'alba.yaml');
  mkdirSync(root); mkdirSync(path.join(dir, 'orders'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(path.join(root, 'input.txt'), 'baseline'); git('add', '.'); git('commit', '-qm', 'Baseline');
  const raw = { id: 'sample', name: 'Sample', root, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), state: { backend }, dispatch: { caps: { sim: 1 } }, resources: { rig: { slots: 2 } }, gates: { nightly: gates, window: '01:00-06:00' } };
  writeFileSync(file, stringify(raw));
  const project = validateProject(raw, file), orders = new Orders(stateStore(project));
  function merge(tag = 'DEMO-A') {
    git('checkout', '-qb', `change-${tag}`); writeFileSync(path.join(root, `${tag}.txt`), tag); git('add', '.'); git('commit', '-qm', `Change ${tag}`);
    git('checkout', '-q', 'main'); git('merge', '--no-ff', '-qm', `Merge ${tag}`, `change-${tag}`);
    const commit = git('rev-parse', 'HEAD'); orders.record(tag, 'accept-merged', { merge: commit }); return commit;
  }
  const at = (day = 1, hour = 2) => new Date(2026, 0, day, hour, 0);
  return { dir, root, project, orders, git, merge, at, file };
}
function noScratch(f: ReturnType<typeof fixture>) {
  // No scratch worktree of the gates is left (an order's own worktree, made by a start, is not scratch).
  const scratch = path.join(f.project.state_dir, 'nightly-gates').split(path.sep).join('/').toLowerCase();
  assert.deepEqual(f.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ') && l.slice(9).replace(/\\/g, '/').toLowerCase().startsWith(scratch)), []);
  assert.ok(readdirSync(path.join(f.project.state_dir, 'nightly-gates')).every(n => !n.startsWith('worktree-')));
  assert.equal(activeLeases(f.project, f.orders).length, 0);
}

test('local windows include start, exclude end and count an overnight window as one night', () => {
  assert.equal(nightlyWindow('01:00-06:00', new Date(2026, 0, 1, 1)).inside, true);
  assert.equal(nightlyWindow('01:00-06:00', new Date(2026, 0, 1, 6)).inside, false);
  assert.deepEqual(nightlyWindow('23:00-04:00', new Date(2026, 0, 2, 2)), { inside: true, night: '2026-01-01' });
});

for (const backend of ['sqlite', 'files'] as const) test(`nightly requires a merge and window, runs once, and skips unchanged next night (${backend})`, async () => {
  const f = fixture(backend);
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at() })).status, 'skipped');
  const commit = f.merge();
  assert.match((await runNightlyGates(f.project, f.orders, { now: f.at(1, 12) })).reason!, /window/);
  const result = await runNightlyGates(f.project, f.orders, { now: f.at() });
  assert.equal(result.status, 'passed', result.reason); assert.equal(result.run?.commit, commit);
  assert.deepEqual(result.run?.mergedOrders, ['DEMO-A']);
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at() })).status, 'skipped');
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at(2) })).status, 'skipped');
  f.merge('DEMO-B'); assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at(2) })).status, 'passed'); noScratch(f);
});

test('serve schedules a batch after dispatch inside the window and exposes its results in overview', async () => {
  const f = fixture(); f.merge(); let now = f.at(1, 12);
  const probes = { now: () => now, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => { throw new Error('Fixture forbids workers.'); } } as unknown as Probes;
  const workers = validateWorkers({ workers: [{ id: 'fixture', engine: 'fake', enabled: false }] }, 'workers.yaml');
  const options = { projects: [f.project], probes, workers, port: 0, everyMinutes: 0, maxDispatch: 0, print: () => {}, reloadConfigs: false };
  const board = createBoard(options), serve = startCoordinator(options, board);
  try {
    await new Promise<void>(resolve => board.server.once('listening', resolve));
    serve.tickNow('schedule'); assert.equal(gatesState(f.project).runs.length, 0);
    // Let the skipped scheduling promise release its in-process guard.
    await new Promise(resolve => setImmediate(resolve));
    now = f.at(); serve.tickNow('schedule');
    const deadline = Date.now() + 10000;
    while (!gatesState(f.project).runs.at(-1)?.ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(gatesState(f.project).runs.at(-1)?.status, 'passed');
    const address = board.server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/p/sample/overview`, { headers: { 'x-alba-token': board.ctx.token } });
    assert.equal(response.status, 200);
    const overview = await response.json() as import('../src/api/types.ts').ProjectOverview;
    assert.equal(overview.nightlyGates?.last?.status, 'passed'); noScratch(f);
  } finally { await serve.stop(); }
});

test('gates defer to a held order resource even with spare slots, queued orders and kind caps', async () => {
  const f = fixture('sqlite', [gate('reference', '', { uses: ['rig'], kind: 'sim' })]); f.merge();
  f.orders.add({ tag: 'HOLDER', title: 'Running simulation', kind: 'sim', uses: ['rig'] }); f.orders.act('HOLDER', 'queue');
  f.orders.runStart('HOLDER', { worker: 'fake' }); acquireLeases(f.project, f.orders, f.orders.get('HOLDER'), undefined, new Date());
  assert.match((await runNightlyGates(f.project, f.orders, { now: f.at() })).reason!, /held by order/);
  f.orders.runEnd('HOLDER'); f.orders.act('HOLDER', 'cancel');
  acquireAcceptanceResources(f.project, f.orders, 'TRIAL', ['rig']);
  assert.match((await runNightlyGates(f.project, f.orders, { now: f.at() })).reason!, /held by job TRIAL/);
  releaseAcceptanceResources(f.project, f.orders, 'TRIAL');
  f.orders.add({ tag: 'QUEUED', title: 'Queued simulation', kind: 'sim' }); f.orders.act('QUEUED', 'queue');
  assert.match((await runNightlyGates(f.project, f.orders, { now: f.at() })).reason!, /priority/);
  f.orders.act('QUEUED', 'cancel');
  assert.match((await runNightlyGates(f.project, f.orders, { now: f.at(), ordersFirst: true })).reason!, /priority/);
  acquireAcceptanceResources(f.project, f.orders, 'TRIAL', ['sim']);
  assert.match((await runNightlyGates(f.project, f.orders, { now: f.at() })).reason!, /cap/i);
  releaseAcceptanceResources(f.project, f.orders, 'TRIAL');
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at() })).status, 'passed'); noScratch(f);
});

test('failure attribution starts at the last full pass, one case survives intake and a later pass closes it', async () => {
  const f = fixture(); f.merge('DEMO-A');
  await runNightlyGates(f.project, f.orders, { now: f.at() });
  const from = gatesState(f.project).lastPass!.commit;
  f.project.gates!.nightly = [gate('reference', 'console.error("regression"); process.exit(4)')];
  f.merge('DEMO-B'); const commit = f.merge('DEMO-C');
  const failed = await runNightlyGates(f.project, f.orders, { now: f.at(2) });
  assert.equal(failed.status, 'failed'); assert.equal(failed.run?.results[0].exit, 4);
  let cases = producerCases(f.project, true).filter(c => c.trigger === 'nightly-gate-failed');
  assert.equal(cases.length, 1); assert.equal(cases[0].facts.from, from); assert.equal(cases[0].facts.commit, commit);
  assert.deepEqual(cases[0].facts.mergedOrders, ['DEMO-B', 'DEMO-C']);
  intakeProducer(f.project, f.orders, { verify: false });
  await runNightlyGates(f.project, f.orders, { force: true });
  cases = producerCases(f.project, true).filter(c => c.trigger === 'nightly-gate-failed'); assert.equal(cases.length, 1);
  assert.match(readFileSync(failed.run!.results[0].log, 'utf8'), /regression/);
  assert.equal(producerLog(f.project, f.orders).rows.filter(r => r.kind === 'nightly-gates').length, 3);
  f.project.gates!.nightly = [gate()];
  assert.equal((await runNightlyGates(f.project, f.orders, { force: true })).status, 'passed');
  assert.equal(producerCases(f.project, true).filter(c => c.trigger === 'nightly-gate-failed').length, 0); noScratch(f);
});

test('timeout removes scratch and leases; --now runs immediately with no merge outside window', async () => {
  const f = fixture('sqlite', [gate('slow', 'setTimeout(()=>{},10000)', { timeout_minutes: 0.002 })]);
  const result = await runNightlyGates(f.project, f.orders, { force: true });
  assert.equal(result.status, 'failed'); assert.equal(result.run?.results[0].timedOut, true); noScratch(f);
  const raw = validateProject({ id: 'sample', name: 'Sample', root: f.root, work_orders: f.project.work_orders, state_dir: f.project.state_dir, gates: { nightly: [gate()], window: '00:00-00:01' } }, f.file);
  writeFileSync(f.file, stringify({ ...raw, file: undefined }));
  const cli = alba(f.file, ['gates', 'run', '--now', '--gate', 'reference']); assert.equal(cli.code, 0, cli.err); assert.equal(JSON.parse(cli.out).status, 'passed');
  const status = alba(f.file, ['gates', 'status']); assert.equal(status.code, 0, status.err); assert.equal(JSON.parse(status.out).last.status, 'passed'); noScratch(f);
});

test('scratch uses main commit instead of dirty checkout, result readers parse JSON/files/regex and malformed output fails', async () => {
  const f = fixture('sqlite', [gate('json', 'if(require("fs").readFileSync("input.txt","utf8")!=="baseline")process.exit(2); console.log(JSON.stringify({pass:true,value:7}))', { result: { pass: { json_pointer: '/pass' }, value: { json_pointer: '/value' } } }),
    gate('regex', 'console.log("PASS value=8")', { result: { pass: { regex: '^PASS' }, value: { regex: 'value=(\\d+)', group: 1 } } }),
    gate('file', 'require("fs").writeFileSync("result.json",JSON.stringify({ok:"yes",score:9}))', { result: { pass: { json_pointer: '/ok', file: 'result.json', equals: 'yes' }, value: { json_pointer: '/score', file: 'result.json' } } })]);
  const commit = f.git('rev-parse', 'HEAD'); f.git('checkout', '-qb', 'unmerged'); writeFileSync(path.join(f.root, 'input.txt'), 'dirty');
  const result = await runNightlyGates(f.project, f.orders, { force: true });
  assert.equal(result.status, 'passed', JSON.stringify(result)); assert.equal(result.run?.commit, commit);
  assert.deepEqual(result.run?.results.map(r => r.value), [7, 8, 9]); assert.equal(readFileSync(path.join(f.root, 'input.txt'), 'utf8'), 'dirty');
  f.project.gates!.nightly = [gate('bad', 'console.log("invalid")', { result: { pass: { json_pointer: '/ok' } } })];
  assert.equal((await runNightlyGates(f.project, f.orders, { force: true })).status, 'error'); noScratch(f);
});

test('active gates reserve resources and caps, concurrent invocations wait and queued work takes the next turn', async () => {
  const f = fixture('sqlite', [gate('first', 'setTimeout(()=>console.log("ok"),150)', { kind: 'sim', uses: ['rig'] }), gate('second')]); f.merge();
  let pending = false;
  const job = runNightlyGates(f.project, f.orders, { now: f.at(), ordersFirst: () => pending });
  await until(() => activeLeases(f.project, f.orders).some(l => l.acceptance?.cap === 'sim'));
  assert.equal(activeLeases(f.project, f.orders).filter(l => l.acceptance?.cap === 'sim').length, 1);
  assert.ok(startBlocked(f.project.resources!, activeLeases(f.project, f.orders), occupants(f.project, f.orders), { tag: 'ORDER', kind: 'sim', uses: ['rig'] }));
  assert.equal((await runNightlyGates(f.project, f.orders, { force: true })).status, 'waiting');
  pending = true; assert.equal((await job).status, 'waiting'); noScratch(f);
  const resumed = await runNightlyGates(f.project, f.orders, { now: f.at() });
  assert.equal(resumed.status, 'passed'); assert.equal(resumed.run?.results.length, 2); assert.equal(gatesState(f.project).runs.length, 1); noScratch(f);
});

test('a gate named run cannot release the batch lock before the next gate finishes', { timeout: 120_000 }, async t => {
  const f = fixture('sqlite', [gate('run'), gate('slow')]);
  const ready = path.join(f.dir, 'slow-started'), release = path.join(f.dir, 'slow-release');
  f.project.gates!.nightly[1]!.argv = [process.execPath, '-e', `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);}},20);`];
  const watcher = watch(f.dir, { signal: t.signal });
  const job = runNightlyGates(f.project, f.orders, { force: true });
  try {
    // Hold a real gate at a filesystem handshake instead of racing a 300 ms sleep.
    while (!existsSync(ready)) await once(watcher, 'change', { signal: t.signal });
    assert.equal(gatesState(f.project).runs.at(-1)?.results.length, 1);
    assert.match((await runNightlyGates(f.project, f.orders, { force: true })).reason!, /already running/);
  } finally {
    watcher.close(); writeFileSync(release, 'release');
    assert.equal((await job).status, 'passed');
  }
  noScratch(f);
});

test('the last nights are retained and partial reruns do not advance the full checkpoint', async () => {
  const f = fixture('sqlite', [gate('first'), gate('second')]); f.project.gates!.only_if_merged = false;
  for (let day = 1; day <= 4; day++) assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at(day), keepNights: 3 })).status, 'passed');
  const state = gatesState(f.project); assert.equal(state.runs.length, 3); assert.equal(state.runs[0].night, '2026-01-02');
  assert.equal(readdirSync(path.join(f.project.state_dir, 'nightly-gates')).length, 3);
  f.merge(); await runNightlyGates(f.project, f.orders, { now: f.at(4), force: true, gate: 'first', keepNights: 3 });
  assert.deepEqual(gatesState(f.project).lastFull, state.lastFull); assert.equal(gatesStatus(f.project)?.gates.length, 2); noScratch(f);
});

test('config defaults and strict validation, disabled projects have no state changes', async () => {
  const f = fixture();
  assert.equal(f.project.gates?.only_if_merged, true);
  for (const over of [{ nightly: [gate(), gate()] }, { window: '25:00-26:00' }, { window: '01:00-01:00' }, { only_if_merged: 'yes' }, { nightly: [gate('x', '', { cwd: '../outside' })] }, { nightly: [gate('x', '', { uses: ['missing'] })] }, { nightly: [gate('x', '', { kind: 'missing' })] }, { nightly: [gate('x', '', { timeout_minutes: 0 })] }, { nightly: [gate('x', '', { result: { pass: { regex: '[' } } })] }]) assert.throws(() => gatesConfig({ ...f.project.gates, ...over }, f.project), /gates/);
  delete f.project.gates;
  assert.equal((await runNightlyGates(f.project, f.orders, { force: true })).status, 'skipped'); assert.equal(gatesStatus(f.project), undefined);
  assert.equal(existsSync(path.join(f.project.state_dir, '_nightly-gates.json')), false);
});

test('forced daytime batches leave the coming scheduled night and merge checkpoint available', async () => {
  const f = fixture(); f.merge();
  const forced = await runNightlyGates(f.project, f.orders, { force: true, now: f.at(1, 12) });
  assert.equal(forced.status, 'passed'); assert.equal(forced.run?.forced, true);
  assert.equal(gatesState(f.project).lastFull, undefined);
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at() })).status, 'passed');
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at() })).status, 'skipped'); noScratch(f);
});

test('nightly leases reject reused identities, expired owners and legacy unidentified pids', async () => {
  await ensureOwnStartedAt();
  const f = fixture(), now = new Date(), identity = leaseProcessIdentity();
  assert.ok(identity.started_at);
  const lease: StoredLease = { resource: 'nightly:run', tag: 'nightly:run', since: now.toISOString(), expires: new Date(now.getTime() + 60000).toISOString(), acceptance: { ...identity, nightly: true } };
  assert.equal(acceptanceLeaseActive(lease, now), true);
  assert.equal(acceptanceLeaseActive(lease, now, () => new Date(Date.parse(identity.started_at!) + 1000).toISOString()), false);
  assert.equal(acceptanceLeaseActive({ ...lease, expires: now.toISOString() }, now), true);
  assert.equal(acceptanceLeaseActive({ ...lease, acceptance: { pid: process.pid, nightly: true } }, now), false);
  assert.equal(acceptanceLeaseActive({ ...lease, acceptance: { pid: process.pid } }, now), true);
  writeStateFile(f.project, '_leases.json', JSON.stringify({ leases: [{ ...lease, acceptance: { ...lease.acceptance, started_at: '2000-01-01T00:00:00Z' } }] }));
  assert.equal((await runNightlyGates(f.project, f.orders, { force: true })).status, 'passed'); noScratch(f);
});

test('batch lock covers the sum of multi-day gates and uses real expiry time', async () => {
  const f = fixture('sqlite', [gate('soak', 'setTimeout(()=>{},100)', { timeout_minutes: 4320 }), gate('second', '', { timeout_minutes: 4320 })]);
  const job = runNightlyGates(f.project, f.orders, { force: true, now: f.at() });
  await until(() => readLeases(f.project).some(l => l.tag === 'nightly:run'));
  const lock = readLeases(f.project).find(l => l.tag === 'nightly:run')!;
  assert.ok(Date.parse(lock.expires) - Date.now() > 144 * 3600000);
  assert.ok(Date.parse(lock.expires) - Date.now() > 145 * 3600000, 'budget both 30-minute worktree operations as well as all gates');
  assert.equal(acceptanceLeaseActive(lock), true);
  assert.equal((await job).status, 'passed'); noScratch(f);
});

test('setup errors do not blame merged orders or close an existing regression case', async () => {
  const f = fixture('sqlite', [gate('reference', 'process.exit(3)')]); f.merge();
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at() })).status, 'failed');
  writeFileSync(path.join(f.root, 'fixture.cmd'), '@echo off\r\nexit /b 0\r\n'); f.git('add', '.'); f.git('commit', '-qm', 'Fixture batch script');
  for (const broken of [gate('reference', '', { cwd: 'missing' }), gate('reference', '', { argv: ['nonexistent-fixture-executable'] }), ...(process.platform === 'win32' ? [gate('reference', '', { argv: ['./fixture.cmd'] })] : [])]) {
    f.project.gates!.nightly = [broken];
    const result = await runNightlyGates(f.project, f.orders, { force: true });
    assert.equal(result.status, 'error', JSON.stringify(result)); assert.equal(result.run?.results[0].status, 'error');
    assert.equal(producerCases(f.project, true).filter(c => c.trigger === 'nightly-gate-failed').length, 1);
    noScratch(f);
  }
  const fresh = fixture('sqlite', [gate('missing', '', { cwd: 'missing' })]); fresh.merge();
  assert.equal((await runNightlyGates(fresh.project, fresh.orders, { force: true })).status, 'error');
  assert.equal(producerCases(fresh.project, true).filter(c => c.trigger === 'nightly-gate-failed').length, 0);
  assert.ok(producerLog(fresh.project, fresh.orders).rows.some(r => r.kind === 'nightly-notice' && /setup error/.test(r.note)));
});

test('serve runs gates when a queued dispatch plan repeatedly fails to launch', async () => {
  const f = fixture('sqlite', [gate('reference', '', { kind: 'sim', uses: ['rig'] })]); f.merge();
  f.project.roles = { default: { sources: {} } };
  f.orders.add({ tag: 'QUEUED', title: 'Fixture queued order', kind: 'sim' }); f.orders.act('QUEUED', 'queue');
  const queued = f.orders.get('QUEUED'); queued.actions.at(-1)!.at = new Date(f.at().getTime() - 2 * 3_600_000 - 1000).toISOString(); f.orders.store.write(queued);
  writeFileSync(path.join(f.project.work_orders, 'QUEUED-fixture.md'), '# Fixture\nRun a quick check.\n');
  const probes = { now: () => f.at(), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => { throw new Error('Fixture launch failure.'); } } as unknown as Probes;
  const workers = validateWorkers({ workers: [{ id: 'fixture', engine: 'fake', launch: { program: 'fixture-missing', args: ['{prompt_file}'] } }] }, 'workers.yaml');
  const report = tick(f.project, f.orders, workers, probes, { record: false }).report;
  assert.ok(report.moves.some(m => m.mode !== 'card'), JSON.stringify(report));
  const printed: string[] = [];
  const options = { projects: [f.project], probes, workers, port: 0, everyMinutes: 0, maxDispatch: 1, print: (line: string) => printed.push(line), reloadConfigs: false };
  const board = createBoard(options), serve = startCoordinator(options, board);
  try {
    await new Promise<void>(resolve => board.server.once('listening', resolve));
    serve.tickNow('schedule');
    const deadline = Date.now() + 10000;
    while (!gatesState(f.project).runs.at(-1)?.ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(printed.some(line => line.includes('could not start QUEUED')), printed.join('\n'));
    assert.equal(gatesState(f.project).runs.at(-1)?.status, 'passed');
    assert.ok(f.orders.store.events().some(e => e.type === 'nightly-notice' && String(e.data?.text).includes('over 2 h')));
    assert.ok(tick(f.project, f.orders, workers, probes, { record: false }).report.moves.some(m => m.mode !== 'card'));
    serve.tickNow('schedule'); noScratch(f);
  } finally { await serve.stop(); }
});

test('failed worktree creation preserves its reason and an unregistered leftover cannot abort the next batch', async () => {
  const f = fixture('sqlite', [gate('first'), gate('second')]); f.merge();
  const hook = path.join(f.root, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, '#!/bin/sh\necho fixture-checkout-failure >&2\nexit 9\n'); chmodSync(hook, 0o755);
  const failed = await runNightlyGates(f.project, f.orders, { now: f.at() });
  assert.equal(failed.status, 'error'); assert.equal(failed.run?.results.length, 1);
  assert.match(failed.run!.results[0].reason!, /worktree add.*exited/);
  assert.match(failed.run!.results[0].reason!, /fixture-checkout-failure/);
  assert.equal(producerCases(f.project, true).filter(c => c.trigger === 'nightly-gate-failed').length, 0);
  noScratch(f); rmSync(hook);
  const leftover = path.join(f.project.state_dir, 'nightly-gates', `worktree-${failed.run!.id}`);
  mkdirSync(leftover); writeFileSync(path.join(leftover, 'leftover.txt'), 'not registered');
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at() })).status, 'skipped');
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at(2) })).status, 'passed'); noScratch(f);
});

test('interrupted runs become abandoned after night, definition, selection changes or disablement', async () => {
  for (const change of ['night', 'definition', 'selection', 'disabled']) {
    const f = fixture('sqlite', [gate('first'), gate('second')]); f.merge();
    let calls = 0;
    const paused = await runNightlyGates(f.project, f.orders, { now: f.at(), ordersFirst: () => ++calls >= 2 });
    assert.equal(paused.status, 'waiting');
    if (change === 'definition') f.project.gates!.nightly[0].argv = [process.execPath, '-e', 'console.log("changed")'];
    if (change === 'disabled') delete f.project.gates;
    await runNightlyGates(f.project, f.orders, { now: f.at(change === 'night' ? 2 : 1), ...(change === 'selection' ? { gate: 'second' } : {}) });
    assert.equal(gatesState(f.project).runs.find(r => r.id === paused.run!.id)?.status, 'abandoned');
    assert.ok(gatesState(f.project).runs.find(r => r.id === paused.run!.id)?.ended); noScratch(f);
  }
});

test('a parent exit completes even when a descendant keeps stdout open', async () => {
  const script = 'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},1500)"],{stdio:["ignore",process.stdout,process.stderr]}).unref();';
  const started = Date.now();
  assert.equal((await gateCommand([process.execPath, '-e', script], process.cwd(), 10000)).exit, 0);
  assert.ok(Date.now() - started < 10000);
});

test('Windows timeout stops a child and its stdout-inheriting grandchild, then releases the rig', { skip: process.platform !== 'win32' ? 'Requires Windows process-tree and inherited stdout-handle behavior; POSIX has separate native coverage.' : false }, async () => {
  const f = fixture(); const pids = path.join(f.dir, 'pids.json');
  f.project.gates!.nightly = [gate('tree', `const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:['ignore',process.stdout,process.stderr]});require('node:fs').writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,c.pid]));setTimeout(()=>{},120000);`, { timeout_minutes: 0.05, uses: ['rig'] })];
  const started = Date.now(), job = runNightlyGates(f.project, f.orders, { force: true });
  const result = await job;
  assert.equal(result.status, 'failed'); assert.equal(result.run?.results[0].timedOut, true);
  assert.ok(Date.now() - started < 30000);
  const identities = JSON.parse(readFileSync(pids, 'utf8')) as number[];
  assert.equal(identities.length, 2);
  for (const pid of identities) assert.throws(() => process.kill(pid, 0), /ESRCH/);
  noScratch(f);
  assert.equal(acquireAcceptanceResources(f.project, f.orders, 'NEXT', ['rig']), undefined);
  releaseAcceptanceResources(f.project, f.orders, 'NEXT');
});

test('CLI and serve share resource-aware priority and its two-hour cap', async () => {
  const f = fixture('sqlite', [gate('reference', '', { uses: ['rig'], kind: 'sim' })]); f.merge();
  f.orders.add({ tag: 'WAITING', title: 'Queued simulation', kind: 'sim', uses: ['rig'] }); f.orders.act('WAITING', 'queue');
  assert.match(yieldDecision(f.project, f.orders, f.project.gates!.nightly[0], new Date()).reason!, /WAITING/);
  const waiting = alba(f.file, ['gates', 'run', '--now']);
  assert.equal(waiting.code, 0, waiting.err); assert.equal(JSON.parse(waiting.out).status, 'waiting');
  const doc = f.orders.get('WAITING'); doc.actions.at(-1)!.at = new Date(Date.now() - 2 * 3_600_000 - 1000).toISOString(); f.orders.store.write(doc);
  const capped = alba(f.file, ['gates', 'run', '--now']);
  assert.equal(capped.code, 0, capped.err); assert.equal(JSON.parse(capped.out).status, 'passed');
  assert.ok(f.orders.store.events().some(e => e.type === 'nightly-notice' && String(e.data?.text).includes('over 2 h')));
  f.orders.act('WAITING', 'cancel');
  f.orders.add({ tag: 'UNRELATED', title: 'Other work', kind: 'docs' }); f.orders.act('UNRELATED', 'queue');
  assert.equal(yieldDecision(f.project, f.orders, f.project.gates!.nightly[0], new Date()).reason, undefined);
  noScratch(f);
});

test('error attempts retry hourly at most three times and retain already completed gates', async () => {
  const f = fixture('sqlite', [gate('first'), gate('reader', 'console.log("invalid")', { result: { pass: { json_pointer: '/ok' } } })]); f.merge();
  const first = await runNightlyGates(f.project, f.orders, { now: f.at() });
  assert.equal(first.status, 'error'); assert.deepEqual(first.run?.results.map(r => r.status), ['passed', 'error']);
  const original = first.run!.results[0];
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at() })).status, 'skipped');
  for (let attempt = 2; attempt <= 3; attempt++) {
    // Put the saved attempt in the fixture's synthetic scheduling timeline.
    const state = gatesState(f.project); state.runs[0].ended = f.at(1, attempt).toISOString(); writeStateFile(f.project, '_nightly-gates.json', JSON.stringify(state));
    assert.equal((await runNightlyGates(f.project, f.orders, { now: new Date(f.at(1, attempt).getTime() + 30 * 60_000) })).status, 'skipped');
    const next = await runNightlyGates(f.project, f.orders, { now: f.at(1, attempt + 1) });
    assert.equal(next.status, 'error'); assert.equal(next.run?.id, first.run!.id); assert.equal(next.run?.attempts, attempt);
    assert.deepEqual(next.run?.results[0], original);
  }
  assert.match((await runNightlyGates(f.project, f.orders, { now: f.at(1, 5) })).reason!, /3 attempts/);
  assert.equal(gatesState(f.project).runs.length, 1); assert.equal(gatesState(f.project).lastFull, undefined); noScratch(f);
});

test('unknown start times keep nightly, acceptance and measurement leases even after expiry', () => {
  for (const mode of [{ nightly: true }, {}, { measurement: true }]) {
    const lease: StoredLease = { resource: 'rig', tag: 'HOLDER', since: '2000-01-01T00:00:00Z', expires: '2000-01-01T00:01:00Z', acceptance: { pid: process.pid, started_at: '2000-01-01T00:00:00Z', ...mode } };
    assert.equal(acceptanceLeaseActive(lease, new Date(), () => undefined), true);
    assert.equal(acceptanceLeaseActive({ ...lease, acceptance: { pid: process.pid, nightly: true, unverified: true } }), true);
  }
});

test('cached process identities expire so a reused live PID is checked again', async t => {
  resetStartedAtCache();
  const start = Date.now(), first = '2026-01-01T00:00:00Z', reused = '2026-01-01T00:01:00Z';
  t.mock.method(Date, 'now', () => start);
  assert.equal(await primeStartedAt(12345, async () => first), first);
  t.mock.method(Date, 'now', () => start + 60_001);
  assert.equal(knownStartedAt(12345), undefined);
  assert.equal(await primeStartedAt(12345, async () => reused), reused);
  resetStartedAtCache();
});

test('BOM-prefixed result files pass and malformed result files are infrastructure errors', async () => {
  const f = fixture('sqlite', [gate('bom', 'require("fs").writeFileSync("result.json","\\ufeff"+JSON.stringify({ok:true,value:12}))', { result: { pass: { json_pointer: '/ok', file: 'result.json' }, value: { json_pointer: '/value', file: 'result.json' } } })]);
  const passed = await runNightlyGates(f.project, f.orders, { force: true });
  assert.equal(passed.status, 'passed'); assert.equal(passed.run?.results[0].value, 12);
  f.project.gates!.nightly[0].argv = [process.execPath, '-e', 'require("fs").writeFileSync("result.json","{")'];
  const error = await runNightlyGates(f.project, f.orders, { force: true });
  assert.equal(error.status, 'error'); assert.match(error.run!.results[0].reason!, /Cannot read gate result/);
  assert.equal(producerCases(f.project, true).filter(c => c.trigger === 'nightly-gate-failed').length, 0); noScratch(f);
});

test('forced runs resume outside the window, can be cancelled by CLI/API, and have a waiting deadline', async () => {
  const f = fixture('sqlite', [gate('first'), gate('second', '', { uses: ['rig'] })]);
  acquireAcceptanceResources(f.project, f.orders, 'TRIAL', ['rig']);
  const paused = await runNightlyGates(f.project, f.orders, { force: true, now: f.at(1, 12) });
  assert.equal(paused.status, 'waiting'); assert.equal(paused.run?.results.length, 1);
  assert.match((await runNightlyGates(f.project, f.orders, { now: f.at(1, 13) })).reason!, /TRIAL/);
  releaseAcceptanceResources(f.project, f.orders, 'TRIAL');
  const resumed = await runNightlyGates(f.project, f.orders, { now: f.at(1, 13) });
  assert.equal(resumed.status, 'passed'); assert.equal(resumed.run?.id, paused.run?.id); assert.equal(resumed.run?.results.length, 2);
  acquireAcceptanceResources(f.project, f.orders, 'TRIAL', ['rig']);
  await runNightlyGates(f.project, f.orders, { force: true, now: f.at(1, 12) });
  const cancelled = alba(f.file, ['gates', 'cancel']); assert.equal(cancelled.code, 0, cancelled.err); assert.equal(JSON.parse(cancelled.out).cancelled, 1);
  const expiring = await runNightlyGates(f.project, f.orders, { force: true, now: f.at(1, 12) });
  releaseAcceptanceResources(f.project, f.orders, 'TRIAL'); f.project.gates!.only_if_merged = false;
  assert.equal((await runNightlyGates(f.project, f.orders, { now: f.at(3) })).status, 'passed');
  assert.equal(gatesState(f.project).runs.find(r => r.id === expiring.run?.id)?.status, 'abandoned'); noScratch(f);

  const api = await apiFixture({ populate: false, project: () => ({ gates: { nightly: [gate()] } }) });
  const project = api.board.ctx.projects[0];
  await runNightlyGates(project, api.orders, { force: true, ordersFirst: true });
  assert.equal((await api.post('/api/gates/cancel', { project: project.id })).status, 401);
  const response = await api.write('/api/gates/cancel', { project: project.id });
  assert.equal(response.status, 200); assert.equal(response.body.cancelled, 1);
});

test('running leases renew each pass and before a failed-identity timeout stops its tree', async t => {
  const f = fixture('sqlite', [gate('slow', 'setTimeout(()=>{},120000)', { timeout_minutes: 0.05, uses: ['rig'] })]);
  let beforeStop = false;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const job = runNightlyGates(f.project, f.orders, { force: true, commandOptions: { lookupStartedAt: async () => undefined, beforeStop: () => {
    beforeStop = true;
    assert.ok(readLeases(f.project).every(l => Date.parse(l.expires) > Date.now() + 120_000));
  } } });
  await until(() => readLeases(f.project).some(l => l.acceptance?.child_pid));
  assert.match(cancelNightlyRuns(f.project, f.orders).reason!, /running/);
  const leases = readLeases(f.project).map(l => ({ ...l, expires: new Date(Date.now() - 1).toISOString() }));
  writeStateFile(f.project, '_leases.json', JSON.stringify({ leases }));
  assert.equal(activeLeases(f.project, f.orders).length, leases.length, 'verified live holders survive expiry');
  t.mock.timers.tick(30_000);
  assert.ok(readLeases(f.project).every(l => Date.parse(l.expires) > Date.now() + 120_000));
  const result = await job;
  assert.equal(result.status, 'failed'); assert.equal(result.run?.results[0].timedOut, true); assert.equal(beforeStop, true); noScratch(f);
});

test('a locked log append reports one command error without an uncaught stream exception', async () => {
  const f = fixture();
  // A directory deterministically refuses append, like a Windows file held without write sharing.
  await assert.rejects(gateCommand([process.execPath, '-e', 'console.log("first");console.error("second")'], f.root, 10_000, f.dir), /Could not append gate log/);
});

test('UI overview reads live lease identities without synchronous PowerShell', async t => {
  const api = await apiFixture({ populate: false, project: () => ({ gates: { nightly: [gate()] }, resources: { rig: { slots: 1 } } }) });
  const project = api.board.ctx.projects[0];
  writeStateFile(project, '_leases.json', JSON.stringify({ leases: [{ resource: 'rig', tag: 'nightly:gate:reference', since: new Date().toISOString(), expires: '2000-01-01T00:00:00Z', acceptance: { pid: process.ppid, started_at: '2000-01-01T00:00:00Z', nightly: true } }] }));
  const original = childProcess.execFileSync; let calls = 0;
  t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof original>) => { if (/powershell/i.test(args[0])) calls++; return Reflect.apply(original, childProcess, args); });
  syncBuiltinESMExports();
  try { assert.equal((await api.get('/api/p/demo/overview')).status, 200); assert.equal(calls, 0); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('startup records its identity for projects without gates, and failed lookups stay unverified', () => {
  const f = fixture(); delete f.project.gates;
  const script = `
    const { runNightlyGates } = await import('./src/gates/runner.ts');
    const { leaseProcessIdentity } = await import('./src/resources/leases.ts');
    const { Orders } = await import('./src/orders/service.ts');
    const { stateStore } = await import('./src/orders/backend.ts');
    const project = JSON.parse(process.argv[1]);
    await runNightlyGates(project, new Orders(stateStore(project)));
    console.log(JSON.stringify(leaseProcessIdentity()));`;
  const invoke = (prefix: string) => JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', prefix + script, JSON.stringify(f.project)], { encoding: 'utf8', windowsHide: true }));
  assert.ok(invoke('').started_at);
  const failed = invoke(`const { default: cp } = await import('node:child_process'); const { syncBuiltinESMExports } = await import('node:module');
    cp.execFile = (...args) => { queueMicrotask(() => args.at(-1)(new Error('fixture lookup failed'), '', '')); return {}; }; syncBuiltinESMExports();`);
  assert.equal(failed.unverified, true); assert.equal(failed.started_at, undefined);
});

test('unconfirmed trees hold their leases and back off later stop attempts', async () => {
  const f = fixture('sqlite', [gate('reference', '', { uses: ['rig'] })]); let calls = 0;
  const commandOptions = { stopTree: async () => ({ gone: ++calls >= 3, stopped: [] }) };
  const first = await runNightlyGates(f.project, f.orders, { force: true, now: f.at(), commandOptions });
  assert.equal(first.status, 'error'); assert.equal(calls, 1); assert.ok(activeLeases(f.project, f.orders).some(l => l.resource === 'rig'));
  await runNightlyGates(f.project, f.orders, { now: f.at(), commandOptions }); assert.equal(calls, 2);
  await runNightlyGates(f.project, f.orders, { now: f.at(), commandOptions }); assert.equal(calls, 2, 'a consecutive pass does not spawn another stop snapshot');
  const state = gatesState(f.project); state.stuck![0].retryAt = 0; writeStateFile(f.project, '_nightly-gates.json', JSON.stringify(state));
  assert.equal((await runNightlyGates(f.project, f.orders, { force: true, now: f.at(), commandOptions })).status, 'passed'); noScratch(f);
});

for (const backend of ['sqlite', 'files'] as const) test(`settling a confirmed-gone tree releases another live host's batch and gate leases (${backend})`, async () => {
  const f = fixture(backend, [gate('reference', '', { uses: ['rig'], kind: 'sim' })]);
  const host = childProcess.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    assert.ok(host.pid);
    const tag = 'nightly:gate:reference', at = new Date().toISOString();
    writeStateFile(f.project, '_leases.json', JSON.stringify({ leases: ['nightly:run', tag, 'rig'].map(resource => ({ resource,
      tag: resource === 'nightly:run' ? resource : tag, since: at, expires: at,
      acceptance: { pid: host.pid, unverified: true, nightly: true, ...(resource === tag ? { cap: 'sim' } : {}) } })) }));
    writeStateFile(f.project, '_nightly-gates.json', JSON.stringify({ runs: [], failures: {}, stuck: [
      { run: 'previous-run', gate: 'reference', tag, pid: 99999999, notBefore: 0, since: at, reason: 'Fixture tree was not confirmed gone.' },
    ] }));
    assert.equal(activeLeases(f.project, f.orders).length, 3);
    const result = await runNightlyGates(f.project, f.orders, { now: f.at(1, 12), commandOptions: { stopTree: async target => {
      assert.equal(target.pid, 99999999); return { gone: true, stopped: [] };
    } } });
    assert.equal(result.status, 'skipped');
    assert.deepEqual(gatesState(f.project).stuck, []);
    assert.deepEqual(readLeases(f.project), []);
    assert.equal(cancelNightlyRuns(f.project, f.orders).reason, undefined);
    assert.equal(startBlocked(f.project.resources!, activeLeases(f.project, f.orders), occupants(f.project, f.orders), { tag: 'NEXT', kind: 'sim', uses: ['rig'] }), undefined);
    assert.equal(acquireAcceptanceResources(f.project, f.orders, 'NEXT', ['rig', 'sim']), undefined);
    releaseAcceptanceResources(f.project, f.orders, 'NEXT');
    process.kill(host.pid, 0); // The host stays alive; only its confirmed-gone gate's leases were reclaimed.
  } finally {
    const exited = new Promise<void>(resolve => host.once('exit', () => resolve()));
    if (host.exitCode === null && host.signalCode === null) { host.kill(); await exited; }
  }
});

for (const backend of ['sqlite', 'files'] as const) test(`settling an old stuck tree keeps the lock of a batch started after it (${backend})`, async () => {
  const f = fixture(backend, [gate('reference', '', { uses: ['rig'], kind: 'sim' })]);
  const host = childProcess.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    assert.ok(host.pid);
    const tag = 'nightly:gate:reference', recorded = new Date(Date.now() - 3_600_000).toISOString(), later = new Date().toISOString();
    writeStateFile(f.project, '_leases.json', JSON.stringify({ leases: [
      { resource: tag, tag, since: recorded, expires: recorded, acceptance: { pid: host.pid, unverified: true, nightly: true, cap: 'sim' } },
      { resource: 'nightly:run', tag: 'nightly:run', since: later, expires: later, acceptance: { pid: host.pid, unverified: true, nightly: true } },
    ] }));
    writeStateFile(f.project, '_nightly-gates.json', JSON.stringify({ runs: [], failures: {}, stuck: [
      { run: 'previous-run', gate: 'reference', tag, pid: 99999999, notBefore: 0, since: recorded, reason: 'Fixture tree was not confirmed gone.' },
    ] }));
    const result = await runNightlyGates(f.project, f.orders, { now: f.at(1, 12), commandOptions: { stopTree: async () => ({ gone: true, stopped: [] }) } });
    assert.equal(result.status, 'skipped');
    assert.deepEqual(gatesState(f.project).stuck, []);
    assert.deepEqual(readLeases(f.project).map(l => l.tag), ['nightly:run'], 'the newer batch keeps its lock; only the old gate lease is released');
  } finally {
    const exited = new Promise<void>(resolve => host.once('exit', () => resolve()));
    if (host.exitCode === null && host.signalCode === null) { host.kill(); await exited; }
  }
});

for (const backend of ['sqlite', 'files'] as const) test(`gate persistence preserves interleaved state additions and removals (${backend})`, async () => {
  const f = fixture(backend), before = { run: 'old-run', gate: 'old', tag: 'nightly:gate:old', pid: 99999999, notBefore: 0,
    since: new Date().toISOString(), reason: 'Fixture pending tree.', retryAt: Date.now() + 3_600_000 };
  writeStateFile(f.project, '_nightly-gates.json', JSON.stringify({ runs: [], failures: {}, stuck: [before] }));
  let interleaved = false;
  const checkpoint = { commit: 'other-commit', at: new Date().toISOString() };
  const result = await runNightlyGates(f.project, f.orders, { force: true, commandOptions: {
    lookupStartedAt: async () => undefined, snapshot: async () => [], stopTree: async () => ({ gone: true, stopped: [] }),
    onMembers: () => {
      if (interleaved) return;
      interleaved = true;
      // An independent writer commits while this invocation is awaiting its gate command.
      stateTransaction(f.project, () => {
        const state = gatesState(f.project), current = state.runs[0];
        state.stuck = [{ ...before, run: 'other-run', gate: 'other', tag: 'nightly:gate:other' }];
        state.notices = { 'Other process notice': '2026-01-01' };
        state.runs.push({ ...current, id: 'other-run', status: 'waiting', reason: 'Other process update.' });
        state.failures.other = { run: 'other-run', mergedOrders: [], result: { gate: 'other', commit: current.commit,
          started: current.started, ended: current.started, status: 'failed', exit: 1, timedOut: false, log: 'other.log' } };
        state.lastFull = checkpoint; state.lastPass = checkpoint;
        writeStateFile(f.project, '_nightly-gates.json', JSON.stringify(state));
      });
    },
  } });
  assert.equal(interleaved, true); assert.equal(result.status, 'passed');
  const state = gatesState(f.project);
  assert.deepEqual(state.stuck?.map(s => s.run), ['other-run'], 'preserve the addition without resurrecting the removed tree');
  assert.deepEqual(state.notices, { 'Other process notice': '2026-01-01' });
  assert.equal(state.runs.find(r => r.id === 'other-run')?.reason, 'Other process update.');
  assert.equal(state.runs.find(r => r.id === result.run?.id)?.status, 'passed');
  assert.equal(state.failures.other.run, 'other-run');
  assert.deepEqual(state.lastFull, checkpoint); assert.deepEqual(state.lastPass, checkpoint);
  noScratch(f);
});

test('a state read failure after lock acquisition releases the lock and renewal timer', async t => {
  const f = fixture(), store = stateStore(f.project);
  assert.ok(store instanceof SqliteStore);
  const read = store.readMeta.bind(store), clear = t.mock.method(globalThis, 'clearInterval');
  let failed = false;
  t.mock.method(store, 'readMeta', (key: string) => {
    if (key === 'nightly-gates' && !failed && readLeases(f.project).some(l => l.tag === 'nightly:run')) {
      failed = true; throw new Error('Fixture post-lock state read failure.');
    }
    return read(key);
  });
  const result = await runNightlyGates(f.project, f.orders, { force: true });
  assert.equal(failed, true); assert.equal(result.status, 'error'); assert.match(result.reason!, /post-lock state read/);
  assert.deepEqual(readLeases(f.project), []);
  assert.equal(clear.mock.callCount(), 1);
});

test('command member snapshots back off from five to thirty seconds after the first minute', async t => {
  let pid: number | undefined, snapshots = 0;
  let firstSnapshot!: () => void;
  const observed = new Promise<void>(resolve => { firstSnapshot = resolve; });
  const job = gateCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], process.cwd(), 120_000, undefined, child => {
    if (pid) return;
    pid = child;
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  }, { lookupStartedAt: async () => undefined, snapshot: async () => { snapshots++; firstSnapshot(); return []; }, stopTree: async () => ({ gone: true, stopped: [] }) });
  try {
    await observed;
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    await flush();
    for (let i = 0; i < 12; i++) { t.mock.timers.tick(5000); await flush(); }
    assert.equal(snapshots, 13, 'initial snapshot plus five-second samples through the first minute');
    t.mock.timers.tick(29_999); await flush(); assert.equal(snapshots, 13);
    t.mock.timers.tick(1); await flush(); assert.equal(snapshots, 14);
    t.mock.timers.tick(30_000); await flush(); assert.equal(snapshots, 15);
  } finally {
    t.mock.timers.reset();
    if (pid) process.kill(pid);
    await job;
  }
});
