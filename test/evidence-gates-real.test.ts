import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { validateProject, type ProjectConfig } from '../src/config.ts';
import { Orders } from '../src/orders/service.ts';
import { closeStateStores } from '../src/orders/backend.ts';
import { ARTIFACT_CAPS, trialAcceptance } from '../src/review/acceptance.ts';
import { verifyOrder, type VerifyReport } from '../src/verify/verify.ts';
import { regionError } from '../src/verify/png.ts';
import { alba, projectDir } from './cli-helper.ts';
import { testStore } from './state-helper.ts';
import { tmpDir } from './tmp.ts';

const MAIN = path.resolve('src/cli/main.ts');
const nodeArgs = ['--disable-warning=ExperimentalWarning', MAIN];

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y), i = y * (1 + width * 3) + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const chunk = (type: string, body: Buffer) => { const name = Buffer.from(type); const out = Buffer.alloc(12 + body.length); out.writeUInt32BE(body.length, 0); name.copy(out, 4); body.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([name, body])), 8 + body.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const flat = (value: number, width = 2, height = 1) => png(width, height, () => [value, value, value]);
const black = flat(0);
const white = flat(255);
const thresholds = { duplicate_diff: 0, blank_std: 0, dark_mean: 0, dark_fraction: 1 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function removeLinks(root: string): void {
  if (!existsSync(root)) return;
  let info; try { info = lstatSync(root); } catch { return; }
  if (info.isSymbolicLink()) { rmSync(root, { force: true }); return; }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(root)) removeLinks(path.join(root, entry));
}

type GateFixture = { dir: string; root: string; delivery: string; workOrders: string; projectFile: string; project: ProjectConfig; orders: Orders; tag: string; cleanup: () => void };

function fixture(t: TestContext, images: Record<string, Buffer>, screenshots: Record<string, unknown> = thresholds, accept?: Record<string, unknown>): GateFixture {
  const dir = tmpDir('alba-real-evidence-'), root = path.join(dir, 'repo'), delivery = path.join(dir, 'delivery'), workOrders = path.join(root, 'orders');
  mkdirSync(workOrders, { recursive: true });
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'fixture'); git(root, 'config', 'user.email', 'fixture@example.com');
  writeFileSync(path.join(root, 'README.md'), 'fixture\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial');
  git(root, 'worktree', 'add', '-qb', 'delivery', delivery);
  writeFileSync(path.join(delivery, 'feature.txt'), 'feature\n'); git(delivery, 'add', '.'); git(delivery, 'commit', '-qm', 'feature');
  for (const [name, data] of Object.entries(images)) { const file = path.join(delivery, 'shots', name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); }
  const projectFile = path.join(dir, 'alba.yaml');
  const project = validateProject({ id: 'fixture', name: 'Fixture', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: dir, base_ref: 'main' }, verify: { screenshots }, ...(accept ? { accept } : {}) }, projectFile);
  const orders = new Orders(testStore(project.state_dir));
  const tag = `REAL${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  writeFileSync(path.join(workOrders, `${tag}.md`), `# ${tag}\n\n## Acceptance\n- fixture passes\n\n## Evidence\n${Object.keys(images).map(name => `- shots/${name}: image`).join('\n')}\n`);
  orders.add({ tag, title: 'Evidence fixture', kind: 'code', branch: 'delivery', worktree: delivery });
  orders.runStart(tag, { worker: 'fixture' }); orders.runEnd(tag);
  orders.report(tag, { status: 'ready', summary: 'ready', commits: [git(delivery, 'rev-parse', 'HEAD')], evidence: Object.keys(images).map(name => `shots/${name}`) });
  const quote = (value: string) => JSON.stringify(value.replace(/\\/g, '/'));
  writeFileSync(projectFile, `id: fixture\nname: Fixture\nroot: ${quote(root)}\nwork_orders: ${quote(workOrders)}\nstate_dir: ${quote(project.state_dir)}\ndispatch:\n  worktree_parent: ${quote(dir)}\n  base_ref: main\n`);
  const cleanup = () => { try { git(root, 'worktree', 'remove', '--force', delivery); } catch {} closeStateStores(); removeLinks(dir); rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); };
  t.after(cleanup);
  return { dir, root, delivery, workOrders, projectFile, project, orders, tag, cleanup };
}

