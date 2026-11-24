import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, watch, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { validateProject } from '../src/config.ts';
import { gatesConfig } from '../src/gates/config.ts';
import { nightlyWindow, runNightlyGates } from '../src/gates/runner.ts';
import { gatesState, gatesStatus } from '../src/gates/state.ts';
import { producerCases, intakeProducer } from '../src/producer/producer.ts';
import { producerLog } from '../src/producer/activity.ts';
import { acceptanceLeaseActive, acquireAcceptanceResources, acquireLeases, activeLeases, ensureOwnStartedAt, leaseProcessIdentity, readLeases, releaseAcceptanceResources, startBlocked, occupants, type StoredLease } from '../src/resources/leases.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { alba } from './cli-helper.ts';
import { createBoard } from '../src/web/server.ts';
import { startCoordinator } from '../src/serve/coordinator.ts';
import { validateWorkers } from '../src/workers/config.ts';
import type { Probes } from '../src/tick/gather.ts';
import { fixture, gate, noScratch, runFixtureGates, until } from './nightly-gates-fixture.ts';

test('local windows include start, exclude end and count an overnight window as one night', () => {
  assert.equal(nightlyWindow('01:00-06:00', new Date(2026, 0, 1, 1)).inside, true);
  assert.equal(nightlyWindow('01:00-06:00', new Date(2026, 0, 1, 6)).inside, false);
  assert.deepEqual(nightlyWindow('23:00-04:00', new Date(2026, 0, 2, 2)), { inside: true, night: '2026-01-01' });
});

for (const backend of ['sqlite', 'files'] as const) test(`nightly requires a merge and window, runs once, and skips unchanged next night (${backend})`, async () => {
  const f = fixture(backend);
  assert.equal((await runFixtureGates(f.project, f.orders, { now: f.at() })).status, 'skipped');
  const commit = f.merge();
  assert.match((await runFixtureGates(f.project, f.orders, { now: f.at(1, 12) })).reason!, /window/);
  const result = await runFixtureGates(f.project, f.orders, { now: f.at() });
  assert.equal(result.status, 'passed', result.reason); assert.equal(result.run?.commit, commit);
  assert.deepEqual(result.run?.mergedOrders, ['DEMO-A']);
  assert.equal((await runFixtureGates(f.project, f.orders, { now: f.at() })).status, 'skipped');
  assert.equal((await runFixtureGates(f.project, f.orders, { now: f.at(2) })).status, 'skipped');
  f.merge('DEMO-B'); assert.equal((await runFixtureGates(f.project, f.orders, { now: f.at(2) })).status, 'passed'); noScratch(f);
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
  assert.match((await runFixtureGates(f.project, f.orders, { now: f.at() })).reason!, /held by order/);
  f.orders.runEnd('HOLDER'); f.orders.act('HOLDER', 'cancel');
  acquireAcceptanceResources(f.project, f.orders, 'TRIAL', ['rig']);
  assert.match((await runFixtureGates(f.project, f.orders, { now: f.at() })).reason!, /held by job TRIAL/);
  releaseAcceptanceResources(f.project, f.orders, 'TRIAL');
  f.orders.add({ tag: 'QUEUED', title: 'Queued simulation', kind: 'sim' }); f.orders.act('QUEUED', 'queue');
  assert.match((await runFixtureGates(f.project, f.orders, { now: f.at() })).reason!, /priority/);
  f.orders.act('QUEUED', 'cancel');
  assert.match((await runFixtureGates(f.project, f.orders, { now: f.at(), ordersFirst: true })).reason!, /priority/);
  acquireAcceptanceResources(f.project, f.orders, 'TRIAL', ['sim']);
  assert.match((await runFixtureGates(f.project, f.orders, { now: f.at() })).reason!, /cap/i);
  releaseAcceptanceResources(f.project, f.orders, 'TRIAL');
  assert.equal((await runFixtureGates(f.project, f.orders, { now: f.at() })).status, 'passed'); noScratch(f);
});

