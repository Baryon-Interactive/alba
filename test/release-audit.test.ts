import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { auditBuild } from '../src/release/audit.ts';
import { validateRelease } from '../src/release/config.ts';

function folder(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-release-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (relative: string, content: string | Buffer = '') => {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  return { dir, put };
}

test('audits Unity builds and records allowed findings', async t => {
  const { dir, put } = folder(t);
  put('Demo_Data/Managed/Demo.dll');
  put('Demo_Data/Managed/UnityEngine.CoreModule.dll');
  put('Demo_Data/Managed/mscorlib.dll');
  put('MonoBleedingEdge/runtime.dll');
  const mono = await auditBuild(dir);
  assert.equal(mono.engine, 'unity');
  assert.deepEqual(mono.summary, { fail: 1, warn: 0 });
  assert.deepEqual(mono.findings[0]?.files, ['Demo_Data/Managed/Demo.dll', 'MonoBleedingEdge']);
  assert.match(mono.findings[0]?.advice ?? '', /global-metadata\.dat/);

  const policy = validateRelease({ audit: { allow: [{ id: 'mono-assemblies', reason: 'Internal test build' }] } }, 'demo.yaml').audit;
  const allowed = await auditBuild(dir, 'unity', policy);
  assert.deepEqual(allowed.summary, { fail: 0, warn: 1 });
  assert.equal(allowed.findings[0]?.reason, 'Internal test build');

  const native = folder(t);
  native.put('GameAssembly.dll');
  native.put('Demo_Data/Managed/Demo.dll');
  assert.deepEqual(await auditBuild(native.dir), { engine: 'unity', findings: [], summary: { fail: 0, warn: 0 } });
  native.put('Temp/demo_BackUpThisFolder_ButDontShipItWithYourGame/info');
  native.put('demo_BurstDebugInformation_DoNotShip/info');
  native.put('Demo.pdb');
  native.put('Demo.dSYM/Contents/Info.plist');
  native.put('Build/Demo.wasm.br');
  const debug = await auditBuild(native.dir);
  assert.deepEqual(debug.findings.map(({ id, severity }) => [id, severity]), [
    ['debug-symbols', 'fail'], ['il2cpp-backup', 'fail'], ['web-build', 'warn'],
  ]);
  assert.deepEqual(debug.findings[0]?.files, ['Demo.dSYM', 'Demo.pdb']);
  assert.equal(debug.findings[1]?.files.length, 2);
});

test('scans text and chunked binary strings with masked excerpts', async t => {
  const { dir, put } = folder(t);
  put('.env', 'PRIVATE=never-include-this');
  put('data/test.pem', '-----BEGIN PRIVATE KEY-----\nnever-include-this');
  const fakeId = 'AKIA' + 'Z'.repeat(16);
  put('data/fixture.bin', Buffer.concat([Buffer.alloc(65530), Buffer.from(fakeId), Buffer.alloc(6)]));
  put('settings.toml', 'code = INVENTED-12345678');
  put('also.p12');
  const policy = validateRelease({ audit: { extra_secret_patterns: ['INVENTED-\\d{8}'] } }, 'demo.yaml').audit;
  const result = await auditBuild(dir, undefined, policy);
  assert.deepEqual(result.summary, { fail: 1, warn: 0 });
  assert.equal(result.findings[0]?.id, 'secrets');
  assert.deepEqual({ ...result.findings[0]?.excerpts }, {
    '.env': '.env***', 'also.p12': 'also***', 'data/fixture.bin': 'AKIA***', 'data/test.pem': '----***', 'settings.toml': 'INVE***',
  });
  const json = JSON.stringify(result);
  for (const value of [fakeId, 'never-include-this', 'INVENTED-12345678']) assert.equal(json.includes(value), false);
});

function pakFooter(version: number, encrypted: boolean, methods = 5): Buffer {
  const footer = Buffer.alloc(61 + methods * 32 + (version === 9 ? 1 : 0));
  footer[16] = +encrypted;
  footer.writeUInt32LE(0x5a6f12e1, 17);
  footer.writeUInt32LE(version, 21);
  footer.writeBigUInt64LE(16n, 33);
  return Buffer.concat([Buffer.alloc(16), footer]);
}

test('reads Unreal pak v8 to v11 and IoStore encryption flags', async t => {
  const { dir, put } = folder(t);
  put('paks/v8-four.pak', pakFooter(8, false, 4));
  put('paks/v8-five.pak', pakFooter(8, true));
  put('paks/v9.pak', pakFooter(9, false));
  put('paks/v10.pak', pakFooter(10, true));
  put('paks/v11.pak', pakFooter(11, true));
  put('paks/v11.sig');
  put('paks/truncated.pak', pakFooter(11, true).subarray(0, 51));
  const toc = Buffer.alloc(144);
  toc.write('-==--==--==--==-');
  toc.writeUInt32LE(144, 20);
  put('paks/clear.utoc', toc);
  toc[80] = 2;
  put('paks/encrypted.utoc', toc);
  const result = await auditBuild(dir);
  assert.equal(result.engine, 'unreal');
  const findings = Object.fromEntries(result.findings.map(finding => [finding.id, finding]));
  assert.deepEqual(findings['unencrypted-pak'].files, ['paks/clear.utoc', 'paks/v8-four.pak', 'paks/v9.pak']);
  assert.deepEqual(findings['pak-unreadable'].files, ['paks/truncated.pak']);
  assert.equal(findings['pak-unreadable'].severity, 'warn');
  assert.ok(findings['unsigned-pak'].files.includes('paks/v10.pak'));
  assert.ok(!findings['unsigned-pak'].files.includes('paks/v11.pak'));
  const unsignedAllowed = await auditBuild(dir, 'unreal', undefined, false);
  assert.ok(!unsignedAllowed.findings.some(finding => finding.id === 'unsigned-pak'));
});

function pckHeader(encrypted: boolean, version = 2): Buffer {
  const header = Buffer.alloc(112);
  header.write('GDPC');
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(+encrypted, 20);
  return header;
}

test('uses Godot directory flags in standalone and executable-tail PCKs', async t => {
  const { dir, put } = folder(t);
  put('clear.pck', pckHeader(false));
  put('encrypted.pck', pckHeader(true, 3));
  assert.deepEqual((await auditBuild(dir)).findings[0]?.files, ['clear.pck']);
  const embedded = folder(t);
  const pack = pckHeader(false);
  const end = Buffer.alloc(12);
  end.writeBigUInt64LE(BigInt(pack.length));
  end.write('GDPC', 8);
  embedded.put('game.x86_64', Buffer.concat([Buffer.alloc(100), pack, end]));
  const result = await auditBuild(embedded.dir);
  assert.equal(result.engine, 'godot');
  assert.deepEqual(result.findings[0]?.files, ['game.x86_64']);
});
