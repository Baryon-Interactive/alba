import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadProject, selectTestBackend } from './state-helper.ts';
import { stateStore } from '../src/orders/backend.ts';
import { claimIdempotency } from '../src/api/idempotency.ts';
import { Orders } from '../src/orders/service.ts';
import { testStore } from './state-helper.ts';
import { startServe, type Serve } from '../src/serve/serve.ts';
import type { Probes } from '../src/tick/gather.ts';
import { loadWorkers } from '../src/workers/config.ts';
import { openStream, tempOrders } from './helpers.ts';

const started: Serve[] = [];
after(() => { for (const s of started) s.stop(); });

const WORKERS = (concurrency: number) => `workers:\n  - id: coder\n    engine: x\n    concurrency: ${concurrency}\n`;

function setup(extraProject = '', workersYaml = WORKERS(1)) {
  const { dir } = tempOrders();
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  mkdirSync(path.join(dir, 'game'), { recursive: true });
  writeFileSync(path.join(dir, 'workers.yaml'), workersYaml);
  writeFileSync(path.join(dir, 'alba.yaml'), `id: demo\nname: Demo\nroot: game\nwork_orders: orders\nstate_dir: state\n${extraProject}`);
  const config = loadProject(path.join(dir, 'alba.yaml'));
  return { dir, config, workersFile: path.join(dir, 'workers.yaml'), projectFile: path.join(dir, 'alba.yaml'), table: path.join(dir, 'plan.md') };
}

function probes(commands: string[] = []): Probes {
  return { now: () => new Date(), isAlive: () => false, tail: () => '', head: () => '', readText: () => undefined, fileTime: () => undefined, runCommand: (c: string[]) => { commands.push(c.join(' ')); return '[{"name":"w","used_percent":10}]'; }, freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: () => 1 } as unknown as Probes;
}

async function run(s: ReturnType<typeof setup>, over: Record<string, unknown> = {}, p: Probes = probes()) {
  const printed: string[] = [];
  const serve = startServe({ projects: [s.config], workers: loadWorkers(s.workersFile), port: 0, probes: p, everyMinutes: 0, maxDispatch: 1, print: l => printed.push(l), watchMs: 100000, eventMs: 20, debounceMs: 80, ...over });
  started.push(serve);
  await new Promise<void>(resolve => serve.server.once('listening', resolve));
  const stream = await openStream(`http://127.0.0.1:${(serve.server.address() as AddressInfo).port}`, 'project=demo', { 'x-alba-token': serve.board.ctx.token });
  assert.equal((await stream.next()).event, 'hello');
  return { serve, stream, printed, base: `http://127.0.0.1:${(serve.server.address() as AddressInfo).port}` };
}

/** The messages of a stream, collected in the background: a read that timed out would swallow the next message. */
const feeds = new WeakMap<object, { items: { event: string; data: any }[]; mark: number }>();
async function collect(stream: Awaited<ReturnType<typeof openStream>>, ms: number): Promise<{ event: string; data: any }[]> {
  let feed = feeds.get(stream);
  if (!feed) {
    const made = { items: [] as { event: string; data: any }[], mark: 0 };
    feed = made;
    feeds.set(stream, made);
    void (async () => { try { for (;;) made.items.push(await stream.next(3_600_000)); } catch { /* closed */ } })();
  }
  await new Promise(r => setTimeout(r, ms));
  const out = feed.items.slice(feed.mark);
  feed.mark = feed.items.length;
  return out;
}

