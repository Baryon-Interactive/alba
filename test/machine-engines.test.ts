import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capabilityCommand, parseCapabilities, suggestRoles } from '../src/machines/capabilities.ts';
import { ENGINE_IDS, engineModule } from '../src/machines/engines/index.ts';
import { splitParts, unrealPlan } from '../src/machines/engines/unreal-install.ts';
import { validateMachines, type Machine } from '../src/machines/config.ts';
import { machinesView, probeMachines, scanCapabilities } from '../src/machines/probe.ts';
import { InstallRefused, installPlan } from '../src/machines/install.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { validateProject } from './state-helper.ts';

const machine = (os: Machine['os'] = 'windows', engine?: string): Machine => ({ id: 'box', name: 'Box', os, connect: { local: true }, hardware: {}, roles: [], slots: 1, min_free_mem_gb: 0, timing_allowed: false, services: [], ...(engine ? { engine } : {}) });
const unpack = (argv: string[]) => {
  const loader = Buffer.from(argv.at(-1)!, 'base64').toString('utf16le');
  const packed = /FromBase64String\('([^']+)'\)/.exec(loader);
  return packed ? gunzipSync(Buffer.from(packed[1], 'base64')).toString('utf8') : loader;
};
const now = new Date('2026-01-02T00:00:00Z');
const generic = JSON.stringify({ cpu: 'Sample CPU', threads: 16, cores: 8, ram: 32, os: 'Sample OS', gpus: [], tools: { git: '2.45', cmake: '3.30', clang: '19.1', dotnet: '9.0', docker: '27.1' } });

test('generic commands and parsed results have no engine fields or engine installation probes', () => {
  for (const platform of ['windows', 'linux', 'macos'] as const) {
    const command = capabilityCommand(platform);
    const script = platform === 'windows' ? unpack(command) : command.at(-1)!;
    assert.doesNotMatch(script, /Unreal|EpicGames|UBA|Unity|Godot|vswhere|Windows Kits/i);
    for (const tool of ['git', 'cmake', 'node', 'dotnet', 'docker']) assert.ok(script.includes(tool));
  }
  const caps = parseCapabilities(generic, now.toISOString());
  assert.deepEqual(Object.keys(caps).sort(), ['at', 'cores', 'cpu', 'gpus', 'os_version', 'ram_gb', 'threads', 'tools']);
  assert.deepEqual(suggestRoles('windows', caps).roles.map(r => r.role), []);
  assert.deepEqual(suggestRoles('windows', { ...caps, tools: {} }).missing.map(m => m.item), []);
});

test('engine modules generate platform commands and reject incomplete scans', () => {
  assert.deepEqual(ENGINE_IDS, ['unreal', 'unity', 'godot']);
  for (const id of ENGINE_IDS) {
    const module = engineModule(id)!;
    for (const platform of ['windows', 'linux', 'macos'] as const) {
      const argv = module.command(platform);
      const script = platform === 'windows' ? unpack(argv) : argv.at(-1)!;
      assert.ok(script.length > 60);
      if (platform === 'windows' && process.platform === 'win32') {
        // Parse the generated PowerShell, never execute its probe or installation commands.
        const check = '$script=[Console]::In.ReadToEnd(); $tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseInput($script,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}';
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', check], { input: script });
      } else if (process.platform !== 'win32' && platform !== 'windows') execFileSync('sh', ['-n'], { input: script });
      assert.throws(() => module.parse('incomplete', platform));
    }
  }
  assert.match(unpack(engineModule('unreal')!.command('windows')), /vswhere|Windows Kits/);
  assert.match(unpack(engineModule('unity')!.command('windows')), /Unity\\Hub\\Editor/);
  assert.match(engineModule('unity')!.command('macos').at(-1)!, /Unity\.app/);
  assert.match(engineModule('godot')!.command('linux').at(-1)!, /godot4/);
});

test('modules parse editor versions, Unreal toolsets, and explicit platform limitations', () => {
  for (const id of ['unity', 'godot']) {
    const module = engineModule(id)!;
    const result = module.parse('4.4.1.stable\n4.4.1.stable\nend\n', 'linux');
    assert.deepEqual(result.versions, ['4.4.1.stable']);
    assert.deepEqual(module.suggest('linux', result).roles.map(r => r.role), ['package']);
    assert.equal(module.suggest('macos', module.parse('end\n', 'macos')).missing[0].item, undefined);
  }
  const unreal = engineModule('unreal')!;
  const result = unreal.parse(JSON.stringify({ versions: ['5.8'], uba: true, msvc: null, toolsets: ['14.44'], sdk: ['10.0.26100'] }), 'windows');
  assert.deepEqual(result.features.MSVC, ['toolset 14.44']);
  assert.deepEqual(unreal.suggest('windows', result).roles.map(r => r.role), ['package', 'compile-helper']);
  const missing = unreal.suggest('windows', unreal.parse('{}', 'windows')).missing;
  assert.deepEqual([...new Set(missing.map(m => m.item))], ['unreal', 'msvc', 'windows-sdk']);
  const linux = unreal.parse('version\t5.8.1\nend\n', 'linux');
  assert.equal(linux.unsupported?.length, 3);
  assert.deepEqual(unreal.suggest('linux', linux).roles.map(r => r.role), ['package']);
});

