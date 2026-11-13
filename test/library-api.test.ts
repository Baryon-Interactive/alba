import { writeStateFile } from '../src/orders/state-files.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, shape } from './api-fixture.ts';
import { PNG } from './library-helpers.ts';

const PICK = 'id: P1\ntitle: Door\nquestion: Which door?\nmulti: false\noptions:\n  - { key: a, label: Round, images: [Docs/picks/a.png] }\n  - { key: b, label: Square, images: [] }\n';
const TEXT = '# Setting\n\n## Heroine\n\nSilver hair.\n';
const QUOTE = 'id: Q1\nservice: gen\norder: T1\nquote_status: estimate\nitems: 2\nper_item: 70\ntotal: 140\ncap_requested: 150\n';

async function library() {
  let ledger = '';
  const f = await fixture({
    project: (dir, root) => {
      const put = (rel: string, body: string | Buffer) => { const p = path.join(root, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, body); };
      put('Docs/picks/P1.yaml', PICK); put('Docs/picks/a.png', PNG);
      put('Docs/art/refs.yaml', '- { id: r1, image: https://img.example.test/a.png, title: Dusk, tags: [dusk], learn: light }\n');
      put('Docs/art/visual.md', TEXT);
      put('Docs/art/settings/heroine.yaml', 'id: heroine\ntitle: Heroine\nkind: character\ntext: Docs/art/visual.md#heroine\nrefs: [r1]\nimages: []\nstatus: text-draft\n');
      put('Docs/credits/Q1.yaml', QUOTE);
      ledger = path.join(dir, 'calls.jsonl');
      writeFileSync(ledger, JSON.stringify({ time: '2026-11-01 10:00:00', model: 'img-a', status: 'ok', cwd: root }) + '\n' + JSON.stringify({ time: '2026-11-01 11:00:00', model: 'img-a', status: 'error', cwd: root }) + '\n');
      return {
        picks: { dir: 'Docs/picks' }, art: { dir: 'Docs/art' }, credits: { dir: 'Docs/credits' },
        usage_ledgers: [{ id: 'gen', file: 'calls.jsonl', fields: { time: 'time', model: 'model', status: 'status', cwd: 'cwd', out: 'out' } }],
      };
    },
  });
  return { f, ledger };
}

