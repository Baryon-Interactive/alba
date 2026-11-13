import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { alba, projectDir } from './cli-helper.ts';

const PICK = 'id: P1\ntitle: Door\nquestion: Which door?\nmulti: false\noptions:\n  - { key: a, label: Round, images: [] }\n  - { key: b, label: Square, images: [] }\n';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-libcli-'));
  const put = (rel: string, body: string) => { const p = path.join(dir, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, body); };
  put('Docs/picks/P1.yaml', PICK);
  put('Docs/art/refs.yaml', '- { id: r1, image: https://img.example.test/a.png, title: Dusk, work: W, tags: [dusk], learn: light }\n');
  put('Docs/art/visual.md', '# S\n\n## Heroine\n\nSilver hair.\n');
  put('Docs/art/settings/heroine.yaml', 'id: heroine\ntitle: Heroine\nkind: character\ntext: Docs/art/visual.md#heroine\nrefs: [r1]\nimages: []\nstatus: text-draft\n');
  put('Docs/credits/Q1.yaml', 'id: Q1\nservice: gen\norder: T1\nquote_status: estimate\nitems: 2\nper_item: 70\ntotal: 140\ncap_requested: 150\n');
  put('calls.jsonl', JSON.stringify({ time: '2026-11-04 09:00:00', model: 'img-a', status: 'ok', cwd: dir }) + '\n');
  const file = projectDir(dir, `picks: { dir: Docs/picks }\nart: { dir: Docs/art }\ncredits: { dir: Docs/credits }\nusage_ledgers:\n  - { id: gen, file: calls.jsonl, fields: { time: time, model: model, status: status, cwd: cwd } }\n`);
  return { dir, file };
}

test('cli: picks list and choose, with the decision text to record', () => {
  const { file } = setup();
  const list = alba(file, ['picks']);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /P1\s+pending\s+Door\s+a\/b/);
  assert.match(list.out, /1 pending, 0 chosen, 0 decided, 0 files not read/);
  assert.equal(alba(file, ['picks', 'choose', 'P1']).code, 1);
  const r = alba(file, ['picks', 'choose', 'P1', '--choice', 'b', '--note', 'square', '--who', 'Alex']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /P1: chosen b\./);
  assert.match(r.out, /alba decide "Door: Square \(square\)\. picks:P1"/);
  assert.match(alba(file, ['picks']).out, /P1\s+chosen/);
  assert.equal(JSON.parse(alba(file, ['picks', '--json']).out).sets[0].choice.choice[0], 'b');
  assert.match(alba(file, ['picks', 'choose', 'P1', '--choice', 'zz']).err, /does not have/);
});

test('cli: art, settings approve, refs list', () => {
  const { file } = setup();
  const art = alba(file, ['art']);
  assert.equal(art.code, 0, art.err);
  assert.match(art.out, /1 references \(0 kept\), 1 settings/);
  assert.match(art.out, /heroine\s+text-draft\s+no/);
  assert.match(alba(file, ['refs', 'list']).out, /r1\s+W\s+Dusk\s+dusk\s+no\s+light/);
  assert.doesNotMatch(alba(file, ['refs', 'list', '--tag', 'nothing']).out, /r1/);
  const ok = alba(file, ['settings', 'approve', 'heroine', '--note', 'text is right']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /heroine: the text is confirmed \(sha256 [a-f0-9]{12}\)\./);
  assert.match(alba(file, ['art']).out, /heroine\s+text-draft\s+yes/);
  assert.equal(alba(file, ['settings', 'approve']).code, 1);
  const add = alba(file, ['refs', 'add', '--page', 'https://site.example.test/p', '--image', 'https://img.example.test/n.png', '--title', 'New', '--work', 'W', '--tags', 'x,y', '--learn', 'shape']);
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /added to the board/);
  assert.match(alba(file, ['refs', 'list', '--tag', 'x']).out, /New/);
  assert.equal(alba(file, ['refs', 'add', '--page', 'http://site.example.test/p', '--title', 'T', '--tags', 'x', '--learn', 'l', '--image', 'https://a.example.test/i.png']).code, 1);
});

test('cli: spend list and approve, usage', () => {
  const { file } = setup();
  const list = alba(file, ['spend']);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /Q1\s+pending\s+estimate\s+gen\s+140\s+\(150\)\s+0\s+0/);
  assert.equal(alba(file, ['spend', 'approve', 'Q1']).code, 1);
  const ok = alba(file, ['spend', 'approve', 'Q1', '--cap', '150', '--note', 'ok']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Q1: approved up to 150; 0 spent, 150 left\./);
  assert.match(alba(file, ['spend']).out, /Q1\s+approved\s+estimate\s+gen\s+140\s+150/);
  const usage = alba(file, ['usage', '--days', '400']);
  assert.equal(usage.code, 1);
  const days = alba(file, ['usage', '--days', '30']);
  assert.equal(days.code, 0, days.err);
  assert.match(days.out, /gen\s+\S.*\s1\s+1\s+0\s*\n/);
});

test('cli: a project without the sections says so', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-libcli-'));
  const file = projectDir(dir);
  assert.match(alba(file, ['picks']).out, /no pick sets/);
  assert.match(alba(file, ['art']).out, /no art section/);
  assert.match(alba(file, ['spend']).out, /no credits section/);
  assert.match(alba(file, ['usage']).out, /Tokens[\s\S]*Total/);
  assert.match(alba(file, ['usage', '--days', '7']).out, /No usage ledgers/);
  assert.equal(alba(file, ['refs', 'list']).code, 1);
  assert.match(alba(file, ['refs', 'adopt']).err, /./);      // the check command of the same name still answers
});
