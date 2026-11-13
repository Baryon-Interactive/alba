import { zh as translated } from '../src/i18n-zh.ts';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { unreachableStatusLines } from '../src/cli/live.ts';
import { t, withLang } from '../src/i18n.ts';
import type { Run } from '../src/orders/model.ts';
import { classifyCause } from '../src/producer/facts/engine.ts';
import { classifyEndpoint, endingCaseText, endpointOf, probeEndpoint } from '../src/run/endpoint.ts';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { startRun, trailingTransientFailures } from '../src/run/launch.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { executeTick } from '../src/tick/execute.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture() {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-do-something.md'), '# T1\nDo something.\n');
  writeFileSync(path.join(workOrders, 'T2-do-something.md'), '# T2\nDo something else.\n');
  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
  }, path.join(dir, 'factory.yaml'));
  orders.add({ tag: 'T1', title: 'Do something', kind: 'sim' });
  orders.act('T1', 'queue');
  return { orders, project };
}

function probes(over: Partial<Probes> = {}): Probes & { spawned: { program: string; args: string[] }[] } {
  const spawned: { program: string; args: string[] }[] = [];
  return {
    spawned, now: () => new Date('2026-01-01T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined,
    spawnDetached(program, args) { spawned.push({ program, args }); return 4242; },
    ...over,
  };
}

const worker = (env: Record<string, string> = {}, extra: Record<string, unknown> = {}) => validateWorkers({
  workers: [{ id: 'coder', engine: 'claude-cli', on_limit: 'rotate', ...extra, launch: { program: process.execPath, args: ['-e', 'process.exit(0)'], env: { ANTHROPIC_AUTH_TOKEN: 'test', ...env } } }],
}, 'w.yaml');

const retry = (status: number | null) => JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: status, error: status === null ? 'unknown' : 'overloaded' });

function deadGateway(): string {
  const retries = Array.from({ length: 10 }, () => retry(null));
  const assistant = JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'no model output' }], usage: { input_tokens: 0, output_tokens: 0 } } });
  return [...retries, assistant].join('\n');
}

function overloaded(): string {
  const retries = Array.from({ length: 10 }, () => retry(529));
  const result = JSON.stringify({ type: 'result', is_error: true, usage: { input_tokens: 0, output_tokens: 0 } });
  return [...retries, result].join('\n');
}

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('no port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}

function listening(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.end());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('no port')); return; }
      resolve({ port: address.port, close: () => new Promise(done => server.close(() => done())) });
    });
  });
}

test('a status-less Claude retry stream is unreachable, and HTTP 529 stays capacity', () => {
  const base = 'http://sk-test-token@127.0.0.1:9/v1?access_token=secret';
  const { orders, project } = fixture();
  const workers = worker({ ANTHROPIC_BASE_URL: base });
  const ctx = { project, orders, workers, probes: probes() };
  startRun(ctx, 'T1', 'coder');
  const unreachable = findFinishes(project, orders, probes({ tail: () => deadGateway() }), workers)[0];
  assert.equal(unreachable.outcome, 'capacity');
  assert.equal(unreachable.limit, 'unreachable');
  assert.equal(unreachable.why, 'endpoint 127.0.0.1:9 is unreachable');
  assert.equal(unreachable.why.includes('sk-test-token'), false);
  assert.equal(unreachable.why.includes('secret'), false);
  assert.equal(unreachable.why.includes(process.execPath), false);
  applyFinish(orders, unreachable);
  startRun(ctx, 'T1', 'coder');
  const full = findFinishes(project, orders, probes({ tail: () => overloaded() }), workers)[0];
  assert.equal(full.outcome, 'capacity');
  assert.equal(full.limit, 'capacity');
});

test('connection errors name the configured endpoint, and a log with no base URL stays capacity', () => {
  const { orders, project } = fixture();
  const named = worker({ OPENAI_BASE_URL: 'http://127.0.0.1:9' });
  const plain = worker();
  const ctx = { project, orders, workers: named, probes: probes() };
  startRun(ctx, 'T1', 'coder');
  const refused = findFinishes(project, orders, probes({ tail: () => 'fetch failed http://127.0.0.1:9/v1\n' }), named)[0];
  assert.equal(refused.limit, 'unreachable');
  assert.equal(refused.why, 'endpoint 127.0.0.1:9 is unreachable');
  applyFinish(orders, refused);
  startRun({ ...ctx, workers: plain }, 'T1', 'coder');
  const ordinary = findFinishes(project, orders, probes({ tail: () => 'connection refused\n' }), plain)[0];
  assert.equal(ordinary.outcome, 'capacity');
  assert.equal(ordinary.limit, 'capacity');
  applyFinish(orders, ordinary);
  startRun(ctx, 'T1', 'coder');
  const elsewhere = findFinishes(project, orders, probes({ tail: () => 'fetch failed http://localhost:9/v1\n' }), named)[0];
  assert.notEqual(elsewhere.limit, 'unreachable');
  const statusless = findFinishes(project, orders, probes({ tail: () => deadGateway() }), plain)[0];
  assert.equal(statusless.limit, 'capacity');
  for (const text of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:9', 'connect ECONNREFUSED 127.0.0.1:5432', 'fetch failed http://127.0.0.1:5432/v1']) {
    assert.notEqual(classifyEndpoint({ events: '', log: text, cut: false, worker: named.workers[0] }).kind, 'unreachable');
  }
});

