import { appendStateFile } from '../src/orders/state-files.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { Orders } from '../src/orders/service.ts';
import type { Probes } from '../src/tick/gather.ts';
import { openStream, tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

import { REPORT, RUN, SUMMARY, WORKER, fixture, shape, type Fixture, type Spec } from './api-fixture.ts';
// ---------------------------------------------------------------------------------------------------- reads

test('api: session, projects, overview (counts equal the lists), orders and workers have the documented shapes', async () => {
  const f = await fixture();
  const session = await f.get('/api/session');
  shape(session.body, { version: 'string', at: 'string', projects: [{ id: 'string', name: 'string', orderCount: 'number', hasWorkers: 'boolean', workOrdersDir: 'string', tableWriteBack: 'boolean', checks: 'boolean', stages: 'object' }] });
  assert.equal(session.body.projects[0].orderCount, 4);
  assert.ok(!('token' in session.body) && !JSON.stringify(session.body).includes(f.token), 'the session hands out no key');
  assert.deepEqual((await f.get('/api/projects')).body, session.body.projects);

  const o = (await f.get('/api/overview?project=demo')).body;   // one project: "project" may be left out
  shape(o, { project: 'string', name: 'string', at: 'string', needsYou: { count: 'number', items: [SUMMARY] }, problems: { count: 'number', items: 'array' }, running: { count: 'number', items: [SUMMARY] }, workers: { count: 'number', items: [WORKER] }, stages: 'object', next: { moves: 'array', heldBack: 'array' } });
  for (const block of ['needsYou', 'problems', 'running', 'workers'] as const) assert.equal(o[block].count, o[block].items.length, block);
  assert.deepEqual(o.needsYou.items.map((i: { tag: string }) => i.tag), ['Q1', 'R1']);       // awaiting-user before awaiting-review
  assert.equal(o.needsYou.items[0].report.question, 'Which tileset first?');
  assert.deepEqual(o.needsYou.items[0].actions, ['hold', 'cancel', 'rework', 'answer']);
  assert.deepEqual(o.running.items.map((i: { tag: string }) => i.tag), ['W1']);
  assert.deepEqual((await f.get('/api/overview')).body.stages, o.stages);

  const list = (await f.get('/api/orders?stage=draft')).body;
  shape(list, { project: 'string', stage: 'string', count: 'number', items: [SUMMARY] });
  assert.equal(list.count, 1);
  assert.equal((await f.get('/api/orders')).body.count, 4);
  assert.equal((await f.get('/api/orders?stage=nonsense')).status, 400);

  const w = (await f.get('/api/workers')).body;
  shape(w, { workers: [WORKER], sources: 'array' });
  assert.deepEqual(w.workers.map((x: { id: string; canResume: boolean }) => [x.id, x.canResume]), [['coder', true], ['editor', false]]);
  shape((await f.get('/api/quota/history?worker=coder')).body, { worker: 'string', points: 'array' });
  assert.equal((await f.get('/api/quota/history?worker=nobody')).status, 404);
});

test('api: an order in detail, the diff of its branch, and the tail of a run log', async () => {
  const f = await fixture();
  const d = (await f.get('/api/orders/R1')).body;
  shape(d, {
    project: 'string', order: { tag: 'string', title: 'string', kind: 'string', needs: 'array', created: 'string', updated: 'string' }, stage: 'string', why: 'string', needsStatus: 'array', actions: 'array', unavailable: 'object',
    runs: [RUN], reports: [REPORT], decisions: 'array', events: 'array', eventsTotal: 'number', 'file?': { path: 'string', markdown: 'string', truncated: 'boolean' },
  });
  assert.equal(d.stage, 'awaiting-review');
  assert.equal(d.runs[0].key, 'R1:r1');
  assert.equal(d.runs[0].hasLog, true);
  assert.equal(d.runs[0].usage.source, 'unknown');                     // nothing is guessed
  assert.match(d.file.markdown, /Review me/);
  assert.ok(d.actions.includes('approve') && !d.actions.includes('run'));
  assert.match(d.unavailable.release, /cannot release/);
  assert.ok(d.events.every((e: { id: number }, i: number, all: { id: number }[]) => i === 0 || e.id > all[i - 1].id));
  assert.equal((await f.get('/api/orders/NOPE')).status, 404);

  const diff = (await f.get('/api/orders/R1/diff')).body;
  shape(diff, { project: 'string', tag: 'string', base: 'string', head: 'string', worktree: 'string', commits: [{ hash: 'string', subject: 'string', at: 'string' }], stat: { files: 'number', insertions: 'number', deletions: 'number' }, files: [{ path: 'string', status: 'string', insertions: 'number', deletions: 'number', binary: 'boolean', truncated: 'boolean' }], truncated: 'boolean' });
  assert.equal(diff.base, 'main');
  assert.deepEqual(diff.commits.map((c: { subject: string }) => c.subject), ['R1: work']);
  const byPath = Object.fromEntries(diff.files.map((x: { path: string }) => [x.path, x]));
  assert.deepEqual([byPath['a.txt'].status, byPath['a.txt'].insertions, byPath['a.txt'].deletions], ['modified', 1, 0]);
  assert.match(byPath['a.txt'].patch, /\+b/);
  assert.equal(byPath['new.bin'].binary, true);
  assert.equal(byPath['new.bin'].patch, undefined);
  assert.equal(byPath['big.txt'].truncated, true);                      // over 200 KB: cut, and it says so
  assert.ok(byPath['big.txt'].patch.length <= 200_000 && /cut at 200 KB/.test(byPath['big.txt'].note));
  assert.equal(diff.truncated, true);
  assert.equal(diff.stat.files, 3);
  assert.equal((await f.get('/api/orders/D1/diff')).status, 404);       // no worktree

  const log = (await f.get('/api/runs/R1:r1/log?tail=2')).body;
  shape(log, { project: 'string', key: 'string', lines: 'array', offset: 'number', size: 'number', cut: 'boolean' });
  assert.deepEqual([log.lines, log.cut, log.offset], [['line 2', 'line 3'], true, 21]);
  assert.deepEqual((await f.get('/api/runs/R1:r1/log')).body.lines, ['line 1', 'line 2', 'line 3']);
  assert.equal((await f.get('/api/runs/W1:r1/log')).status, 404);
  assert.equal((await f.get('/api/runs/nonsense/log')).status, 404);
});

test('api: several projects need "project"; errors have one shape', async () => {
  const f = await fixture({ second: true });
  const missing = await f.get('/api/overview');
  assert.equal(missing.status, 400);
  shape(missing.body, { error: { code: 'string', message: 'string' } });
  assert.equal(missing.body.error.code, 'bad_request');
  assert.equal((await f.get('/api/overview?project=nope')).status, 404);
  assert.equal((await f.get('/api/overview?project=other')).body.needsYou.count, 0);
  assert.equal((await f.get('/api/nothing')).body.error.code, 'not_found');
});

// ---------------------------------------------------------------------------------------------------- the token, the origin and the host

test('api: without --sign-in this machine needs no key, and other sites are still refused', async () => {
  const f = await fixture({ signIn: false });
  const body = { action: 'queue' };
  assert.equal((await f.get('/api/overview', { 'x-alba-token': '' })).status, 200);                                  // a read without key
  // a page of another site: refused before anything runs, reads and writes alike
  assert.equal((await f.get('/api/overview', { 'x-alba-token': '', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.post('/api/orders/D1/actions', body, { 'x-alba-token': '', origin: 'http://evil.example' })).status, 403);
  // a browser's write must carry this server's Origin
  assert.equal((await f.post('/api/orders/D1/actions', body, { 'x-alba-token': '', 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal(f.orders.stage(f.orders.get('D1')).stage, 'draft');                                                    // nothing changed
  const browser = await f.post('/api/orders/D1/actions', body, { 'x-alba-token': '', 'sec-fetch-site': 'same-origin', origin: f.base });
  assert.deepEqual([browser.status, browser.body.stage], [200, 'queued']);
  // a program on this machine (no Origin, no Sec-Fetch-Site) writes without the key, as before the key existed
  assert.equal((await f.post('/api/orders/D1/actions', { action: 'hold' }, { 'x-alba-token': '' })).status, 200);
  // an old sign-in link lands on the page instead of a sign-in form
  const link = await fetch(`${f.base}/login?key=old&next=/orders`, { redirect: 'manual' });
  assert.deepEqual([link.status, link.headers.get('location')], [303, '/orders']);
});

test('api: every call needs the key; an origin of another site and another host name are refused', async () => {
  const f = await fixture({ signIn: true });
  const body = { action: 'queue' };
  const before = f.orders.stage(f.orders.get('D1')).stage;
  assert.equal(before, 'draft');
  const anonymous = await f.post('/api/orders/D1/actions', body, { 'x-alba-token': '' });                             // no key
  assert.deepEqual([anonymous.status, anonymous.body.error.code], [401, 'unauthorized']);
  assert.equal((await f.post('/api/orders/D1/actions', body, { 'x-alba-token': 'wrong' })).status, 401);
  assert.equal((await f.get('/api/session', { 'x-alba-token': '' })).status, 401);                                    // reads too
  assert.equal((await f.get('/api/overview', { 'x-alba-token': f.token.toUpperCase() })).status, 401);
  assert.equal((await f.post('/api/orders/D1/actions', body, { 'x-alba-token': f.token, origin: 'http://evil.example' })).status, 403);   // right token, wrong site
  assert.equal((await f.get('/api/overview', { origin: 'http://evil.example' })).status, 403);                         // reads too
  assert.equal(f.orders.stage(f.orders.get('D1')).stage, 'draft');                                                    // nothing changed
  const ok = await f.post('/api/orders/D1/actions', body, { 'x-alba-token': f.token, origin: f.base });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stage, 'queued');
  assert.equal(f.orders.get('D1').order.updated !== undefined && f.orders.store.events({ tag: 'D1' }).at(-1)?.by, 'web');     // logged as the web
  // an origin named at start (a front end's dev server) is allowed
  const dev = await fixture({ extraOrigins: ['http://localhost:5173'] });
  assert.equal((await dev.post('/api/orders/D1/actions', body, { 'x-alba-token': dev.token, origin: 'http://localhost:5173' })).status, 200);
  // another host name: refused with the error shape
  const status = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: (f.board.server.address() as AddressInfo).port, path: '/api/overview', headers: { host: 'evil.example' } }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t })); });
    req.on('error', reject); req.end();
  });
  assert.equal(status.status, 403);
  assert.equal(JSON.parse(status.text).error.code, 'forbidden');
  assert.equal((f.board.server.address() as AddressInfo).address, '127.0.0.1');
});