for (const backend of ['files', 'sqlite']) test(`restarting serve preserves the attention baseline and clears abandoned writes (${backend})`, async () => {
  const s = setup(`state: { backend: ${backend} }`);
  let time = new Date('2026-01-01T00:00:00Z');
  const p = { ...probes(), now: () => time };
  const claim = () => claimIdempotency(stateStore(s.config), { key: 'pending', method: 'POST', route: '/demo', bodyHash: 'demo', instanceId: 'old', now: time });
  const merge = (tag: string) => {
    const orders = new Orders(stateStore(s.config), () => time.toISOString());
    orders.add({ tag, title: 'Demo', kind: 'docs' });
    orders.act(tag, 'merged-elsewhere', { commit: 'abc1234' });
  };
  for (let i = 1; i <= 5; i++) merge(`T${i}`);
  assert.equal(claim().outcome, 'claimed');
  for (let start = 0; start < 2; start++) {
    const { serve, base, stream } = await run(s, {}, p);
    try {
      const response = await fetch(base + '/api/orders');
      assert.equal(response.status, 200);
      const { items } = await response.json() as import('../src/api/types.ts').OrderList;
      assert.deepEqual(items.filter(o => o.unread).map(o => o.tag), start ? ['T6'] : []);
      assert.equal(claim().outcome, 'claimed', 'startup removed the prior owner before a retry');
    } finally { stream.close(); await serve.stop(); }
    if (!start) { time = new Date('2026-01-01T00:01:00Z'); merge('T6'); }
  }
});

test('serve: a queue from another process starts a tick within seconds; several triggers become one; the serve\'s own writes trigger nothing', async () => {
  const s = setup();
  const { stream } = await run(s);
  const other = new Orders(testStore(s.config.state_dir), undefined, 'cli');       // another process: the command line
  other.add({ tag: 'T1', title: 'One', kind: 'k' });
  other.add({ tag: 'T2', title: 'Two', kind: 'k' });
  other.act('T1', 'queue');
  other.act('T2', 'queue');
  const seen = await collect(stream, 1500);
  const ticks = seen.filter(m => m.event === 'tick.done');
  assert.equal(ticks.length, 1, seen.map(m => m.event).join(','));
  assert.equal(ticks[0].data.source, 'event');
  // the tick wrote events as "serve" (nothing is dispatchable: no launch template, so at most reports); none of them started another tick
  assert.equal((await collect(stream, 500)).filter(m => m.event === 'tick.done').length, 0);
  // an action that does not make anything dispatchable (a check record, a decision) triggers nothing
  other.record('T1', 'check', { ok: true });
  assert.equal((await collect(stream, 400)).filter(m => m.event === 'tick.done').length, 0);
  // and a later rework from a web board (actor "web") does
  other.runStart('T1', { worker: 'coder' }); other.runEnd('T1'); other.report('T1', { status: 'ready', summary: 'x', evidence: [], commits: [] });
  await collect(stream, 600);
  new Orders(testStore(s.config.state_dir), undefined, 'web').act('T1', 'rework', { note: 'again' });
  assert.equal((await collect(stream, 1200)).filter(m => m.event === 'tick.done').length, 1);
  stream.close();
});

test('serve: a changed dispatch table is imported once it has been quiet, then a tick follows; a broken table is reported and does no harm', async () => {
  const s = setup('dispatch_table:\n  file: plan.md\n  status_column: 1\n  order_column: 2\n  status_map:\n    todo: queued\n    done: merged\n');
  writeFileSync(s.table, '| Status | Order |\n|---|---|\n| todo | AB1 First |\n');
  const { stream, serve } = await run(s);
  appendFileSync(s.table, '| todo | AB2 Second |\n');
  const seen = await collect(stream, 1500);
  const notice = seen.find(m => m.event === 'serve.notice');
  assert.equal(notice?.data.kind, 'table-imported', seen.map(m => m.event).join(','));
  assert.deepEqual(new Orders(testStore(s.config.state_dir)).store.tags().sort(), ['AB1', 'AB2']);
  assert.equal(seen.filter(m => m.event === 'tick.done')[0]?.data.source, 'event');
  // an invalid table: reported, state untouched, no second notice until it changes again
  writeFileSync(s.table, '| Status | Order |\n|---|---|\n| mystery | AB1 First |\n');
  const bad = await collect(stream, 1200);
  assert.equal(bad.find(m => m.event === 'serve.notice')?.data.kind, 'table-import-failed', JSON.stringify(bad.map(m => [m.event, m.data?.kind ?? m.data?.type])));
  assert.equal(new Orders(testStore(s.config.state_dir)).store.tags().length, 2);
  assert.equal(bad.filter(m => m.event === 'serve.notice').length, 1);
  assert.ok(serve.board.ctx.projects.length === 1);
  stream.close();
});

