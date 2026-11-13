import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RefClient, addRef, cacheDir, cachedFile, fetchRefs, httpsUrl, pageImage, readRefs, refCards } from '../src/library/refs.ts';
import { sha256 } from '../src/library/files.ts';
import { libraryProject, PNG } from './library-helpers.ts';

const REFS = `- id: r1
  image: https://img.example.test/a.png
  page: https://site.example.test/a
  title: Harbor at dusk
  work: Demo Work
  tags: [harbor, dusk]
  learn: warm rim light
  added: 2026-10-01
- id: r2
  image: https://img.example.test/b.png
  title: Market
  tags: [market]
  learn: crowd density
- id: r3
  image: https://other.example.test/c.png
  title: Blocked
  tags: [harbor]
`;

/** A fetch that answers from a table, offline. */
function fake(routes: Record<string, { status?: number; type?: string; body?: Buffer | string; length?: string; location?: string }>, log: { url: string; at: number }[] = [], clock?: () => number) {
  const fn = (async (url: string) => {
    log.push({ url, at: clock?.() ?? 0 });
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    const headers: Record<string, string> = {};
    if (r.type) headers['content-type'] = r.type;
    if (r.length) headers['content-length'] = r.length;
    if (r.location) headers.location = r.location;
    return new Response(r.body ?? '', { status: r.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return fn;
}

const manners = () => {
  let now = 1_000_000;
  const slept: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms; }, slept, advance: (ms: number) => { now += ms; } };
};

test('only https addresses without a user name are used', () => {
  assert.equal(httpsUrl('https://a.example.test/x.png').hostname, 'a.example.test');
  for (const bad of ['http://a.example.test/x.png', 'ftp://a.example.test/x', 'https://user:pw@a.example.test/x', 'not a url']) assert.throws(() => httpsUrl(bad));
});

test('refs.yaml is read tolerantly: an entry that cannot be used is named, the rest stays', () => {
  const s = libraryProject({ 'art/refs.yaml': REFS + '- id: r1\n  image: https://x.example.test/d.png\n- title: no id\n- id: r5\n  title: no image\n' }, { art: { dir: 'art' } });
  const { refs, problems } = readRefs(s.project.art!);
  assert.deepEqual(refs.map(r => r.id), ['r1', 'r2', 'r3']);
  assert.equal(problems.length, 3);
  assert.deepEqual(refs[0].tags, ['harbor', 'dusk']);
  const broken = libraryProject({ 'art/refs.yaml': 'a: [unclosed' }, { art: { dir: 'art' } });
  assert.match(readRefs(broken.project.art!).problems[0], /not valid YAML/);
});

test('the picture of a page: og:image first, then twitter:image; relative addresses are resolved; a human-check page is given up', () => {
  const og = '<html><head><meta property="og:image" content="/img/a.jpg?x=1&amp;y=2"><meta name="twitter:image" content="https://t.example.test/t.jpg"></head></html>';
  assert.equal(pageImage(og, 'https://site.example.test/p/1'), 'https://site.example.test/img/a.jpg?x=1&y=2');
  assert.equal(pageImage('<meta name="twitter:image" content="https://t.example.test/t.jpg">', 'https://site.example.test/'), 'https://t.example.test/t.jpg');
  assert.throws(() => pageImage('<html><title>Just a moment...</title></html>', 'https://site.example.test/'), /human check/);
  assert.throws(() => pageImage('<html></html>', 'https://site.example.test/'), /no og:image/);
  assert.throws(() => pageImage('<meta property="og:image" content="http://insecure.example.test/a.jpg">', 'https://site.example.test/'), /https/);
});

test('fetching keeps the pictures by the sha256 of their bytes in the state folder, once; a second run downloads nothing; no network is touched', async () => {
  const s = libraryProject({ 'art/refs.yaml': REFS }, { art: { dir: 'art' } });
  const log: { url: string; at: number }[] = [];
  const m = manners();
  const routes = {
    'https://img.example.test/a.png': { type: 'image/png', body: PNG },
    'https://img.example.test/b.png': { type: 'image/png', body: PNG },
    'https://other.example.test/c.png': { type: 'text/html', body: '<html>verify you are human</html>' },
  };
  const client = new RefClient({ fetch: fake(routes, log, m.now), now: m.now, sleep: m.sleep });
  const result = await fetchRefs(s.project, client, () => '2026-11-01T00:00:00Z');
  assert.deepEqual([result.fetched, result.failed], [2, 1]);
  assert.match(result.failures[0].reason, /not a picture, or a human-check page/);
  const dir = cacheDir(s.project);
  assert.ok(dir.startsWith(s.project.state_dir));
  const file = `${sha256(PNG)}.png`;
  assert.ok(existsSync(path.join(dir, file)));
  assert.equal(readdirCount(dir, '.png'), 1);                                // the same bytes are kept once
  assert.ok(cachedFile(s.project, { id: 'r1', image: 'https://img.example.test/a.png' })?.file.endsWith(file));
  // the board shows what is kept and why the rest is missing
  const cards = refCards(s.project).refs;
  assert.deepEqual(cards.map(c => [c.id, c.cached, c.cacheFrom ?? '', c.failure ? 'failed' : '']), [['r1', true, 'alba', ''], ['r2', true, 'alba', ''], ['r3', false, '', 'failed']]);
  // a second run: only the failed one is tried again
  log.length = 0;
  const again = await fetchRefs(s.project, new RefClient({ fetch: fake(routes, log, m.now), now: m.now, sleep: m.sleep }));
  assert.deepEqual([again.fetched, again.skipped, again.failed], [0, 2, 1]);
  assert.deepEqual(log.map(l => l.url), ['https://other.example.test/c.png']);
});

function readdirCount(dir: string, ext: string): number {
  return readdirSync(dir).filter(f => f.endsWith(ext)).length;
}

test('manners: one request per host every 1.5 seconds, redirects are followed over https only, images only, 15 MB at most', async () => {
  const m = manners();
  const log: { url: string; at: number }[] = [];
  const routes = {
    'https://h.example.test/1': { type: 'image/png', body: PNG },
    'https://h.example.test/2': { type: 'image/png', body: PNG },
    'https://g.example.test/1': { type: 'image/png', body: PNG },
    'https://h.example.test/redir': { status: 302, location: '/1' },
    'https://h.example.test/to-http': { status: 302, location: 'http://h.example.test/1' },
    'https://h.example.test/big': { type: 'image/png', body: PNG, length: String(16 * 1024 * 1024) },
    'https://h.example.test/page': { type: 'text/html', body: '<html>hi</html>' },
  };
  const c = new RefClient({ fetch: fake(routes, log, m.now), now: m.now, sleep: m.sleep });
  await c.get('https://h.example.test/1', { image: true });
  await c.get('https://g.example.test/1', { image: true });           // another host: no wait
  assert.deepEqual(m.slept, []);
  await c.get('https://h.example.test/2', { image: true });           // same host straight after: waits
  assert.deepEqual(m.slept, [1500]);
  m.advance(10_000);
  const r = await c.get('https://h.example.test/redir', { image: true });
  assert.equal(r.url, 'https://h.example.test/1');
  await assert.rejects(() => c.get('https://h.example.test/to-http', { image: true }), /https/);
  await assert.rejects(() => c.get('https://h.example.test/big', { image: true }), /size limit/);
  await assert.rejects(() => c.get('https://h.example.test/page', { image: true }), /not a picture/);
  await assert.rejects(() => c.get('https://h.example.test/missing', { image: true }), /HTTP 404/);
});

test('a external cache named by reuse_cache is used read only before any download', async () => {
  const s = libraryProject({ 'art/refs.yaml': REFS }, { art: { dir: 'art', reuse_cache: 'external-cache' } });
  const studio = path.join(s.dir, 'external-cache');
  mkdirSync(studio, { recursive: true });
  writeFileSync(path.join(studio, 'abc.png'), PNG);
  writeFileSync(path.join(studio, 'index.json'), JSON.stringify({ 'https://img.example.test/a.png': { image: 'https://img.example.test/a.png', file: 'abc.png', thumb: 'abc-480.webp' }, 'https://img.example.test/b.png': { image: 'https://img.example.test/b.png', file: 'abc.png', thumb: 'x' }, 'https://changed.example.test/c.png': { image: 'https://changed.example.test/c.png', file: 'abc.png', thumb: 'x' } }));
  const log: { url: string; at: number }[] = [];
  const result = await fetchRefs(s.project, new RefClient({ fetch: fake({}, log), sleep: async () => {} }));
  assert.deepEqual(log.map(l => l.url), ['https://other.example.test/c.png']);   // r1 by id, r2 by its address under another id; r3's address changed
  assert.deepEqual([result.reused, result.fetched, result.failed], [2, 0, 1]);
  assert.equal(refCards(s.project).refs[0].cacheFrom, 'external');
  assert.equal(existsSync(path.join(cacheDir(s.project), 'index.json')), false);   // nothing was written for what was reused
});

test('alba refs add appends a card with the page\'s picture; a duplicate picture or a missing --learn is refused', () => {
  const s = libraryProject({ 'art/refs.yaml': '# my board\n' + REFS }, { art: { dir: 'art' } });
  const ref = addRef(s.project.art!, { image: 'https://img.example.test/new.png', page: 'https://site.example.test/n', title: 'New', tags: ['x'], learn: 'shape language' }, new Date('2026-11-02T00:00:00Z'));
  assert.match(ref.id, /^ref-[a-f0-9]{10}$/);
  const text = readFileSync(path.join(s.root, 'art/refs.yaml'), 'utf8');
  assert.ok(text.startsWith('# my board'));
  assert.equal(readRefs(s.project.art!).refs.length, 4);
  assert.throws(() => addRef(s.project.art!, { image: 'https://img.example.test/new.png', title: 'Again', tags: ['x'], learn: 'y' }), /already/);
  assert.throws(() => addRef(s.project.art!, { image: 'https://img.example.test/z.png', title: 'No learn', tags: ['x'] }), /--learn/);
  assert.throws(() => addRef(s.project.art!, { image: 'http://img.example.test/z.png', title: 't', tags: ['x'], learn: 'y' }), /https/);
});
