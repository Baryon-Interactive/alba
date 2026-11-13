import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BACKUPS_KEPT, EditRefused } from '../src/yamledit.ts';
import { addWorker, editWorker, editWorkerYaml, looksLikeSecret, parseSetArgs, workerYaml } from '../src/workers/edit.ts';
import { loadWorkers } from '../src/workers/config.ts';
import { Orders } from '../src/orders/service.ts';
import { testStore } from './state-helper.ts';
import { fixture } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';

const FILE = `# The workers of the studio. Comments are the owner's notes.
workers:
  # the heavy coder
  - id: coder          # runs on the subscription
    engine: codex
    notes: "Writes code"   # short
    price:
      input_per_mtok: 2
      output_per_mtok: 1         # only small merges
      per_mtok: 4        # flat rate
    concurrency: 2

  # the second one
  - id: reviewer
    engine: claude
    enabled: true
    launch:
      program: reviewer
      args: ["--last", "{last_file}"]
      env:
        HOME_DIR: "tools"
`;

function workers(text = FILE, eol = '\n') {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-edit-'));
  const file = path.join(dir, 'workers.yaml');
  writeFileSync(file, eol === '\n' ? text : text.replace(/\n/g, eol));
  return { dir, file };
}
const read = (f: string) => readFileSync(f, 'utf8');

test('editing a worker keeps the comments, the order and the layout of everything that did not change', () => {
  const { file } = workers();
  const out = editWorker(file, 'coder', [{ path: ['price', 'input_per_mtok'], value: 3 }, { path: ['concurrency'], value: 4 }]);
  assert.deepEqual(out.changed.sort(), ['concurrency', 'price.input_per_mtok']);
  const after = read(file);
  assert.equal(after, FILE.replace('input_per_mtok: 2', 'input_per_mtok: 3').replace('concurrency: 2', 'concurrency: 4'));
  assert.ok(out.backup && existsSync(out.backup) && read(out.backup) === FILE, 'the old file is kept as it was');
  assert.equal(loadWorkers(file).workers.find(w => w.id === 'coder')!.concurrency, 4);
});

test('a value that is not different writes nothing and makes no backup', () => {
  const { file, dir } = workers();
  const out = editWorker(file, 'coder', [{ path: ['concurrency'], value: 2 }]);
  assert.deepEqual(out.changed, []);
  assert.equal(read(file), FILE);
  assert.deepEqual(readdirSync(dir), ['workers.yaml']);
});