test('api: a browser trades the key at /login for an HttpOnly SameSite=Strict session; its writes need an Origin of this server', async () => {
  const f = await fixture({ signIn: true });
  const port = (f.board.server.address() as AddressInfo).port;
  const bad = await fetch(`${f.base}/login?key=wrong`, { redirect: 'manual' });
  assert.deepEqual([bad.status, bad.headers.get('set-cookie')], [403, null]);
  const login = await fetch(`${f.base}/login?key=${f.token}&next=${encodeURIComponent('/orders/R1')}`, { redirect: 'manual' });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/orders/R1');
  const set = login.headers.get('set-cookie') ?? '';
  assert.match(set, new RegExp(`^alba_session_${port}=[A-Za-z0-9_-]{40,}; Path=/; HttpOnly; SameSite=Strict$`));
  assert.ok(!set.includes(f.token), 'the cookie is not the key');
  const cookie = set.split(';')[0];
  const browser = { 'x-alba-token': '', cookie };
  // reads with the cookie alone; the session answer still has no key
  const session = await f.get('/api/session', browser);
  assert.equal(session.status, 200);
  assert.ok(!JSON.stringify(session.body).includes(f.token));
  // writes: the cookie and an Origin of this server; without an Origin, or from another site, nothing happens
  assert.equal((await f.post('/api/orders/D1/actions', { action: 'queue' }, browser)).status, 403);
  assert.equal((await f.post('/api/orders/D1/actions', { action: 'queue' }, { ...browser, origin: 'http://127.0.0.1:1' })).status, 403);
  assert.equal(f.orders.stage(f.orders.get('D1')).stage, 'draft');
  const ok = await f.post('/api/orders/D1/actions', { action: 'queue' }, { ...browser, origin: f.base, 'sec-fetch-site': 'same-origin' });
  assert.deepEqual([ok.status, ok.body.stage], [200, 'queued']);
  // a cookie this board did not give, or a session that signed out, is no proof
  assert.equal((await f.get('/api/session', { 'x-alba-token': '', cookie: `alba_session_${port}=forged` })).status, 401);
  assert.equal((await fetch(`${f.base}/logout`)).status, 405);                                                     // signing out is a POST
  const out = await fetch(`${f.base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: f.base } });
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal((await f.get('/api/session', browser)).status, 401);
  // after signing in, only a path of this server is a place to go on to
  for (const next of ['//evil.example/x', 'http://evil.example/', '/\\evil.example']) {
    const r = await fetch(`${f.base}/login?key=${f.token}&next=${encodeURIComponent(next)}`, { redirect: 'manual' });
    assert.equal(r.headers.get('location'), '/', next);
  }
  // the sign-in form: the key in a POST, from this origin
  const form = await fetch(`${f.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: f.base }, body: new URLSearchParams({ key: f.token, next: '/x' }).toString() });
  assert.deepEqual([form.status, form.headers.get('location')], [303, '/x']);
  const page = await fetch(`${f.base}/login`);
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes(f.token));
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
});

