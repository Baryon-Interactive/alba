import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from '../src/config.ts';
import { applyFinish } from '../src/run/finish.ts';
import { Orders } from '../src/orders/service.ts';
import { verifyOrder, parseOrderSections, type VerifyReport } from '../src/verify/verify.ts';
import { decodePng, imageFormat, summarizePng } from '../src/verify/png.ts';
import { lintReworkNote } from '../src/producer/delivery-lint.ts';
import { producerSystemPrompt } from '../src/producer/session.ts';
import { testStore } from './state-helper.ts';
import { tmpDir } from './tmp.ts';

test('order acceptance sections parse evidence and path rules, with warnings for vague text', () => {
  const sections = parseOrderSections(`# T1

## Acceptance
- looks good
- Pause menu opens

## Evidence
- screenshots/pause.png: pause menu visible
- logs/test.txt

## Paths
- allow: src/**
- deny: secrets/**
- max-lines: 400 for src/**
`);
  assert.deepEqual(sections.acceptance, ['looks good', 'Pause menu opens']);
  assert.deepEqual(sections.evidence, [
    { path: 'screenshots/pause.png', what: 'pause menu visible' },
    { path: 'logs/test.txt', what: '' },
  ]);
  assert.deepEqual(sections.allow, ['src/**']);
  assert.deepEqual(sections.deny, ['secrets/**']);
  assert.deepEqual(sections.maxLines, [{ glob: 'src/**', max: 400 }]);
  assert.match(sections.warnings.join('\n'), /Vague acceptance item/);
});

test('verify config protects gate globs', () => {
  const project = validateProject({
    id: 'game', name: 'Game', root: process.cwd(), work_orders: 'docs', state_dir: 'state',
    verify: { protected_gates: ['alba.yaml', 'work-orders/**'] },
  }, 'alba.yaml');
  assert.deepEqual(project.verify.protected_gates, ['alba.yaml', 'work-orders/**']);
});

test('verify screenshot thresholds validate and can be disabled', () => {
  const project = validateProject({
    id: 'game', name: 'Game', root: process.cwd(), work_orders: 'docs', state_dir: 'state',
    verify: { screenshots: { duplicate_diff: 0.02, blank_std: 0.03, dark_mean: 0.1, dark_fraction: 0.9 } },
  }, 'alba.yaml');
  assert.deepEqual(project.verify.screenshots, { duplicate_diff: 0.02, blank_std: 0.03, dark_mean: 0.1, dark_fraction: 0.9 });
  const off = validateProject({ id: 'game', name: 'Game', root: process.cwd(), work_orders: 'docs', state_dir: 'state', verify: { screenshots: 'off' } }, 'alba.yaml');
  assert.equal(off.verify.screenshots, 'off');
});

