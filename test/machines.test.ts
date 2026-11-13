import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { stringify } from 'yaml';
import { loadMachines, validateMachines } from '../src/machines/config.ts';
import { hostCheckCommand, machineCommand, machineProblems, machinesView, probeMachines, type MachineView } from '../src/machines/probe.ts';
import { capabilityCommand } from '../src/machines/capabilities.ts';
import { readStateJson } from '../src/orders/state-files.ts';
import { systemProbes, tick } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { scheduledRound } from '../src/producer/round.ts';
import { DEFAULT_NOTICE_TRIGGERS } from '../src/config.ts';
import { tempOrders } from './helpers.ts';
import { projectDir, alba } from './cli-helper.ts';
import { loadProject } from './state-helper.ts';
import { createBoard } from '../src/web/server.ts';

const machine = (id = 'build-box', os = 'windows') => ({ id, name: 'Build box', os, connect: { ssh: id }, roles: ['compile-helper'], min_free_mem_gb: 4,
  services: [{ id: 'agent', check: { process: 'compile-agent' }, start_hint: 'Open the compile helper.' }] });
const metrics = { free_mem_gb: 8, total_mem_gb: 32, load: 0.3, uptime_seconds: 3600, disks: [{ mount: 'system', free_gb: 30, total_gb: 100 }], services: [{ id: 'agent', up: true }] };
function fixture() {
  const { dir, orders } = tempOrders();
  const file = projectDir(dir, 'machines: machines.yaml\nproducer:\n  enabled: true\n  round: { enabled: true, every_minutes: 5 }\n');
  const project = loadProject(file), config = validateMachines({ machines: [machine(), machine('sim-linux', 'linux')] });
  writeFileSync(project.machines!, stringify(config));
  let now = new Date('2026-01-01T00:00:00Z');
  const calls: string[][] = [];
  const probes = { ...systemProbes, runCommandAsync: undefined, now: () => now, runCommand: (argv: string[], timeout: number) => { calls.push(argv); assert.ok(timeout >= 5); return JSON.stringify(metrics); },
    worktrees: () => [], freeRamGb: () => 32, gitActivity: () => ({}), tail: () => '', readText: () => undefined, isAlive: () => false };
  const workers = validateWorkers({ workers: [{ id: 'sample-worker', engine: 'fake', concurrency: 1 }] }, path.join(dir, 'workers.yaml'));
  return { dir, project, config, orders, probes, calls, workers, advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60000); } };
}
test('machine registry validates checks, unknown keys, SSH aliases and duplicates', () => {
  const good = { probe_minutes: 3, machines: [machine()] };
  assert.equal(validateMachines(good).probe_minutes, 3);
  assert.equal(validateMachines({ machines: [] }).probe_minutes, 5);
  for (const raw of [ { ...good, typo: true }, { machines: [{ ...machine(), password: 'forbidden' }] },
    { machines: [{ ...machine(), connect: { ssh: '-oProxyCommand=bad' } }] },
    { machines: [{ ...machine(), connect: { ssh: 'user@host' } }] },
    { machines: [{ ...machine(), services: [{ id: 'agent', check: { process: 'agent', tcp: 'build-box:80' } }] }] },
    { machines: [{ ...machine(), services: [{ id: 'agent', check: { command: [] } }] }] },
    { machines: [machine(), machine()] }, { machines: [{ ...machine(), slots: 1.5 }] }, { ...good, probe_minutes: 0 },
  ]) assert.throws(() => validateMachines(raw));
  assert.throws(() => validateMachines({ machines: [{ ...machine(), services: [{ id: 'web', check: { http: 'ftp://build-box/' } }] }] }));
});
test('registry precedence is environment, project, then workers sibling', () => {
  const f = fixture(), old = process.env.ALBA_MACHINES;
  try {
    assert.equal(loadMachines(f.project).machines.length, 2);
    const envFile = path.join(f.dir, 'other.yaml'); writeFileSync(envFile, 'machines: []'); process.env.ALBA_MACHINES = envFile;
    assert.equal(loadMachines(f.project).machines.length, 0);
    delete process.env.ALBA_MACHINES; delete f.project.machines;
    assert.equal(loadMachines(f.project, path.join(f.dir, 'workers.yaml')).machines.length, 2);
    process.env.ALBA_MACHINES = path.join(f.dir, 'missing.yaml'); assert.throws(() => loadMachines(f.project), /missing.yaml/);
  } finally { if (old === undefined) delete process.env.ALBA_MACHINES; else process.env.ALBA_MACHINES = old; }
});
test('Windows and Linux readings persist with one remote command per machine and throttle', async () => {
  const f = fixture();
  const views = await probeMachines(f.project, f.probes);
  // One health command per machine, plus the first capability scan of each (once a day afterwards).
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(c => c[0] === 'ssh' && c.includes('BatchMode=yes') && c.includes('ConnectTimeout=5')));
  assert.equal(views[0].latest?.total_mem_gb, 32);
  assert.equal(views[1].latest?.reachable, true);
  assert.equal(Object.keys(readStateJson(f.project, '_machines.json', {})).length, 2);
  f.advance(4); await probeMachines(f.project, f.probes); assert.equal(f.calls.length, 4);
  f.advance(1); await probeMachines(f.project, f.probes); assert.equal(f.calls.length, 6, 'health probes repeat; capability scans do not');
  assert.equal(machinesView(f.project, f.config, f.probes.now())[0].history.length, 2);
  await probeMachines(f.project, f.probes, { force: true, id: 'build-box' }); assert.equal(f.calls.length, 8, 'a forced probe rescans');
  await assert.rejects(() => probeMachines(f.project, f.probes, { force: true, id: 'missing' }), /Unknown machine/);
  f.advance(1441); await probeMachines(f.project, f.probes); assert.equal(machinesView(f.project, f.config, f.probes.now())[0].history.length, 1);
  assert.equal(f.calls.length, 12, 'a day later both machines are scanned again');
  assert.ok(machinesView(f.project, f.config, f.probes.now()).every(m => m.capabilities && Array.isArray(m.suggestions.roles)));
});
test('unreachable and unhealthy machines create tick problems and stable notice round cards', async () => {
  const f = fixture();
  f.probes.runCommand = argv => { if (argv.includes('sim-linux')) throw new Error('private command line must not be stored'); return JSON.stringify({ ...metrics, free_mem_gb: 1, disks: [{ mount: 'system', free_gb: 2, total_gb: 100 }], services: [{ id: 'agent', up: false }] }); };
  await probeMachines(f.project, f.probes); // ticks read stored readings and only start background refreshes
  const result = tick(f.project, f.orders, f.workers, f.probes, { record: true });
  const problems = result.report.problems.filter(p => p.kind === 'machine-down');
  assert.equal(problems.length, 4);
  assert.match(problems[0].text, /free memory.*below 10% free disk/);
  assert.equal(problems[1].text, 'machine build-box: service agent is down (process: compile-agent)');
  assert.equal(machinesView(f.project, f.config, f.probes.now())[1].latest?.reachable, false);
  assert.ok(!JSON.stringify(readStateJson(f.project, '_machines.json', {})).includes('private command'));
  const env = { probes: f.probes, workers: f.workers };
  const round = scheduledRound(f.project, f.orders, env)!;
  const cards = round.cases.filter(c => c.trigger === 'machine-down'); assert.equal(cards.length, 4);
  assert.equal(new Set(cards.map(c => c.key)).size, 4);
  assert.ok(DEFAULT_NOTICE_TRIGGERS.includes('machine-down'));
  f.advance(5); f.probes.runCommand = () => JSON.stringify(metrics); await probeMachines(f.project, f.probes);
  assert.equal(scheduledRound(f.project, f.orders, env)!.cases.filter(c => c.trigger === 'machine-down').length, 0);
});
test('shell protocol parses metrics and service status; local stays reachable after metric failure', async () => {
  const f = fixture();
  f.probes.runCommand = () => 'memory\t12\t32\nuptime\t300\nload\t0.5\ndisk\t/\t20\t100\nservice\tagent\t0\nend\n';
  const views = await probeMachines(f.project, f.probes);
  assert.equal(views[1].latest?.free_mem_gb, 12); assert.equal(machineProblems(views).length, 2);
  const local = validateMachines({ machines: [{ ...machine(), connect: { local: true } }] });
  f.probes.runCommand = () => { throw new Error('failed'); };
  const r = (await probeMachines(f.project, f.probes, { force: true, config: local }))[0].latest;
  assert.equal(r?.reachable, true); assert.ok(r?.error);
});
test('host network checks stay off SSH, have five-second limit and report down', async () => {
  const f = fixture();
  const config = validateMachines({ machines: [{ ...machine(), services: [{ id: 'web', check: { http: 'http://build-box/health' } }, { id: 'cache', check: { tcp: 'build-box:8123' } }] }] });
  let remote = 0, host = 0;
  f.probes.runCommand = (argv, seconds) => { if (argv[0] === 'ssh') { remote++; return JSON.stringify(metrics); } host++; assert.equal(seconds, 5); throw new Error('down'); };
  const views = await probeMachines(f.project, f.probes, { config });
  assert.equal(remote, 2, 'one health command and one capability scan'); assert.equal(host, 2); assert.equal(machineProblems(views).length, 2);
  const argv = hostCheckCommand({ tcp: '[::1]:8123' }); assert.match(argv.at(-1)!, /"host":"::1"/);
});
test('probe commands bound commands and never query full process command lines', () => {
  for (const os of ['windows', 'linux', 'macos']) {
    const m = validateMachines({ machines: [{ ...machine('build-box', os), services: [{ id: 'status', check: { command: ['status-tool', "a'b", 'space arg'] } }] }] }).machines[0];
    const command = machineCommand(m);
    assert.equal(command[0], 'ssh'); assert.doesNotMatch(command.join(' '), /CommandLine|ps aux|ps -ef/);
    if (os === 'windows') assert.match(Buffer.from(command.at(-1)!.split(' ').at(-1)!, 'base64').toString('utf16le'), /WaitForExit\(5000\)/);
    else assert.match(command.at(-1)!, /sleep 5/);
    const scan = capabilityCommand(os as 'windows' | 'linux' | 'macos');
    const text = os === 'windows' ? Buffer.from(scan.at(-1)!, 'base64').toString('utf16le') : scan.at(-1)!;
    assert.doesNotMatch(text, /CommandLine|Win32_Process\b|ps aux|ps -ef|\/proc\/(?:\d|self|\*)|cmdline|environ|Get-ChildItem Env:|printenv/);
  }
});
test('machines --json exposes registry, latest and history without probing', async () => {
  const f = fixture(); await probeMachines(f.project, f.probes);
  const response = alba(f.project.file, ['machines', '--json']); assert.equal(response.code, 0, response.err);
  const value = JSON.parse(response.out); assert.equal(value.project, 'demo'); assert.equal(value.machines.length, 2);
  assert.equal(value.machines[0].id, 'build-box'); assert.equal(value.machines[0].latest.free_mem_gb, 8);
  assert.ok(Array.isArray(value.machines[0].history));
  const missing = alba(f.project.file, ['machines', 'check', 'missing']);
  assert.notEqual(missing.code, 0); assert.match(missing.err, /Unknown machine/);
});

