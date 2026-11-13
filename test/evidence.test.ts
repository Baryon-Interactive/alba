import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { imageSize } from '../src/evidence/evidence.ts';
import { fixture, shape } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';

/** A real PNG of the given size (solid grey). */
export function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The head of a jpeg: an APP0 segment, then SOF0 with the size. Enough for a size reader. */
const jpeg = (width: number, height: number): Buffer => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
const gif = (width: number, height: number): Buffer => Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 255, width >> 8, height & 255, height >> 8, 0, 0, 0, 0x3b]);

test('image size: read from the header of a png, jpeg and gif; nothing for other bytes', () => {
  const { dir } = tempOrders();
  const write = (name: string, data: Buffer) => { const f = path.join(dir, name); writeFileSync(f, data); return f; };
  assert.deepEqual(imageSize(write('a.png', png(13, 7))), { width: 13, height: 7 });
  assert.deepEqual(imageSize(write('a.jpg', jpeg(640, 480))), { width: 640, height: 480 });
  assert.deepEqual(imageSize(write('a.gif', gif(300, 200))), { width: 300, height: 200 });
  assert.equal(imageSize(write('a.bin', Buffer.from('not an image at all, really'))), undefined);
});

async function withEvidence() {
  const f = await fixture({ project: () => ({ evidence: { dirs: ['artifacts/evidence/{tag}'] } }) });
  // R1 has a worktree. Its report names a screenshot by a relative path; a folder holds more; a question has an image.
  const shots = path.join(f.worktree, 'shots');
  mkdirSync(shots, { recursive: true });
  writeFileSync(path.join(shots, 'start.png'), png(32, 16));
  const folder = path.join(f.worktree, 'artifacts', 'evidence', 'R1', 'run1');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'after.png'), png(64, 48));
  writeFileSync(path.join(folder, 'photo.jpg'), jpeg(800, 600));
  writeFileSync(path.join(folder, 'clip.mp4'), Buffer.from('not really a video'));
  writeFileSync(path.join(folder, 'notes.txt'), 'text');
  f.orders.report('R1', { status: 'ready', summary: 'again', evidence: ['shots/start.png', 'shots/missing.png', 'some free text', 'orders/R1-review.md'], commits: [] });
  return f;
}