test('failure attribution starts at the last full pass, one case survives intake and a later pass closes it', async () => {
  const f = fixture(); f.merge('DEMO-A');
  await runFixtureGates(f.project, f.orders, { now: f.at() });
  const from = gatesState(f.project).lastPass!.commit;
  f.project.gates!.nightly = [gate('reference', 'console.error("regression"); process.exit(4)')];
  f.merge('DEMO-B'); const commit = f.merge('DEMO-C');
  const failed = await runFixtureGates(f.project, f.orders, { now: f.at(2) });
  assert.equal(failed.status, 'failed'); assert.equal(failed.run?.results[0].exit, 4);
  let cases = producerCases(f.project, true).filter(c => c.trigger === 'nightly-gate-failed');
  assert.equal(cases.length, 1); assert.equal(cases[0].facts.from, from); assert.equal(cases[0].facts.commit, commit);
  assert.deepEqual(cases[0].facts.mergedOrders, ['DEMO-B', 'DEMO-C']);
  intakeProducer(f.project, f.orders, { verify: false });
  await runFixtureGates(f.project, f.orders, { force: true });
  cases = producerCases(f.project, true).filter(c => c.trigger === 'nightly-gate-failed'); assert.equal(cases.length, 1);
  assert.match(readFileSync(failed.run!.results[0].log, 'utf8'), /regression/);
  assert.equal(producerLog(f.project, f.orders).rows.filter(r => r.kind === 'nightly-gates').length, 3);
  f.project.gates!.nightly = [gate()];
  assert.equal((await runFixtureGates(f.project, f.orders, { force: true })).status, 'passed');
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
  const result = await runFixtureGates(f.project, f.orders, { force: true });
  assert.equal(result.status, 'passed', JSON.stringify(result)); assert.equal(result.run?.commit, commit);
  assert.deepEqual(result.run?.results.map(r => r.value), [7, 8, 9]); assert.equal(readFileSync(path.join(f.root, 'input.txt'), 'utf8'), 'dirty');
  f.project.gates!.nightly = [gate('bad', 'console.log("invalid")', { result: { pass: { json_pointer: '/ok' } } })];
  assert.equal((await runFixtureGates(f.project, f.orders, { force: true })).status, 'error'); noScratch(f);
});

test('active gates reserve resources and caps, concurrent invocations wait and queued work takes the next turn', async () => {
  const f = fixture('sqlite', [gate('first', 'setTimeout(()=>console.log("ok"),150)', { kind: 'sim', uses: ['rig'] }), gate('second')]); f.merge();
  let pending = false;
  const job = runFixtureGates(f.project, f.orders, { now: f.at(), ordersFirst: () => pending });
  await until(() => activeLeases(f.project, f.orders).some(l => l.acceptance?.cap === 'sim'));
  assert.equal(activeLeases(f.project, f.orders).filter(l => l.acceptance?.cap === 'sim').length, 1);
  assert.ok(startBlocked(f.project.resources!, activeLeases(f.project, f.orders), occupants(f.project, f.orders), { tag: 'ORDER', kind: 'sim', uses: ['rig'] }));
  assert.equal((await runFixtureGates(f.project, f.orders, { force: true })).status, 'waiting');
  pending = true; assert.equal((await job).status, 'waiting'); noScratch(f);
  const resumed = await runFixtureGates(f.project, f.orders, { now: f.at() });
  assert.equal(resumed.status, 'passed'); assert.equal(resumed.run?.results.length, 2); assert.equal(gatesState(f.project).runs.length, 1); noScratch(f);
});

test('a gate named run cannot release the batch lock before the next gate finishes', { timeout: 120_000 }, async t => {
  const f = fixture('sqlite', [gate('run'), gate('slow')]);
  const ready = path.join(f.dir, 'slow-started'), release = path.join(f.dir, 'slow-release');
  f.project.gates!.nightly[1]!.argv = [process.execPath, '-e', `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);}},20);`];
  const watcher = watch(f.dir, { signal: t.signal });
  const job = runFixtureGates(f.project, f.orders, { force: true });
  try {
    // Hold a real gate at a filesystem handshake instead of racing a 300 ms sleep.
    while (!existsSync(ready)) await once(watcher, 'change', { signal: t.signal });
    assert.equal(gatesState(f.project).runs.at(-1)?.results.length, 1);
    assert.match((await runFixtureGates(f.project, f.orders, { force: true })).reason!, /already running/);
  } finally {
    watcher.close(); writeFileSync(release, 'release');
    assert.equal((await job).status, 'passed');
  }
  noScratch(f);
});

