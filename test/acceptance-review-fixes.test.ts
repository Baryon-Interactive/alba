import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { approve } from '../src/run/review.ts';
import { recoverAcceptanceMerge } from '../src/review/acceptance.ts';
import { gate } from '../src/credits/credits.ts';
import { FileStore } from '../src/orders/store.ts';
import { closeStateStores } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { syncOrders } from '../src/sync/sync.ts';
import { evidenceProblems } from '../src/review/evidence-check.ts';
import { decodeJpegBlocks } from '../src/verify/jpeg.ts';
import { decodePng, summarizePng } from '../src/verify/png.ts';
import { lockOwner, tryLock, type LockProbes } from '../src/fs/lock.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const command = (source: string) => [process.execPath, '-e', source];

/** Removes a test folder; a SQLite state store keeps its file open until it is closed. */
const removeDir = (dir: string) => { closeStateStores(); rmSync(dir, { recursive: true, force: true }); };

/** A repository with a delivery branch (with or without a commit of its own) and a project whose pipeline runs one step. */
function pipeline(t: TestContext, options: { commit?: boolean; step?: string; postMerge?: string[][] } = {}) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'repo'), delivery = path.join(dir, 'delivery'), workOrders = path.join(dir, 'orders');
  mkdirSync(root); mkdirSync(workOrders);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com'); git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'game.txt'), 'base\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial');
  git(root, 'worktree', 'add', '-qb', 'delivery', delivery);
  if (options.commit !== false) { writeFileSync(path.join(delivery, 'feature.txt'), 'feature\n'); git(delivery, 'add', '.'); git(delivery, 'commit', '-qm', 'feature'); }
  const project = validateProject({ id: 'sample', name: 'Sample', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { base_ref: 'main' }, accept: {
    steps: [{ name: 'build', command: command(options.step ?? 'process.exit(0)'), timeout_minutes: 1 }], post_merge: options.postMerge ?? [],
  } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'DEMO', title: 'Sample feature', kind: 'code', worktree: delivery, branch: 'delivery' });
  writeFileSync(path.join(workOrders, 'DEMO.md'), '# Sample\n\n## Acceptance\n- The sample feature works.\n');
  const run = orders.runStart('DEMO', { worker: 'fake' }).run;
  t.after(() => { try { git(root, 'worktree', 'remove', '--force', delivery); } catch { /* removed */ } removeDir(dir); });
  return { orders, dir, root, delivery, workOrders, project, run };
}
const deliverReady = (f: ReturnType<typeof pipeline>, end = true) => {
  if (end) f.orders.runEnd('DEMO', 'completed');
  f.orders.report('DEMO', { status: 'ready', summary: 'Feature works', evidence: [], commits: [] });
};

test('A-1: approval is refused while a run of the order is open, by the engine and by approve', t => {
  const f = pipeline(t);
  deliverReady(f, false); // the worker reported ready, but its run has not ended
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  assert.throws(() => f.orders.act('DEMO', 'approve', { note: 'looks good to me' }), /is still open/);
  assert.throws(() => approve(f.project, f.orders, 'DEMO', 'looks good to me'), /is still open/);
  assert.equal(git(f.root, 'rev-parse', 'main'), git(f.root, 'rev-parse', 'HEAD'));
  assert.equal(f.orders.get('DEMO').actions.some(a => a.kind === 'approve'), false);
  // A run on its own (no report) is not approvable either, even with an override.
  const g = pipeline(t);
  assert.equal(g.orders.stage(g.orders.get('DEMO')).stage, 'running');
  assert.throws(() => g.orders.act('DEMO', 'approve', { note: 'approve it anyway please', override: true }), /is still open/);
  f.orders.runEnd('DEMO', 'completed');
  approve(f.project, f.orders, 'DEMO', 'looks good to me');
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
});

