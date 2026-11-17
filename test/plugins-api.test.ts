import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { loadProject } from './state-helper.ts';
import { EDITABLE } from '../src/config-edit.ts';
import { writeStateFile } from '../src/orders/state-files.ts';

/** A secret-looking value in the environment of the server; it must never appear in an answer. */
const KEY_NAME = 'ALBA_TEST_PLUGINS_API_KEY';
const KEY_VALUE = 'plugins-api-test-value-0123456789abcdef';

/** A served project whose file (on disk, so it can be edited) enables image-gateway with a key variable that is set, and example-echo. */
async function withTools() {
  const f = await fixture({ populate: false });
  const file = f.board.ctx.projects[0].file;
  writeFileSync(file, [
    '# the demo project',
    'id: demo', 'name: Demo', `root: ${JSON.stringify(f.root)}`, `work_orders: ${JSON.stringify(path.join(f.root, 'orders'))}`, `state_dir: ${JSON.stringify(path.join(f.dir, 'state'))}`,
    'dispatch:', `  worktree_parent: ${JSON.stringify(f.dir)}`, '  base_ref: refs/heads/main',
    'plugins:',
    '  enable: [image-gateway, example-echo]   # pictures and the example',
    '  settings:',
    `    image-gateway: { base_url: "http://127.0.0.1:8000", key_env: ${KEY_NAME} }`,
    '  by_kind:', '    art: [image-gateway]',
    '  auto_approve: { images: { per_job: 2, per_day: 20 } }', '',
  ].join('\n'));
  const project = loadProject(file);
  f.board.ctx.projects[0] = project;
  const day = new Date().toISOString().slice(0, 10);
  writeStateFile(project, '_tool-jobs.json', JSON.stringify([
    { id: 'J1', tool: 'image-gateway', version: '1.0.0', operation: 'generate', order: 'A1', by: 'web', input: { prompt: 'a cat' }, status: 'done', created: `${day}T01:00:00.000Z`, quote: { unit: 'images', amount: 2, id: 'C1', auto: true, autoAt: `${day}T01:00:01.000Z` }, spent: 2, out: '/x/J1', files: ['/x/J1/image.png'], text: 'long answer' },
    { id: 'J2', tool: 'image-gateway', version: '1.0.0', operation: 'generate', order: 'A1', by: 'web', input: { prompt: 'a dog' }, status: 'waiting-quote', created: '2020-01-01T00:00:00.000Z', quote: { unit: 'images', amount: 1, auto: true, autoAt: '2020-01-01T00:00:01.000Z' }, out: '/x/J2' },
    { id: 'J10', tool: 'example-echo', version: '1.0.0', operation: 'echo', by: 'cli', input: { text: 'hi' }, status: 'failed', created: `${day}T02:00:00.000Z`, error: 'the server exited', out: '/x/J10' },
  ]));
  return { ...f, file };
}

test('GET /api/plugins: every plugin with settings, servers, env names (set or not, never the value), operations, kinds, auto approvals and the newest jobs', async () => {
  process.env[KEY_NAME] = KEY_VALUE;
  try {
    const f = await withTools();
    const r = await f.get('/api/plugins?project=demo');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(KEY_VALUE), 'the value of an environment variable never appears');
    const v = r.body;
    assert.equal(v.project, 'demo');
    assert.deepEqual(v.enable, ['image-gateway', 'example-echo']);
    assert.deepEqual(v.tools.map((x: { id: string }) => x.id), ['audio-studio', 'example-echo', 'image-gateway', 'tripo-3d']);
    const image = v.tools.find((x: { id: string }) => x.id === 'image-gateway');
    assert.equal(image.enabled, true);
    assert.equal(image.origin, 'built-in');
    assert.deepEqual(image.settings.find((s: { name: string }) => s.name === 'base_url'), { name: 'base_url', description: image.settings.find((s: { name: string }) => s.name === 'base_url').description, default: 'https://api.openai.com', value: 'http://127.0.0.1:8000' });
    assert.equal(image.settings.find((s: { name: string }) => s.name === 'model').value, undefined);
    assert.deepEqual(image.servers[0].env, [{ name: KEY_NAME, set: true }]);
    assert.deepEqual(image.servers[0].tools, ['image_generate']);
    assert.equal(image.operations[0].name, 'generate');
    assert.deepEqual(image.operations[0].paid, { unit: 'images', priced_by_tool: true });
    assert.deepEqual(image.kinds, ['art']);
    const tripo = v.tools.find((x: { id: string }) => x.id === 'tripo-3d');
    assert.equal(tripo.enabled, false);
    assert.deepEqual(tripo.resources, [{ name: 'tripo-wallet', slots: 1 }]);
    assert.equal(tripo.servers.find((s: { name: string }) => s.name === 'tripo-ops').workers, false);
    assert.deepEqual(v.by_kind, { art: ['image-gateway'] });
    assert.deepEqual(v.units, ['credits', 'images']);
    // two images approved by Alba today (J1), three ever (J1 and J2)
    assert.deepEqual(v.auto_approve, [{ unit: 'images', per_job: 2, per_day: 20, today: 2, ever: 3 }]);
    // newest first, without input or answer text
    assert.deepEqual(v.jobs.map((j: { id: string }) => j.id), ['J10', 'J2', 'J1']);
    assert.equal(v.jobCount, 3);
    assert.equal(v.jobs[0].error, 'the server exited');
    assert.equal(v.jobs[2].spent, 2);
    assert.ok(!('input' in v.jobs[2]) && !('text' in v.jobs[2]));

    // unset: the name is still there, marked missing
    delete process.env[KEY_NAME];
    const unset = (await f.get('/api/plugins?project=demo')).body;
    assert.deepEqual(unset.tools.find((x: { id: string }) => x.id === 'image-gateway').servers[0].env, [{ name: KEY_NAME, set: false }]);
  } finally { delete process.env[KEY_NAME]; }
});

