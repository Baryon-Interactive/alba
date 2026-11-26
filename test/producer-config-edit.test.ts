import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { validateProject } from './state-helper.ts';
import { editProducerConfig, lineDiff, readProducerConfig } from '../src/producer/config-edit.ts';
import { tmpDir } from './tmp.ts';

const settings = () => ({ producer: { enabled: true, rules: [], budgets: {}, session: { enabled: true, engine: 'claude', max_turns: 100 } } });

test('producer settings: the producer section is shown and replaced as text, the rest of the file stays byte for byte, an invalid file is never written', async () => {
  const dir = tmpDir('alba-producer-config-');
  const file = path.join(dir, 'alba.yaml');
  const head = '# History\r\nid: demo\r\nname: Demo\r\nroot: .\r\nwork_orders: .\r\nstate_dir: .state\r\n';
  const producer = 'producer:\r\n  enabled: false   # off for now\r\n  session:\r\n    enabled: true\r\n\r\n  # rules follow\r\n  rules: []\r\n';
  const tail = '\r\n# after the producer\r\ndispatch:\r\n  base_ref: main\r\n';
  writeFileSync(file, head + producer + tail);
  const view = readProducerConfig(file);
  assert.equal(view.yaml, 'enabled: false   # off for now\nsession:\n  enabled: true\n\n# rules follow\nrules: []\n');
  const next = view.yaml.replace('enabled: false', 'enabled: true').replace('rules: []', 'rules: []\nsession_note: x').replace('session_note: x', 'reviews: false');
  const dry = editProducerConfig(file, next, { dryRun: true });
  assert.equal(dry.changed, true); assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.diff.filter(d => d.op !== ' ').map(d => `${d.op}${d.text}`), ['-enabled: false   # off for now', '+enabled: true   # off for now', '+reviews: false']);
  assert.equal(readFileSync(file, 'utf8'), head + producer + tail, 'a dry run writes nothing');
  const saved = editProducerConfig(file, next, { now: new Date('2026-11-12T10:00:00Z') });
  assert.ok(saved.backup && existsSync(saved.backup));
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith(head + 'producer:\r\n  enabled: true   # off for now\r\n'));
  assert.ok(text.endsWith('  rules: []\r\n  reviews: false\r\n' + tail), JSON.stringify(text.slice(-120)));
  assert.equal(validateProject((await import('yaml')).parse(text), file).producer.reviews, false);
  // a wrong value anywhere stops the write, with the validation message
  assert.throws(() => editProducerConfig(file, 'enabled: true\nsession:\n  work_timeout_minutes: -1\n'), /work_timeout_minutes/);
  assert.throws(() => editProducerConfig(file, 'enabled: [true\n'), /not valid YAML/);
  assert.throws(() => editProducerConfig(file, '- a list\n'), /must be a mapping/);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(readdirSync(dir).filter(n => n.includes('.bak-')).length, 1);
  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nc\nd\n').map(d => d.op + d.text), [' a', '-b', ' c', '+d']);

  // the API: GET shows the section, POST previews and saves; a bad value is a 400 and nothing changes
  const f = await fixture({ populate: false, project: settings });
  const albaFile = path.join(f.dir, 'alba.yaml');
  writeFileSync(albaFile, `id: demo\nname: Demo\nroot: ${JSON.stringify(f.root)}\nwork_orders: ${JSON.stringify(f.root)}\nstate_dir: ${JSON.stringify(f.dir)}\nproducer:\n  enabled: false\n`);
  const got = await f.get('/api/producer/config');
  assert.equal(got.status, 200); assert.equal(got.body.yaml, 'enabled: false\n');
  const preview = await f.write('/api/producer/config', { yaml: 'enabled: true\n', dryRun: true });
  assert.equal(preview.status, 200); assert.equal(preview.body.dryRun, true); assert.match(readFileSync(albaFile, 'utf8'), /enabled: false/);
  assert.equal((await f.write('/api/producer/config', { yaml: 'enabled: maybe\n' })).status, 400);
  const write = await f.write('/api/producer/config', { yaml: 'enabled: true\n' });
  assert.equal(write.status, 200); assert.ok(write.body.backup);
  assert.match(readFileSync(albaFile, 'utf8'), /producer:\n {2}enabled: true\n/);
  assert.equal((await f.write('/api/producer/config', { yaml: 3 })).status, 400);
});