test('A-1: a failing post-merge step rolls the merge back to the recorded state; a merge that died midway is rolled back next time', t => {
  const f = pipeline(t, { postMerge: [command('process.exit(3)')] });
  deliverReady(f);
  const original = git(f.root, 'rev-parse', 'HEAD');
  assert.throws(() => approve(f.project, f.orders, 'DEMO', 'reviewed'), /post_merge 1 failed/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), original);
  assert.equal(existsSync(path.join(f.workOrders, 'DEMO.accept.md')), false);
  assert.equal(existsSync(path.join(f.project.state_dir, 'acceptance', 'merge-journal.json')), false);
  const events = f.orders.store.events({ tag: 'DEMO' }).map(e => e.type);
  assert.ok(events.includes('accept-merge-started') && events.includes('accept-merge-failed'));

  // A process that died after its merge commit: its journal names the state to go back to.
  git(f.root, 'merge', '--no-ff', '-q', '-m', 'Half-done acceptance merge', 'delivery');
  const merge = git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.workOrders, 'DEMO.accept.md'), 'note of the dead merge\n');
  mkdirSync(path.join(f.project.state_dir, 'acceptance'), { recursive: true });
  writeFileSync(path.join(f.project.state_dir, 'acceptance', 'merge-journal.json'), JSON.stringify({ tag: 'DEMO', at: new Date().toISOString(), original, branch: git(f.root, 'rev-parse', 'delivery'), merge, note: path.join(f.workOrders, 'DEMO.accept.md') }));
  recoverAcceptanceMerge(f.project, f.orders);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), original);
  assert.equal(existsSync(path.join(f.workOrders, 'DEMO.accept.md')), false);
  assert.ok(f.orders.store.events({ tag: 'DEMO' }).some(e => e.type === 'accept-merge-recovered'));
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
});

test('A-2: a ready delivery with no commits of its own still has to pass the pipeline trial', t => {
  const f = pipeline(t, { commit: false, step: 'process.exit(5)' });
  deliverReady(f);
  // The branch never moved, so it is "in" main already; the pipeline must not be skipped for it.
  assert.throws(() => approve(f.project, f.orders, 'DEMO', 'nothing to merge'), /Acceptance failed: Step build failed/);
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  assert.equal(existsSync(path.join(f.workOrders, 'DEMO.accept.md')), false);
  const g = pipeline(t, { commit: false });
  deliverReady(g);
  approve(g.project, g.orders, 'DEMO', 'nothing to merge, steps pass');
  assert.equal(g.orders.stage(g.orders.get('DEMO')).stage, 'merged');
  assert.equal(g.orders.store.events({ tag: 'DEMO' }).filter(e => e.type === 'accept-trial').at(-1)?.data?.status, 'passed');
});

test('A-4: the files backend rolls a transaction back, and a journal left by a dead writer is restored', () => {
  const { orders, dir } = tempOrders('files');
  const store = orders.store as FileStore;
  orders.add({ tag: 'A1', title: 'Art', kind: 'task' });
  const before = readFileSync(path.join(dir, 'state', 'A1.json'), 'utf8');
  const events = statSync(path.join(dir, 'state', 'events.jsonl')).size;
  assert.throws(() => store.transaction(() => {
    const doc = orders.get('A1'); doc.order.title = 'Changed'; store.write(doc);
    store.appendEvent({ at: orders.now(), tag: 'A1', type: 'changed', data: {} });
    store.writeMeta('extra', { a: 1 });
    throw new Error('stop');
  }), /stop/);
  assert.equal(readFileSync(path.join(dir, 'state', 'A1.json'), 'utf8'), before);
  assert.equal(statSync(path.join(dir, 'state', 'events.jsonl')).size, events);
  assert.equal(store.readMeta('extra'), undefined);
  assert.equal(existsSync(path.join(dir, 'state', '_write.journal')), false);

  // A writer that died inside a transaction: the next writer puts back what the journal recorded.
  const doc = orders.get('A1'); doc.order.title = 'Half written'; store.write(doc);
  store.appendEvent({ at: orders.now(), tag: 'A1', type: 'half', data: {} });
  writeFileSync(path.join(dir, 'state', '_write.journal'), JSON.stringify({ pid: 1, files: { 'A1.json': before, '_extra.json': null }, events }));
  const fresh = new Orders(new FileStore(path.join(dir, 'state')));
  fresh.record('A1', 'after-recovery');
  assert.equal(fresh.get('A1').order.title, 'Art');
  const types = fresh.store.events({ tag: 'A1' }).map(e => e.type);
  assert.equal(types.at(-1), 'after-recovery');
  assert.equal(types.includes('half'), false);
  assert.equal(existsSync(path.join(dir, 'state', '_write.journal')), false);
});