test('api: picks list and choose (a stale fingerprint is a conflict, a decided or unknown set is refused)', async () => {
  const { f } = await library();
  const list = (await f.get('/api/picks')).body;
  shape(list, { project: 'string', enabled: 'boolean', sets: [{ id: 'string', title: 'string', question: 'string', multi: 'boolean', options: [{ key: 'string', label: 'string', images: 'array' }], state: 'string', source: 'string', problems: 'array', 'fingerprint?': 'string' }], unreadable: 'array', recordProblems: 'array', counts: { pending: 'number', chosen: 'number', decided: 'number', unreadable: 'number' } });
  assert.deepEqual([list.sets[0].id, list.sets[0].state, list.counts.pending], ['P1', 'pending', 1]);
  assert.equal((await f.write('/api/picks/P1/choose', { choice: ['a'], fingerprint: 'x'.repeat(64) })).status, 409);
  assert.equal((await f.write('/api/picks/NOPE/choose', { choice: ['a'] })).status, 404);
  assert.equal((await f.write('/api/picks/P1/choose', { choice: 'a' })).status, 400);
  assert.equal((await f.write('/api/picks/P1/choose', { choice: ['zz'] })).status, 400);
  const ok = await f.write('/api/picks/P1/choose', { choice: ['a'], note: 'round', who: 'Alex', fingerprint: list.sets[0].fingerprint });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.set.state, ok.body.set.choice.choice, ok.body.set.decisionDraft], ['chosen', ['a'], 'Door: Round (round). picks:P1']);
  assert.equal((await f.get('/api/picks')).body.counts.chosen, 1);
  // a write needs the key
  const raw = await fetch(`${f.base}/api/picks/P1/choose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: ['b'] }) });
  assert.equal(raw.status, 401);
});

test('api: art view, a reference picture that is fetched, and the text confirmation', async () => {
  const { f } = await library();
  const art = (await f.get('/api/art')).body;
  shape(art, { project: 'string', enabled: 'boolean', refs: [{ id: 'string', image: 'string', title: 'string', tags: 'array', cached: 'boolean', problems: 'array' }], tags: [{ tag: 'string', count: 'number' }], settings: [{ id: 'string', title: 'string', status: 'string', standard: 'boolean', text: 'string', refs: 'array', refCards: 'array', images: 'array', confirmed: 'boolean', problems: 'array', 'body?': 'string', 'textSha256?': 'string' }], compare: 'array', problems: 'array', cache: { cached: 'number', failures: 'array' } });
  assert.equal(art.refs[0].cached, false);
  assert.equal((await f.get('/api/art/ref/r1')).status, 404);          // not fetched
  assert.equal((await f.get('/api/art/ref/nope')).status, 404);
  // put the picture where the fetch would have: the cache index in the state folder
  const dir = path.join(f.board.ctx.projects[0].state_dir, 'refs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'p.png'), PNG);
  writeStateFile(f.board.ctx.projects[0], 'refs/index.json', JSON.stringify({ 'https://img.example.test/a.png': { image: 'https://img.example.test/a.png', file: 'p.png', bytes: PNG.length, at: '2026-11-01T00:00:00Z' } }));
  const img = await fetch(`${f.base}/api/art/ref/r1`, { headers: { 'x-alba-token': f.token } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).length, PNG.length);
  assert.equal((await f.get('/api/art')).body.refs[0].cacheFrom, 'alba');
  // confirm the text
  const s = art.settings[0];
  assert.equal((await f.write('/api/art/settings/heroine/approve', { fingerprint: '0'.repeat(64) })).status, 409);
  assert.equal((await f.write('/api/art/settings/nope/approve', {})).status, 404);
  const done = await f.write('/api/art/settings/heroine/approve', { note: 'right', who: 'Alex', fingerprint: s.textSha256 });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.confirmed, done.body.confirmation.source, done.body.confirmation.valid], [true, 'alba', true]);
});

test('api: spend view with approval, and the usage view with its days', async () => {
  const { f } = await library();
  const spend = (await f.get('/api/spend')).body;
  shape(spend, { project: 'string', enabled: 'boolean', quotes: [{ id: 'string', statusKnown: 'boolean', file: 'string', fingerprint: 'string', state: 'string', entries: 'array', spent: 'number', problems: 'array' }], unreadable: 'array', recordProblems: 'array', counts: { quotes: 'number', withProblems: 'number', pending: 'number', approved: 'number', stale: 'number', unreadable: 'number' } });
  assert.equal(spend.quotes[0].state, 'pending');
  assert.equal((await f.write('/api/spend/Q1/approve', { fingerprint: spend.quotes[0].fingerprint })).status, 400);        // no cap
  assert.equal((await f.write('/api/spend/Q1/approve', { cap: 150, fingerprint: 'z' })).status, 409);
  assert.equal((await f.write('/api/spend/Q9/approve', { cap: 150 })).status, 404);
  const ok = await f.write('/api/spend/Q1/approve', { cap: 150, note: 'ok', fingerprint: spend.quotes[0].fingerprint });
  assert.deepEqual([ok.status, ok.body.state, ok.body.remaining], [200, 'approved', 150]);
  const usage = (await f.get('/api/usage?days=30')).body;
  shape(usage, { project: 'string', enabled: 'boolean', days: 'number', ledgers: [{ id: 'string', file: 'string', ok: 'boolean', calls: 'number', lines: 'number', unreadable: 'number' }], byDay: 'array', byModel: 'array', total: { ok: 'number', failed: 'number' } });
  assert.equal(usage.ledgers[0].calls, 2);
  assert.equal((await f.get('/api/usage?days=0')).status, 400);
});

test('api: without the sections nothing is enabled and nothing breaks; the order detail names calls made under its worktree', async () => {
  const plain = await fixture();
  for (const p of ['/api/picks', '/api/art', '/api/spend', '/api/usage']) {
    const r = await plain.get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.body.enabled, false, p);
  }
  const { f, ledger } = await library();
  writeFileSync(ledger, JSON.stringify({ time: '2026-11-01 10:00:00', model: 'img-a', status: 'ok', cwd: f.worktree }) + '\n' + JSON.stringify({ time: '2026-11-01 10:05:00', model: 'img-a', status: 'error', out: path.join(f.worktree, 'x.png') }) + '\n');
  f.orders.add({ tag: 'ZZ1', title: 'Art run', kind: 'sim', worktree: f.worktree });
  const detail = (await f.get('/api/orders/ZZ1')).body;
  assert.deepEqual(detail.externalCalls, [{ ledger: 'gen', ok: 1, failed: 1 }]);
});