test('POST /api/plugins/doctor: checks the named tools (starting their servers, calling none) and needs the key', async () => {
  process.env[KEY_NAME] = KEY_VALUE;
  try {
    const f = await withTools();
    assert.equal((await f.post('/api/plugins/doctor', { project: 'demo', ids: ['example-echo'] })).status, 401);
    const r = await f.write('/api/plugins/doctor', { project: 'demo', ids: ['example-echo'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results.length, 1);
    const echo = r.body.results[0];
    assert.equal(echo.id, 'example-echo');
    assert.ok(echo.checks.some((c: { name: string; ok: boolean }) => c.name === 'mcp echo' && c.ok), JSON.stringify(echo));
    assert.equal(r.body.ok, echo.ok);
    // the reads keep answering while a doctor runs
    const [doctor, read] = await Promise.all([f.write('/api/plugins/doctor', { project: 'demo', ids: ['example-echo'] }), f.get('/api/plugins?project=demo')]);
    assert.deepEqual([doctor.status, read.status], [200, 200]);
    // an unknown id is a failed check, not an error
    const unknown = await f.write('/api/plugins/doctor', { project: 'demo', ids: ['nope'] });
    assert.deepEqual([unknown.status, unknown.body.ok, unknown.body.results[0].checks[0].name], [200, false, 'manifest']);
    assert.ok(!JSON.stringify([r.body, unknown.body]).includes(KEY_VALUE));
  } finally { delete process.env[KEY_NAME]; }
});

test('POST /api/config: plugins.enable, settings, by_kind and auto_approve can be changed and must load; sources and replace cannot', async () => {
  assert.deepEqual(EDITABLE.project.filter(p => p[0] === 'plugins').map(p => p.join('.')), ['plugins.enable', 'plugins.settings', 'plugins.by_kind', 'plugins.auto_approve']);
  const f = await withTools();
  const seen = (await f.get('/api/config?project=demo')).body;
  assert.deepEqual(seen.values.plugins.enable, ['image-gateway', 'example-echo']);
  assert.deepEqual(seen.values.plugins.auto_approve, { images: { per_job: 2, per_day: 20 } });

  const ok = await f.write('/api/config', { project: 'demo', edits: [
    { path: ['plugins', 'enable'], value: ['image-gateway', 'example-echo', 'tripo-3d'] },
    { path: ['plugins', 'settings', 'tripo-3d'], value: { ceiling: '40' } },
    { path: ['plugins', 'settings', 'image-gateway', 'model'], value: 'gpt-image-1.5' },
    { path: ['plugins', 'by_kind', 'model'], value: ['tripo-3d'] },
    { path: ['plugins', 'auto_approve', 'credits'], value: 0 },
  ] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const text = readFileSync(f.file, 'utf8');
  assert.match(text, /# the demo project/);
  const project = f.board.ctx.projects[0];
  assert.deepEqual(Object.keys(project.plugins!.tools).sort(), ['example-echo', 'image-gateway', 'tripo-3d']);
  assert.equal(project.plugins!.tools['tripo-3d']!.settings?.ceiling, '40');
  assert.equal(project.plugins!.tools['image-gateway']!.settings?.model, 'gpt-image-1.5');
  assert.deepEqual(project.plugins!.by_kind.model, ['tripo-3d']);
  assert.deepEqual(project.plugins!.auto_approve!.credits, { per_job: 0, per_day: 0 });
  assert.equal((await f.get('/api/plugins?project=demo')).body.tools.find((x: { id: string }) => x.id === 'tripo-3d').enabled, true);

  const refused = async (edits: unknown[], pattern: RegExp) => {
    const before = readFileSync(f.file, 'utf8');
    const r = await f.write('/api/config', { project: 'demo', edits });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), pattern);
    assert.equal(readFileSync(f.file, 'utf8'), before, 'nothing is written');
  };
  await refused([{ path: ['plugins', 'enable'], value: ['image-gateway', 'example-echo', 'tripo-3d', 'nope'] }], /no plugin \\"nope\\"/);
  await refused([{ path: ['plugins', 'by_kind', 'art'], value: ['example-echo', 'missing-tool'] }], /missing-tool/);
  // turning a tool off while its settings or kinds still name it is refused; the console sends all three changes together
  await refused([{ path: ['plugins', 'enable'], value: ['image-gateway', 'example-echo'] }], /plugins\.settings\.tripo-3d/);
  await refused([{ path: ['plugins', 'settings', 'image-gateway', 'colour'], value: 'red' }], /no such setting/);
  await refused([{ path: ['plugins', 'auto_approve', 'images'], value: -1 }], /at least 0/);
  await refused([{ path: ['plugins', 'sources'], value: [{ path: 'elsewhere' }] }], /cannot be changed from the console/);
  await refused([{ path: ['plugins', 'replace'], value: ['image-gateway'] }], /cannot be changed from the console/);
  const off = await f.write('/api/config', { project: 'demo', edits: [
    { path: ['plugins', 'enable'], value: ['image-gateway', 'example-echo'] }, { path: ['plugins', 'settings', 'tripo-3d'] }, { path: ['plugins', 'by_kind', 'model'] },
  ] });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(f.board.ctx.projects[0].plugins!.tools['tripo-3d'], undefined);
});
