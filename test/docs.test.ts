import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { DOC_MARK_END, DOC_MARK_START, documentContentReads, listDocuments, resetDocumentIndex, searchDocuments } from '../src/docs/docs.ts';
import { fixture } from './api-fixture.ts';

const factory = () => path.join(process.cwd(), 'f.yaml');

test('docs config: paths and globs, a research folder, and nothing that leaves the project', () => {
  const cfg = validateProject({
    id: 'd', name: 'D', root: '.', work_orders: '.', state_dir: 's',
    docs: { files: ['./docs/a.md', 'docs/**/*.md'], research: 'docs/research/' },
  }, factory());
  assert.deepEqual(cfg.docs, { files: ['docs/a.md', 'docs/**/*.md'], research: 'docs/research' });
  assert.equal(validateProject({ id: 'd', name: 'D', root: '.', work_orders: '.', state_dir: 's' }, factory()).docs, undefined);
  assert.throws(() => validateProject({ id: 'd', name: 'D', root: '.', work_orders: '.', state_dir: 's', docs: { files: ['a.md'], colour: 'red' } }, factory()), /unknown key/);
  assert.throws(() => validateProject({ id: 'd', name: 'D', root: '.', work_orders: '.', state_dir: 's', docs: ['a.md'] }, factory()), /must be a mapping/);
  assert.throws(() => validateProject({ id: 'd', name: 'D', root: '.', work_orders: '.', state_dir: 's', docs: { files: ['docs/../secret.md'] } }, factory()), /inside the project/);
  assert.throws(() => validateProject({ id: 'd', name: 'D', root: '.', work_orders: '.', state_dir: 's', docs: { files: ['a.md'], research: path.resolve('outside') } }, factory()), /docs.research/);
});

/** A project whose docs mix a missing path, plain paths and a glob, plus a junction that leaves the root. */
async function docsProject() {
  return fixture({
    project: (dir, root) => {
      mkdirSync(path.join(root, 'docs', 'research'), { recursive: true });
      mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true });
      mkdirSync(path.join(root, 'other'), { recursive: true });
      mkdirSync(path.join(root, 'extra'), { recursive: true });
      writeFileSync(path.join(root, 'docs', 'later.md'), '# Later\n\nThe inventory screen.\n\n## Screen\none\n\n## Screen\ntwo\n');
      writeFileSync(path.join(root, 'docs', 'a.md'), '# Character\n\nThe character moves at four metres per second.\n\n## Movement\n\nWalk.\n');
      writeFileSync(path.join(root, 'docs', 'sub', 'c.md'), '```\n# not a heading\n```\n\n#### Ignored\n\n### Deep\n');
      writeFileSync(path.join(root, 'docs', 'research', 'note.md'), '# Notes\n\nSee the inventory too.\n');
      writeFileSync(path.join(root, 'docs', 'skip.txt'), 'not markdown\n');
      writeFileSync(path.join(root, 'other', 'listed.md'), '# Listed\n\nA plain path.\n');
      writeFileSync(path.join(root, 'other', 'neighbor.md'), '# Neighbor\n\nReached from the folder.\n');
      writeFileSync(path.join(root, 'extra', 'out.md'), '# Out\n\nnope\n');
      const outside = path.join(dir, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'secret.md'), '# Secret\n\noutside the project\n');
      symlinkSync(outside, path.join(root, 'docs', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      return { docs: { files: ['docs/missing.md', 'docs/research/soon.md', 'docs/later.md', 'docs/**/*.md', 'other/listed.md'], research: 'docs/research' } };
    },
  });
}

test('docs list: declared paths, then glob matches in path order, missing files and the research group', async () => {
  const f = await docsProject();
  const list = await f.get('/api/docs?project=demo');
  assert.equal(list.status, 200);
  assert.equal(list.body.enabled, true);
  assert.deepEqual(list.body.items.map((d: { path: string }) => d.path), [
    'docs/missing.md', 'docs/research/soon.md', 'docs/later.md', 'other/listed.md',
    'docs/a.md', 'docs/research/note.md', 'docs/sub/c.md',
  ]);
  const byPath = Object.fromEntries(list.body.items.map((d: { path: string }) => [d.path, d]));
  assert.equal(byPath['docs/missing.md'].exists, false);
  assert.equal(byPath['docs/missing.md'].title, 'missing.md');
  assert.equal(byPath['docs/missing.md'].bytes, 0);
  assert.equal(byPath['docs/missing.md'].modified, undefined);
  assert.equal(byPath['docs/missing.md'].group, 'docs');
  assert.equal(byPath['docs/research/soon.md'].exists, false);
  assert.equal(byPath['docs/research/soon.md'].group, 'research');
  assert.equal(byPath['docs/later.md'].title, 'Later');
  assert.equal(byPath['docs/later.md'].group, 'docs');
  assert.deepEqual(byPath['docs/later.md'].headings.map((h: { slug: string }) => h.slug), ['later', 'screen', 'screen-1']);
  assert.equal(byPath['docs/a.md'].title, 'Character');
  assert.equal(byPath['docs/research/note.md'].group, 'research');
  assert.equal(byPath['docs/research/note.md'].title, 'Notes');
  assert.ok(byPath['docs/later.md'].bytes > 0);
  assert.ok(byPath['docs/later.md'].modified);
  const sub = byPath['docs/sub/c.md'];
  assert.equal(sub.title, 'c.md');
  assert.deepEqual(sub.headings.map((h: { level: number; text: string }) => [h.level, h.text]), [[3, 'Deep']]);
  assert.ok(!list.body.items.some((d: { path: string }) => d.path.endsWith('.txt') || d.path.startsWith('extra/')));
});