test('serve: a slow quota command is read at most once a minute whatever the number of ticks', async () => {
  const s = setup('', 'workers:\n  - id: coder\n    engine: x\n    quota: q\nquota_sources:\n  q: { type: command-json, command: [quota, --json], windows: "$" }\n'.replace(', windows: "$"', ''));
  const commands: string[] = [];
  const { serve, stream } = await run(s, {}, probes(commands));
  for (let i = 0; i < 4; i++) serve.tickNow('event');
  assert.equal(commands.length, 1, commands.join(' | '));
  stream.close();
});

test('serve: workers.yaml and the project file are reloaded when they change; an invalid file is refused with a problem line and the old one stays', async () => {
  const s = setup();
  const { serve, stream, base } = await run(s);
  const concurrency = () => serve.board.ctx.workers!.workers[0].concurrency;
  assert.equal(concurrency(), 1);
  writeFileSync(s.workersFile, WORKERS(5));
  const reloaded = await collect(stream, 1500);
  assert.ok(reloaded.some(m => m.event === 'serve.notice' && m.data.kind === 'config-reloaded'), reloaded.map(m => m.event).join(','));
  assert.equal(concurrency(), 5);
  // the board's own views follow the reload too (they are built from the workers as they are now)
  assert.equal(((await (await fetch(`${base}/api/workers`, { headers: { 'x-alba-token': serve.board.ctx.token } })).json()) as { workers: { concurrency: number }[] }).workers[0].concurrency, 5);
  assert.ok(reloaded.some(m => m.event === 'tick.done' && m.data.source === 'event'), 'a tick follows, so held-back orders are looked at again');

  // invalid: refused, the old one is kept, the overview says so
  writeFileSync(s.workersFile, 'workers:\n  - id: coder\n    engine: x\n    concurrency: 0\n');
  const refused = await collect(stream, 1500);
  assert.ok(refused.some(m => m.event === 'serve.notice' && m.data.kind === 'config-invalid'));
  assert.equal(concurrency(), 5);
  const overview = await (await fetch(`${base}/api/overview`, { headers: { 'x-alba-token': serve.board.ctx.token } })).json() as { problems: { items: { kind: string; text: string }[] } };
  assert.ok(overview.problems.items.some(p => p.kind === 'config' && /workers\.yaml changed but is not valid; the old one is still in use/.test(p.text)), JSON.stringify(overview.problems));
  // fixed: the problem goes away
  writeFileSync(s.workersFile, WORKERS(2));
  await collect(stream, 1500);
  assert.equal(concurrency(), 2);
  const fixed = await (await fetch(`${base}/api/overview`, { headers: { 'x-alba-token': serve.board.ctx.token } })).json() as { problems: { items: { kind: string }[] } };
  assert.ok(!fixed.problems.items.some(p => p.kind === 'config'));

  // the project file
  assert.equal(serve.board.ctx.projects[0].dispatch.stall_minutes, undefined);
  writeFileSync(s.projectFile, 'id: demo\nname: Demo renamed\nroot: game\nwork_orders: orders\nstate_dir: state\ndispatch:\n  stall_minutes: 30\n');
  selectTestBackend(s.projectFile);
  await collect(stream, 1500);
  assert.equal(serve.board.ctx.projects[0].dispatch.stall_minutes, 30);
  assert.equal(serve.board.ctx.projects[0].name, 'Demo renamed');
  // a changed id or state folder needs a restart: refused
  writeFileSync(s.projectFile, 'id: other\nname: X\nroot: game\nwork_orders: orders\nstate_dir: state\n');
  const idChange = await collect(stream, 1500);
  assert.ok(idChange.some(m => m.event === 'serve.notice' && m.data.kind === 'config-invalid' && /restart/.test(m.data.text)));
  assert.equal(serve.board.ctx.projects[0].id, 'demo');
  stream.close();
});

test('serve: configuration reload can be switched off', async () => {
  const s = setup();
  const { serve, stream } = await run(s, { reloadConfigs: false });
  writeFileSync(s.workersFile, WORKERS(7));
  await collect(stream, 600);
  assert.equal(serve.board.ctx.workers!.workers[0].concurrency, 1);
  stream.close();
});
