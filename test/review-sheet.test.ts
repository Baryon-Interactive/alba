import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { contactSheet, encodePng, formatSheet } from '../src/review/sheet.ts';
import type { Probes } from '../src/tick/gather.ts';
import { decodePng } from '../src/verify/png.ts';
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
