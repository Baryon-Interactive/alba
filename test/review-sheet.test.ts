import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { contactSheet, encodePng, formatSheet } from '../src/review/sheet.ts';
import type { Probes } from '../src/tick/gather.ts';
import { decodePng, pictureStats, subjectStats } from '../src/verify/png.ts';
import { tempOrders } from './helpers.ts';

const flat = (w: number, h: number, v: number) => encodePng(w, h, Buffer.alloc(w * h * 3, v));

test('review sheet: the evidence pictures of an order on one PNG, with size, mean luminance and dark share', () => {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(path.join(root, 'shots'), { recursive: true }); mkdirSync(path.join(dir, 'orders'), { recursive: true });
  writeFileSync(path.join(root, 'shots', 'black.png'), flat(200, 100, 0));
  writeFileSync(path.join(root, 'shots', 'white.png'), flat(100, 100, 255));
  writeFileSync(path.join(root, 'shots', 'photo.jpg'), 'not decoded');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees') } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Shots', kind: 'ue' });
  orders.act('T1', 'queue'); orders.runStart('T1', { worker: 'w' }); orders.runEnd('T1');
  orders.report('T1', { status: 'ready', summary: 'Shots', evidence: ['shots/black.png', 'shots/white.png', 'shots/photo.jpg'], commits: [] });
  const probes = { now: () => new Date(), fileTime: () => undefined, readText: () => undefined, isAlive: () => false, worktrees: () => [] } as unknown as Probes;
  const out = path.join(dir, 'sheet.png');
  const sheet = contactSheet(project, orders, probes, 't1', { out, columns: 2, cell: 64 });
  assert.deepEqual(sheet.images.map(i => [path.basename(i.file), i.width ?? null, i.meanLuminance === undefined ? null : Math.round(i.meanLuminance * 100) / 100, i.darkFraction ?? null, i.skipped ?? null]), [
    ['black.png', 200, 0, 1, null], ['white.png', 100, 1, 0, null], ['photo.jpg', null, null, null, 'not a PNG'],
  ]);
  const decoded = decodePng(readFileSync(out));
  assert.equal(decoded.status, 'ok');
  if (decoded.status === 'ok') { assert.equal(decoded.image.width, 2 * 64 + 3 * 8); assert.equal(decoded.image.height, 64 + 2 * 8); }
  const text = formatSheet(sheet);
  assert.match(text, /T1: .*sheet\.png \(2 per row\)/);
  assert.match(text, /  1  200x100  mean 0\.000  spread 0\.000  dark 100%  .*black\.png/);
  assert.match(text, /  -  .*photo\.jpg  skipped: not a PNG/);
});