test('api: a request another site makes is refused before it is read, a GET without Origin too (Sec-Fetch-Site)', async () => {
  const f = await fixture();
  const login = await fetch(`${f.base}/login?key=${f.token}`, { redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  for (const site of ['cross-site', 'same-site']) {
    // what <img src="http://127.0.0.1:port/api/..."> on another site (or on another port of this machine) sends: no Origin
    const read = await f.get('/api/orders?project=demo', { 'x-alba-token': '', cookie, 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors' });
    assert.deepEqual([read.status, read.body.error.code], [403, 'forbidden'], site);
    assert.equal((await f.get('/api/session', { 'sec-fetch-site': site })).status, 403, `${site}: the key does not help a page of another site`);
    const signIn = await fetch(`${f.base}/login?key=${f.token}`, { redirect: 'manual', headers: { 'sec-fetch-site': site } });
    assert.deepEqual([signIn.status, signIn.headers.get('set-cookie')], [403, null], `${site}: no sign-in from another site`);
  }
  for (const site of ['same-origin', 'none']) assert.equal((await f.get('/api/session', { 'x-alba-token': '', cookie, 'sec-fetch-site': site })).status, 200, site);
  // a dev server's origin named with --allow-origin may call across sites (it proxies, or it is the front end under development)
  const dev = await fixture({ extraOrigins: ['http://localhost:5173'] });
  assert.equal((await dev.get('/api/session', { origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' })).status, 200);
  assert.equal((await dev.get('/api/session', { origin: 'http://localhost:5174', 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('api: project pictures are served under a sandbox policy', async () => {
  const f = await fixture();
  const image = path.join(f.root, 'shot.png');
  writeFileSync(image, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0d10000000049454e44ae426082', 'hex'));
  const r = await fetch(`${f.base}/api/files?project=demo&path=shot.png`, { headers: { 'x-alba-token': f.token } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'.*sandbox/);
});

// ---------------------------------------------------------------------------------------------------- writes

test('api: actions go through the service layer: not allowed is 409, a missing field is 400, answer and run start workers', async () => {
  const f = await fixture();
  assert.equal((await f.write('/api/orders/D1/actions', { action: 'approve' })).status, 409);
  assert.equal((await f.write('/api/orders/D1/actions', { action: 'dance' })).status, 400);
  assert.equal((await f.write('/api/orders/R1/actions', { action: 'rework' })).status, 400);                    // a note is needed
  assert.equal((await f.write('/api/orders/NOPE/actions', { action: 'queue' })).status, 404);
  assert.equal((await f.post('/api/orders/D1/actions', 'not json', { 'x-alba-token': f.token })).status, 400);
  const rework = await f.write('/api/orders/R1/actions', { action: 'rework', note: 'vary the grass' });
  assert.deepEqual([rework.status, rework.body.stage], [200, 'queued']);

  // answer: the worker (coder has session arguments) continues its session s-1
  const answered = await f.write('/api/orders/Q1/actions', { action: 'answer', text: 'the dark one' });
  assert.equal(answered.status, 200);
  assert.deepEqual([answered.body.stage, answered.body.run.resumed, answered.body.run.worker, answered.body.run.key], ['running', true, 'coder', 'Q1:r2']);
  assert.deepEqual(f.spawned[0].args.slice(0, 3), ['run', '-r', 's-1']);
  assert.equal((await f.write('/api/orders/Q1/actions', { action: 'answer', text: 'again' })).status, 409);       // it is running now
  assert.equal((await f.write('/api/orders/D1/actions', { action: 'answer', text: 'x' })).status, 409);

  // run: a queued order is started now
  writeFileSync(path.join(f.root, 'orders', 'D1-draft.md'), '# D1\n');
  await f.write('/api/orders/D1/actions', { action: 'queue' });
  assert.equal((await f.write('/api/orders/D1/actions', { action: 'run' })).status, 400);                         // which worker?
  const run = await f.write('/api/orders/D1/actions', { action: 'run', worker: 'coder' });
  assert.equal(run.status, 200);
  assert.deepEqual([run.body.stage, run.body.run.worker, run.body.run.pid], ['running', 'coder', 4242]);
});

test('api: a new order with a work-order file; an existing file or tag is 409 and changes nothing', async () => {
  const f = await fixture();
  const made = await f.write('/api/orders', { tag: 'N1', title: 'A new order', kind: 'ui', needs: ['R1'], body: '# N1\nDo the thing.', queue: true });
  assert.equal(made.status, 201);
  shape(made.body, { order: SUMMARY, file: 'string', tableRow: 'boolean' });
  assert.equal(made.body.order.stage, 'waiting-needs');
  assert.equal(made.body.tableRow, false);
  const file = path.join(f.root, 'orders', 'N1-a-new-order.md');
  assert.equal(made.body.file.replace(/\\/g, '/'), file.replace(/\\/g, '/'));
  assert.equal(readFileSync(file, 'utf8'), '# N1\nDo the thing.\n');
  const again = await f.write('/api/orders', { tag: 'N2', title: 'Other', body: 'new text', slug: 'a-new-order' });   // different tag: its own file name
  assert.equal(again.status, 201);
  const clash = await f.write('/api/orders', { tag: 'N1', title: 'Again', body: 'replace it' });
  assert.equal(clash.status, 409);
  assert.equal(readFileSync(file, 'utf8'), '# N1\nDo the thing.\n');                                                // never replaced
  assert.equal((await f.write('/api/orders', { tag: 'N3' })).status, 400);                                         // no title
  assert.equal((await f.write('/api/orders', { tag: 'N3', title: 'x', needs: 'R1' })).status, 400);
  assert.equal(f.orders.resolveTag('N3'), undefined);
});

test('api: a dry tick records nothing; a check runs on the worktree and is recorded on the order', async () => {
  const f = await fixture();
  const events = f.orders.store.events().length;
  const t = await f.write('/api/tick', {});
  assert.equal(t.status, 200);
  shape(t.body, { project: 'string', at: 'string', real: 'boolean', exitCode: 'number', needsUser: 'array', problems: 'array', moves: 'array', heldBack: 'array', unavailable: 'array', waiting: 'array', finishes: 'array', done: 'array', text: 'string' });
  assert.equal(t.body.real, false);
  assert.equal(f.orders.store.events().length, events);

  const c = await f.write('/api/check/R1', {});
  assert.equal(c.status, 200);
  shape(c.body, { tag: 'string', at: 'string', ok: 'boolean', base: 'string', worktree: 'string', general: [{ name: 'string', ok: 'boolean', detail: 'string' }] });
  assert.equal(c.body.ok, true);
  assert.equal(f.orders.store.events({ tag: 'R1' }).at(-1)?.type, 'check');
  assert.equal((await f.get('/api/orders/R1')).body.lastCheck.ok, true);
  assert.equal((await f.write('/api/check/R1', { results: ['../../outside.txt'] })).status, 400);                  // not outside the project's folders
});

// ---------------------------------------------------------------------------------------------------- the stream

const stream = (f: Fixture, query: string, headers: Record<string, string> = {}) => openStream(f.base, query, { 'x-alba-token': f.token, ...headers });

test('stream: new events arrive under their names, a reconnect with Last-Event-ID replays what was missed, an unknown id says resync', async () => {
  const f = await fixture();
  const a = await stream(f, 'project=demo');
  const hello = await a.next();
  assert.equal(hello.event, 'hello');
  assert.deepEqual([hello.data.project, hello.data.replayed], ['demo', 0]);
  const boot = hello.data.boot as string;

  f.orders.act('D1', 'queue');
  f.board.hub.scan();
  const first = await a.next();
  assert.equal(first.event, 'order.action');
  assert.equal(first.data.tag, 'D1');
  assert.equal(first.data.type, 'action-queue');
  assert.equal(first.data.project, 'demo');
  assert.match(first.id!, new RegExp(`^${boot}\\.\\d+$`));
  assert.equal(first.data.id, f.orders.store.events().length);          // the event's position in the log
  a.close();

  // two things happen while nobody is connected: a run starts, a quota reading is written
  f.orders.runStart('D1', { worker: 'coder' });
  appendStateFile(f.board.ctx.projects[0], 'quota-history.jsonl', JSON.stringify({ source: 'gw', at: '2026-01-01T00:00:00Z', ok: true, windows: [{ name: '5 hours', usedPercent: 12 }], entries: 1 }) + '\n');
  f.board.hub.scan();

  const b = await stream(f, 'project=demo', { 'last-event-id': first.id! });
  const hello2 = await b.next();
  assert.equal(hello2.data.replayed, 2);
  const names: string[] = [];
  for (let i = 0; i < hello2.data.replayed; i++) names.push((await b.next()).event);
  assert.deepEqual(names.sort(), ['quota', 'run.start']);
  b.close();

  // an id from another process, or from the future, cannot be replayed: the client reads the lists again
  const c = await stream(f, 'project=demo', { 'last-event-id': 'ffffffff.5' });
  assert.equal((await c.next()).event, 'hello');
  assert.equal((await c.next()).event, 'resync');
  c.close();
  const d = await stream(f, 'project=demo', { 'last-event-id': `${boot}.99999` });
  await d.next();
  assert.equal((await d.next()).data.reason, 'unknown event id');
  d.close();
});

test('stream: new lines of a subscribed run log are pushed, from the offset the log call gave', async () => {
  const f = await fixture();
  const log = f.orders.get('R1').runs[0].log!;
  const offset = (await f.get('/api/runs/R1:r1/log')).body.offset as number;
  const s = await stream(f, `project=demo&logs=R1:r1@${offset},W1:r1,nonsense`);
  await s.next();
  appendFileSync(log, 'line 4\nline 5\npart');
  f.board.hub.scan();
  const m = await s.next();
  assert.equal(m.event, 'run.log');
  assert.deepEqual([m.data.key, m.data.lines], ['R1:r1', ['line 4', 'line 5']]);       // the unfinished line waits
  appendFileSync(log, 'ial\n');
  f.board.hub.scan();
  assert.deepEqual((await s.next()).data.lines, ['partial']);
  s.close();
});

test('stream: the file watchers and the safety check find changes without a manual scan', async () => {
  const f = await fixture();
  const s = await stream(f, 'project=demo');
  await s.next();
  f.orders.act('D1', 'queue');
  const m = await s.next(5000);
  assert.equal(m.event, 'order.action');
});

// ---------------------------------------------------------------------------------------------------- hosting

test('hosting: ui/dist is served when it exists (with the token in the page), the old board is at /legacy, and nothing outside the folder is served', async () => {
  const none = await fixture();
  const hint = await fetch(none.base + '/');
  assert.match(await hint.text(), /not built here.*\/legacy/);
  assert.equal((await fetch(none.base + '/legacy/')).status, 200);
  assert.equal((await fetch(none.base + '/anything/at/all')).status, 404);

  const { dir } = tempOrders();
  const ui = path.join(dir, 'ui');
  mkdirSync(path.join(ui, 'assets'), { recursive: true });
  const inline = "\n      document.documentElement.dataset.boot = '1';\n    ";
  writeFileSync(path.join(ui, 'index.html'), `<!doctype html><html><head><title>c</title><script>${inline}</script></head><body>console<script type="module" src="/assets/app.js"></script></body></html>`);
  writeFileSync(path.join(ui, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'secret.txt'), 'secret');
  const f = await fixture({ uiDir: ui });
  const page = await fetch(f.base + '/');
  const index = await page.text();
  assert.ok(!index.includes(f.token) && !index.includes('alba-token'), 'the page holds no key');
  // S-7: a Content-Security-Policy that allows this server's scripts and the page's own inline script, by its hash, and nothing else
  const csp = page.headers.get('content-security-policy') ?? '';
  const hash = createHash('sha256').update(inline, 'utf8').digest('base64');
  assert.ok(csp.split('; ').includes(`script-src 'self' 'sha256-${hash}'`), csp);
  for (const rule of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "connect-src 'self'"]) assert.ok(csp.includes(rule), rule);
  assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline|\*/.test(csp), csp);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.ok((await (await fetch(f.base + '/orders/R1')).text()).includes('console'));                 // the page routes by itself
  const js = await fetch(f.base + '/assets/app.js');
  assert.deepEqual([js.status, js.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
  assert.equal((await fetch(f.base + '/assets/missing.js')).status, 404);
  for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%5c..%5csecret.txt', '/%zz']) {
    const r = await fetch(f.base + p);
    assert.ok(r.status === 404 || r.status === 200 && !(await r.clone().text()).includes('secret'), p);
  }
  assert.ok(existsSync(ui));
});