function item(report: VerifyReport, name = 'screenshots') { return report.results.find(result => result.name === name)!; }
function runRaw(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [...nodeArgs, ...args], { encoding: 'utf8', env: { ...process.env, ALBA_LANG: 'en', ...env }, timeout: 30000, windowsHide: true });
}

test('real verifyOrder luminance gates cover floors, regions, maxima, warnings, corrupt PNGs and legacy results', t => {
  const low = fixture(t, { 'low.png': flat(25) }, { ...thresholds, luminance: [{ match: 'shots/low.png', mean_min: 0.22 }] });
  const lowResult = item(verifyOrder(low.project, low.orders, low.tag, { record: false }));
  assert.equal(lowResult.status, 'fail'); assert.match(lowResult.reason, /low\.png/); assert.match(lowResult.reason, /0\.0980/); assert.match(lowResult.reason, /0\.22/);
  const high = fixture(t, { 'high.png': flat(102) }, { ...thresholds, luminance: [{ match: 'shots/high.png', mean_min: 0.22 }] });
  assert.equal(item(verifyOrder(high.project, high.orders, high.tag, { record: false })).status, 'pass');
  const strip = fixture(t, { 'strip.png': png(4, 1, (x) => x < 2 ? [0, 0, 0] : [255, 255, 255]) }, { ...thresholds, luminance: [
    { match: 'shots/strip.png', mean_min: 0.75 },
    { match: 'shots/strip.png', mean_min: 0.99, region: [2, 0, 2, 1] },
    { match: 'shots/strip.png', mean_min: 0.1, region: [0, 0, 2, 1] },
  ] });
  const stripResult = item(verifyOrder(strip.project, strip.orders, strip.tag, { record: false }));
  // Hand calculation: whole image is (0 + 0 + 255 + 255) / (4 * 255) = 0.5; bright strip is 1; dark strip is 0.
  assert.equal(stripResult.status, 'fail'); assert.match(stripResult.reason, /0\.5000/); assert.match(stripResult.reason, /mean luminance 1\.0000/); assert.match(stripResult.reason, /mean luminance 0\.0000/);
  const max = fixture(t, { 'white.png': white }, { ...thresholds, luminance: [{ match: 'shots/white.png', mean_max: 0.8 }] });
  assert.equal(item(verifyOrder(max.project, max.orders, max.tag, { record: false })).status, 'fail'); assert.match(item(verifyOrder(max.project, max.orders, max.tag, { record: false })).reason, /above 0\.8/);
  const unmatched = fixture(t, { 'other.png': white }, { ...thresholds, luminance: [{ match: 'shots/missing.png', mean_min: 0.2 }] });
  const unmatchedResult = item(verifyOrder(unmatched.project, unmatched.orders, unmatched.tag, { record: false })); assert.equal(unmatchedResult.status, 'warn'); assert.match(unmatchedResult.reason, /matched no image/);
  const corrupt = fixture(t, { 'broken.png': Buffer.from('89504e470d0a1a0a', 'hex') }, { ...thresholds, luminance: [{ match: 'shots/broken.png', mean_min: 0.2 }] });
  const corruptResult = item(verifyOrder(corrupt.project, corrupt.orders, corrupt.tag, { record: false })); assert.equal(corruptResult.status, 'warn'); assert.match(corruptResult.reason, /broken\.png/); assert.match(corruptResult.reason, /truncated PNG|not a PNG/);
  const legacy = fixture(t, { 'dark.png': black }, { duplicate_diff: 0.02, blank_std: 0.02, dark_mean: 0.12, dark_fraction: 0.85 });
  const legacyResult = item(verifyOrder(legacy.project, legacy.orders, legacy.tag, { record: false }));
  assert.equal(legacyResult.status, 'fail'); assert.match(legacyResult.reason, /Blank screenshots/); assert.doesNotMatch(legacyResult.reason, /Luminance rule|Motion rule/);
});