test('the last nights are retained and partial reruns do not advance the full checkpoint', async () => {
  const f = fixture('sqlite', [gate('first'), gate('second')]); f.project.gates!.only_if_merged = false;
  for (let day = 1; day <= 4; day++) assert.equal((await runFixtureGates(f.project, f.orders, { now: f.at(day), keepNights: 3 })).status, 'passed');
  const state = gatesState(f.project); assert.equal(state.runs.length, 3); assert.equal(state.runs[0].night, '2026-01-02');
  assert.equal(readdirSync(path.join(f.project.state_dir, 'nightly-gates')).length, 3);
  f.merge(); await runFixtureGates(f.project, f.orders, { now: f.at(4), force: true, gate: 'first', keepNights: 3 });
  assert.deepEqual(gatesState(f.project).lastFull, state.lastFull); assert.equal(gatesStatus(f.project)?.gates.length, 2); noScratch(f);
});

test('config defaults and strict validation, disabled projects have no state changes', async () => {
  const f = fixture();
  assert.equal(f.project.gates?.only_if_merged, true);
  for (const over of [{ nightly: [gate(), gate()] }, { window: '25:00-26:00' }, { window: '01:00-01:00' }, { only_if_merged: 'yes' }, { nightly: [gate('x', '', { cwd: '../outside' })] }, { nightly: [gate('x', '', { uses: ['missing'] })] }, { nightly: [gate('x', '', { kind: 'missing' })] }, { nightly: [gate('x', '', { timeout_minutes: 0 })] }, { nightly: [gate('x', '', { result: { pass: { regex: '[' } } })] }]) assert.throws(() => gatesConfig({ ...f.project.gates, ...over }, f.project), /gates/);
  delete f.project.gates;
  assert.equal((await runFixtureGates(f.project, f.orders, { force: true })).status, 'skipped'); assert.equal(gatesStatus(f.project), undefined);
  assert.equal(existsSync(path.join(f.project.state_dir, '_nightly-gates.json')), false);
});

test('forced daytime batches leave the coming scheduled night and merge checkpoint available', async () => {
  const f = fixture(); f.merge();
  const forced = await runFixtureGates(f.project, f.orders, { force: true, now: f.at(1, 12) });
  assert.equal(forced.status, 'passed'); assert.equal(forced.run?.forced, true);
  assert.equal(gatesState(f.project).lastFull, undefined);
  assert.equal((await runFixtureGates(f.project, f.orders, { now: f.at() })).status, 'passed');
  assert.equal((await runFixtureGates(f.project, f.orders, { now: f.at() })).status, 'skipped'); noScratch(f);
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
  assert.equal((await runFixtureGates(f.project, f.orders, { force: true })).status, 'passed'); noScratch(f);
});

test('batch lock covers the sum of multi-day gates and uses real expiry time', async () => {
  const f = fixture('sqlite', [gate('soak', 'setTimeout(()=>{},100)', { timeout_minutes: 4320 }), gate('second', '', { timeout_minutes: 4320 })]);
  const job = runFixtureGates(f.project, f.orders, { force: true, now: f.at() });
  await until(() => readLeases(f.project).some(l => l.tag === 'nightly:run'));
  const lock = readLeases(f.project).find(l => l.tag === 'nightly:run')!;
  assert.ok(Date.parse(lock.expires) - Date.now() > 144 * 3600000);
  assert.ok(Date.parse(lock.expires) - Date.now() > 145 * 3600000, 'budget both 30-minute worktree operations as well as all gates');
  assert.equal(acceptanceLeaseActive(lock), true);
  assert.equal((await job).status, 'passed'); noScratch(f);
});