type Fixture = {
  project: ReturnType<typeof validateProject>;
  orders: Orders;
  root: string;
  worktree: string;
  branchCommit: string;
  started: Date;
  advance: (ms: number) => void;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(markdown: string, options: { protectedGates?: string[] } = {}): Fixture {
  const dir = tmpDir('alba-verify-');
  const root = path.join(dir, 'game');
  const ordersDir = path.join(root, 'orders');
  const worktree = path.join(dir, 'game-r1');
  mkdirSync(ordersDir, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
  git(root, 'worktree', 'add', '-q', '-b', 'game-r1', worktree, 'main');
  const project = validateProject({
    id: 'game', name: 'Game', root, work_orders: ordersDir, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: dir, base_ref: 'refs/heads/main' },
    verify: { protected_gates: options.protectedGates ?? [] },
  }, path.join(dir, 'alba.yaml'));
  const started = new Date(Date.now() - 10_000);
  let clock = started.getTime();
  const orders = new Orders(testStore(project.state_dir), () => new Date(clock += 10).toISOString());
  writeFileSync(path.join(ordersDir, 'R1-gates.md'), markdown);
  orders.add({ tag: 'R1', title: 'Verify gates', kind: 'sim', branch: 'game-r1', worktree });
  orders.act('R1', 'queue');
  orders.runStart('R1', { worker: 'fixture' });
  orders.runEnd('R1');
  writeFileSync(path.join(worktree, 'feature.txt'), 'feature\n');
  git(worktree, 'add', 'feature.txt');
  git(worktree, 'commit', '-q', '-m', 'feature');
  const branchCommit = git(worktree, 'rev-parse', 'HEAD');
  return { project, orders, root, worktree, branchCommit, started, advance: ms => { clock += ms; } };
}

function ready(f: Fixture, input: { commits?: string[]; evidence?: string[] } = {}): void {
  f.orders.report('R1', {
    status: 'ready', summary: 'ready', commits: input.commits ?? [f.branchCommit], evidence: input.evidence ?? [],
  });
}

function result(report: VerifyReport, name: string) {
  return report.results.find(item => item.name === name)!;
}

function rework(f: Fixture): void {
  ready(f);
  f.orders.act('R1', 'rework', { note: 'Reuse this order evidence and check the result.' });
  f.advance(5_000);
  f.orders.runStart('R1', { worker: 'fixture' });
  f.orders.runEnd('R1');
}

test('earlier evidence from the same order warns in both gates', () => {
  const f = fixture('# R1\n\n## Acceptance\n- result exists\n\n## Evidence\n- result.txt\n');
  const evidence = path.join(f.worktree, 'result.txt');
  writeFileSync(evidence, 'earlier run result');
  const made = new Date(f.started.getTime() + 1_000);
  utimesSync(evidence, made, made);
  rework(f);
  ready(f, { evidence: ['result.txt'] });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  for (const name of ['evidence', 'required evidence']) {
    assert.equal(result(report, name).status, 'warn');
    assert.match(result(report, name).reason, /carried over from an earlier run of this order: .*result\.txt/);
  }
});

test('evidence predating the order still fails after rework', () => {
  const f = fixture('# R1\n\n## Acceptance\n- result exists\n\n## Evidence\n- result.txt\n');
  const evidence = path.join(f.worktree, 'result.txt');
  writeFileSync(evidence, 'preexisting result');
  const made = new Date(f.started.getTime() - 1_000);
  utimesSync(evidence, made, made);
  rework(f);
  ready(f, { evidence: ['result.txt'] });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  for (const name of ['evidence', 'required evidence']) {
    assert.equal(result(report, name).status, 'fail');
    assert.match(result(report, name).reason, /older than the order's first run start/);
    assert.match(result(report, name).reason, /Do not change file times or move files to pass this check/);
  }
});

test('required glob names fresh evidence first and counts old leftovers', () => {
  const f = fixture('# R1\n\n## Acceptance\n- result exists\n\n## Evidence\n- shots/*.txt\n');
  mkdirSync(path.join(f.worktree, 'shots'));
  for (const name of ['old-a.txt', 'old-b.txt', 'old-c.txt', 'carried.txt', 'fresh.txt']) {
    const file = path.join(f.worktree, 'shots', name);
    writeFileSync(file, name);
    const made = new Date(f.started.getTime() + (name === 'fresh.txt' ? 10_000 : name === 'carried.txt' ? 1_000 : -1_000));
    utimesSync(file, made, made);
  }
  rework(f);
  ready(f);
  const item = result(verifyOrder(f.project, f.orders, 'R1', { record: false }), 'required evidence');
  assert.equal(item.status, 'pass', item.reason);
  assert.match(item.reason, /^Fresh files for shots\/\*\.txt: .*fresh\.txt; 4 leftover match\(es\) \(1 carried over\)/);
  assert.doesNotMatch(item.reason, /old-a|old-b|old-c|carried\.txt/);
});

test('carried matches with stale leftovers warn and directories count carryovers', () => {
  const f = fixture('# R1\n\n## Acceptance\n- result exists\n\n## Evidence\n- shots/*.txt\n- shots/\n');
  mkdirSync(path.join(f.worktree, 'shots'));
  for (const [name, delta] of [['old.txt', -1_000], ['carried.txt', 1_000]] as const) {
    const file = path.join(f.worktree, 'shots', name);
    writeFileSync(file, name);
    const made = new Date(f.started.getTime() + delta);
    utimesSync(file, made, made);
  }
  rework(f);
  ready(f, { evidence: ['shots/'] });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  for (const name of ['evidence', 'required evidence']) {
    assert.equal(result(report, name).status, 'warn');
    assert.match(result(report, name).reason, /0 of 2 files fresh, 1 carried over/);
  }
  assert.doesNotMatch(result(report, 'required evidence').reason, /old\.txt/);
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width: number, height: number, pixels: Buffer, colorType = 2, filters?: number[], options: { bitDepth?: number; palette?: Buffer; transparency?: Buffer; interlace?: number } = {}): Buffer {
  const bitDepth = options.bitDepth ?? 8;
  const samples = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const channels = Math.max(1, Math.ceil(samples * bitDepth / 8));
  const rowBytes = Math.ceil(width * samples * bitDepth / 8);
  const chunk = (type: string, body: Buffer) => { const t = Buffer.from(type); const out = Buffer.alloc(12 + body.length); out.writeUInt32BE(body.length, 0); t.copy(out, 4); body.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([t, body])), 8 + body.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = options.interlace ?? 0;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    const filter = filters?.[y] ?? 0;
    const encoded = Buffer.alloc(row.length + 1); encoded[0] = filter;
    for (let x = 0; x < row.length; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = y ? pixels[(y - 1) * rowBytes + x] : 0;
      const upLeft = y && x >= channels ? pixels[(y - 1) * rowBytes + x - channels] : 0;
      const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      encoded[x + 1] = filter === 0 ? row[x] : filter === 1 ? (row[x] - left + 256) & 255 : filter === 2 ? (row[x] - up + 256) & 255 : filter === 3 ? (row[x] - Math.floor((left + up) / 2) + 256) & 255 : (row[x] - paeth(left, up, upLeft) + 256) & 255;
    }
    rows.push(encoded);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...(options.palette ? [chunk('PLTE', options.palette)] : []), ...(options.transparency ? [chunk('tRNS', options.transparency)] : []), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function screenshotFixture(markdown: string, images: Record<string, Buffer>, config?: Record<string, unknown>): Fixture {
  const f = fixture(markdown);
  if (config) f.project.verify.screenshots = config as never;
  for (const [name, data] of Object.entries(images)) { const file = path.join(f.worktree, 'shots', name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); }
  ready(f, { evidence: Object.keys(images).map(name => path.join('shots', name)) });
  return f;
}

test('PNG decoder handles RGBA and all five row filters', () => {
  const width = 3, height = 5;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 17 + 3) & 255;
  const encoded = png(width, height, pixels, 6, [0, 1, 2, 3, 4]);
  const decoded = decodePng(encoded);
  assert.equal(decoded.status, 'ok');
  if (decoded.status === 'ok') { assert.equal(decoded.image.channels, 4); assert.deepEqual(decoded.image.pixels, pixels); }
});

test('image signatures distinguish PNG, JPEG, GIF, WebP and other data', () => {
  for (const [data, expected] of [
    [png(1, 1, Buffer.from([1, 2, 3])), 'PNG'],
    [Buffer.from([0xff, 0xd8, 0xff]), 'JPEG'],
    [Buffer.from('GIF87a'), 'GIF'], [Buffer.from('GIF89a'), 'GIF'],
    [Buffer.from('RIFF0000WEBP'), 'WebP'], [Buffer.from('plain text'), 'other'], [Buffer.alloc(0), 'other'],
  ] as const) assert.equal(imageFormat(data), expected);
});

for (const bitDepth of [1, 2, 4, 8]) test(`palette PNG with ${bitDepth}-bit packed indices decodes and summarizes`, () => {
  const last = 2 ** bitDepth - 1;
  const palette = Buffer.alloc((last + 1) * 3); palette.fill(255, last * 3);
  const data = bitDepth === 8 ? Buffer.from([0, last]) : Buffer.from([last << (8 - 2 * bitDepth)]);
  const decoded = decodePng(png(2, 1, data, 3, undefined, { bitDepth, palette, transparency: Buffer.from([0]) }));
  assert.equal(decoded.status, 'ok');
  if (decoded.status === 'ok') {
    assert.deepEqual(decoded.image.pixels, Buffer.from([0, 0, 0, 0, 255, 255, 255, 255]));
    assert.ok(Math.abs(summarizePng(decoded.image).meanLuminance - 0.5) < 1e-12);
  }
});

for (const colorType of [0, 4]) for (const bitDepth of [8, 16]) test(`grayscale PNG type ${colorType}, ${bitDepth}-bit decodes and summarizes`, () => {
  const samples = colorType === 4 ? [0, 255, 255, 128] : [0, 255];
  const data = bitDepth === 8 ? Buffer.from(samples) : Buffer.from(samples.flatMap(v => [v, 17]));
  const decoded = decodePng(png(2, 1, data, colorType, [1], { bitDepth }));
  assert.equal(decoded.status, 'ok');
  if (decoded.status === 'ok') {
    assert.deepEqual(decoded.image.pixels, Buffer.from(colorType === 4 ? [0, 0, 0, 255, 255, 255, 255, 128] : [0, 0, 0, 255, 255, 255]));
    assert.ok(Math.abs(summarizePng(decoded.image).meanLuminance - 0.5) < 1e-12);
    assert.equal(summarizePng(decoded.image).darkFraction, 0.5);
  }
});

for (const bitDepth of [1, 2, 4]) test(`packed ${bitDepth}-bit grayscale scales samples to bytes`, () => {
  const decoded = decodePng(png(2, 1, Buffer.from([(2 ** bitDepth - 1) << (8 - 2 * bitDepth)]), 0, undefined, { bitDepth }));
  assert.equal(decoded.status, 'ok');
  if (decoded.status === 'ok') assert.deepEqual(decoded.image.pixels, Buffer.from([0, 0, 0, 255, 255, 255]));
});

for (const colorType of [2, 6]) test(`16-bit colour PNG type ${colorType} reduces samples after unfiltering`, () => {
  const channels = colorType === 6 ? 4 : 3;
  const expected = Buffer.from(Array.from({ length: 3 * 5 * channels }, (_, i) => (i * 17 + 3) & 255));
  const data = Buffer.from([...expected].flatMap(v => [v, 123]));
  const decoded = decodePng(png(3, 5, data, colorType, [0, 1, 2, 3, 4], { bitDepth: 16 }));
  assert.equal(decoded.status, 'ok');
  if (decoded.status === 'ok') {
    assert.deepEqual(decoded.image.pixels, expected);
    assert.ok(summarizePng(decoded.image).luminanceStddev > 0);
  }
});

test('screenshot gate fails JPEG data in a .png file with a repair reason', () => {
  const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.png\n', { 'wrong.png': Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  const item = result(verifyOrder(f.project, f.orders, 'R1', { record: false }), 'screenshots');
  assert.equal(item.status, 'fail');
  assert.match(item.reason, /JPEG data in a \.png file: save it as PNG or rename it \.jpg/);
});

test('an interlaced PNG is decoded like a plain one (a 1x1 Adam7 image is its first pass)', () => {
  const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.png\n', { 'interlaced.png': png(1, 1, Buffer.from([1, 2, 3]), 2, undefined, { interlace: 1 }) });
  const item = result(verifyOrder(f.project, f.orders, 'R1', { record: false }), 'screenshots');
  assert.doesNotMatch(item.reason, /not decoded/);
  assert.equal((item.details as { files: { state: string }[] }).files[0].state, 'decoded');
});

test('expanded PNG types participate in the screenshot summary gate', () => {
  for (const image of [
    png(2, 1, Buffer.from([0, 1]), 3, undefined, { palette: Buffer.from([0, 0, 0, 255, 255, 255]) }),
    png(2, 1, Buffer.from([0, 255]), 0),
    png(2, 1, Buffer.from([0, 1, 255, 1]), 0, undefined, { bitDepth: 16 }),
  ]) {
    const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.png\n', { 'summary.png': image });
    const item = result(verifyOrder(f.project, f.orders, 'R1', { record: false }), 'screenshots');
    assert.equal(item.status, 'pass', item.reason);
    const files = item.details!.files as { state: string; mean_luminance: number }[];
    assert.equal(files[0].state, 'decoded');
    assert.ok(Math.abs(files[0].mean_luminance - 0.5) < 1e-12);
  }
});

test('screenshot gate fails byte-identical PNGs and reports their names', () => {
  const pixels = Buffer.alloc(8 * 8 * 3, 120);
  const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.png: screenshots\n', { 'one.png': png(8, 8, pixels), 'two.png': png(8, 8, pixels) });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'screenshots').status, 'fail');
  assert.match(result(report, 'screenshots').reason, /Duplicate screenshots/);
  assert.match(result(report, 'screenshots').reason, /one\.png/);
  assert.match(result(report, 'screenshots').reason, /two\.png/);
});

test('screenshot gate fails PNGs that differ only in a few pixels', () => {
  const a = Buffer.alloc(16 * 16 * 3, 100), b = Buffer.from(a); b[0] = 101;
  const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.png: screenshots\n', { 'one.png': png(16, 16, a), 'two.png': png(16, 16, b) });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'screenshots').status, 'fail');
});

test('screenshot gate passes clearly different non-flat PNGs', () => {
  const a = Buffer.alloc(16 * 16 * 3), b = Buffer.alloc(16 * 16 * 3);
  for (let i = 0; i < 16 * 16; i++) { const v = i % 16; a[i * 3] = v * 16; a[i * 3 + 1] = v * 16; a[i * 3 + 2] = v * 16; b[i * 3] = (15 - v) * 16; b[i * 3 + 1] = (15 - v) * 16; b[i * 3 + 2] = (15 - v) * 16; }
  const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.png: screenshots\n', { 'one.png': png(16, 16, a), 'two.png': png(16, 16, b) });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'screenshots').status, 'pass');
});

test('screenshot gate fails a flat single-colour PNG', () => {
  const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.png: screenshots\n', { 'flat.png': png(8, 8, Buffer.alloc(8 * 8 * 3, 40)) });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'screenshots').status, 'fail');
  assert.match(result(report, 'screenshots').reason, /Blank screenshots/);
});

test('screenshot gate warns for a mostly black PNG with a bright patch', () => {
  const pixels = Buffer.alloc(10 * 10 * 3); pixels.fill(0); pixels.fill(255, 0, 3 * 3 * 3);
  const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.png: screenshots\n', { 'dark.png': png(10, 10, pixels) });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'screenshots').status, 'warn');
  assert.match(result(report, 'screenshots').reason, /Dark screenshots/);
});

test('JPEG bytes without image data are listed as images, not decoded', () => {
  const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.jpg: screenshots\n', { 'image.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'screenshots').status, 'pass');
  assert.match(result(report, 'screenshots').reason, /not decoded \(JPEG has no image data\)/);
  assert.doesNotMatch(result(report, 'screenshots').reason, /unsupported/i);
  assert.equal((result(report, 'screenshots').details as { files: { state: string; format: string }[] }).files[0].state, 'not decoded');
  assert.equal((result(report, 'screenshots').details as { files: { format: string }[] }).files[0].format, 'JPEG');
});

test('verify.screenshots off removes the screenshot item', () => {
  const f = screenshotFixture('# R1\n\n## Acceptance\n- screenshots\n\n## Evidence\n- shots/*.png: screenshots\n', { 'flat.png': png(8, 8, Buffer.alloc(8 * 8 * 3, 40)) });
  f.project.verify.screenshots = 'off';
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'screenshots'), undefined);
});