test('machines API serves saved readings without launching probes', async () => {
  const f = fixture(); await probeMachines(f.project, f.probes);
  const before = f.calls.length;
  const board = createBoard({ projects: [f.project], workers: f.workers, probes: f.probes, port: 0, hubCheckMs: 60000 });
  try {
    await new Promise<void>(resolve => board.server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${(board.server.address() as AddressInfo).port}/api/machines`, { headers: { 'x-alba-token': board.ctx.token } });
    assert.equal(response.status, 200);
    const value = await response.json() as { machines: MachineView[] };
    assert.equal(value.machines[0].latest?.free_mem_gb, 8);
    assert.equal(value.machines[0].history.length, 1);
    assert.equal(f.calls.length, before);
  } finally {
    board.hub.stop(); board.server.closeAllConnections();
    await new Promise<void>(resolve => board.server.close(() => resolve()));
  }
});

test('live Windows probe preserves argv and bounds service processes', { skip: process.platform !== 'win32' ? 'Requires the native Windows PowerShell/CIM probe and process service checks.' : false, timeout: 120000 }, async () => {
  const f = fixture(), pidFile = path.join(f.dir, 'check.pid');
  const args = ['space arg', 'a"b', '', 'trailing\\', 'space slash\\'];
  const exact = `process.exit(JSON.stringify(process.argv.slice(1))===${JSON.stringify(JSON.stringify(args))}?0:1)`;
  const config = validateMachines({ machines: [{ ...machine(), connect: { local: true }, services: [
    { id: 'self', check: { process: 'node.exe' } },
    { id: 'argv', check: { command: [process.execPath, '-e', exact, '--', ...args] } },
    { id: 'failed', check: { command: [process.execPath, '-e', 'process.exit(1)'] } },
    { id: 'timeout', check: { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},60000)`] } },
  ] }] });
  try {
    const view = (await probeMachines(f.project, systemProbes, { force: true, config }))[0];
    assert.equal(view.latest?.error, undefined);
    assert.ok(view.latest!.total_mem_gb! > 0); assert.ok(view.latest!.disks.length > 0);
    assert.deepEqual(view.latest!.services, [{ id: 'self', up: true }, { id: 'argv', up: true }, { id: 'failed', up: false }, { id: 'timeout', up: false }]);
    assert.ok(existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch { /* already stopped */ } }
  }
});