test('real verifyOrder motion gates measure exact regions, warn for missing pairs, fail size and bounds, and enforce max', t => {
  const identical = fixture(t, { 'same-t0.png': black, 'same-t1.png': black }, { ...thresholds, motion: [{ a: 'shots/{name}-t0.png', b: 'shots/{name}-t1.png', min: 0.5 }] });
  const sameResult = item(verifyOrder(identical.project, identical.orders, identical.tag, { record: false })); assert.equal(sameResult.status, 'fail'); assert.match(sameResult.reason, /motion 0\.0000 is below 0\.5/);
  const moved = fixture(t, { 'known-t0.png': png(4, 1, () => [0, 0, 0]), 'known-t1.png': png(4, 1, x => x === 1 ? [255, 255, 255] : [0, 0, 0]) }, { ...thresholds, motion: [{ a: 'shots/{name}-t0.png', b: 'shots/{name}-t1.png', region: [1, 0, 2, 1], min: 100 }] });
  const movedResult = item(verifyOrder(moved.project, moved.orders, moved.tag, { record: false })); assert.equal(movedResult.status, 'pass'); assert.match(movedResult.reason, /motion 127\.5000/);
  const outside = fixture(t, { 'outside-t0.png': png(4, 1, () => [0, 0, 0]), 'outside-t1.png': png(4, 1, x => x === 3 ? [255, 255, 255] : [0, 0, 0]) }, { ...thresholds, motion: [{ a: 'shots/{name}-t0.png', b: 'shots/{name}-t1.png', region: [0, 0, 2, 1], min: 0.5 }] });
  assert.equal(item(verifyOrder(outside.project, outside.orders, outside.tag, { record: false })).status, 'fail'); assert.match(item(verifyOrder(outside.project, outside.orders, outside.tag, { record: false })).reason, /motion 0\.0000/);
  const mismatch = fixture(t, { 'size-t0.png': black, 'size-t1.png': png(3, 1, () => [0, 0, 0]) }, { ...thresholds, motion: [{ a: 'shots/{name}-t0.png', b: 'shots/{name}-t1.png', min: 0.5 }] });
  const mismatchResult = item(verifyOrder(mismatch.project, mismatch.orders, mismatch.tag, { record: false })); assert.equal(mismatchResult.status, 'fail'); assert.match(mismatchResult.reason, /image sizes differ: 2x1 and 3x1/);
  const noPair = fixture(t, { 'orphan-t0.png': black }, { ...thresholds, motion: [{ a: 'shots/{name}-t0.png', b: 'shots/{name}-t1.png', min: 0.5 }] });
  assert.equal(item(verifyOrder(noPair.project, noPair.orders, noPair.tag, { record: false })).status, 'warn'); assert.match(item(verifyOrder(noPair.project, noPair.orders, noPair.tag, { record: false })).reason, /has no pair/);
  const tooMuch = fixture(t, { 'max-t0.png': black, 'max-t1.png': white }, { ...thresholds, motion: [{ a: 'shots/{name}-t0.png', b: 'shots/{name}-t1.png', max: 100 }] });
  const tooMuchResult = item(verifyOrder(tooMuch.project, tooMuch.orders, tooMuch.tag, { record: false })); assert.equal(tooMuchResult.status, 'fail'); assert.match(tooMuchResult.reason, /motion 255\.0000 is above 100/);
  const badRegion = fixture(t, { 'bad.png': white }, { ...thresholds, luminance: [{ match: 'shots/bad.png', mean_min: 0.2, region: [1, 0, 2, 1] }] });
  const badRegionResult = item(verifyOrder(badRegion.project, badRegion.orders, badRegion.tag, { record: false })); assert.equal(badRegionResult.status, 'fail'); assert.match(badRegionResult.reason, /bad\.png/); assert.match(badRegionResult.reason, /image size 2x1/); assert.equal(regionError({ width: 2, height: 1, channels: 3, pixels: Buffer.alloc(6) }, [1, 0, 2, 1])?.includes('2x1'), true);
});