test('docs file: a listed path, a markdown file under its folder, and a refusal outside the list or the root', async () => {
  const f = await docsProject();
  const neighbor = await f.get('/api/docs/file?project=demo&path=' + encodeURIComponent('other/neighbor.md'));
  assert.equal(neighbor.status, 200);
  assert.equal(neighbor.body.title, 'Neighbor');
  assert.match(neighbor.body.markdown, /Reached from the folder/);
  const listed = await f.get('/api/docs/file?project=demo&path=' + encodeURIComponent('docs/a.md'));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.title, 'Character');
  assert.equal((await f.get('/api/docs/file?project=demo&path=' + encodeURIComponent('docs/missing.md'))).status, 404);
  assert.equal((await f.get('/api/docs/file?project=demo')).status, 400);
  assert.equal((await f.get('/api/docs/file?project=demo&path=' + encodeURIComponent('extra/out.md'))).status, 403);
  assert.equal((await f.get('/api/docs/file?project=demo&path=' + encodeURIComponent('docs/../../outside/secret.md'))).status, 403);
  assert.equal((await f.get('/api/docs/file?project=demo&path=' + encodeURIComponent('docs/linked/secret.md'))).status, 403);
  assert.equal((await f.get('/api/docs/file?project=demo&path=' + encodeURIComponent('docs/skip.txt'))).status, 403);
});

test('docs search: English substrings, a long query refused, and the index reused until the file changes', async () => {
  const f = await docsProject();
  resetDocumentIndex(f.root);
  const list = await f.get('/api/docs?project=demo');
  assert.equal(list.status, 200);
  const reads = documentContentReads(f.root);
  assert.ok(reads >= 4, `expected the list to read the files, got ${reads}`);

  const english = await f.get('/api/docs/search?project=demo&q=InVenTory');
  assert.equal(english.status, 200);
  assert.equal(documentContentReads(f.root), reads);
  assert.deepEqual(english.body.items.map((h: { path: string }) => h.path), ['docs/later.md', 'docs/research/note.md']);
  const marked = english.body.items[0].snippet.split(DOC_MARK_START)[1]?.split(DOC_MARK_END)[0];
  assert.equal(marked?.toLowerCase(), 'inventory');
  assert.equal(english.body.items[0].heading.slug, 'later');
  assert.equal(english.body.count, 2);

  const chinese = await f.get('/api/docs/search?project=demo&q=' + encodeURIComponent('Walk'));
  assert.equal(chinese.status, 200);
  assert.equal(documentContentReads(f.root), reads);
  assert.equal(chinese.body.items.length, 1);
  assert.equal(chinese.body.items[0].path, 'docs/a.md');
  assert.equal(chinese.body.items[0].heading.text, 'Movement');
  assert.equal(chinese.body.items[0].heading.slug, 'movement');
  assert.ok(chinese.body.items[0].line > 1);

  const second = await f.get('/api/docs/search?project=demo&q=' + encodeURIComponent('two') + '&limit=1');
  assert.equal(second.body.items.length, 1);
  assert.equal(second.body.items[0].heading.slug, 'screen-1');
  assert.equal(documentContentReads(f.root), reads);

  assert.equal((await f.get('/api/docs/search?project=demo&q=' + 'x'.repeat(200))).status, 400);
  assert.equal((await f.get('/api/docs/search?project=demo&q=')).body.count, 0);

  writeFileSync(path.join(f.root, 'docs', 'later.md'), '# Later\n\nThe atlas screen is new.\n');
  const again = await f.get('/api/docs/search?project=demo&q=atlas');
  assert.equal(again.status, 200);
  assert.ok(documentContentReads(f.root) > reads);
  assert.equal(again.body.items[0].path, 'docs/later.md');
  assert.equal((await f.get('/api/docs/search?project=demo&q=inventory')).body.items.some((h: { path: string }) => h.path === 'docs/later.md'), false);
});

test('docs calls say the feature is off when the project has no docs section', async () => {
  const f = await fixture();
  const list = await f.get('/api/docs?project=demo');
  assert.equal(list.status, 200);
  assert.equal(list.body.enabled, false);
  assert.equal(list.body.items.length, 0);
  assert.match(list.body.note, /docs\.files/);
  assert.equal((await f.get('/api/docs/file?project=demo&path=README.md')).status, 404);
  assert.equal((await f.get('/api/docs/search?project=demo&q=a')).status, 404);
  const direct = listDocuments(f.board.ctx.projects[0]!);
  assert.equal(direct.enabled, false);
  assert.throws(() => searchDocuments(f.board.ctx.projects[0]!, 'a', 10));
});

test('a listed document at the project root opens only itself, not every .md of the project', async () => {
  const { readDocument } = await import('../src/docs/docs.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'alba-docs-root-'));
  mkdirSync(path.join(root, 'orders')); mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'README.md'), '# Readme\n');
  writeFileSync(path.join(root, 'orders', 'T1-x.md'), '# T1\n');
  writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n');
  writeFileSync(path.join(root, 'docs', 'other.md'), '# Other\n');
  const cfg = validateProject({ id: 'd', name: 'D', root, work_orders: 'orders', state_dir: 'state', docs: { files: ['README.md', 'docs/guide.md'] } }, path.join(root, 'alba.yaml'));
  resetDocumentIndex(root);
  assert.equal(readDocument(cfg, 'README.md').title, 'Readme');
  assert.throws(() => readDocument(cfg, 'orders/T1-x.md'));
  assert.equal(readDocument(cfg, 'docs/other.md').title, 'Other', 'a listed document still opens the .md files of its own folder');
});
