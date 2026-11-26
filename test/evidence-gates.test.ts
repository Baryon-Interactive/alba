import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { decodePng, meanAbsoluteLuminanceDifference, meanLuminance } from '../src/verify/png.ts';
import { collectArtifacts } from '../src/review/acceptance.ts';
import { validateProject } from '../src/config.ts';
import { tmpDir } from './tmp.ts';

function png(width: number, height: number, pixels: Buffer): Buffer {
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), pixels.subarray(y * width * 3, (y + 1) * width * 3)])));
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4); return Buffer.concat([head, data, Buffer.alloc(4)]); };
  const header = Buffer.from([0, 0, 0, width, 0, 0, 0, height, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('evidence gates image metrics use Rec.709 and honor regions', () => {
  const decode = (data: Buffer) => { const result = decodePng(data); assert.equal(result.status, 'ok'); return result.image; };
  const black = decode(png(2, 1, Buffer.alloc(6)));
  const white = decode(png(2, 1, Buffer.alloc(6, 255)));
  assert.equal(meanLuminance(white), 1);
  assert.equal(meanLuminance(white, [0, 0, 1, 1]), 1);
  assert.equal(meanAbsoluteLuminanceDifference(black, white), 255);
  assert.equal(meanAbsoluteLuminanceDifference(black, white, [0, 0, 1, 1]), 255);
});

test('evidence gates verify config accepts measured luminance and motion rules', () => {
  const dir = tmpDir('alba-evidence-config-'); mkdirSync(path.join(dir, 'orders'));
  const project = validateProject({ id: 'g', name: 'G', root: dir, work_orders: 'orders', state_dir: 'state', verify: { screenshots: { luminance: [{ match: '**/*-cin*.png', mean_min: 0.22 }], motion: [{ a: '**/{name}-t0.png', b: '**/{name}-t1.png', min: 0.5 }] } } }, path.join(dir, 'alba.yaml'));
  assert.equal(project.verify.screenshots !== 'off' && project.verify.screenshots.luminance?.[0]?.mean_min, 0.22);
  assert.equal(project.verify.screenshots !== 'off' && project.verify.screenshots.motion?.[0]?.min, 0.5);
});

test('evidence gates image CLI returns JSON numbers and decode exit code 3', () => {
  const dir = tmpDir('alba-evidence-cli-'), a = path.join(dir, 'a.png'), b = path.join(dir, 'b.png');
  writeFileSync(a, png(2, 1, Buffer.alloc(6))); writeFileSync(b, png(2, 1, Buffer.alloc(6, 255)));
  const cli = path.resolve('src/cli/main.ts');
  const lum = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'image', 'lum', a, '--json'], { encoding: 'utf8' });
  assert.equal(lum.status, 0); assert.equal(JSON.parse(lum.stdout).mean_luminance, 0);
  const motion = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'image', 'motion', a, b, '--json'], { encoding: 'utf8' });
  assert.equal(motion.status, 0); assert.equal(JSON.parse(motion.stdout).mean_difference, 255);
  const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'image', 'lum', path.join(dir, 'missing.png')], { encoding: 'utf8' });
  assert.equal(bad.status, 3);
});

test('evidence gates artifact receipts stream hashes and warn on missing optional globs', () => {
  const dir = tmpDir('alba-evidence-artifacts-'), file = path.join(dir, 'dist', 'package.exe'); mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from('package bytes'); writeFileSync(file, bytes);
  const result = collectArtifacts({ artifacts: ['dist/*.exe', 'missing/*.json'] }, dir, dir);
  assert.equal(result.receipts[0]!.path, 'dist/package.exe');
  assert.equal(result.receipts[0]!.size, bytes.length);
  assert.equal(result.receipts[0]!.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.warnings.length, 1); assert.equal(result.requiredFailure, undefined);
});

test('evidence gates lock helper preserves child exit code and releases its file', async () => {
  const dir = tmpDir('alba-evidence-lock-'), helper = path.resolve('src/run/lock-helper.mjs');
  const child = spawn(process.execPath, [helper, 'test', '--', process.execPath, '-e', 'process.exit(4)'], { env: { ...process.env, ALBA_LOCK_DIR: dir } });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  assert.equal(code, 4); assert.deepEqual(spawnSync(process.execPath, [helper, 'test', '--', process.execPath, '-e', 'process.exit(0)'], { env: { ...process.env, ALBA_LOCK_DIR: dir } }).status, 0);
});
