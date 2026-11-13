import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headings, headingText, markdownSection, slug } from '../src/library/markdown.ts';

const DOC = [
  '# Title', '', 'intro', '',
  '## Hero', '', 'the hero text', '',
  '### Cloak', '', 'cloak text', '',
  '## Villain & Friends', '', 'villain text', '',
  '```md', '## Not a heading', '```', '',
  '## Hero', '', 'second hero', '',
].join('\n');

test('anchors follow the heading text; a heading used twice gets -1, -2', () => {
  assert.deepEqual(headings(DOC).map(h => h.id), ['title', 'hero', 'cloak', 'villain-amp-friends', 'hero-1']);
  assert.equal(slug('Hero 2: The Return (v2)'), 'hero-2-the-return-v2');
  assert.equal(slug('Setting A:Old city'), 'setting-aold-city');
});

test('inline marks are taken off: emphasis, code, links; an image leaves nothing', () => {
  assert.equal(headingText('**Bold** and `code` and [a link](http://x.y)'), 'Bold and code and a link');
  assert.equal(slug(headingText('Use _this_ ![pic](a.png) now')), 'use-this--now');
  assert.equal(slug(headingText('A & B')), 'a-amp-b');
});

test('a section runs to the next heading of the same or a higher level, raw, and fenced code holds no headings', () => {
  assert.equal(markdownSection(DOC, 'hero'), '## Hero\n\nthe hero text\n\n### Cloak\n\ncloak text\n\n');
  assert.equal(markdownSection(DOC, 'cloak'), '### Cloak\n\ncloak text\n\n');
  assert.equal(markdownSection(DOC, 'villain-amp-friends'), '## Villain & Friends\n\nvillain text\n\n```md\n## Not a heading\n```\n\n');
  assert.equal(markdownSection(DOC, 'hero-1'), '## Hero\n\nsecond hero\n');
  assert.equal(markdownSection(DOC, 'title'), DOC);
  assert.equal(markdownSection(DOC, 'nothing-here'), undefined);
  assert.equal(markdownSection(DOC), DOC);
});

test('line endings stay as they are: a CRLF file gives a CRLF section', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  assert.equal(markdownSection(crlf, 'cloak'), '### Cloak\r\n\r\ncloak text\r\n\r\n');
  assert.deepEqual(headings(crlf).map(h => h.id), headings(DOC).map(h => h.id));
});

test('a heading with an underline is a heading too; trailing # marks are not part of the text', () => {
  const doc = 'Name\n====\n\ntext\n\nSub\n---\n\nmore\n\n## Closed ##\n\nend\n';
  assert.deepEqual(headings(doc).map(h => [h.level, h.id]), [[1, 'name'], [2, 'sub'], [2, 'closed']]);
  assert.equal(markdownSection(doc, 'sub'), 'Sub\n---\n\nmore\n\n');
});
