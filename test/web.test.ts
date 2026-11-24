import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import { after, test } from 'node:test';
import { request, type Server } from 'node:http';
import { validateProject } from './state-helper.ts';
import { Orders } from '../src/orders/service.ts';
import { testStore } from './state-helper.ts';
import { humanAction } from '../src/service/actions.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { balanceChange } from '../src/web/html.ts';
import { startServer } from '../src/web/server.ts';
import { formToken, keyFile, newKey, readKeyFile, writeKeyFile } from '../src/web/auth.ts';
import { tempOrders } from './helpers.ts';

const probes: Probes = {
  now: () => new Date(), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined,
  isAlive: () => false, tail: () => 'line one\nline <two>\n', readText: () => undefined, spawnDetached: () => 1,
};
const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'x', aliases: ['Coder'] }, { id: 'editor', engine: 'claude-session' }] }, 'w.yaml');
const ready = { status: 'ready' as const, summary: 'did it', evidence: [], commits: ['abc1234'] };

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

/** A project with orders in several stages, and a board on a free port. */
async function board(populate = true, signIn = false) {
  const { dir } = tempOrders();
  const root = path.join(dir, 'game'); mkdirSync(root, { recursive: true });
  const config = validateProject({ id: 'demo', name: 'Demo', root, work_orders: root, state_dir: path.join(dir, 'state'), dispatch: { min_free_ram_gb: 4 } }, path.join(dir, 'alba.yaml'));
  const orders = new Orders(testStore(config.state_dir));
  if (populate) {
    const add = (tag: string, title: string) => orders.add({ tag, title, kind: 'sim', worker: 'Coder' });
    add('Q1', 'Waits for an answer'); orders.act('Q1', 'queue'); orders.runStart('Q1', { worker: 'coder' }); orders.report('Q1', { status: 'waiting', summary: 's', question: 'Which tileset <b>first</b>?', evidence: [], commits: [] }); orders.runEnd('Q1');
    add('R1', 'Waits for review'); orders.act('R1', 'queue'); orders.runStart('R1', { worker: 'coder' }); orders.report('R1', ready); orders.runEnd('R1');
    add('B1', 'Is blocked'); orders.act('B1', 'queue'); orders.runStart('B1', { worker: 'coder' }); orders.report('B1', { status: 'blocked', summary: 'needs a key', evidence: [], commits: [] }); orders.runEnd('B1');
    add('F1', 'Failed'); orders.act('F1', 'queue'); orders.runStart('F1', { worker: 'coder' }); orders.report('F1', { status: 'failed', summary: 'broke', evidence: [], commits: [] }); orders.runEnd('F1');
    add('W1', 'Is running'); orders.act('W1', 'queue'); orders.runStart('W1', { worker: 'coder' });
    add('D1', 'A draft <script>alert(1)</script>');
  }
  const key = newKey();
  const server = startServer({ projects: [config], workers, port: 0, probes, snapshotTtlMs: 0, writeToken: key, signIn });
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A signed-in browser: the sign-in link gives the session cookie; a form post carries this board's Origin, as a browser's does.
  const cookie = ((await fetch(`${base}/login?key=${key}`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0];
  const get = async (p: string, headers: Record<string, string> = {}) => { const r = await fetch(base + '/legacy' + p, { redirect: 'manual', headers: { cookie, ...headers } }); return { status: r.status, location: r.headers.get('location'), text: await r.text() }; };
  const post = async (p: string, body: Record<string, string>, headers: Record<string, string> = {}) => {
    const r = await fetch(base + '/legacy' + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: base, ...headers }, body: new URLSearchParams(body).toString() });
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const tokenOf = async () => /name="token" value="([0-9a-f]+)"/.exec((await get('/')).text)![1];
  return { config, orders, server, base, key, cookie, get, post, tokenOf };
}

test('the board listens on 127.0.0.1 only and refuses other host names', async () => {
  const b = await board();
  assert.equal((b.server.address() as AddressInfo).address, '127.0.0.1');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: (b.server.address() as AddressInfo).port, path: '/', headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});

test('a request path starting with // or a malformed Host header gets 400 and the server stays up', async () => {
  const b = await board(false);
  const port = (b.server.address() as AddressInfo).port;
  const raw = (path: string, host: string) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject); req.end();
  });
  assert.equal(await raw('//%5B/', `127.0.0.1:${port}`), 400);      // what <img src="http://127.0.0.1:port//%5B/"> sends
  assert.equal(await raw('/api/session', 'a b'), 403);
  assert.equal((await b.get('/')).status, 200);
});