test('review sheet: highlight share, p5/p95 and saturation per picture; a <name>.mask.png gives the subject against its surround', () => {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(path.join(root, 'shots'), { recursive: true }); mkdirSync(path.join(dir, 'orders'), { recursive: true });
  // A grey 50 ground with a 20 x 40 subject of grey 240 at (40, 30); its mask is white there.
  const w = 100, h = 100;
  const scene = Buffer.alloc(w * h * 3, 50), mask = Buffer.alloc(w * h * 3, 0);
  for (let y = 30; y < 70; y++) for (let x = 40; x < 60; x++) { scene.fill(240, (y * w + x) * 3, (y * w + x) * 3 + 3); mask.fill(255, (y * w + x) * 3, (y * w + x) * 3 + 3); }
  writeFileSync(path.join(root, 'shots', 'scene.png'), encodePng(w, h, scene));
  writeFileSync(path.join(root, 'shots', 'scene.mask.png'), encodePng(w, h, mask));
  const red = Buffer.alloc(10 * 10 * 3); for (let p = 0; p < 100; p++) red[p * 3] = 255;
  writeFileSync(path.join(root, 'shots', 'red.png'), encodePng(10, 10, red));
  writeFileSync(path.join(root, 'shots', 'red.mask.png'), flat(4, 4, 255));
  writeFileSync(path.join(root, 'shots', 'empty.png'), flat(8, 8, 128));
  writeFileSync(path.join(root, 'shots', 'empty.mask.png'), flat(8, 8, 0));
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees') } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T2', title: 'Scene', kind: 'art' });
  orders.act('T2', 'queue'); orders.runStart('T2', { worker: 'w' }); orders.runEnd('T2');
  orders.report('T2', { status: 'ready', summary: 'Scene', evidence: ['shots/scene.png', 'shots/scene.mask.png', 'shots/red.png', 'shots/empty.png'], commits: [] });
  const probes = { now: () => new Date(), fileTime: () => undefined, readText: () => undefined, isAlive: () => false, worktrees: () => [] } as unknown as Probes;
  const sheet = contactSheet(project, orders, probes, 'T2');
  assert.deepEqual(sheet.images.map(i => path.basename(i.file)), ['scene.png', 'red.png', 'empty.png'], 'a mask is read with its picture, not shown as one');
  const [scene1, red1, empty1] = sheet.images;
  const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  near(scene1.highlightFraction, 800 / 10000); near(scene1.p5, 50 / 255); near(scene1.p95, 240 / 255); near(scene1.meanSaturation, 0);
  near(scene1.subjectMeanLuminance, 240 / 255); near(scene1.surroundMeanLuminance, 50 / 255); near(scene1.subjectContrast, 190 / 255);
  assert.equal(scene1.subjectHeight, 40);
  assert.match(scene1.mask ?? '', /shots\/scene\.mask\.png$/);
  // The fields that were there before keep their values.
  near(scene1.meanLuminance, (800 * 240 + 9200 * 50) / 10000 / 255); near(scene1.darkFraction, 0);
  near(red1.meanSaturation, 1); near(red1.highlightFraction, 0); assert.equal(red1.maskSkipped, 'the mask is 4x4, the picture 10x10'); assert.equal(red1.subjectHeight, undefined);
  assert.equal(empty1.maskSkipped, 'the mask marks no subject');
  const text = formatSheet(sheet);
  assert.match(text, /  1  100x100  mean 0\.\d{3}  spread 0\.\d{3}  dark 0%  high 8%  p5 0\.196  p95 0\.941  sat 0\.000  subject 0\.941 vs 0\.196 \(\+0\.745\) 40px  .*scene\.png/);
  assert.match(text, /  2  10x10  .*sat 1\.000  mask skipped: the mask is 4x4, the picture 10x10  .*red\.png/);
});

test('subject stats: the surround is a band around the mask, not the rest of the picture', () => {
  // A 200-wide picture: the subject (4 x 4, white) sits in a grey 100 field 10 px wide, then black to the edge.
  const w = 200, h = 20, rgb = Buffer.alloc(w * h * 3, 0), mask = Buffer.alloc(w * h * 3, 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < 30; x++) rgb.fill(100, (y * w + x) * 3, (y * w + x) * 3 + 3);
  for (let y = 8; y < 12; y++) for (let x = 10; x < 14; x++) { rgb.fill(255, (y * w + x) * 3, (y * w + x) * 3 + 3); mask.fill(255, (y * w + x) * 3, (y * w + x) * 3 + 3); }
  const image = decodePng(encodePng(w, h, rgb)), m = decodePng(encodePng(w, h, mask));
  assert.ok(image.status === 'ok' && m.status === 'ok');
  const result = subjectStats(image.image, m.image);
  assert.ok(result.status === 'ok');
  assert.equal(result.stats.surroundBand, 2);
  assert.ok(Math.abs((result.stats.surroundMeanLuminance ?? 0) - 100 / 255) < 1e-9, 'only the grey field next to the subject counts');
  assert.equal(result.stats.subjectHeight, 4);
  const all = pictureStats(image.image);
  assert.equal(all.p5, 0);
});
