import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { encodePng } from '../src/review/sheet.ts';
import { applyFinish } from '../src/run/finish.ts';
import { pendingNotes } from '../src/run/prompt.ts';
import { tempOrders } from './helpers.ts';

/** A small picture with a gradient (not flat), or one flat colour. */
const picture = (shift: number, flat = false) => { const w = 16, h = 8, rgb = Buffer.alloc(w * h * 3); for (let i = 0; i < rgb.length; i++) rgb[i] = flat ? 0 : (i * 7 + shift) % 256; return encodePng(w, h, rgb); };

function fixture() {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(path.join(root, 'shots'), { recursive: true }); mkdirSync(path.join(dir, 'orders'));
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees') } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'C1', title: 'Camera moments', kind: 'ue' });
  orders.act('C1', 'queue');
  return { orders, project, shots: path.join(root, 'shots') };
}

const deliver = (f: ReturnType<typeof fixture>, evidence: string[]) => {
  const { run } = f.orders.runStart('C1', { worker: 'w' });
  applyFinish(f.orders, { tag: 'C1', run: run.id, outcome: 'completed', report: { status: 'ready', summary: 'Four camera moments', evidence, commits: [] }, why: 'done' }, f.project);
};

test('evidence pictures that are copies of one file, or one flat colour, go back to the worker once', () => {
  const f = fixture();
  for (const name of ['open.png', 'charge.png', 'close.png']) writeFileSync(path.join(f.shots, name), picture(1));
  writeFileSync(path.join(f.shots, 'night.png'), picture(0, true));
  writeFileSync(path.join(f.shots, 'wide.png'), picture(2));
  const evidence = ['shots/open.png', 'shots/charge.png', 'shots/close.png', 'shots/night.png', 'shots/wide.png'];
  deliver(f, evidence);
  let doc = f.orders.get('C1');
  assert.equal(f.orders.stage(doc).stage, 'queued');
  const note = pendingNotes(doc).at(-1)!.text;
  assert.match(note, /shots\/open\.png, shots\/charge\.png, shots\/close\.png are the same file, byte for byte/);
  assert.match(note, /shots\/night\.png is a single flat colour/);
  assert.doesNotMatch(note, /wide\.png/);
  // Delivered the same again: to review, with a warning.
  deliver(f, evidence);
  doc = f.orders.get('C1');
  assert.equal(f.orders.stage(doc).stage, 'awaiting-review');
  assert.ok(f.orders.store.events({ tag: 'C1' }).some(e => e.type === 'accept-warning' && e.data?.name === 'evidence-images'));
});

test('distinct pictures pass', () => {
  const f = fixture();
  writeFileSync(path.join(f.shots, 'a.png'), picture(1)); writeFileSync(path.join(f.shots, 'b.png'), picture(2));
  deliver(f, ['shots/a.png', 'shots/b.png', 'shots/missing.png']);
  assert.equal(f.orders.stage(f.orders.get('C1')).stage, 'awaiting-review');
});