test('config overrides expose only host and port; real output or usage prevents status-less inference', () => {
  const configured = worker().workers[0];
  configured.launch!.args.push('-c', 'model_providers.local.base_url="http://token@localhost:12345/v1?key=secret"');
  assert.deepEqual(endpointOf(configured), { host: 'localhost', port: 12345, label: 'localhost:12345' });
  const input = { events: deadGateway(), log: '', cut: false, worker: configured };
  assert.equal(classifyEndpoint(input).kind, 'unreachable');
  assert.equal(classifyEndpoint({ ...input, usageTotal: 1 }).kind, 'none');
  assert.equal(classifyEndpoint({ ...input, cut: true }).kind, 'none');
  const real = JSON.stringify({ type: 'assistant', message: { model: 'model', content: [{ type: 'text', text: 'Done' }] } });
  assert.equal(classifyEndpoint({ ...input, events: `${input.events}\n${real}` }).kind, 'none');
});

test('probe-held waits are free, but resumed status-less failures reach max resumes and back off', async () => {
  const run = (seq: number, outcome: Run['outcome'], limit?: Run['limit']): Run => ({ id: `r${seq}`, seq, worker: 'a', started: 't', ended: 't', outcome, ...(limit ? { limit } : {}) });
  assert.equal(trailingTransientFailures([run(1, 'capacity', 'capacity'), run(2, 'capacity', 'unreachable'), run(3, 'capacity', 'capacity')], 'a'), 3);
  const { orders, project } = fixture();
  const workers = worker({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, { max_resumes: 3, on_limit: 'wait' });
  let clock = Date.parse('2026-01-01T12:00:00Z');
  let up = false;
  const seen = probes({ now: () => new Date(clock), probePort: async () => up });
  const ctx = { project, orders, workers, probes: seen };
  startRun(ctx, 'T1', 'coder');
  for (let i = 0; i < 4; i++) {
    const finish = findFinishes(project, orders, probes({ tail: () => deadGateway() }), workers)[0];
    assert.equal(finish.limit, i === 3 ? undefined : 'unreachable');
    applyFinish(orders, finish);
    orders.patchRun('T1', orders.get('T1').runs.at(-1)!.id, { ended: new Date(clock).toISOString() });
    if (i < 3) {
      const blocked = tick(project, orders, workers, seen, { record: false });
      assert.equal(blocked.report.moves.length, 0);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(orders.get('T1').runs.length, i + 1);
      if (i === 0) {
        assert.equal(tick(project, orders, workers, seen, { record: false }).report.moves.length, 0);
        assert.equal(orders.get('T1').runs.length, 1);
      }
      up = true;
      clock += 6000;
      tick(project, orders, workers, seen, { record: false });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(tick(project, orders, workers, seen, { record: false }).report.moves.length, 0, 'probe passed, but transient backoff still applies');
      clock += 20 * 60_000;
      executeTick(ctx, { maxDispatch: 1 });
      assert.equal(orders.get('T1').runs.length, i + 2);
      assert.equal(orders.get('T1').runs.at(-1)?.attempt, i + 2);
      up = false;
      clock += 6000;
      tick(project, orders, workers, seen, { record: false });
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  const doc = orders.get('T1');
  assert.equal(orders.stage(doc).stage, 'failed');
  assert.equal(doc.runs.filter(r => r.limit === 'unreachable').length, 3);
  assert.equal(doc.runs.at(-1)?.outcome, 'failed');
});

test('a dead endpoint holds every order and raises one problem; a listening one starts', async () => {
  const down = await closedPort();
  const { orders, project } = fixture();
  const workers = worker({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${down}` });
  orders.runStart('T1', { worker: 'coder', session: 'sess-1' });
  orders.runEnd('T1', 'capacity');
  orders.patchRun('T1', 'r1', { limit: 'unreachable' });
  orders.add({ tag: 'T2', title: 'Other', kind: 'sim' });
  orders.act('T2', 'queue');
  const held = tick(project, orders, workers, probes(), { record: false });
  assert.deepEqual(held.report.problems.map(p => p.text), [`coder: endpoint unreachable`]);
  assert.deepEqual(held.report.heldBack.map(h => h.tag).sort(), ['T1', 'T2']);
  assert.equal(held.report.heldBack.every(h => h.why === `endpoint 127.0.0.1:${down} is down`), true);
  assert.equal(held.report.moves.length, 0);
  assert.equal(held.workers[0].available, false);
  assert.equal(held.workers[0].reasons.includes('endpoint unreachable'), true);
  assert.match(unreachableStatusLines([{ project, orders }]).join('\n'), /endpoint unreachable/);
  assert.equal(orders.get('T1').runs.length, 1);

  const up = await listening();
  try {
    const again = fixture();
    const liveWorkers = validateWorkers({
      workers: [
        { id: 'coder', engine: 'claude-cli', on_limit: 'rotate', launch: { program: process.execPath, args: ['-e', 'process.exit(0)'], env: { ANTHROPIC_AUTH_TOKEN: 'test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${up.port}` } } },
        { id: 'other', engine: 'claude-cli', launch: { program: process.execPath, args: ['-e', 'process.exit(0)'], env: {} } },
      ],
    }, 'w.yaml');
    again.orders.runStart('T1', { worker: 'coder', session: 'sess-1' });
    again.orders.runEnd('T1', 'capacity');
    again.orders.patchRun('T1', 'r1', { limit: 'unreachable' });
    let checked: Promise<boolean> | undefined;
    const seen = probes({ probePort: (host, port, timeout) => checked = probeEndpoint(host, port, timeout) });
    tick(again.project, again.orders, liveWorkers, seen, { record: false });
    // Finish the real asynchronous connection before the next tick consumes its answer.
    await new Promise(resolve => setImmediate(resolve));
    await checked;
    await new Promise(resolve => setImmediate(resolve));
    executeTick({ project: again.project, orders: again.orders, workers: liveWorkers, probes: seen }, { maxDispatch: 1 });
    const started = again.orders.get('T1').runs.at(-1)!;
    assert.equal(again.orders.get('T1').runs.length, 2);
    assert.equal(started.worker, 'coder');
    assert.equal(started.ended, undefined);
    assert.equal(started.attempt, 2);
    assert.equal(started.rotated, undefined);
    assert.equal(seen.spawned.at(-1)?.args.includes('--resume'), true);
    assert.equal(seen.spawned.at(-1)?.args.includes('sess-1'), true);
    assert.equal(await probeEndpoint('127.0.0.1', up.port, 1000), true);
    assert.equal(await probeEndpoint('127.0.0.1', down, 1000), false);
  } finally { await up.close(); }
});