test('A-5: the credits gate holds what it lets through, and a spend with a key books once', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'A1', title: 'Art', kind: 'task' });
  orders.quote('A1', { service: 'images', cap_requested: 10 });
  orders.decideQuote('A1', 'C1', { approve: true, cap: 10 });
  const first = gate(orders, 'A1', 'C1', 6, { key: 'call-1' });
  assert.equal(first.ok, true);
  assert.equal(first.hold?.key, 'call-1');
  // A second call at the same time cannot have the same money.
  const second = gate(orders, 'A1', 'C1', 6, { key: 'call-2' });
  assert.equal(second.ok, false);
  assert.match(second.why, /4 credits left, 6 are needed/);
  // The holder books its call; the same booking again (a retry) books nothing more.
  orders.spend('A1', 'C1', { amount: 6, what: 'six sprites', key: 'call-1' });
  const again = orders.spend('A1', 'C1', { amount: 6, what: 'six sprites', key: 'call-1' });
  assert.equal(again.repeated, true);
  const quote = orders.get('A1').quotes![0];
  assert.equal(quote.ledger.length, 1);
  assert.equal(quote.holds, undefined);
  assert.throws(() => orders.spend('A1', 'C1', { amount: 2, what: 'other amount', key: 'call-1' }), /already booked 6 credits with key call-1/);
  assert.equal(gate(orders, 'A1', 'C1', 4, { key: 'call-3' }).ok, true);
  assert.equal(gate(orders, 'A1', 'C1', 1).ok, false);
  // A hold that lapses gives its money back.
  orders.releaseHold('A1', 'C1', 'call-3');
  assert.equal(gate(orders, 'A1', 'C1', 0).remaining, 4);
});

test('A-6: sync approves from a note only for a ready delivery; a leftover note on a failed one is left to a person', t => {
  const failed = pipeline(t);
  failed.project.accept = undefined;
  failed.orders.runEnd('DEMO', 'completed');
  failed.orders.report('DEMO', { status: 'failed', summary: 'Broke the build', evidence: [], commits: [] });
  writeFileSync(path.join(failed.workOrders, 'DEMO.accept.md'), '# Accepted earlier\n');
  const result = syncOrders(failed.project, failed.orders);
  assert.equal(failed.orders.stage(failed.orders.get('DEMO')).stage, 'failed');
  assert.ok(result.skipped.some(s => /not a ready delivery/.test(s.why)));
  const ready = pipeline(t);
  ready.project.accept = undefined;
  deliverReady(ready);
  writeFileSync(path.join(ready.workOrders, 'DEMO.accept.md'), '# Accepted\n');
  syncOrders(ready.project, ready.orders);
  assert.equal(ready.orders.stage(ready.orders.get('DEMO')).stage, 'merged');
  assert.equal(ready.orders.get('DEMO').actions.at(-1)?.imported, true);
});