test('image CLI reports exact luminance and motion values and distinguishes argument, bounds and decode exits', () => {
  const dir = tmpDir('alba-real-cli-'), half = path.join(dir, 'half.png'), changed = path.join(dir, 'changed.png'), bad = path.join(dir, 'bad.png');
  writeFileSync(half, png(2, 1, x => x === 0 ? [0, 0, 0] : [255, 255, 255])); writeFileSync(changed, png(2, 1, x => x === 0 ? [255, 255, 255] : [0, 0, 0])); writeFileSync(bad, Buffer.from('89504e470d0a1a0a', 'hex'));
  const whole = runRaw(['image', 'lum', half, '--json']); assert.equal(whole.status, 0); assert.ok(Math.abs(JSON.parse(whole.stdout).mean_luminance - 0.5) < 1e-12);
  const left = runRaw(['image', 'lum', half, '--region', '0,0,1,1', '--json']); assert.equal(left.status, 0); assert.equal(JSON.parse(left.stdout).mean_luminance, 0);
  const right = runRaw(['image', 'lum', half, '--region', '1,0,1,1', '--json']); assert.equal(right.status, 0); assert.equal(JSON.parse(right.stdout).mean_luminance, 1);
  const motionJson = runRaw(['image', 'motion', half, changed, '--region', '0,0,1,1', '--json']); assert.equal(motionJson.status, 0); assert.equal(JSON.parse(motionJson.stdout).mean_difference, 255);
  const motionPlain = runRaw(['image', 'motion', half, changed, '--region', '0,0,1,1']); assert.equal(motionPlain.status, 0); assert.equal(motionPlain.stdout.trim(), '255.000000');
  for (const region of ['1,2', '0,0,0,1', 'a,b,c,d']) { const result = runRaw(['image', 'lum', half, '--region', region]); assert.equal(result.status, 2); }
  const outside = runRaw(['image', 'lum', half, '--region', '1,0,2,1']); assert.equal(outside.status, 2); assert.match(outside.stdout, /image size 2x1/);
  const negative = runRaw(['image', 'lum', half, '--region=-1,0,1,1']); assert.equal(negative.status, 2); assert.match(negative.stdout, /image size 2x1/);
  assert.equal(runRaw(['image', 'lum']).status, 2); assert.equal(runRaw(['image', 'lum', bad]).status, 3); assert.equal(runRaw(['image', 'lum', path.join(dir, 'missing.png')]).status, 3);
  rmSync(dir, { recursive: true, force: true });
});