test('overview: sections appear only when they have something, and counts equal the lists', async () => {
  const b = await board();
  const { text } = await b.get('/');
  assert.match(text, /Needs you <span class="n">4<\/span>/);
  assert.equal((text.match(/class="card need"/g) ?? []).length, 4);
  assert.match(text, /Running <span class="n">1<\/span>/);
  assert.ok(text.includes('Which tileset &lt;b&gt;first&lt;/b&gt;?'), 'the question is shown, escaped');
  assert.ok(!text.includes('<b>first</b>'));
  assert.ok(!text.includes('Nothing needs you'));
  assert.ok(!text.includes('>Problems '), 'no problems block when nothing is wrong');
  // every card for a waiting order has its action buttons
  assert.equal((text.match(/action="\/legacy\/confirm"/g) ?? []).length, 2 + 3 + 3 + 3);
  // the project page: stage counts equal the length of the list they open
  const project = await b.get('/p/demo');
  const draftCount = Number(/draft (\d+)<\/a>/.exec(project.text)![1]);
  const list = await b.get('/p/demo?stage=draft');
  assert.equal((list.text.match(/<tr><td><a class="tag"/g) ?? []).length, draftCount);
  assert.match(list.text, /draft <span class="n">1<\/span>/);
  assert.ok(list.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('overview: an empty board says nothing needs you and shows no other block', async () => {
  const b = await board(false);
  const { text } = await b.get('/');
  assert.match(text, /Nothing needs you/);
  assert.ok(!text.includes('Needs you <span'));
  assert.ok(!text.includes('>Running <span'));
});

test('order detail: definition, the matching row of the stage table, runs with log tail, reports, timeline', async () => {
  const b = await board();
  b.orders.update('R1', { branch: 'r1-branch' });
  const run = b.orders.get('R1').runs[0];
  b.orders.patchRun('R1', run.id, { log: 'x.log' });
  const { status, text } = await b.get('/o/demo/R1');
  assert.equal(status, 200);
  assert.match(text, /Row 5 of 16: awaiting-review/);
  assert.match(text, /<tr class="on"><td>5<\/td><td>awaiting-review<\/td>/);
  assert.match(text, /Runs <span class="n">1<\/span>/);
  assert.ok(text.includes('line &lt;two&gt;'));
  assert.match(text, /Reports <span class="n">1<\/span>/);
  assert.match(text, /Timeline <span class="n">\d+<\/span>/);
  assert.equal((await b.get('/o/demo/NOPE')).status, 404);
});

test('actions need the form token and a second step, and are logged as the web', async () => {
  const b = await board();
  const token = await b.tokenOf();
  assert.equal((await b.post('/do', { project: 'demo', tag: 'D1', action: 'queue' })).status, 403);               // no token
  const confirm = await b.get('/confirm?project=demo&tag=D1&action=queue');
  assert.match(confirm.text, /Queue D1\?/);
  assert.match(confirm.text, /Confirm: Queue/);
  assert.equal(b.orders.stage(b.orders.get('D1')).stage, 'draft');                                                  // opening the confirm page changed nothing
  const done = await b.post('/do', { token, project: 'demo', tag: 'D1', action: 'queue' });
  assert.equal(done.status, 303);
  assert.equal(done.location, '/legacy/o/demo/D1');
  assert.equal(b.orders.stage(b.orders.get('D1')).stage, 'queued');
  const events = b.orders.store.events({ tag: 'D1' });
  assert.equal(events[events.length - 1].type, 'action-queue');
  assert.equal(events[events.length - 1].by, 'web');
  // rework needs a note; an illegal action is refused with the reason
  assert.equal((await b.post('/do', { token, project: 'demo', tag: 'R1', action: 'rework', note: '' })).status, 400);
  const bad = await b.post('/do', { token, project: 'demo', tag: 'D1', action: 'approve' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /only an order that is awaiting review/);
  const rework = await b.post('/do', { token, project: 'demo', tag: 'R1', action: 'rework', note: 'vary the grass' });
  assert.equal(rework.status, 303);
  assert.equal(b.orders.stage(b.orders.get('R1')).stage, 'queued');
  assert.equal(b.orders.store.events({ tag: 'R1' }).at(-1)?.by, 'web');
  // the tick form: dry run by default
  const dry = await b.post('/tick', { token });
  assert.equal(dry.status, 200);
  assert.match(dry.text, /Tick \(dry run\)/);
});

test('the command line and the board share one service layer', () => {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'g'); mkdirSync(root);
  const config = validateProject({ id: 'demo', name: 'D', root, work_orders: root, state_dir: path.join(dir, 's') }, path.join(dir, 'f.yaml'));
  orders.add({ tag: 'T1', title: 't', kind: 'k' });
  assert.equal(humanAction(config, orders, 'T1', 'queue'), 'queued');
  assert.equal(humanAction(config, orders, 'T1', 'hold'), 'held');
  assert.equal(humanAction(config, orders, 'T1', 'release'), 'queued');
  assert.throws(() => humanAction(config, orders, 'T1', 'rework'), /cannot rework|needs a note/);
  assert.equal(humanAction(config, orders, 'T1', 'cancel'), 'cancelled');
});

test('balance change over the last day', () => {
  const at = (hours: number, amount: number) => ({ source: 's', at: new Date(Date.UTC(2026, 0, 2, 12) - hours * 3600000).toISOString(), ok: true, windows: [], entries: 1, balance: { raw: String(amount), amount } });
  const now = new Date(Date.UTC(2026, 0, 2, 12)).toISOString();
  assert.deepEqual(balanceChange([at(30, 1000), at(20, 990), at(5, 960)], at(0, 950), now), { delta: -40, hours: 20 });
  assert.equal(balanceChange([], at(0, 950), now), undefined);
});

test('a legacy form posted from another origin is refused even with the right token', async () => {
  const b = await board();
  const token = await b.tokenOf();
  const r = await b.post('/do', { token, project: 'demo', tag: 'B1', action: 'queue' }, { origin: 'https://evil.example' });   // a signed-in browser, on another site
  assert.equal(r.status, 403);
  assert.notEqual(b.orders.stage(b.orders.get('B1')).stage, 'queued');
});

// ---------------------------------------------------------------------------------------------------- access (S-2, S-3)

test('the old board needs a signed-in browser: without one it sends the browser to /login, which takes only the key of this board', async () => {
  const b = await board(false, true);
  const anonymous = await fetch(b.base + '/legacy/p/demo?stage=draft', { redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), `/login?next=${encodeURIComponent('/legacy/p/demo?stage=draft')}`);
  const form = await fetch(b.base + '/login');
  const text = await form.text();
  assert.match(text, /<form method="post" action="\/login">/);
  assert.ok(!text.includes(b.key));
  assert.equal((await fetch(`${b.base}/login?key=${newKey()}`, { redirect: 'manual' })).status, 403);
  const link = await fetch(`${b.base}/login?key=${b.key}&next=${encodeURIComponent('/legacy/p/demo')}`, { redirect: 'manual' });
  assert.equal(link.status, 303);
  assert.equal(link.headers.get('location'), '/legacy/p/demo');
  assert.match(link.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
  assert.equal((await b.get('/p/demo')).status, 200);
  // the key also works for a program, without a cookie
  assert.equal((await fetch(b.base + '/legacy/', { headers: { 'x-alba-token': b.key } })).status, 200);
});

test('old board pages hold no key: their forms carry a token derived from it, and a post needs it, the cookie and this Origin', async () => {
  const b = await board(true, true);
  const page = await b.get('/');
  assert.ok(!page.text.includes(b.key), 'the key is not in a page');
  const token = await b.tokenOf();
  assert.equal(token, formToken(b.key));
  assert.notEqual(token, b.key);
  const queue = { token, project: 'demo', tag: 'D1', action: 'queue' };
  assert.equal((await b.post('/do', queue, { origin: '' })).status, 403);                                         // no Origin
  assert.equal((await b.post('/do', queue, { origin: 'http://127.0.0.1:1' })).status, 403);                       // another port
  assert.equal((await b.post('/do', queue, { cookie: '' })).status, 401);                                         // no session
  assert.equal(b.orders.stage(b.orders.get('D1')).stage, 'draft');
  assert.equal((await b.post('/do', queue, { 'sec-fetch-site': 'same-origin' })).status, 303);
  assert.equal(b.orders.stage(b.orders.get('D1')).stage, 'queued');
});

test('a request another site makes is refused before the board reads anything (an <img> sends no Origin)', async () => {
  const b = await board();
  for (const site of ['cross-site', 'same-site']) {
    const r = await b.get('/o/demo/R1', { 'sec-fetch-site': site, 'sec-fetch-dest': 'image' });
    assert.equal(r.status, 403, site);
    assert.ok(!r.text.includes('Waits for review'), site);
    assert.equal((await b.post('/do', { token: await b.tokenOf(), project: 'demo', tag: 'D1', action: 'queue' }, { 'sec-fetch-site': site })).status, 403, site);
  }
  assert.equal(b.orders.stage(b.orders.get('D1')).stage, 'draft');
  assert.equal((await b.get('/o/demo/R1', { 'sec-fetch-site': 'none' })).status, 200);                           // typed into the address bar
  // nothing that changes state answers a GET
  assert.equal((await b.get('/do?project=demo&tag=D1&action=queue')).status, 404);
  assert.equal(b.orders.stage(b.orders.get('D1')).stage, 'draft');
});

test('the key file: in its own folder, readable by this account only, removed by the process that wrote it', () => {
  const env = { ALBA_RUNTIME_DIR: path.join(tempOrders().dir, 'run') };
  const key = newKey();
  const remove = writeKeyFile(4999, key, env);
  assert.equal(keyFile(4999, env), path.join(env.ALBA_RUNTIME_DIR, 'console-4999.json'));
  const record = readKeyFile(4999, env)!;
  assert.deepEqual([record.key, record.port, record.pid], [key, 4999, process.pid]);
  if (process.platform !== 'win32') {
    assert.equal(statSync(keyFile(4999, env)).mode & 0o777, 0o600);
    assert.equal(statSync(env.ALBA_RUNTIME_DIR).mode & 0o777, 0o700);
  }
  assert.equal(readKeyFile(5000, env), undefined);
  remove();
  assert.equal(readKeyFile(4999, env), undefined);
});