test('a mapping is replaced key by key: a key left out is removed, the comment of a key that stays is kept', () => {
  const { file } = workers();
  editWorker(file, 'coder', [{ path: ['price'], value: { per_mtok: 4 } }]);
  const after = read(file);
  assert.match(after, /per_mtok: 4 +# flat rate/);
  assert.doesNotMatch(after, /output_per_mtok: 1/);
  assert.match(after, /# the heavy coder/);
  assert.match(after, /# the second one/);
});

test('an invalid value is not written, nothing is backed up, and the refusal names the field', () => {
  const { file, dir } = workers();
  assert.throws(() => editWorker(file, 'coder', [{ path: ['price', 'input_per_mtok'], value: -1 }]), (e: unknown) => e instanceof EditRefused && e.details.length > 0);
  assert.throws(() => editWorker(file, 'coder', [{ path: ['concurrency'], value: 'many' }]), EditRefused);
  assert.equal(read(file), FILE);
  assert.deepEqual(readdirSync(dir), ['workers.yaml']);
  assert.throws(() => editWorker(file, 'nobody', [{ path: ['concurrency'], value: 1 }]), /No worker/);
});

test('a dry run validates and reports but writes nothing', () => {
  const { file, dir } = workers();
  const out = editWorker(file, 'coder', [{ path: ['concurrency'], value: 5 }], { dryRun: true });
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.changed, ['concurrency']);
  assert.equal(read(file), FILE);
  assert.deepEqual(readdirSync(dir), ['workers.yaml']);
});

test('backups: one per write, named by the time, only the newest 20 stay', () => {
  const { file, dir } = workers();
  const start = new Date(2026, 0, 1, 10, 0, 0);
  for (let i = 0; i < BACKUPS_KEPT + 5; i++) editWorker(file, 'coder', [{ path: ['concurrency'], value: 3 + i }], { now: new Date(start.getTime() + i * 1000) });
  const backups = readdirSync(dir).filter(f => f.startsWith('workers.yaml.bak-')).sort();
  assert.equal(backups.length, BACKUPS_KEPT);
  assert.equal(backups[0], 'workers.yaml.bak-20260101-100005', 'the five oldest are gone');
  assert.equal(backups.at(-1), 'workers.yaml.bak-20260101-100024');
  // two writes in the same second do not overwrite each other
  editWorker(file, 'coder', [{ path: ['concurrency'], value: 99 }], { now: new Date(start.getTime() + 24000) });
  assert.ok(readdirSync(dir).includes('workers.yaml.bak-20260101-100024-2'));
});

test('keys do not go into the file: a key-looking value in launch.env or args is refused, with the field', () => {
  const { file } = workers();
  const refused = (value: unknown) => assert.throws(() => editWorker(file, 'reviewer', [{ path: ['launch', 'env'], value }]), (e: unknown) => e instanceof EditRefused && /key/i.test(e.message) && !!e.details[0].field?.startsWith('launch.env.'));
  refused({ OPENAI_API_KEY: ('sk-proj-' + 'test'.repeat(10)) });
  refused({ TOKEN: ('ghp_' + 'test'.repeat(10)) });
  refused({ X: Array.from({ length: 12 }, (_, i) => `A${i}b`).join('') });
  assert.throws(() => editWorker(file, 'reviewer', [{ path: ['launch', 'args'], value: ['--api-key=' + ('sk-' + 'test'.repeat(10)) + ''] }]), EditRefused);
  assert.equal(read(file), FILE);
  // placeholders, paths and short words are fine
  editWorker(file, 'reviewer', [{ path: ['launch', 'env'], value: { HOME_DIR: "tools", MODE: 'fast', ROOT: 'workspace/user/some/long/path/that/is/not/a/key/at/all' } }]);
  assert.equal(looksLikeSecret('{work_dir}', true), false);
  assert.equal(looksLikeSecret('' + ('sk-' + 'test'.repeat(10)) + '', false), true);
});

test('the advanced editor: the YAML of one worker is shown with its comments, and a replacement changes only the difference', () => {
  const { file } = workers();
  const shown = workerYaml(file, 'coder');
  assert.match(shown, /^id: coder +# runs on the subscription\nengine: codex/);
  assert.match(shown, /output_per_mtok: 1 +# only small merges/);
  const out = editWorkerYaml(file, 'coder', shown.replace('input_per_mtok: 2', 'input_per_mtok: 3').replace('concurrency: 2\n', ''));
  assert.deepEqual(out.changed.sort(), ['concurrency', 'price.input_per_mtok']);
  const after = read(file);
  assert.match(after, /input_per_mtok: 3/);
  assert.doesNotMatch(after, /concurrency: 2/);
  assert.match(after, /# only small merges/);
  assert.throws(() => editWorkerYaml(file, 'coder', 'id: other\nengine: x\n'), /id/);
  assert.throws(() => editWorkerYaml(file, 'coder', 'engine: [unclosed\n'), EditRefused);
  assert.throws(() => editWorkerYaml(file, 'coder', 'engine: codex\nlaunch:\n  program: p\n  env:\n    K: ' + ('sk-' + 'test'.repeat(10)) + '\n'), /key/i);
});

test('a new worker: a copy goes right after the original, under a new id, with changes; an id that exists or is badly written is refused', () => {
  const { file } = workers();
  addWorker(file, { id: 'coder-2', copyFrom: 'coder', set: { concurrency: 1, notes: null, price: { per_mtok: 1 } } });
  const list = loadWorkers(file).workers;
  assert.deepEqual(list.map(w => w.id), ['coder', 'coder-2', 'reviewer']);
  const copy = list[1];
  assert.equal(copy.concurrency, 1);
  assert.equal(copy.engine, 'codex');
  assert.match(read(file), /# the second one/);
  assert.throws(() => addWorker(file, { id: 'coder', copyFrom: 'coder' }), /already/);
  assert.throws(() => addWorker(file, { id: 'bad id!', copyFrom: 'coder' }), EditRefused);
  assert.throws(() => addWorker(file, { id: 'x', copyFrom: 'ghost' }), /No worker/);
  addWorker(file, { id: 'fresh', yaml: 'engine: claude\nnotes: New\n' });
  assert.equal(loadWorkers(file).workers.at(-1)!.id, 'fresh');
});

test('files with CRLF line endings and a byte-order mark keep both', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-edit-'));
  const file = path.join(dir, 'workers.yaml');
  writeFileSync(file, '﻿' + FILE.replace(/\n/g, '\r\n'));
  editWorker(file, 'coder', [{ path: ['concurrency'], value: 7 }]);
  const raw = readFileSync(file);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = raw.toString('utf8');
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare line feed');
  assert.match(text, /concurrency: 7\r\n/);
});

test('alba workers set: key=value arguments are read as YAML, dotted keys go inside, null removes', () => {
  const ops = parseSetArgs(['price.input_per_mtok=3', 'enabled=false', 'aliases=[a, b]', 'notes=Writes code, fast', 'cost=null']);
  assert.deepEqual(ops, [
    { path: ['price', 'input_per_mtok'], value: 3 }, { path: ['enabled'], value: false }, { path: ['aliases'], value: ['a', 'b'] },
    { path: ['notes'], value: 'Writes code, fast' }, { path: ['cost'], value: undefined },
  ]);
  assert.throws(() => parseSetArgs(['nokey']), /key=value/);
  assert.throws(() => parseSetArgs([]), /Usage/);
});

// ------------------------------------------------------------------------------------------------------------------ through the interface

test('api: a worker is edited with PUT (comments kept, backup made, event recorded, the server reads the new file), refused edits answer 400 with details, a copy is made with POST', async () => {
  const f = await fixture({ populate: false });
  const { file } = workers();
  f.board.ctx.workers = loadWorkers(file);
  const before = read(file);

  const shown = await f.get('/api/workers/coder/yaml');
  assert.equal(shown.status, 200);
  assert.match(shown.body.yaml, /^id: coder/);

  const noToken = await fetch(f.base + '/api/workers/coder', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"set":{"concurrency":3}}' });
  assert.equal(noToken.status, 401);
  assert.equal(read(file), before);

  const dry = await f.put('/api/workers/coder', { set: { concurrency: 3 }, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.equal(read(file), before);

  const ok = await f.put('/api/workers/coder', { set: { concurrency: 3, capabilities: ['shell', 'edit'] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.changed.sort(), ['capabilities', 'concurrency']);
  assert.equal(ok.body.worker.concurrency, 3);
  assert.deepEqual(ok.body.worker.capabilities, ['shell', 'edit']);
  assert.deepEqual(ok.body.worker.price, { input_per_mtok: 2, output_per_mtok: 1, per_mtok: 4 });
  assert.equal(ok.body.worker.notes, 'Writes code');
  assert.equal('fits' in ok.body.worker, false);
  assert.ok(existsSync(ok.body.backup));
  assert.match(read(file), /# the heavy coder/);
  assert.equal(f.board.ctx.workers!.workers.find(w => w.id === 'coder')!.concurrency, 3);
  const event = f.orders.store.events().find(e => e.type === 'workers.edited');
  assert.ok(event, 'workers.edited is in the log');
  assert.equal(event!.by, 'web');
  assert.deepEqual((event!.data!.fields as string[]).sort(), ['capabilities', 'concurrency']);

  const refused = await f.put('/api/workers/coder', { set: { price: { input_per_mtok: -1 } } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'bad_request');
  assert.ok(refused.body.error.details.length > 0);
  const secret = await f.put('/api/workers/reviewer', { yaml: 'engine: claude\nlaunch:\n  program: p\n  env:\n    OPENAI_API_KEY: ' + ('sk-' + 'test'.repeat(10)) + '\n' });
  assert.equal(secret.status, 400);
  assert.equal(secret.body.error.details[0].field, 'launch.env.OPENAI_API_KEY');
  assert.equal((await f.put('/api/workers/coder', { set: { launch: { program: 'x' } } })).status, 400, 'launch only through the YAML editor');
  assert.equal((await f.put('/api/workers/ghost', { set: { concurrency: 1 } })).status, 404);
  assert.equal((await f.put('/api/workers/coder', {})).status, 400);

  const copy = await f.write('/api/workers', { id: 'coder-2', copyFrom: 'coder', set: { concurrency: 1 } });
  assert.equal(copy.status, 201);
  assert.equal(f.board.ctx.workers!.workers.map(w => w.id).join(), 'coder,coder-2,reviewer');
  assert.equal((await f.write('/api/workers', { id: 'coder-2', copyFrom: 'coder' })).status, 409);
});

test('cli: alba workers set / copy / yaml write the same way; a refused change exits 1 and writes nothing', () => {
  const { dir, file } = workers();
  const project = projectDir(dir);
  const set = alba(project, ['--workers', file, 'workers', 'set', 'coder', 'price.input_per_mtok=3', 'concurrency=4']);
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /coder: changed .*concurrency/);
  assert.equal(read(file), FILE.replace('input_per_mtok: 2', 'input_per_mtok: 3').replace('concurrency: 2', 'concurrency: 4'));
  assert.ok(readdirSync(dir).some(f => f.startsWith('workers.yaml.bak-')));
  const bad = alba(project, ['--workers', file, 'workers', 'set', 'coder', 'price.input_per_mtok=-1']);
  assert.equal(bad.code, 1);
  assert.equal(read(file), FILE.replace('input_per_mtok: 2', 'input_per_mtok: 3').replace('concurrency: 2', 'concurrency: 4'));
  const dry = alba(project, ['--workers', file, 'workers', 'set', 'coder', 'concurrency=1', '--dry-run']);
  assert.match(dry.out, /dry run/);
  assert.match(alba(project, ['--workers', file, 'workers', 'copy', 'coder', 'coder-b', 'concurrency=1']).out, /coder-b: changed/);
  assert.match(alba(project, ['--workers', file, 'workers', 'yaml', 'coder-b']).out, /^id: coder-b/);
  const events = new Orders(testStore(path.join(dir, 'state'))).store.events().filter(e => e.type === 'workers.edited');
  assert.deepEqual(events.map(e => e.by), ['cli', 'cli']);
});
