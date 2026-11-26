import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { alba, projectDir } from './cli-helper.ts';
import { tmpDir } from './tmp.ts';

const windows = process.platform === 'win32';
const fixture = fileURLToPath(new URL('./fixtures/release-engine.mjs', import.meta.url));
const main = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

function executable(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const contents = windows ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`;
  writeFileSync(file, contents, { mode: 0o755 });
  return file.replaceAll('\\', '/');
}

function setup(t: TestContext, engine: string, yaml: string) {
  const root = tmpDir('alba release cli ');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trace = path.join(root, 'trace.jsonl');
  const exe = executable(path.join(root, windows ? 'fake engine.cmd' : 'fake engine'));
  const file = projectDir(root, `engine: ${engine}\nrelease:\n  version: 1.2.0\n  targets: [windows-x64]\n${yaml.replaceAll('<exe>', exe)}`);
  const run = (args: string[], env: Record<string, string> = {}) => alba(file, ['release', ...args], { DEMO_RELEASE_TRACE: trace, ...env });
  const targetDir = (version = '1.2.0', target = 'windows-x64') => path.join(root, 'builds', 'release', version, target);
  const report = (version?: string, target?: string) => JSON.parse(readFileSync(path.join(targetDir(version, target), 'release.json'), 'utf8'));
  const log = (version?: string) => readFileSync(path.join(targetDir(version), 'build.log'), 'utf8');
  const calls = () => readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { root, trace, run, targetDir, report, log, calls };
}

test('Unity plan and template installation, release, audit and engine exit codes', t => {
  const { root, trace, run, targetDir, report, log, calls } = setup(t, 'unity', '  unity: {editor: "<exe>", scripting_backend: mono}\n');
  const planned = run(['plan', '--target', 'windows-x64', '--target', 'web-wasm32']);
  assert.equal(planned.code, 0, planned.err);
  const plan = JSON.parse(planned.out);
  assert.deepEqual(plan.map((row: { target: string }) => row.target), ['windows-x64', 'web-wasm32']);
  assert.ok(!plan[1].args.includes('-albaBackend'));
  assert.match(plan[1].notices[0], /always uses IL2CPP/);
  assert.equal(run(['build', '--dry-run']).code, 0);
  assert.ok(!existsSync(trace) && !existsSync(targetDir()));

  const template = path.join(root, 'Assets', 'Editor', 'Alba', 'AlbaReleaseBuild.cs');
  assert.equal(run(['init-unity']).code, 0);
  const installed = readFileSync(template, 'utf8');
  assert.match(installed, /namespace Alba\.Release/);
  assert.equal(run(['init-unity']).code, 0);
  writeFileSync(template, 'Edited fixture');
  assert.match(run(['init-unity']).err, /--force/);
  assert.equal(readFileSync(template, 'utf8'), 'Edited fixture');
  assert.equal(run(['init-unity', '--force']).code, 0);
  assert.equal(readFileSync(template, 'utf8'), installed);

  const result = run(['build']);
  assert.equal(result.code, 1, result.err);
  assert.match(result.out, /mono-assemblies/);
  assert.deepEqual(calls()[0].args, plan[0].args);
  assert.deepEqual(plan[0].args.slice(0, 11), ['-batchmode', '-nographics', '-quit', '-projectPath', root, '-buildTarget', 'Win64',
    '-executeMethod', 'Alba.Release.AlbaReleaseBuild.Build', '-logFile', path.join(targetDir(), 'build.log')]);
  assert.equal(report().exit_code, 0);
  assert.equal(report().audit.findings[0].id, 'mono-assemblies');
  assert.equal(report().audit.summary.fail, 1);
  assert.match(log(), /Unity editor log/);
  assert.match(log(), /Finished unity/);
  const standalone = spawnSync(process.execPath, [main, 'release', 'audit', path.join(targetDir(), 'game'), '--json'],
    { env: { ...process.env, ALBA_PROJECT: '', ALBA_LANG: 'en' }, encoding: 'utf8' });
  assert.equal(standalone.status, 1, standalone.stderr);
  assert.equal(JSON.parse(standalone.stdout).engine, 'unity');
  assert.match(run(['build']).out, /already exists/);
  assert.equal(calls().length, 1);

  const failed = run(['build', '--version', '1.2.1'], { DEMO_RELEASE_FAIL: '1' });
  assert.equal(failed.code, 1, failed.err);
  assert.equal(report('1.2.1').exit_code, 7);
  assert.match(log('1.2.1'), /Fixture engine failed/);
  const skipped = run(['build', '--version', '1.2.2', '--skip-audit']);
  assert.equal(skipped.code, 0, skipped.err);
  assert.match(skipped.err, /audit skipped/);
  assert.deepEqual(report('1.2.2').audit, { skipped: true });
});

test('Unreal UAT requires Crypto settings and masks their key in the log', t => {
  const { root, trace, run, calls, targetDir, report, log } = setup(t, 'unreal', '  unreal: {engine_root: "Fake Engine"}\n');
  executable(path.join(root, 'Fake Engine', 'Engine', 'Build', 'BatchFiles', windows ? 'RunUAT.bat' : 'RunUAT.sh'));
  writeFileSync(path.join(root, 'Demo.uproject'), '{}');
  const missing = run(['build']);
  assert.equal(missing.code, 1, missing.err);
  assert.match(missing.out + missing.err, /Project Settings > Crypto/);
  assert.ok(!existsSync(trace));
  mkdirSync(path.join(root, 'Config'));
  const key = 'invented-encryption-value';
  writeFileSync(path.join(root, 'Config', 'DefaultCrypto.ini'), `[/Script/CryptoKeys.CryptoKeysSettings]\nbEnablePakIndexEncryption=True\nEncryptionKey=${key}\nbEnablePakSigning=True\nSigningModulus=fixture-modulus\nSigningPublicExponent=fixture-public\nSigningPrivateExponent=fixture-private\n`);
  const ready = run(['build', '--version', '2.0.0']);
  assert.equal(ready.code, 0, ready.out + ready.err);
  const dir = targetDir('2.0.0');
  assert.deepEqual(calls()[0].args, ['BuildCookRun', `-project=${path.join(root, 'Demo.uproject')}`, '-platform=Win64',
    '-clientconfig=Shipping', '-build', '-cook', '-stage', '-pak', '-iostore', '-package', '-archive', `-archivedirectory=${path.join(dir, 'game')}`, '-nodebuginfo', '-utf8output']);
  assert.deepEqual(report('2.0.0').audit.summary, { fail: 0, warn: 0 });
  assert.match(log('2.0.0'), /Crypto key from editor: <redacted>/);
  assert.ok(![ready.out, ready.err, log('2.0.0'), JSON.stringify(report('2.0.0'))].some(value => value.includes(key)));
});

test('Godot secrets stay out of release output and Vesper is local and opt-in', t => {
  const { root, run, calls, targetDir, report, log } = setup(t, 'godot',
    '  godot: {executable: "<exe>", preset: {windows-x64: Windows Desktop}, encryption_key_env: DEMO_GODOT_KEY}\n  vesper: {app_id: demo.game}\n');
  executable(path.join(root, windows ? 'vesper.cmd' : 'vesper'));
  const key = 'ABC01234'.repeat(8);
  const env = { DEMO_GODOT_KEY: key, PATH: root + path.delimiter + process.env.PATH };
  const plan = run(['plan'], { DEMO_GODOT_KEY: '' });
  assert.equal(plan.code, 0, plan.out + plan.err);
  assert.equal(JSON.parse(plan.out)[0].env.GODOT_SCRIPT_ENCRYPTION_KEY, '<from $DEMO_GODOT_KEY>');
  const built = run(['build'], env);
  assert.equal(built.code, 0, built.out + built.err);
  assert.match(built.out, /vesper pack/);
  assert.match(built.err, /export templates/);
  assert.match(log(), /Godot key: <redacted>/);
  assert.match(log(), /Godot key again: <redacted>/);
  assert.equal(calls().length, 1);
  assert.deepEqual(calls()[0], { engine: 'godot', args: ['--headless', '--export-release', 'Windows Desktop', path.join(targetDir(), 'game', 'Demo.exe')],
    cwd: root, mappedKey: true, sourceKey: false });
  const packed = run(['build', '--version', '3.0.0', '--vesper-pack'], env);
  assert.equal(packed.code, 0, packed.out + packed.err);
  const payload = path.join(targetDir('3.0.0'), 'game');
  assert.deepEqual(calls().at(-1), { engine: 'vesper', args: ['pack', '--input', payload, '--output', `${payload}-vesper`, '--app-id', 'demo.game',
    '--platform', 'windows-x64', '--version', '3.0.0', '--release-tag', 'v3.0.0-windows-x64'], cwd: root, mappedKey: false, sourceKey: false });
  for (const content of [plan.out, built.out, built.err, packed.out, packed.err, log(), JSON.stringify(report())]) {
    assert.ok(!content.toLowerCase().includes(key.toLowerCase()));
  }
  assert.equal(report().command.env.GODOT_SCRIPT_ENCRYPTION_KEY, '<from $DEMO_GODOT_KEY>');
});
