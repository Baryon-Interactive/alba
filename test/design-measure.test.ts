import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { designFixture, initialDesign } from './fixtures/design.ts';
import { applyChangeSet, designHistory, readLibrary } from '../src/design/library.ts';
import { measurementViews, runMeasurements } from '../src/design/measure.ts';
import { acquireAcceptanceResources, releaseAcceptanceResources, activeLeases } from '../src/resources/leases.ts';
import { alba } from './cli-helper.ts';
import { fixture as apiFixture } from './api-fixture.ts';

function fixture() {
  const f = designFixture();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.root, windowsHide: true, stdio: 'pipe' }).toString().trim();
  git('init'); git('add', 'rules.md'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline');
  applyChangeSet(f.project, f.orders, initialDesign());
  return { ...f, git };
}
const measure = (script: string, value: object = { json_pointer: '/score' }, extra: object = {}) => ({ argv: [process.execPath, '-e', script], timeout_minutes: 1, value, when: { every_hours: 2, after_merge_paths: ['src/**/*.ts'] }, ...extra });
function setMeasure(f: ReturnType<typeof fixture>, id: string, m: object) {
  const t = readLibrary(f.project).target.find(t => t.id === id)!;
  return applyChangeSet(f.project, f.orders, { title: 'Configure measurement', changes: [{ kind: 'target', op: 'update', id, base_version: t.version, fields: { measure: m } }] });
}

test('measure parses stdout JSON pointer and regex, logs both streams and attributes history to measure', async () => {
  const f = fixture();
  setMeasure(f, 'ECON-T01', measure('console.log(JSON.stringify({score:8})); console.error("diagnostic")'));
  const before = designHistory(f.project).length;
  const result = await runMeasurements(f.project, f.orders, { targets: ['ECON-T01'] });
  assert.equal(result[0].status, 'ok', result[0].reason); assert.equal(result[0].value, 8);
  const row = readLibrary(f.project).target[0], history = designHistory(f.project).slice(before);
  assert.equal(history.length, 1); assert.equal(history[0].by, 'measure');
  assert.equal(row.measured_commit, f.git('rev-parse', 'HEAD')); assert.ok(row.measured_at);
  assert.match(readFileSync(path.join(f.root, row.evidence[0].ref), 'utf8'), /diagnostic/);
  setMeasure(f, 'ECON-T02', measure('console.log("elapsed=6.25")', { regex: 'elapsed=([0-9.]+)', group: 1 }));
  assert.equal((await runMeasurements(f.project, f.orders, { targets: ['ECON-T02'] }))[0].value, 6.25);
  assert.equal(activeLeases(f.project, f.orders).length, 0);
});

test('failed exit and unparsable result keep the previous value and record reasons', async () => {
  const f = fixture();
  for (const script of ['console.error("broken"); process.exit(3)', 'console.log("bad json")']) {
    setMeasure(f, 'ECON-T01', measure(script));
    const n = designHistory(f.project).length;
    const [result] = await runMeasurements(f.project, f.orders, { targets: ['ECON-T01'] });
    assert.equal(result.status, 'failed'); assert.ok(result.reason);
    assert.equal(readLibrary(f.project).target[0].last_value, 12); assert.equal(designHistory(f.project).length, n);
    assert.equal(measurementViews(f.project, f.orders)[0].last?.status, 'failed');
  }
});

test('measure waits for exclusive resources, kind caps, free memory and priority orders', async () => {
  const f = fixture();
  f.project.resources = { rig: { slots: 1, exclusive: true, blocks: ['sim'], lease_minutes: 60 } };
  f.project.dispatch.caps = { sim: 1 };
  f.project.dispatch.min_free_ram_gb = 4;
  setMeasure(f, 'ECON-T01', measure('console.log("{\"score\":8}")', { json_pointer: '/score' }, { kind: 'sim', uses: ['rig'] }));
  assert.equal(acquireAcceptanceResources(f.project, f.orders, 'HOLDER', ['rig']), undefined);
  const run = () => runMeasurements(f.project, f.orders, { targets: ['ECON-T01'], freeRamGb: () => 8 });
  assert.match((await run())[0].reason!, /resource|exclusive/i);
  assert.equal((await runMeasurements(f.project, f.orders, { targets: ['ECON-T01'], freeRamGb: () => 8, dryRun: true }))[0].status, 'waiting');
  releaseAcceptanceResources(f.project, f.orders, 'HOLDER');
  assert.equal(acquireAcceptanceResources(f.project, f.orders, 'HOLDER', ['sim']), undefined);
  assert.match((await run())[0].reason!, /cap/i);
  releaseAcceptanceResources(f.project, f.orders, 'HOLDER');
  assert.match((await runMeasurements(f.project, f.orders, { targets: ['ECON-T01'], freeRamGb: () => 1 }))[0].reason!, /memory/i);
  assert.match((await runMeasurements(f.project, f.orders, { targets: ['ECON-T01'], ordersFirst: true }))[0].reason!, /priority/i);
  assert.equal(f.orders.store.events().filter(e => e.type === 'design-measurement').length, 0);
});