test('verify fails when the ready report names a commit that does not exist', () => {
  const f = fixture('# R1\n\n## Acceptance\n- branch is ready\n');
  ready(f, { commits: ['deadbeef'] });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'report').status, 'fail');
  assert.match(result(report, 'report').reason, /do not exist/);
});

test('verify fails when reported evidence predates the order first run', () => {
  const f = fixture('# R1\n\n## Acceptance\n- branch is ready\n');
  const evidence = path.join(f.worktree, 'old.txt');
  writeFileSync(evidence, 'old evidence\n');
  git(f.worktree, 'add', 'old.txt');
  git(f.worktree, 'commit', '-q', '-m', 'old evidence');
  const old = new Date(f.started.getTime() - 1_000);
  utimesSync(evidence, old, old);
  ready(f, { evidence: ['old.txt'] });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'evidence').status, 'fail');
  assert.match(result(report, 'evidence').reason, /stale \(older than the order's first run start\)/);
  const note = lintReworkNote([{ name: 'evidence', ok: false, detail: result(report, 'evidence').reason }]);
  assert.match(note, /Do not change file times or move files to pass this check; rerun the step or cite files from this run\./);
  assert.doesNotMatch(note, /\btouch\b|re-?time|utimes|SetLastWriteTime/i);
  assert.match(producerSystemPrompt(f.project), /For delivery review and rework briefs: Do not change file times or move files to pass this check/);
});

