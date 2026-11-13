import { readStateFile } from '../src/orders/state-files.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { approveSetting, artView } from '../src/library/art.ts';
import { sha256 } from '../src/library/files.ts';
import { markdownSection } from '../src/library/markdown.ts';
import { libraryProject, PNG } from './library-helpers.ts';

const TEXT = '# Visual setting\n\nintro\n\n## Heroine\n\nShort silver hair, a green coat.\n\n### Coat\n\nWaxed canvas.\n\n## Villain\n\nTall, scarred.\n';
const REFS = '- { id: r1, image: https://img.example.test/a.png, page: https://site.example.test/a, title: Dusk, work: W, tags: [dusk, harbor], learn: warm light }\n- { id: r2, image: https://img.example.test/b.png, title: Market, work: W, tags: [harbor], learn: crowds }\n';
const SETTING = (extra = '') => `id: heroine\ntitle: Heroine\nkind: character\ntext: art/visual-setting.md#heroine\nrefs: [r1, r2]\nimages: []\nstatus: concept\n${extra}`;

function setup(files: Record<string, string> = {}) {
  return libraryProject({ 'art/refs.yaml': REFS, 'art/visual-setting.md': TEXT, 'art/settings/heroine.yaml': SETTING(), ...files }, { art: { dir: 'art', records: 'external-settings.jsonl' } });
}