test('lock CLI timeout, list, stale state, resources view and standalone worktree helper', async t => {
  const dir = tmpDir('alba-real-lock-'), env = { ALBA_LOCK_DIR: dir }, project = projectDir(dir);
  const holder = spawn(process.execPath, [...nodeArgs, 'lock', 'held', '--wait-minutes', '1', '--', process.execPath, '-e', 'setTimeout(() => {}, 8000)'], { env: { ...process.env, ...env }, windowsHide: true });
  t.after(() => { try { holder.kill(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 30 && !existsSync(path.join(dir, 'held.lock')); i++) await new Promise(resolve => setTimeout(resolve, 50));
  const listed = alba(project, ['lock', 'list'], env); assert.equal(listed.code, 0); assert.match(listed.out, /held/); assert.match(listed.out, /pid \d+/); assert.match(listed.out, /held 0 min/); assert.match(listed.out, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const resources = alba(project, ['resources'], env); assert.equal(resources.code, 0); assert.match(resources.out, /held/);
  const timed = runRaw(['lock', 'held', '--wait-minutes', '0.02', '--', process.execPath, '-e', 'process.exit(0)'], env); assert.equal(timed.status, 75); assert.match(timed.stderr, /gave up after 0\.02 minutes/);
  await new Promise<void>(resolve => holder.once('close', () => resolve()));
  assert.match(alba(project, ['lock', 'list'], env).out, /no named locks/);
  writeFileSync(path.join(dir, 'dead.lock'), JSON.stringify({ pid: 999999, cwd: 'dead-folder', command: 'dead command', since: new Date().toISOString() }));
  assert.match(alba(project, ['lock', 'list'], env).out, /dead  STALE pid 999999/);
  const worktree = path.join(dir, 'standalone'); mkdirSync(path.join(worktree, '.alba', 'bin'), { recursive: true });
  // The real installer is exercised by importing the same source used by inbox setup.
  const { installLockHelper } = await import('../src/run/inbox.ts'); installLockHelper(worktree);
  const standalone = spawnSync(process.execPath, [path.join(worktree, '.alba', 'bin', 'lock.mjs'), 'standalone', '--', process.execPath, '-e', 'process.exit(6)'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(standalone.status, 6); assert.equal(standalone.stderr.includes('src/run'), false);
});

function acceptanceFixture(t: TestContext, steps: Record<string, unknown>[], tag = 'ART') {
  const f = fixture(t, {}, thresholds, { conflicts: {}, steps, merge_message: 'Merge {tag}: {title}', post_merge: [], push: false, parallel: 1 });
  // Keep tags deterministic for CLI show tests while preserving independent temp projects.
  if (f.tag !== tag) { /* the random tag prevents state collisions; callers use f.tag */ }
  return f;
}

test('trialAcceptance records receipt fields, refuses links, warns or fails missing globs, finds project-root files, and truncates at lowered caps', t => {
  const bytes = Buffer.from('receipt bytes');
  const f = acceptanceFixture(t, [{ name: 'package', command: [process.execPath, '-e', `require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/out.bin',${JSON.stringify(bytes.toString())})`], timeout_minutes: 1, artifacts: ['dist/*.bin'] }]);
  const trial = trialAcceptance(f.project, f.orders, f.tag); assert.equal(trial.status, 'passed');
  const receipt = trial.artifacts?.find(a => a.path === 'dist/out.bin'); assert.ok(receipt); assert.equal(receipt.size, bytes.length); assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex')); assert.ok(receipt.modified);
  const stepEvent = f.orders.store.events({ tag: f.tag }).find(e => e.type === 'accept-step')!; assert.equal((stepEvent.data?.artifacts as { path: string }[])[0]?.path, 'dist/out.bin');
  const trialEvent = f.orders.store.events({ tag: f.tag }).find(e => e.type === 'accept-trial')!; assert.equal((trialEvent.data?.artifacts as { sha256: string }[])[0]?.sha256, receipt.sha256);
  const trialJson = JSON.parse(readFileSync(path.join(trial.log_dir!, 'trial.json'), 'utf8')); assert.equal(trialJson.artifacts[0].path, 'dist/out.bin'); assert.equal(trialJson.artifacts[0].size, bytes.length); assert.equal(trialJson.artifacts[0].sha256, receipt.sha256); assert.ok(trialJson.artifacts[0].modified);

  const outside = path.join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'secret.bin'), 'secret');
  const linked = acceptanceFixture(t, [{ name: 'link', command: [process.execPath, '-e', `require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').symlinkSync(${JSON.stringify(outside)},'dist/link',${JSON.stringify(process.platform === 'win32' ? 'junction' : 'dir')})`], timeout_minutes: 1, artifacts: ['dist/link/*.bin'] }]);
  const linkedTrial = trialAcceptance(linked.project, linked.orders, linked.tag); assert.equal(linkedTrial.status, 'passed'); assert.equal(linkedTrial.artifacts?.[0]?.status, 'refused'); assert.match(linkedTrial.artifacts?.[0]?.reason ?? '', /outside the allowed root/);

  const optional = acceptanceFixture(t, [{ name: 'optional', command: [process.execPath, '-e', 'process.exit(0)'], timeout_minutes: 1, artifacts: ['missing/*.bin'] }]);
  const optionalTrial = trialAcceptance(optional.project, optional.orders, optional.tag); assert.equal(optionalTrial.status, 'passed'); assert.match(optionalTrial.steps[0]!.artifact_warnings?.[0] ?? '', /missing\/\*\.bin/);
  const required = acceptanceFixture(t, [{ name: 'required', command: [process.execPath, '-e', 'process.exit(0)'], timeout_minutes: 1, artifacts: ['missing/*.bin'], artifacts_required: true }]);
  const requiredTrial = trialAcceptance(required.project, required.orders, required.tag); assert.equal(requiredTrial.status, 'failed'); assert.match(requiredTrial.reason ?? '', /missing\/\*\.bin/);

  const rootMatch = acceptanceFixture(t, [{ name: 'root', command: [process.execPath, '-e', 'process.exit(0)'], timeout_minutes: 1, artifacts: ['project-root.bin'] }]);
  const rootFile = path.join(rootMatch.root, 'project-root.bin'); writeFileSync(rootFile, 'root artifact');
  const rootTrial = trialAcceptance(rootMatch.project, rootMatch.orders, rootMatch.tag); assert.equal(rootTrial.status, 'passed'); assert.equal(rootTrial.artifacts?.[0]?.path, 'project-root.bin');

  const original = { ...ARTIFACT_CAPS };
  try {
    const count = acceptanceFixture(t, [{ name: 'count', command: [process.execPath, '-e', "require('node:fs').mkdirSync('dist',{recursive:true});for(const n of ['a','b'])require('node:fs').writeFileSync('dist/'+n,'x')"], timeout_minutes: 1, artifacts: ['dist/*'] }]);
    ARTIFACT_CAPS.maxFiles = 1; const countTrial = trialAcceptance(count.project, count.orders, count.tag); assert.equal(countTrial.status, 'passed'); assert.equal(countTrial.steps[0]!.truncated, true);
    const size = acceptanceFixture(t, [{ name: 'size', command: [process.execPath, '-e', "require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/a','1234')"], timeout_minutes: 1, artifacts: ['dist/*'] }]);
    ARTIFACT_CAPS.maxFiles = 200; ARTIFACT_CAPS.maxBytes = 2; const sizeTrial = trialAcceptance(size.project, size.orders, size.tag); assert.equal(sizeTrial.status, 'passed'); assert.equal(sizeTrial.steps[0]!.truncated, true);
  } finally { Object.assign(ARTIFACT_CAPS, original); }

  const failed = acceptanceFixture(t, [{ name: 'failed', command: [process.execPath, '-e', "require('node:fs').writeFileSync('failed.bin','x');process.exit(4)"], timeout_minutes: 1, artifacts: ['failed.bin'] }]);
  const failedTrial = trialAcceptance(failed.project, failed.orders, failed.tag); assert.equal(failedTrial.status, 'failed'); assert.equal(failedTrial.artifacts?.length, 0); assert.equal(failedTrial.steps[0]!.artifacts, undefined);
});

test('orders show prints acceptance artifact path, hash and size, and wiring validation names malformed keys', t => {
  const bytes = Buffer.from('show bytes');
  const f = acceptanceFixture(t, [{ name: 'show', command: [process.execPath, '-e', `require('node:fs').writeFileSync('show.bin',${JSON.stringify(bytes.toString())})`], timeout_minutes: 1, artifacts: ['show.bin'] }]);
  const trial = trialAcceptance(f.project, f.orders, f.tag); const shown = alba(f.projectFile, ['orders', 'show', f.tag]); assert.equal(shown.code, 0); assert.match(shown.out, /show\.bin/); assert.match(shown.out, new RegExp(createHash('sha256').update(bytes).digest('hex'))); assert.match(shown.out, new RegExp(`${bytes.length} bytes`));
  const parsed = validateProject({ id: 'wire', name: 'Wire', root: f.root, work_orders: f.workOrders, state_dir: path.join(f.dir, 'wire-state'), verify: { screenshots: { luminance: [{ match: 'x', mean_min: 0.2 }], motion: [{ a: 'a-{name}', b: 'b-{name}', min: 0.5 }] } }, accept: { steps: [{ name: 'x', command: [process.execPath], timeout_minutes: 1, artifacts: ['x/*.bin'], artifacts_required: true }] } }, path.join(f.dir, 'wire.yaml'));
  assert.equal(parsed.verify.screenshots !== 'off' && parsed.verify.screenshots.luminance?.[0]?.mean_min, 0.2); assert.equal(parsed.verify.screenshots !== 'off' && parsed.verify.screenshots.motion?.[0]?.min, 0.5); assert.equal(parsed.accept?.steps[0]?.artifacts_required, true); assert.equal(parsed.accept?.steps[0]?.artifacts?.[0], 'x/*.bin');
  const raw = { id: 'x', name: 'X', root: f.root, work_orders: f.workOrders, state_dir: f.project.state_dir, verify: { screenshots: { luminance: [{ match: 'x', mean_min: 'x' }], motion: [{ a: 'a', b: 'b', min: 1, region: [0, 0, 1] }] } }, accept: { steps: [{ name: 'x', command: [process.execPath], timeout_minutes: 1, artifacts: 'a' }] } };
  assert.throws(() => validateProject(raw, path.join(f.dir, 'bad.yaml')), /mean_min/); assert.throws(() => validateProject({ ...raw, verify: { screenshots: { luminance: [{ match: 'x', mean_min: 0.1, region: [0, 0, 1] }] } } }, path.join(f.dir, 'bad.yaml')), /region/); assert.throws(() => validateProject({ ...raw, verify: undefined }, path.join(f.dir, 'bad.yaml')), /steps\.artifacts/);
  assert.equal(trial.status, 'passed');
});