for (const scenario of [
  { name: 'new files', files: true, fresh: true, status: 'pass', count: '1 of 2 files fresh' },
  { name: 'only old files', files: true, fresh: false, status: 'fail', count: '0 of 2 files fresh' },
  { name: 'no files', files: false, fresh: false, status: 'fail', count: '0 of 0 files fresh' },
] as const) {
  for (const required of ['evidence/shots', 'evidence/*', 'evidence/shots/']) {
    test(`verify checks an old directory holding ${scenario.name}, required as ${required}`, () => {
      const f = fixture(`# R1\n\n## Acceptance\n- branch is ready\n\n## Evidence\n- ${required}\n`);
      const directory = path.join(f.worktree, 'evidence', 'shots');
      const nested = path.join(directory, 'nested');
      mkdirSync(nested, { recursive: true });
      const old = new Date(f.started.getTime() - 1_000);
      const fresh = new Date(f.started.getTime() + 1_000);
      if (scenario.files) {
        const oldFile = path.join(directory, 'old.txt');
        const nestedFile = path.join(nested, 'result.txt');
        writeFileSync(oldFile, 'old evidence\n');
        writeFileSync(nestedFile, 'nested evidence\n');
        utimesSync(oldFile, old, old);
        utimesSync(nestedFile, scenario.fresh ? fresh : old, scenario.fresh ? fresh : old);
      }
      // Force old directory timestamps even though their contents were just written.
      utimesSync(nested, old, old);
      utimesSync(directory, old, old);
      ready(f, { evidence: ['evidence/shots/'] });
      const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
      for (const name of ['evidence', 'required evidence']) {
        const item = result(report, name);
        assert.equal(item.status, scenario.status, item.reason);
        assert.match(item.reason, /shots/);
        assert.ok(item.reason.includes(scenario.count), item.reason);
        if (!scenario.files) assert.match(item.reason, /missing/);
        else if (!scenario.fresh) {
          assert.match(item.reason, /older than the order's first run start/);
          assert.doesNotMatch(item.reason, /missing/);
        }
      }
    });
  }
}

test('verify fails when a required screenshot is missing', () => {
  const f = fixture('# R1\n\n## Acceptance\n- branch is ready\n\n## Evidence\n- screenshots/*.png: a play-through screenshot\n');
  ready(f);
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'required evidence').status, 'fail');
  assert.match(result(report, 'required evidence').reason, /Required evidence is missing/);
});

