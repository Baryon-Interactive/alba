import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadProject } from '../src/config.ts';
import { tmpDir } from './tmp.ts';

test('project loader accepts release config and applies hardening defaults', t => {
  const root = tmpDir('alba-release-config-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'alba.yaml');
  const load = (release = '') => {
    writeFileSync(file, `id: demo\nname: Demo\nroot: .\nwork_orders: .\nstate_dir: state\nengine: unity\n${release}`);
    return loadProject(file);
  };
  assert.equal(load().release, undefined);
  const release = load(`release:
  version: 1.2.0
  targets: [windows-x64, web-wasm32]
  godot:
    preset: {windows-x64: Windows Desktop}
    encryption_key_env: DEMO_GODOT_KEY
  audit:
    allow: [{id: debug-symbols, reason: Internal symbol server}]
  vesper: {app_id: demo.game}
`).release!;
  assert.equal(release.output, 'builds/release');
  assert.equal(release.version, '1.2.0');
  assert.deepEqual(release.targets, ['windows-x64', 'web-wasm32']);
  assert.equal(release.unity.scripting_backend, 'il2cpp');
  assert.equal(release.unity.stripping, 'high');
  assert.equal(release.unreal.configuration, 'Shipping');
  assert.equal(release.unreal.encrypt_pak && release.unreal.sign_pak, true);
  assert.deepEqual(release.godot.preset, { 'windows-x64': 'Windows Desktop' });
  assert.equal(release.audit.allow[0]?.reason, 'Internal symbol server');
  assert.equal(release.vesper?.app_id, 'demo.game');

  for (const [yaml, key, message] of [
    ['unity: {extra: true}', 'unity.extra', 'unknown key'],
    ['targets: [bad-target]', 'targets[0]', 'windows-x64'],
    ['godot: {encryption_key: invented-value}', 'godot.encryption_key', 'literal secrets'],
    [`godot: {encryption_key_env: ${'a'.repeat(64)}}`, 'godot.encryption_key_env', 'literal secrets'],
    ['output: ../elsewhere', 'output', 'relative output path'],
    ['audit: {allow: [{id: debug-symbols}]}', 'audit.allow[0].reason', 'non-empty'],
  ]) {
    assert.throws(() => load(`release:\n  ${yaml}\n`), (error: Error) =>
      [file, `release.${key}`, message].every(part => error.message.includes(part)) && !error.message.includes('invented-value'));
  }
});