test('producer case text and Chinese say the endpoint is unreachable', () => {
  assert.equal(endingCaseText({ outcome: 'capacity', limit: 'unreachable' }), 'endpoint unreachable');
  assert.equal(endingCaseText({ outcome: 'capacity', limit: 'capacity' }), 'capacity error');
  assert.equal(classifyCause('endpoint unreachable'), 'environment');
  withLang('zh', () => {
    assert.equal(t('endpoint unreachable'), translated['endpoint unreachable']);
    assert.equal(t('endpoint {endpoint} is down', { endpoint: '127.0.0.1:9' }), translated['endpoint {endpoint} is down']!.replace('{endpoint}', '127.0.0.1:9'));
    assert.ok(translated['endpoint unreachable'] && translated['endpoint unreachable'] !== 'endpoint unreachable', 'the endpoint text has a Chinese translation');
  });
});

test('fresh CLI processes hold a dead endpoint, then show availability and resume after recovery', async () => {
  const port = await closedPort();
  const { orders, project } = fixture();
  const workers = worker({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
  const projectFile = project.file;
  const workersFile = path.join(path.dirname(projectFile), 'workers.yaml');
  writeFileSync(projectFile, JSON.stringify({
    id: project.id, name: project.name, root: project.root, work_orders: project.work_orders,
    state_dir: project.state_dir, state: project.state, roles: { default: {} }, dispatch: project.dispatch,
  }));
  writeFileSync(workersFile, JSON.stringify({ workers: [{ id: 'coder', engine: 'claude-cli', on_limit: 'rotate', launch: {
    program: process.execPath, args: ['-e', 'process.exit(0)'], env: workers.workers[0].launch!.env,
  } }] }));
  orders.runStart('T1', { worker: 'coder', session: 'sess-1' });
  orders.runEnd('T1', 'capacity');
  orders.patchRun('T1', 'r1', { limit: 'unreachable' });
  orders.add({ tag: 'T2', title: 'Other', kind: 'sim' });
  orders.act('T2', 'queue');
  const cli = async (...args: string[]) => {
    try {
      const result = await promisify(execFile)(process.execPath, [
        '--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, '../src/cli/main.ts'),
        ...args, '--project', projectFile, '--workers', workersFile, '--json',
      ], { env: { ...process.env, ALBA_LANG: 'en' }, timeout: 60_000, windowsHide: true });
      return JSON.parse(result.stdout);
    } catch (error) {
      const result = error as { code?: number; stdout?: string };
      if ((result.code === 1 || result.code === 2) && result.stdout?.trim()) return JSON.parse(result.stdout);
      throw error;
    }
  };
  const down = await cli('workers');
  assert.equal(down.workers[0].available, false);
  assert.ok(down.workers[0].why_not.includes('endpoint unreachable'));
  const held = await cli('tick');
  assert.equal(held.dispatched, 0);
  assert.equal(held.problems.filter((p: { text: string }) => p.text === 'coder: endpoint unreachable').length, 1);
  assert.equal(orders.get('T1').runs.length, 1);
  assert.equal(orders.get('T2').runs.length, 0);
  const server = net.createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  try {
    const up = await cli('workers');
    assert.equal(up.workers[0].available, true);
    const preview = await cli('tick', '--dry-run', '--no-record');
    assert.ok(preview.moves.some((m: { tag: string; mode: string }) => m.tag === 'T1' && m.mode === 'resume'));
    assert.equal(orders.get('T1').runs.length, 1, 'preview does not start a run');
    const resumed = await cli('tick', '--max-dispatch', '0');
    assert.equal(resumed.dispatched, 1);
    assert.equal(orders.get('T1').runs.length, 2);
    assert.equal(orders.get('T1').runs.at(-1)?.attempt, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('connection loss after real output is unreachable; old overloads and tool output do not override the ending', () => {
  const named = worker({ OPENAI_BASE_URL: 'http://127.0.0.1:9' }).workers[0];
  const output = JSON.stringify({ type: 'assistant', message: { model: 'model', content: [{ type: 'tool_use', name: 'Read' }], usage: { input_tokens: 10 } } });
  const events = [retry(529), ...Array.from({ length: 20 }, () => output)].join('\n');
  for (const log of ['connect ECONNREFUSED http://127.0.0.1:9', 'fetch failed http://127.0.0.1:9/v1', 'No connection could be made because the target machine actively refused it http://127.0.0.1:9', 'os error 10061 http://127.0.0.1:9']) {
    assert.equal(classifyEndpoint({ events, log, cut: false, worker: named }).kind, 'unreachable');
  }
  assert.equal(classifyEndpoint({ events: `${events}\n${retry(429)}`, log: 'connect ECONNREFUSED http://127.0.0.1:9', cut: false, worker: named }).kind, 'capacity');
  const { orders, project } = fixture();
  const workers = worker({ OPENAI_BASE_URL: 'http://127.0.0.1:9' });
  startRun({ project, orders, workers, probes: probes() }, 'T1', 'coder');
  const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'connect ECONNREFUSED http://127.0.0.1:5432; fetch failed http://127.0.0.1:9' }] } });
  const failed = findFinishes(project, orders, probes({ tail: () => tool }), workers)[0];
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.limit, undefined);
  const final = JSON.stringify({ type: 'assistant', message: { model: 'model', content: [{ type: 'text', text: 'Finished.' }] } });
  const bounced = findFinishes(project, orders, probes({ tail: () => `${tool}\n${final}\nconnect ECONNREFUSED http://127.0.0.1:9` }), workers)[0];
  assert.ok(bounced.bounce);
  const loss = findFinishes(project, orders, probes({ tail: () => `${output}\nconnect ECONNREFUSED http://127.0.0.1:9` }), workers)[0];
  assert.equal(loss.limit, 'unreachable');
  for (const ending of ['permission required: Execute `restricted` was not run, as a headless run cannot ask for approval', JSON.stringify({ type: 'end', stopReason: 'max_turn_requests' })]) {
    const finish = findFinishes(project, orders, probes({ tail: () => `${deadGateway()}\n${ending}` }), workers)[0];
    assert.equal(finish.outcome, 'failed');
  }
  assert.equal(classifyEndpoint({ events: JSON.stringify({ type: 'error', message: 'connect ECONNREFUSED http://127.0.0.1:9' }), log: '', cut: false, worker: named }).kind, 'unreachable');
});