const jpeg = {
  black: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//Z',
  blackProgressive: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wgARCAAwAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGVAAAAAAAAAAAAf//EABQQAQAAAAAAAAAAAAAAAAAAAFD/2gAIAQEAAQUCQ//EABQRAQAAAAAAAAAAAAAAAAAAADD/2gAIAQMBAT8BT//EABQRAQAAAAAAAAAAAAAAAAAAADD/2gAIAQIBAT8BT//EABQQAQAAAAAAAAAAAAAAAAAAAFD/2gAIAQEABj8CQ//EABQQAQAAAAAAAAAAAAAAAAAAAFD/2gAIAQEAAT8hQ//aAAwDAQACAAMAAAAQ888888888888/8QAFBEBAAAAAAAAAAAAAAAAAAAAMP/aAAgBAwEBPxBP/8QAFBEBAAAAAAAAAAAAAAAAAAAAMP/aAAgBAgEBPxBP/8QAFBABAAAAAAAAAAAAAAAAAAAAUP/aAAgBAQABPxBD/9k=',
  gradient: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD817HQeny10FjoPT5a6Wx0Hp8tdDY6D0+Wu3DyOPL8121OasdB6fLXQ2Og9PlrpbHQeny10NjoPT5a+kw7P0vL8121OasdB6fLXQ2Og9PlrpbHQeny10NjoPT5a+jw7P0vL8121OZsdB6fLXQ2Og9PlrpbHQeny10NjoPT5a+jw8j9Ly/NdtT5fsdB6fLXQ2Og9PlrpbHQeny10NjoPT5a/D8Oz/LvL8121OasdB6fLXQ2Og9PlrpbHQeny10NjoPT5a+jw7P0rL8121OasdB6fLXQ2Og9PlrpbHQeny10FjoPT5a+jw7P0vL8121OasdB6fLXQWeiKiFmAVQMkngAV0tnoiou5gFVRkk8ACs3US2ot5MIK2oPpgufU+3t/keNxPxhguEcF9YxHvVZfBBPWT/SK6vpsrtpP9VyfHSryST06s8TsdB6fLXQ2Og9PlrpbHQeny10NjoPT5a+Lw8j/LHL8121OasdB6fLXQ2Og9PlrpbHQeny10NjoPT5a+jw7P0vL8121OasdB6fLW/Z6Isa7mAVQMkngAV0tnoixqWYBVAySeABWbqJbUW8mEFbUHr0Ln1Pt7f5HjcT8YYLhHBfWMR71WXwQvrJ/pFdX02V20n+qZPjpYiSSenVnNaiW1FvJhBW1U+mC59T7e3+RPY6D0+WulsdB6fLXQ2Og9Plr+JcyzvG5/jZ4/Hz5py+5LpGK6JdF83dts/dcrzGNKKhB6H/2Q==',
};

/** An Adam7-interlaced RGB PNG: each of the seven passes filtered (type 0) on its own. */
function interlacedPng(width: number, height: number, rgb: Buffer): Buffer {
  const chunk = (type: string, body: Buffer) => { const head = Buffer.from(type); const out = Buffer.alloc(12 + body.length); out.writeUInt32BE(body.length, 0); head.copy(out, 4); body.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([head, body])), 8 + body.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[12] = 1;
  const rows: Buffer[] = [];
  for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
    for (let y = y0; y < height; y += dy) {
      const row: number[] = [0];
      for (let x = x0; x < width; x += dx) row.push(...rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3));
      if (row.length > 1) rows.push(Buffer.from(row));
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('A-10: a black JPEG and a flat interlaced PNG are caught by the blank check; real pictures decode', t => {
  for (const name of ['black', 'blackProgressive'] as const) {
    const decoded = decodeJpegBlocks(Buffer.from(jpeg[name], 'base64'));
    assert.equal(decoded.status, 'ok', name);
    if (decoded.status === 'ok') { assert.deepEqual([decoded.image.width, decoded.image.height], [8, 6]); assert.equal(summarizePng(decoded.image).luminanceStddev, 0); }
  }
  const gradient = decodeJpegBlocks(Buffer.from(jpeg.gradient, 'base64'));
  assert.equal(gradient.status, 'ok');
  if (gradient.status === 'ok') assert.ok(summarizePng(gradient.image).luminanceStddev > 0.1);

  const w = 13, h = 11, rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37 + 11) & 255;
  const decoded = decodePng(interlacedPng(w, h, rgb));
  assert.equal(decoded.status, 'ok');
  if (decoded.status === 'ok') assert.deepEqual(decoded.image.pixels, rgb);

  const { orders, dir } = tempOrders();
  t.after(() => removeDir(dir));
  const root = path.join(dir, 'game');
  mkdirSync(path.join(root, 'shots'), { recursive: true }); mkdirSync(path.join(dir, 'orders'));
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
  writeFileSync(path.join(root, 'shots', 'black.jpg'), Buffer.from(jpeg.black, 'base64'));
  writeFileSync(path.join(root, 'shots', 'scene.jpg'), Buffer.from(jpeg.gradient, 'base64'));
  writeFileSync(path.join(root, 'shots', 'flat.png'), interlacedPng(w, h, Buffer.alloc(w * h * 3)));
  writeFileSync(path.join(root, 'shots', 'scene.png'), interlacedPng(w, h, rgb));
  orders.add({ tag: 'C1', title: 'Captures', kind: 'ue' });
  orders.runStart('C1', { worker: 'w' }); orders.runEnd('C1', 'completed');
  orders.report('C1', { status: 'ready', summary: 'Captures', evidence: ['shots/black.jpg', 'shots/scene.jpg', 'shots/flat.png', 'shots/scene.png'], commits: [] });
  assert.deepEqual(evidenceProblems(project, orders.get('C1'))?.flat, ['shots/black.jpg', 'shots/flat.png']);
});

