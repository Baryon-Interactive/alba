import path from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DocHeading } from '@api';
import { DocBody } from '@/components/DocBody.tsx';
import { setLang } from '@/i18n';
import { classifyDocHref, docFileUrl, docReaderTo, splitSnippet } from '@/lib/docs.ts';

beforeAll(() => setLang('en'));

const html = (node: ReactNode) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

describe('document links', () => {
  const from = 'docs/a.md';

  it('keeps a relative markdown file in the reader and a relative image on the files route', () => {
    expect(classifyDocHref(from, './b.md')).toEqual({ kind: 'doc', path: 'docs/b.md', hash: '' });
    expect(classifyDocHref(from, './b%20c.md#screen')).toEqual({ kind: 'doc', path: 'docs/b c.md', hash: 'screen' });
    expect(classifyDocHref(from, '/other/x.md')).toEqual({ kind: 'doc', path: 'other/x.md', hash: '' });
    expect(classifyDocHref(from, '../readme.md')).toEqual({ kind: 'doc', path: 'readme.md', hash: '' });
    expect(classifyDocHref(from, './shot.PNG')).toEqual({ kind: 'file', path: 'docs/shot.PNG' });
    expect(classifyDocHref(from, 'clip.mp4')).toEqual({ kind: 'file', path: 'docs/clip.mp4' });
    expect(docReaderTo('demo', 'docs/b.md', 'screen')).toBe('/p/demo/docs/read?path=docs%2Fb.md#screen');
  });

  it('blocks schemes other than http(s), protocol-relative links, and paths that leave the project', () => {
    expect(classifyDocHref(from, 'https://example.com/a')).toEqual({ kind: 'external', href: 'https://example.com/a' });
    expect(classifyDocHref(from, 'HTTP://example.com/a').kind).toBe('external');
    for (const href of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,hi', 'file:///tmp/x', 'mailto:a@b.c', '//evil.example/x', '../../secret.md', 'notes.txt', '#', '', path.win32.resolve('secret.md'), '.\\shot.png']) {
      expect(classifyDocHref(from, href), href).toEqual({ kind: 'blocked' });
    }
    expect(classifyDocHref(from, '#screen')).toEqual({ kind: 'hash', id: 'screen' });
    expect(classifyDocHref('readme.md', './%2e%2e/%2e%2e/secret.md')).toEqual({ kind: 'blocked' });
  });

  it('splits a snippet on the API marks', () => {
    expect(splitSnippet(`see ${'\u0001'}cat${'\u0002'} here`)).toEqual([
      { text: 'see ', mark: false },
      { text: 'cat', mark: true },
      { text: ' here', mark: false },
    ]);
  });
});

describe('document body', () => {
  const headings: DocHeading[] = [
    { level: 1, text: 'Design', slug: 'design', line: 1 },
    { level: 2, text: 'Screen', slug: 'screen', line: 3 },
    { level: 2, text: 'Screen', slug: 'screen-1', line: 5 },
  ];
  const markdown = [
    '# Design',
    '',
    '## Screen',
    '',
    '## Screen',
    '',
    'See [next](./b.md) and [site](https://example.com/a).',
    '',
    '[js](javascript:alert(1)) [data](data:text/html,hi) [disk](file:///tmp/x) [mail](mailto:a@b.c) [proto](//evil.example/x) [up](../../secret.md) [txt](notes.txt)',
    '',
    '![pic](./shot.png)',
    '',
    '![remote](https://evil.example/a.png)',
    '',
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '- [x] done',
    '',
    '```',
    '<script>keep</script>',
    '```',
    '',
    '<script>alert(1)</script>',
    '',
    'a <b>c</b> d',
    '',
    '<https://example.com/auto>',
    '',
  ].join('\n');

  it('rewrites links, escapes raw HTML, and renders tables, tasks and code', () => {
    const out = html(createElement(DocBody, { project: 'demo', path: 'docs/a.md', markdown, headings }));
    expect(out).toContain('id="design"');
    expect(out).toContain('id="screen"');
    expect(out).toContain('id="screen-1"');
    expect(out).toContain('href="/p/demo/docs/read?path=docs%2Fb.md"');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer"');
    expect(out).toContain(docFileUrl('demo', 'docs/shot.png').replaceAll('&', '&amp;'));
    expect(out).toContain('alt="pic"');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:text');
    expect(out).not.toContain('file:///');
    expect(out).not.toContain('mailto:');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('secret.md');
    expect(out).not.toContain('notes.txt');
    expect(out).toContain('<table>');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('<pre>');
    expect(out).toContain('&lt;script&gt;keep&lt;/script&gt;');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('href="https://example.com/auto"');
    expect(out).not.toMatch(/<script[\s>]/);
    expect(out).not.toContain('&amp;lt;');
  });
});