test('evidence: files named by reports, found in the evidence folders and used by questions are listed with their sizes', async () => {
  const f = await withEvidence();
  const list = (await f.get('/api/orders/R1/evidence')).body;
  shape(list, { project: 'string', tag: 'string', files: [{ path: 'string', name: 'string', kind: 'string', size: 'number', modified: 'string', 'width?': 'number', 'height?': 'number', from: 'string' }], folders: 'array' });
  const by = Object.fromEntries(list.files.map((x: { name: string }) => [x.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ['after.png', 'clip.mp4', 'photo.jpg', 'start.png']);
  assert.deepEqual([by['start.png'].from, by['start.png'].width, by['start.png'].height, by['start.png'].kind], ['report', 32, 16, 'image']);
  assert.deepEqual([by['after.png'].from, by['after.png'].width, by['after.png'].height], ['folder', 64, 48]);
  assert.deepEqual([by['photo.jpg'].width, by['photo.jpg'].height], [800, 600]);
  assert.deepEqual([by['clip.mp4'].kind, by['clip.mp4'].width], ['video', undefined]);
  assert.equal(list.folders.length, 1);
  assert.match(list.folders[0], /artifacts\/evidence\/R1$/);
  // an order with nothing says why
  const none = (await f.get('/api/orders/Q1/evidence')).body;
  assert.deepEqual(none.files, []);
  assert.match(none.note, /evidence folders/);
  assert.equal((await f.get('/api/orders/NOPE/evidence')).status, 404);
});

test('evidence: a question can use evidence images as the pictures of its options', async () => {
  const f = await withEvidence();
  f.orders.act('R1', 'rework', { note: 'once more' });
  f.orders.runStart('R1', { worker: 'coder' }); f.orders.runEnd('R1');
  const bad = await f.write('/api/orders/R1/questions', { text: 'Which?', options: [{ label: 'A', images: ['shots/nothing.png'] }, 'B'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /shots\/nothing\.png/);
  const made = await f.write('/api/orders/R1/questions', { text: 'Which?', options: [{ label: 'A', images: ['shots/start.png'] }, { label: 'B', images: [path.join(f.worktree, 'artifacts', 'evidence', 'R1', 'run1', 'after.png')] }] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const image = made.body.options[0].images[0];
  assert.match(image, /shots\/start\.png$/);
  const file = await fetch(`${f.base}/api/files?path=${encodeURIComponent(image)}`, { headers: { 'x-alba-token': f.token } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  const list = (await f.get('/api/orders/R1/evidence')).body;
  assert.ok(list.files.some((x: { name: string }) => x.name === 'start.png'));
});

test('files: bytes with the right type, ranges, and nothing outside the project', async () => {
  const f = await withEvidence();
  const full = png(32, 16);
  const start = path.join(f.worktree, 'shots', 'start.png');
  const ok = await fetch(`${f.base}/api/files?path=${encodeURIComponent(start)}`, { headers: { 'x-alba-token': f.token } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('accept-ranges'), 'bytes');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), full);
  // a relative path is looked up in the order's worktree when a tag is given
  const rel = await fetch(`${f.base}/api/files?tag=R1&path=${encodeURIComponent('shots/start.png')}`, { headers: { 'x-alba-token': f.token } });
  assert.equal(rel.status, 200);
  assert.equal((await fetch(`${f.base}/api/files?path=${encodeURIComponent('shots/start.png')}`, { headers: { 'x-alba-token': f.token } })).status, 404);   // not in the project itself
  // ranges
  const part = await fetch(`${f.base}/api/files?path=${encodeURIComponent(start)}`, { headers: { 'x-alba-token': f.token, range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 2-5/${full.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), full.subarray(2, 6));
  const tail = await fetch(`${f.base}/api/files?path=${encodeURIComponent(start)}`, { headers: { 'x-alba-token': f.token, range: 'bytes=-4' } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), full.subarray(full.length - 4));
  assert.equal((await fetch(`${f.base}/api/files?path=${encodeURIComponent(start)}`, { headers: { 'x-alba-token': f.token, range: `bytes=${full.length + 10}-` } })).status, 416);
  // refused: other types, missing files, folders, paths that climb out
  assert.equal((await f.get(`/api/files?path=${encodeURIComponent(path.join(f.worktree, 'a.txt'))}`)).status, 400);
  assert.equal((await f.get(`/api/files?path=${encodeURIComponent(path.join(f.worktree, 'shots', 'missing.png'))}`)).status, 404);
  assert.equal((await f.get('/api/files')).status, 400);
  const outside = path.join(f.dir, 'secret.png');
  writeFileSync(outside, png(4, 4));
  assert.equal((await f.get(`/api/files?path=${encodeURIComponent(outside)}`)).status, 403);
  assert.equal((await f.get(`/api/files?tag=R1&path=${encodeURIComponent('../secret.png')}`)).status, 403);
});

test('files: a link inside the project that leads out of it is refused, one that stays inside is read', async () => {
  const f = await withEvidence();
  const elsewhere = path.join(f.dir, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(elsewhere, 'private.png'), png(8, 8));
  const link = path.join(f.root, 'out-link');
  const inner = path.join(f.root, 'in-link');
  symlinkSync(elsewhere, link, 'junction');
  mkdirSync(path.join(f.root, 'pics'), { recursive: true });
  writeFileSync(path.join(f.root, 'pics', 'ok.png'), png(8, 8));
  symlinkSync(path.join(f.root, 'pics'), inner, 'junction');
  assert.equal((await f.get(`/api/files?path=${encodeURIComponent(path.join(link, 'private.png'))}`)).status, 403);
  assert.equal((await f.get(`/api/files?path=${encodeURIComponent(path.join(inner, 'ok.png'))}`)).status, 200);
});