test('scanning runs exactly the selected module and isolates its failures from generic information', async () => {
  for (const engine of [undefined, 'unreal', 'unity', 'godot']) {
    const commands: string[][] = [];
    const probes = { now: () => now, runCommand: (argv: string[]) => { commands.push(argv); return commands.length === 1 ? generic : engine === 'unreal' ? '{"versions":["5.8"],"uba":true,"msvc":["17.1"],"sdk":["10.0"]}' : '4.4.1\nend\n'; } };
    const caps = await scanCapabilities(machine('windows', engine), probes);
    assert.equal(commands.length, engine ? 2 : 1);
    assert.deepEqual(Object.keys(caps.engines ?? {}), engine ? [engine] : []);
    assert.equal(caps.tools.docker, '27.1');
  }
  let calls = 0;
  const caps = await scanCapabilities(machine('windows', 'godot'), { now: () => now, runCommand: () => { if (++calls === 1) return generic; throw new Error('private output'); } });
  assert.equal(caps.error, undefined);
  assert.equal(caps.engines?.godot.error, 'Engine scan failed.');
  assert.doesNotMatch(JSON.stringify(caps), /private output/);
});

test('project selection, machine overrides, cache filtering and config changes trigger fresh module scans', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-engines-'));
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: dir, engine: 'unreal' }, path.join(dir, 'alba.yaml'));
  const config = validateMachines({ machines: [machine()] });
  let moduleScans = 0;
  const health = JSON.stringify({ free_mem_gb: 20, total_mem_gb: 32, load: .1, uptime_seconds: 60, disks: [], services: [] });
  const probes = { now: () => now, runCommand: (argv: string[]) => {
    const script = unpack(argv);
    if (script.includes('free_mem_gb')) return health;
    if (script.includes('Win32_Processor')) return generic;
    moduleScans++;
    return script.includes('EpicGames') ? '{"versions":["5.8"],"uba":true,"msvc":["17.1"],"sdk":["10.0"]}' : '4.4.1\nend\n';
  } };
  let [view] = await probeMachines(project, probes, { config });
  assert.deepEqual(Object.keys(view.capabilities!.engines!), ['unreal']);
  assert.ok(view.suggestions.roles.some(r => r.role === 'compile-helper'));
  config.machines[0].engine = 'godot';
  [view] = await probeMachines(project, probes, { config });
  assert.deepEqual(Object.keys(view.capabilities!.engines!), ['godot']);
  assert.equal(moduleScans, 2);
  delete config.machines[0].engine; delete project.engine;
  [view] = machinesView(project, config, now);
  assert.equal('engines' in view.capabilities!, false);
  assert.equal(view.suggestions.roles.some(r => r.role === 'compile-helper' || r.role === 'package'), false);
  writeStateFile(project, '_machines-capabilities.json', JSON.stringify({ box: parseCapabilities(generic, now.toISOString()) }));
  assert.throws(() => validateMachines({ machines: [{ ...machine(), engine: 'unknown' }] }), /engine/);
  writeStateFile(project, '_machines-capabilities.json', JSON.stringify({ box: { ...parseCapabilities(generic, now.toISOString()), unreal: ['5.8'], uba: true, msvc: ['17.1'], windows_sdk: ['10.0'], engines: { unreal: { versions: ['5.8'], features: {} } } } }));
  const canonical = machinesView(project, config, now)[0];
  assert.deepEqual(canonical.capabilities, parseCapabilities(generic, now.toISOString()), 'unselected and noncanonical stored engine fields never escape through the API');
  assert.equal(canonical.suggestions.roles.some(r => r.role === 'package' || r.role === 'compile-helper'), false);
});

test('every generic installer generates OS-specific commands without running package managers', () => {
  for (const item of ['git', 'cmake', 'compiler']) {
    for (const platform of ['windows', 'linux', 'macos'] as const) {
      const plan = installPlan({ ...machine(platform), connect: { ssh: 'box' } }, item);
      assert.equal(plan.steps.length, 1);
      assert.ok('argv' in plan.steps[0]);
      assert.equal(plan.steps[0].argv[0], 'ssh');
      const command = plan.steps[0].argv.at(-1)!;
      assert.match(plan.display.join('\n'), platform === 'windows' ? /winget/ : platform === 'linux' ? /apt-get[\s\S]*dnf/ : /brew install/);
      if (platform === 'windows') {
        assert.ok(command.length < 8191, 'compressed script stays under cmd.exe limit');
        const script = unpack(command.split(' '));
        assert.match(script, /SYSTEM/); assert.match(script, /Microsoft.VCLibs/); assert.match(script, /Microsoft.UI.Xaml/);
        assert.match(script, /finally \{ Unregister-ScheduledTask/);
      } else if (platform === 'macos') {
        assert.match(command, /Homebrew is not installed/);
        assert.doesNotMatch(command, /sudo|apt-get|dnf/);
      }
    }
  }
  assert.throws(() => installPlan(machine(), 'msvc'), InstallRefused);
  assert.match(installPlan(machine('windows', 'unreal'), 'msvc').display[0], /VCTools/);
  assert.throws(() => installPlan(machine('linux', 'unreal'), 'unreal'), InstallRefused);
});

test('engine copy partitions cover every file once with eight balanced gzip streams', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-parts-'));
  for (let i = 0; i < 80; i++) { const folder = path.join(dir, 'Engine', 'part-' + i % 4); mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, 'file-' + i), 'x'); }
  const groups = splitParts(dir, 8);
  assert.equal(groups.length, 8);
  assert.equal(new Set(groups.flat()).size, 80);
  assert.equal(groups.every(g => g.length === 10), true);
  if (process.platform === 'win32') {
    const drive = path.parse(dir).root.slice(0, 2);
    const plan = unrealPlan({ ...machine('windows', 'unreal'), connect: { ssh: 'box' } }, { ueSource: { version: '5.8', dir, parts: groups }, dest: drive + '\\Engines\\UE_5.8' });
    assert.equal(plan.lock, 'copy-unreal');
    const copy = plan.steps[1]; assert.ok('pipes' in copy); assert.equal(copy.pipes.length, 8);
    for (const stream of copy.pipes) assert.equal(stream.from[1], '-czf');
  }
});