test('a setting card: its text is the section under its anchor, its refs are cards of the board, the board counts tags', () => {
  const s = setup();
  const view = artView(s.project);
  assert.equal(view.enabled, true);
  const card = view.settings[0];
  assert.equal(card.body, markdownSection(TEXT, 'heroine'));
  assert.match(card.body!, /^## Heroine\n\nShort silver hair/);
  assert.match(card.body!, /Waxed canvas/);
  assert.doesNotMatch(card.body!, /Villain/);
  assert.equal(card.textSha256, sha256(card.body!));
  assert.deepEqual(card.refCards.map(r => r.id), ['r1', 'r2']);
  assert.deepEqual(view.tags, [{ tag: 'harbor', count: 2 }, { tag: 'dusk', count: 1 }]);
  assert.equal(card.confirmed, false);
});

test('validations are shown on the card: a word that is not one of the four statuses, a dead anchor, a picture in a draft, a picture path in refs, no decision past the draft', () => {
  const s = setup({
    'art/settings/ghost.yaml': 'id: ghost\ntitle: Ghost\nkind: character\ntext: art/visual-setting.md#nowhere\nrefs: [art/settings/ghost/a.png]\nimages: [art/settings/ghost/a.png]\nstatus: draft\n',
    'art/settings/old.yaml': 'id: old\ntitle: Old\nkind: prop\ntext: art/visual-setting.md#villain\nrefs: []\nimages: []\nstatus: final\n',
  });
  const cards = Object.fromEntries(artView(s.project).settings.map(c => [c.id, c]));
  assert.equal(cards.heroine.standard, false);
  assert.ok(cards.heroine.problems.some(p => /"concept" is not one of/.test(p)));
  const ghost = cards.ghost.problems.join('\n');
  assert.match(ghost, /anchor #nowhere is not in/);
  assert.match(ghost, /names a picture file/);
  assert.match(ghost, /a draft has pictures/);
  assert.match(ghost, /picture art\/settings\/ghost\/a.png is missing/);
  assert.equal(cards.ghost.body, undefined);
  const old = cards.old.problems.join('\n');
  assert.match(old, /no "decision"/);
  assert.match(old, /status is "final" but there are no pictures/);
  assert.match(old, /no confirmation of this text is on record/);
});

test('confirming records the fingerprint of the section text in the state folder; editing that section (and only that one) makes it stale', () => {
  const s = setup();
  const fp = artView(s.project).settings[0].textSha256!;
  assert.throws(() => approveSetting(s.project, s.orders, 'heroine', { fingerprint: '0'.repeat(64) }), /changed/);
  const card = approveSetting(s.project, s.orders, 'heroine', { note: 'text is right', who: 'Alex', fingerprint: fp });
  assert.equal(card.confirmed, true);
  assert.deepEqual([card.confirmation?.source, card.confirmation?.by, card.confirmation?.who, card.confirmation?.valid], ['alba', 'test', 'Alex', true]);
  assert.ok(s.orders.store.events().some(e => e.type === 'setting-approved'));
  assert.match(readStateFile(s.project, '_settings.jsonl')!, new RegExp(fp));
  // another section changes: the confirmation holds
  writeFileSync(path.join(s.root, 'art/visual-setting.md'), TEXT.replace('Tall, scarred.', 'Short, scarred.'));
  assert.equal(artView(s.project).settings[0].confirmed, true);
  // this one changes: it does not
  writeFileSync(path.join(s.root, 'art/visual-setting.md'), TEXT.replace('green coat', 'red coat'));
  const stale = artView(s.project).settings[0];
  assert.equal(stale.confirmed, false);
  assert.equal(stale.confirmation?.valid, false);
  assert.ok(stale.problems.some(p => /changed after it was confirmed/.test(p)));
  // line endings of a checkout do not break it
  writeFileSync(path.join(s.root, 'art/visual-setting.md'), TEXT.replace(/\n/g, '\r\n'));
  const crlf = approveSetting(s.project, s.orders, 'heroine', {});
  assert.equal(crlf.confirmed, true);
  writeFileSync(path.join(s.root, 'art/visual-setting.md'), TEXT);
  assert.equal(artView(s.project).settings[0].confirmed, true);   // the LF form of the same text still matches
});

test('only a setting whose text is a draft is confirmed; a setting can be confirmed once its words are written', () => {
  const s = setup({ 'art/settings/done.yaml': 'id: done\ntitle: Done\nkind: prop\ntext: art/visual-setting.md#villain\nrefs: []\nimages: []\nstatus: sheets\ndecision: D1\n' });
  assert.throws(() => approveSetting(s.project, s.orders, 'done', {}), /only a setting whose text is a draft/);
  assert.throws(() => approveSetting(s.project, s.orders, 'missing', {}), /no setting/);
  assert.throws(() => approveSetting(s.project, s.orders, 'heroine', { note: 'x'.repeat(4001) }), /at most 4000/);
});

test('the external tool\'s confirmations are read: a matching hash counts, a line of another project or a broken line does not', () => {
  const s = setup();
  const hash = sha256(markdownSection(TEXT, 'heroine')!);
  const rec = (o: Record<string, unknown>) => JSON.stringify({ at: '2026-10-20T00:00:00Z', project: 'demo', setting: 'heroine', textSha256: hash, note: 'ok', source: 'web', ...o });
  writeFileSync(path.join(s.dir, 'external-settings.jsonl'), [rec({}), rec({ project: 'other', textSha256: '0'.repeat(64), at: '2026-10-21T00:00:00Z' }), 'broken', ''].join('\n'));
  const view = artView(s.project);
  assert.equal(view.settings[0].confirmed, true);
  assert.equal(view.settings[0].confirmation?.source, 'external');
  assert.equal(view.problems.length, 1);
});

test('unreadable files are listed, the folder compare/ is only listed, a missing folder is said, no art section is off', () => {
  const s = setup({ 'art/settings/bad.yaml': 'id: [x', 'art/settings/noid.yaml': 'title: x\n', 'art/compare/shot1.png': PNG.toString('latin1'), 'art/compare/spec.yaml': 'a: 1\n' });
  const view = artView(s.project);
  assert.equal(view.settings.length, 1);
  assert.equal(view.problems.filter(p => p.startsWith('settings/')).length, 2);
  assert.deepEqual(view.compare, ['shot1.png', 'spec.yaml']);
  const gone = libraryProject({}, { art: { dir: 'nowhere' } });
  assert.match(artView(gone.project).problems[0], /not there/);
  assert.equal(artView(libraryProject({}).project).enabled, false);
});