test('verify fails protected gate changes with the only-a-person reason', () => {
  const f = fixture('# R1\n\n## Acceptance\n- branch is ready\n', { protectedGates: ['tests/**'] });
  mkdirSync(path.join(f.worktree, 'tests'), { recursive: true });
  writeFileSync(path.join(f.worktree, 'tests', 'gate.ts'), 'changed gate\n');
  git(f.worktree, 'add', 'tests/gate.ts');
  git(f.worktree, 'commit', '-q', '-m', 'change gate');
  ready(f);
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'tampering').status, 'fail');
  assert.match(result(report, 'tampering').reason, /only a person can accept/);
});

test('verify fails a changed file outside the order allow paths', () => {
  const f = fixture('# R1\n\n## Acceptance\n- branch is ready\n\n## Paths\n- allow: src/**\n');
  ready(f);
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(result(report, 'paths').status, 'fail');
  assert.match(result(report, 'paths').reason, /outside allow/);
});

test('verify passes every gate when the fixture report and evidence are correct', () => {
  const f = fixture('# R1\n\n## Acceptance\n- branch is ready\n\n## Evidence\n- evidence/*.txt: the run result\n\n## Paths\n- allow: feature.txt\n- allow: evidence/**\n');
  mkdirSync(path.join(f.worktree, 'evidence'), { recursive: true });
  const evidence = path.join(f.worktree, 'evidence', 'result.txt');
  writeFileSync(evidence, 'result\n');
  git(f.worktree, 'add', 'evidence/result.txt');
  git(f.worktree, 'commit', '-q', '-m', 'fixture evidence');
  ready(f, { evidence: ['evidence/result.txt'] });
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(report.ok, true);
  assert.ok(report.results.every(item => item.status === 'pass'));
});