/** Lock probes: one live process (this one) on this machine; every other pid is gone unless listed. */
const probes = (alive: (pid: number) => boolean, now = () => Date.now()): LockProbes => ({ alive, startedAt: () => undefined, host: 'here', now });

test('A-11: a stale state lock is recovered once, never from under a live owner, and release keeps another owner\'s lock', t => {
  const { dir } = tempOrders();
  t.after(() => removeDir(dir));
  mkdirSync(path.join(dir, 'locks'));
  const file = path.join(dir, 'locks', 'state.lock');
  // A lock of a process that is gone (the old format held only a pid) is taken over.
  writeFileSync(file, '999999');
  const release = tryLock(file, probes(pid => pid === process.pid));
  assert.ok(release);
  assert.equal(lockOwner(readFileSync(file, 'utf8'))?.pid, process.pid);
  // Held by a live owner: refused, and the lock stays.
  assert.equal(tryLock(file, probes(pid => pid === process.pid)), undefined);
  release!();
  assert.equal(existsSync(file), false);

  // Two waiters judge the same lock stale; the first takes it over. The second must not remove the first one's fresh lock.
  const stale = JSON.stringify({ pid: 999999, host: 'here', started: new Date(0).toISOString(), token: 'old', at: new Date(0).toISOString() });
  writeFileSync(file, stale);
  let raced = false;
  const second = tryLock(file, probes(pid => {
    if (pid === 999999 && !raced) {
      raced = true;
      // The other waiter got there first: the file now holds its lock.
      writeFileSync(file, JSON.stringify({ pid: process.pid, host: 'here', started: new Date().toISOString(), token: 'first', at: new Date().toISOString() }));
      return false;
    }
    return pid === process.pid;
  }));
  assert.equal(second, undefined);
  assert.equal(lockOwner(readFileSync(file, 'utf8'))?.token, 'first');
  assert.equal(existsSync(`${file}.break`), false);

  // A release whose lock was taken over by another owner leaves that owner's lock alone.
  rmSync(file);
  const mine = tryLock(file, probes(pid => pid === process.pid))!;
  writeFileSync(file, JSON.stringify({ pid: process.pid, host: 'here', started: new Date().toISOString(), token: 'someone-else', at: new Date().toISOString() }));
  mine();
  assert.equal(lockOwner(readFileSync(file, 'utf8'))?.token, 'someone-else');

  // A lock from another machine is never judged by a local pid.
  writeFileSync(file, JSON.stringify({ pid: 999999, host: 'elsewhere', started: new Date(0).toISOString(), token: 'remote', at: new Date(0).toISOString() }));
  assert.equal(tryLock(file, probes(pid => pid === process.pid)), undefined);

  // A pid that was reused by another process: the lock is old and the process started at another time.
  writeFileSync(file, JSON.stringify({ pid: 4242, host: 'here', started: new Date(Date.now() - 3600000).toISOString(), token: 'reused', at: new Date(Date.now() - 600000).toISOString() }));
  const reused = tryLock(file, { alive: () => true, startedAt: () => new Date().toISOString(), host: 'here', now: () => Date.now() });
  assert.ok(reused);
  reused!();

  // The files backend takes over a lock left by a writer that is gone.
  const store = new FileStore(path.join(dir, 'state'));
  mkdirSync(store.dir, { recursive: true });
  const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  writeFileSync(path.join(store.dir, '_write.lock'), dead);
  new Orders(store).add({ tag: 'A1', title: 'Art', kind: 'task' });
  assert.equal(existsSync(path.join(store.dir, '_write.lock')), false);
});