test('measure reads a JSON file and matching merged paths make it due again; dry run writes nothing', async () => {
  const f = fixture();
  writeFileSync(path.join(f.root, 'content/result.json'), '{"score":9}');
  setMeasure(f, 'ECON-T01', measure('', { json_pointer: '/score', file: 'content/result.json' }));
  const n = designHistory(f.project).length;
  assert.equal((await runMeasurements(f.project, f.orders, { targets: ['ECON-T01'], dryRun: true }))[0].status, 'dry-run');
  assert.equal(designHistory(f.project).length, n);
  await runMeasurements(f.project, f.orders, { targets: ['ECON-T01'] });
  assert.equal(measurementViews(f.project, f.orders)[0].due, false);
  f.orders.record('SAMPLE', 'accept-merged', { merge: 'new-commit', changed: ['docs/guide.md'] });
  assert.equal(measurementViews(f.project, f.orders)[0].due, false);
  f.orders.record('SAMPLE', 'accept-merged', { merge: 'next-commit', changed: ['src/game/score.ts'] });
  assert.equal(measurementViews(f.project, f.orders)[0].due, true);
  await runMeasurements(f.project, f.orders, { targets: ['ECON-T01'] });
  assert.equal(measurementViews(f.project, f.orders)[0].due, false);
});

test('measurement reserves a kind slot visible to order planning while its command runs', async () => {
  const f = fixture(); f.project.dispatch.caps = { sim: 1 };
  setMeasure(f, 'ECON-T01', measure('setTimeout(()=>console.log("{\"score\":8}"),150)', { json_pointer: '/score' }, { kind: 'sim' }));
  const job = runMeasurements(f.project, f.orders, { targets: ['ECON-T01'] });
  assert.equal(activeLeases(f.project, f.orders).filter(l => l.acceptance?.cap === 'sim').length, 1);
  assert.equal(measurementViews(f.project, f.orders)[0].running, true);
  await job;
  assert.equal(activeLeases(f.project, f.orders).length, 0);
});

test('structured measure validation rejects malformed and escaping definitions atomically', () => {
  const f = fixture();
  for (const m of [measure('', { json_pointer: 'bad' }), measure('', { regex: '[', group: 1 }), measure('', { regex: 'x', group: -1 }), measure('', { json_pointer: '', file: '../out.json' }), measure('', undefined, { uses: ['missing'] }), measure('', undefined, { kind: 'missing' }), measure('', undefined, { argv: [] }), measure('', undefined, { timeout_minutes: 0 }), measure('', undefined, { cwd: '../other' }), measure('', undefined, { when: { every_hours: 0 } })]) assert.throws(() => setMeasure(f, 'ECON-T01', m), /measure/);
});

test('measurement CLI previews without writes and executes an explicit target', () => {
  const f = fixture(); setMeasure(f, 'ECON-T01', measure('console.log(JSON.stringify({score:8}))'));
  const n = designHistory(f.project).length;
  const preview = alba(f.file, ['design', 'measure', 'ECON-T01', '--dry-run']);
  assert.equal(preview.code, 0, preview.err); assert.equal(JSON.parse(preview.out)[0].status, 'dry-run');
  assert.equal(designHistory(f.project).length, n);
  const run = alba(f.file, ['design', 'measure', 'ECON-T01']);
  assert.equal(run.code, 0, run.err); assert.equal(JSON.parse(run.out)[0].value, 8);
  assert.equal(designHistory(f.project).at(-1)?.by, 'measure');
});

test('measurement API requires a write token and publishes the resulting view', async () => {
  const f = await apiFixture({ populate: false, project: (_dir, root) => {
    writeFileSync(path.join(root, 'rules.md'), '# Rules');
    writeFileSync(path.join(root, 'result.json'), '{"score":8}');
    return { state: { backend: 'sqlite' }, design: { enabled: true } };
  } });
  assert.equal((await f.post('/api/design/measure', { targets: ['ECON-T01'] })).status, 401);
  assert.equal((await f.write('/api/design/measure', { targets: [] })).status, 400);
  // A missing target is a validation error, rather than an unguarded command invocation.
  assert.equal((await f.write('/api/design/measure', { targets: ['MISSING-T01'] })).status, 404);
  assert.deepEqual((await f.get('/api/design/measurements')).body, []);
  const seed = initialDesign();
  // Keep this API fixture independent of gameplay parameter files.
  seed.changes = seed.changes.filter(c => ['system', 'rule', 'target'].includes(c.kind));
  const target = seed.changes.find(c => c.id === 'ECON-T01')!;
  target.fields.measure = measure('', { json_pointer: '/score', file: 'result.json' });
  const applied = await f.write('/api/design/changesets', { changeset: seed });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const run = await f.write('/api/design/measure', { targets: ['ECON-T01'] });
  assert.equal(run.status, 200, JSON.stringify(run.body)); assert.equal(run.body[0].status, 'ok', run.body[0].reason);
  assert.equal((await f.get('/api/design/measurements')).body[0].last.value, 8);
});