test('an order with no acceptance or evidence sections produces warnings only', () => {
  const f = fixture('# R1\nNo deterministic sections.\n');
  ready(f);
  const report = verifyOrder(f.project, f.orders, 'R1', { record: false });
  assert.equal(report.ok, true);
  assert.ok(report.results.some(item => item.status === 'warn'));
  assert.ok(report.results.every(item => item.status !== 'fail'));
});

test('a ready run records exactly one order-verified event', () => {
  const f = fixture('# R1\n\n## Acceptance\n- branch is ready\n');
  f.orders.act('R1', 'queue');
  const run = f.orders.runStart('R1', { worker: 'fixture' }).run;
  applyFinish(f.orders, { tag: 'R1', run: run.id, outcome: 'completed', report: { status: 'ready', summary: 'ready', evidence: [], commits: [f.branchCommit] }, why: 'fixture' }, f.project);
  assert.equal(f.orders.store.events({ tag: 'R1' }).filter(event => event.type === 'order-verified').length, 1);
});

test('globBase: only the folder before the first wildcard is walked', async () => {
  const { globBase } = await import('../src/verify/verify.ts');
  assert.equal(globBase('artifacts/evidence/X/shots/*map*.png'), 'artifacts/evidence/X/shots');
  assert.equal(globBase('docs/report.md'), 'docs');
  assert.equal(globBase('**/*.png'), '');
  assert.equal(globBase('a/*/b/c.png'), 'a');
});
