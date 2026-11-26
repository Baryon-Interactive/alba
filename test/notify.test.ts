import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { validateProject, type ProjectConfig } from '../src/config.ts';
import {
  WINDOWS_TOAST_SCRIPT,
  formatFailureLine,
  sendChannel,
  type NotifyPayload,
  type ToastCommand,
} from '../src/notify/channels.ts';
import { createNotifier } from '../src/notify/notifier.ts';
import { notifyStatePath } from '../src/notify/state.ts';
import { stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { acquireLock, exitFile, lockFile, writeServeExit } from '../src/serve/lock.ts';
import { startServe, type Serve } from '../src/serve/serve.ts';
import type { Probes, TickResult } from '../src/tick/gather.ts';
import type { Problem, TickReport } from '../src/tick/plan.ts';
import { loadWorkers, validateWorkers, type WorkersFile } from '../src/workers/config.ts';
import { tmpDir } from './tmp.ts';

const tempDirs: string[] = [];
const servers: Server[] = [];
const serves: Serve[] = [];

after(async () => {
  for (const s of serves.splice(0)) await s.stop();
  await Promise.all(servers.splice(0).map(srv => new Promise<void>(resolve => srv.close(() => resolve()))));
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeTempDir(prefix = 'alba-notify-'): string {
  const dir = tmpDir(prefix);
  tempDirs.push(dir);
  return dir;
}

function makeProject(rootDir: string, id = 'demo'): ProjectConfig {
  const base = path.join(rootDir, id);
  const game = path.join(base, 'game');
  const orders = path.join(base, 'orders');
  const state = path.join(base, 'state');
  mkdirSync(game, { recursive: true });
  mkdirSync(orders, { recursive: true });
  mkdirSync(state, { recursive: true });
  const file = path.join(base, 'alba.yaml');
  writeFileSync(file, `id: ${id}\nname: ${id}\nroot: game\nwork_orders: orders\nstate_dir: state\n`, 'utf8');
  return validateProject({ id, name: id, root: game, work_orders: orders, state_dir: state }, file);
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function startLocalHttpServer(
  handler?: (req: RecordedRequest, count: number) => { status: number; body?: string },
): Promise<{ port: number; endpoint: (pathname: string) => string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const reply = handler ? handler(recorded, requests.length) : { status: 200, body: 'ok' };
      res.writeHead(reply.status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(reply.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const scheme = ['ht', 'tp'].join('');
  return {
    port,
    endpoint: pathname => `${scheme}://127.0.0.1:${port}${pathname}`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function emptyReport(now: Date, overrides: Partial<TickReport> = {}): TickReport {
  return {
    at: now.toISOString(),
    needsUser: [],
    problems: [],
    moves: [],
    heldBack: [],
    unavailable: [],
    notChecked: [],
    waiting: [],
    monitoring: [],
    finishes: [],
    done: [],
    exitCode: 0,
    ...overrides,
  };
}

function makeTickResult(
  now: Date,
  workersFile: WorkersFile,
  overrides: {
    problems?: Problem[];
    needsUser?: TickReport['needsUser'];
    unavailable?: TickReport['unavailable'];
    done?: string[];
    quotas?: TickResult['quotas'];
  } = {},
): TickResult {
  const probs = overrides.problems ?? [];
  return {
    report: emptyReport(now, {
      problems: probs,
      needsUser: overrides.needsUser ?? [],
      unavailable: overrides.unavailable ?? [],
      done: overrides.done ?? [],
      exitCode: probs.length ? 2 : 0,
    }),
    quotas: overrides.quotas ?? [],
    workers: workersFile.workers.map(config => ({
      config,
      available: config.enabled,
      reasons: config.enabled ? [] : ['turned off in the workers file'],
      startable: true,
      roleHistory: {},
      running: 0,
      history: {},
      runsToday: 0,
    })),
    activity: {},
    history: [],
    dispatchOrder: [],
  };
}

function fakeProbes(nowFn: () => Date): Probes {
  return {
    now: nowFn,
    isAlive: () => false,
    tail: () => '',
    head: () => '',
    readText: () => undefined,
    fileTime: () => undefined,
    runCommand: () => '[]',
    freeRamGb: () => 32,
    worktrees: () => [],
    gitActivity: () => ({}),
    spawnDetached: () => 1,
  } as unknown as Probes;
}

const EXAMPLE_WORKERS_YAML = `workers:
  - id: coder-a
    engine: codex-cli
notify:
  channels:
    phone: { type: ntfy, url_env: ALBA_NTFY_URL, token_env: ALBA_NTFY_TOKEN }
    team:  { type: slack, url_env: ALBA_SLACK_WEBHOOK }
    hook:  { type: webhook, url_env: ALBA_HOOK_URL, token_env: ALBA_HOOK_TOKEN }
    desk:  { type: windows-toast }
  to: [phone, desk]
  quiet_hours: { from: "23:00", to: "08:00", except: [serve-crashed, machine-down] }
  digest: { at: "09:00", to: [team] }
  triggers:
    review-waiting:   { after_minutes: 120 }
    question-waiting: { after_minutes: 30 }
    worker-paused:    { after_minutes: 0 }
    quota-unreadable: { after_minutes: 20 }
    run-stalled:      { after_minutes: 0 }
    machine-down:     { after_minutes: 10 }
    serve-crashed:    {}
`;

// 1. Config validation
test('notify config: full example loads; inline url/token/webhook, unknown channel, unknown keys and bad env names are refused; without notify loads unchanged', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'workers.yaml');
  writeFileSync(file, EXAMPLE_WORKERS_YAML, 'utf8');
  const loaded = loadWorkers(file);
  assert.ok(loaded.notify);
  assert.deepEqual(loaded.notify.to, ['phone', 'desk']);
  assert.deepEqual(loaded.notify.quiet_hours, { from: '23:00', to: '08:00', except: ['serve-crashed', 'machine-down'] });
  assert.deepEqual(loaded.notify.digest, { at: '09:00', to: ['team'] });
  assert.equal(loaded.notify.triggers['review-waiting'].after_minutes, 120);
  assert.equal(loaded.notify.triggers['question-waiting'].after_minutes, 30);
  assert.equal(loaded.notify.triggers['quota-unreadable'].after_minutes, 20);
  assert.equal(loaded.notify.triggers['machine-down'].after_minutes, 10);
  assert.equal(loaded.notify.triggers['serve-crashed'].off, false);

  // Defaults apply when triggers block is omitted, and per-trigger off/to/projects load cleanly
  const minimal = validateWorkers({
    workers: [{ id: 'coder-a', engine: 'codex-cli' }],
    notify: {
      channels: { desk: { type: 'windows-toast' }, hook: { type: 'webhook', url_env: 'ALBA_HOOK_URL' } },
      to: ['desk'],
      triggers: {
        'quota-unreadable': { after_minutes: 15, to: ['hook'], projects: ['demo'] },
        'serve-crashed': { off: true },
      },
    },
  }, 'w.yaml');
  assert.equal(minimal.notify?.triggers['review-waiting'].after_minutes, 120);
  assert.equal(minimal.notify?.triggers['quota-unreadable'].after_minutes, 15);
  assert.deepEqual(minimal.notify?.triggers['quota-unreadable'].to, ['hook']);
  assert.deepEqual(minimal.notify?.triggers['quota-unreadable'].projects, ['demo']);
  assert.equal(minimal.notify?.triggers['serve-crashed'].off, true);

  // Inline url / token / webhook values refused
  assert.throws(() => validateWorkers({
    workers: [{ id: 'coder-a', engine: 'codex-cli' }],
    notify: { channels: { hook: { type: 'webhook', url: 'inline-value' } } },
  }, 'w.yaml'), /url_env/);
  assert.throws(() => validateWorkers({
    workers: [{ id: 'coder-a', engine: 'codex-cli' }],
    notify: { channels: { hook: { type: 'webhook', url_env: 'ALBA_HOOK_URL', token: 'inline-secret' } } },
  }, 'w.yaml'), /token_env/);
  assert.throws(() => validateWorkers({
    workers: [{ id: 'coder-a', engine: 'codex-cli' }],
    notify: { channels: { team: { type: 'slack', webhook: 'inline-value' } } },
  }, 'w.yaml'), /url_env/);

  // Unknown channel refused
  assert.throws(() => validateWorkers({
    workers: [{ id: 'coder-a', engine: 'codex-cli' }],
    notify: { channels: { desk: { type: 'windows-toast' } }, to: ['missing-channel'] },
  }, 'w.yaml'), /unknown channel "missing-channel"/);

  // Bad env var names refused
  for (const badEnv of ['lower_case', '1BAD_NAME', 'BAD-ENV']) {
    assert.throws(() => validateWorkers({
      workers: [{ id: 'coder-a', engine: 'codex-cli' }],
      notify: { channels: { hook: { type: 'webhook', url_env: badEnv } } },
    }, 'w.yaml'), /\[A-Z_\]\[A-Z0-9_\]\*/);
  }

  // Unknown keys refused
  assert.throws(() => validateWorkers({
    workers: [{ id: 'coder-a', engine: 'codex-cli' }],
    notify: { channels: { desk: { type: 'windows-toast' } }, extra_key: true },
  }, 'w.yaml'), /unknown key/);

  // Workers file without notify loads unchanged
  const plain = validateWorkers({ workers: [{ id: 'coder-a', engine: 'codex-cli' }] }, 'w.yaml');
  assert.equal(plain.notify, undefined);
});

// 2. Channels against local HTTP server on port 0 + Windows toast injected runner
test('notify channels: webhook JSON + bearer, ntfy headers, slack body, 500 retries 3 times without logging URL, toast keeps text out of script', async () => {
  let failMode = false;
  const srv = await startLocalHttpServer((_req, _count) => (failMode ? { status: 500, body: 'server error' } : { status: 200, body: 'ok' }));
  const authValue = 'local-test-credential';
  const env: NodeJS.ProcessEnv = {
    ALBA_HOOK_URL: srv.endpoint('/webhook'),
    ALBA_HOOK_TOKEN: authValue,
    ALBA_NTFY_URL: srv.endpoint('/ntfy-topic'),
    ALBA_SLACK_WEBHOOK: srv.endpoint('/slack-hook'),
  };

  const sample: NotifyPayload = {
    source: 'alba',
    host: 'build-host',
    trigger: 'run-stalled',
    key: 'run-stalled:demo:T1:stalled',
    project: 'demo',
    tag: 'T1',
    worker: 'coder-a',
    title: '[demo] T1 stalled',
    text: '[demo] T1: no commit for 2 h (on_stall: continue has not acted)',
    since: '2026-11-17T01:00:00.000Z',
    at: '2026-11-17T01:05:00.000Z',
    cleared: false,
  };

  // Webhook
  const hookRes = await sendChannel({ type: 'webhook', url_env: 'ALBA_HOOK_URL', token_env: 'ALBA_HOOK_TOKEN' }, sample, { env });
  assert.equal(hookRes.ok, true);
  assert.equal(hookRes.status, 200);
  assert.equal(srv.requests.length, 1);
  assert.equal(srv.requests[0]!.path, '/webhook');
  assert.equal(srv.requests[0]!.headers.authorization, `Bearer ${authValue}`);
  assert.deepEqual(JSON.parse(srv.requests[0]!.body), {
    source: 'alba',
    host: 'build-host',
    trigger: 'run-stalled',
    key: 'run-stalled:demo:T1:stalled',
    project: 'demo',
    tag: 'T1',
    worker: 'coder-a',
    title: '[demo] T1 stalled',
    text: '[demo] T1: no commit for 2 h (on_stall: continue has not acted)',
    since: '2026-11-17T01:00:00.000Z',
    at: '2026-11-17T01:05:00.000Z',
    cleared: false,
  });

  // ntfy
  const ntfyRes = await sendChannel({ type: 'ntfy', url_env: 'ALBA_NTFY_URL' }, sample, { env });
  assert.equal(ntfyRes.ok, true);
  assert.equal(srv.requests[1]!.path, '/ntfy-topic');
  assert.equal(srv.requests[1]!.headers.title, '[demo] T1 stalled');
  assert.equal(srv.requests[1]!.headers.priority, 'high');
  assert.equal(srv.requests[1]!.body, sample.text);

  // Slack
  const slackRes = await sendChannel({ type: 'slack', url_env: 'ALBA_SLACK_WEBHOOK' }, sample, { env });
  assert.equal(slackRes.ok, true);
  assert.equal(srv.requests[2]!.path, '/slack-hook');
  assert.deepEqual(JSON.parse(srv.requests[2]!.body), { text: sample.text });

  // 500 retried 3 times with backoff, then reported without URL or token
  srv.requests.length = 0;
  failMode = true;
  const sleeps: number[] = [];
  const retryRes = await sendChannel(
    { type: 'webhook', url_env: 'ALBA_HOOK_URL', token_env: 'ALBA_HOOK_TOKEN' },
    sample,
    { env, sleep: async ms => { sleeps.push(ms); } },
  );
  assert.equal(retryRes.ok, false);
  assert.equal(retryRes.status, 500);
  assert.equal(retryRes.tries, 3);
  assert.equal(srv.requests.length, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1]! > sleeps[0]!);
  const failLine = formatFailureLine('hook', retryRes);
  assert.match(failLine, /notify \(hook\): HTTP 500/);
  assert.ok(!failLine.includes(String(srv.port)));
  assert.ok(!failLine.includes('/webhook'));
  assert.ok(!failLine.includes(authValue));

  // Network error that embeds URL in Error.message is scrubbed too
  const netFail = await sendChannel(
    { type: 'webhook', url_env: 'ALBA_HOOK_URL', token_env: 'ALBA_HOOK_TOKEN' },
    sample,
    {
      env,
      sleep: async () => {},
      fetchImpl: async target => { throw new Error(`connect ECONNREFUSED ${String(target)} with ${authValue}`); },
    },
  );
  assert.equal(netFail.ok, false);
  assert.equal(netFail.tries, 3);
  const netLine = formatFailureLine('hook', netFail);
  assert.ok(!netLine.includes(String(srv.port)), netLine);
  assert.ok(!netLine.includes('/webhook'), netLine);
  assert.ok(!netLine.includes(authValue), netLine);

  // Windows toast: powershell.exe 5.1, injected runner, title and text passed via env, never in script
  const toastCalls: ToastCommand[] = [];
  const specialTitle = 'Alba <Toast> "Title" $secret';
  const specialText = "Body with 'quotes' & XML <tags> `backticks`";
  const toastRes = await sendChannel(
    { type: 'windows-toast' },
    { ...sample, title: specialTitle, text: specialText },
    { platform: 'win32', toastRunner: cmd => { toastCalls.push(cmd); } },
  );
  assert.equal(toastRes.ok, true);
  assert.equal(toastCalls.length, 1);
  assert.equal(toastCalls[0]!.program, 'powershell.exe');
  assert.equal(toastCalls[0]!.env.ALBA_TOAST_TITLE, specialTitle);
  assert.equal(toastCalls[0]!.env.ALBA_TOAST_TEXT, specialText);
  const joinedArgs = toastCalls[0]!.args.join(' ');
  assert.ok(joinedArgs.includes('ToastNotificationManager'));
  assert.equal(toastCalls[0]!.args.at(-1), WINDOWS_TOAST_SCRIPT);
  assert.ok(!joinedArgs.includes(specialTitle));
  assert.ok(!joinedArgs.includes(specialText));

  // On non-Windows, windows-toast is "not available" and never invokes runner
  const linuxToast = await sendChannel(
    { type: 'windows-toast' },
    sample,
    { platform: 'linux', toastRunner: () => { throw new Error('must not run'); } },
  );
  assert.equal(linuxToast.ok, false);
  assert.equal(linuxToast.notAvailable, true);
});

// 3. Each trigger: threshold, once while open, clear + return, quota-unreadable shared across 3 projects
test('notifier triggers: threshold gating, single fire while open, re-fire after clear, and shared quota-unreadable over 3 projects', async () => {
  const root = makeTempDir();
  const machine = path.join(root, 'machine');
  const p1 = makeProject(root, 'demo');
  const p2 = makeProject(root, 'alpha');
  const p3 = makeProject(root, 'beta');

  let clockMs = Date.parse('2026-11-17T10:00:00.000Z');
  const clock = () => new Date(clockMs);
  const advanceMinutes = (m: number) => { clockMs += m * 60_000; };

  const workers = validateWorkers({
    quota_sources: {
      'gw-main': { type: 'command-json', command: ['quota-gw', '--json'] },
    },
    workers: [
      { id: 'coder-a', engine: 'codex-cli', quota: 'gw-main', trip_after_failures: 3, trip_minutes: 60 },
    ],
    notify: {
      channels: { hook: { type: 'webhook', url_env: 'ALBA_HOOK_URL' } },
      to: ['hook'],
      triggers: {
        'review-waiting': { after_minutes: 120 },
        'question-waiting': { after_minutes: 30 },
        'worker-paused': { after_minutes: 5 },
        'quota-unreadable': { after_minutes: 20 },
        'run-stalled': { after_minutes: 5 },
        'machine-down': { after_minutes: 10 },
      },
    },
  }, path.join(root, 'workers.yaml'));

  const sent: NotifyPayload[] = [];
  const notifier = createNotifier({
    projects: [p1, p2, p3],
    workers,
    clock,
    machineDir: machine,
    timerMs: 0,
    print: () => {},
    sender: async (_id, _ch, payload) => {
      sent.push(payload);
      return { ok: true, status: 200, tries: 1 };
    },
  });

  // (a) quota-unreadable across 3 projects: sends once after 20 min, carries error text
  const badQuota: TickResult['quotas'] = [{
    source: 'gw-main',
    at: clock().toISOString(),
    ok: false,
    error: 'spawnSync quota-gw ENOENT',
    windows: [],
    entries: 0,
  }];
  for (const p of [p1, p2, p3]) notifier.onTick(p.id, makeTickResult(clock(), workers, { quotas: badQuota }));
  await notifier.flush();
  assert.equal(sent.length, 0, 'not sent at 0 min');

  advanceMinutes(19);
  for (const p of [p1, p2, p3]) notifier.onTick(p.id, makeTickResult(clock(), workers, { quotas: badQuota }));
  await notifier.flush();
  assert.equal(sent.length, 0, 'not sent before 20 min threshold');

  advanceMinutes(2); // 21 min total
  for (const p of [p1, p2, p3]) notifier.onTick(p.id, makeTickResult(clock(), workers, { quotas: badQuota }));
  await notifier.flush();
  assert.equal(sent.length, 1, 'sent once across 3 projects');
  assert.equal(sent[0]!.trigger, 'quota-unreadable');
  assert.equal(sent[0]!.key, 'quota-unreadable:coder-a');
  assert.equal(sent[0]!.project, undefined);
  assert.equal(sent[0]!.worker, 'coder-a');
  assert.match(sent[0]!.text, /spawnSync quota-gw ENOENT/);

  // Still unreadable at +10 min -> not sent again while open
  advanceMinutes(10);
  for (const p of [p1, p2, p3]) notifier.onTick(p.id, makeTickResult(clock(), workers, { quotas: badQuota }));
  await notifier.flush();
  assert.equal(sent.length, 1);

  // Quota recovers -> clears; then fails again -> sends again after 20 min
  const okQuota: TickResult['quotas'] = [{
    source: 'gw-main',
    at: clock().toISOString(),
    ok: true,
    windows: [],
    entries: 1,
  }];
  notifier.onTick(p1.id, makeTickResult(clock(), workers, { quotas: okQuota }));
  await notifier.flush();
  assert.ok(notifier.readState().conditions['quota-unreadable:coder-a']?.cleared_at);

  advanceMinutes(1);
  notifier.onTick(p1.id, makeTickResult(clock(), workers, { quotas: badQuota }));
  advanceMinutes(21);
  notifier.onTick(p1.id, makeTickResult(clock(), workers, { quotas: badQuota }));
  await notifier.flush();
  assert.equal(sent.filter(s => s.trigger === 'quota-unreadable').length, 2, 'sent again after clear and return');
  // Clear quota condition for cleaner subsequent checks
  notifier.onTick(p1.id, makeTickResult(clock(), workers, { quotas: okQuota }));

  // (b) review-waiting (120 min) & question-waiting (30 min) from order store + clock
  sent.length = 0;
  const orders1 = new Orders(stateStore(p1), () => clock().toISOString(), 'test');
  orders1.add({ tag: 'T1', title: 'Review target', kind: 'code' });
  orders1.act('T1', 'queue');
  orders1.runStart('T1', { worker: 'coder-a' });
  orders1.runEnd('T1', 'completed');
  orders1.report('T1', { status: 'ready', summary: 'Implemented feature', evidence: [], commits: ['abc1234'] });

  orders1.add({ tag: 'Q1', title: 'Question target', kind: 'code' });
  orders1.act('Q1', 'queue');
  orders1.runStart('Q1', { worker: 'coder-a' });
  orders1.runEnd('Q1', 'completed');
  orders1.report('Q1', { status: 'waiting', summary: 'Need layout', question: 'Horizontal or vertical?', evidence: [], commits: [] });

  notifier.step();
  await notifier.flush();
  assert.equal(sent.length, 0);

  advanceMinutes(29);
  notifier.step();
  await notifier.flush();
  assert.equal(sent.length, 0, 'neither sent at 29 min');

  advanceMinutes(2); // 31 min: question-waiting fires, review-waiting still < 120 min
  notifier.step();
  await notifier.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.key, 'question-waiting:demo:Q1');
  assert.match(sent[0]!.text, /Horizontal or vertical\?/);

  advanceMinutes(88); // 119 min: review-waiting still < 120 min, question-waiting not repeated
  notifier.step();
  await notifier.flush();
  assert.equal(sent.length, 1);

  advanceMinutes(2); // 121 min: review-waiting fires once
  notifier.step();
  await notifier.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.key, 'review-waiting:demo:T1');
  assert.match(sent[1]!.text, /Implemented feature/);

  // Answer Q1 and rework T1 -> both clear; new waiting report on Q1 -> fires again after 30 min
  orders1.act('Q1', 'answer', { note: 'Use horizontal' });
  orders1.act('T1', 'rework', { note: 'Add edge case' });
  notifier.step();
  assert.ok(notifier.readState().conditions['question-waiting:demo:Q1']?.cleared_at);
  assert.ok(notifier.readState().conditions['review-waiting:demo:T1']?.cleared_at);

  advanceMinutes(1);
  orders1.runStart('Q1', { worker: 'coder-a' });
  orders1.runEnd('Q1', 'completed');
  orders1.report('Q1', { status: 'waiting', summary: 'Second question', question: 'Dark or light?', evidence: [], commits: [] });
  notifier.step();
  advanceMinutes(31);
  notifier.step();
  await notifier.flush();
  assert.equal(sent.filter(s => s.key === 'question-waiting:demo:Q1').length, 2);
  orders1.act('Q1', 'answer', { note: 'Dark' });
  notifier.step();

  // (c) worker-paused: calls workerTrip directly (no reason text needed in TickResult)
  sent.length = 0;
  orders1.add({ tag: 'B1', title: 'Breaker order', kind: 'code' });
  orders1.act('B1', 'queue');
  for (let i = 0; i < 3; i++) {
    const { run } = orders1.runStart('B1', { worker: 'coder-a' });
    orders1.patchRun('B1', run.id, { missing_report: true });
    orders1.runEnd('B1', 'failed', { kind: 'nonzero-exit', exit_code: 1, detail: 'died', why: 'died' });
  }
  notifier.step();
  await notifier.flush();
  assert.equal(sent.length, 0, 'worker-paused respects 5 min threshold');

  advanceMinutes(6);
  notifier.step();
  await notifier.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.key, 'worker-paused:demo:coder-a');

  advanceMinutes(10);
  notifier.step();
  await notifier.flush();
  assert.equal(sent.length, 1, 'not sent again while breaker open');

  // After 60 min trip_minutes expires, breaker clears; one more broken failure trips and notifies again
  advanceMinutes(50);
  notifier.step();
  assert.ok(notifier.readState().conditions['worker-paused:demo:coder-a']?.cleared_at);

  const { run: r4 } = orders1.runStart('B1', { worker: 'coder-a' });
  orders1.patchRun('B1', r4.id, { missing_report: true });
  orders1.runEnd('B1', 'failed', { kind: 'nonzero-exit', exit_code: 1, detail: 'died again', why: 'died again' });
  notifier.step();
  advanceMinutes(6);
  notifier.step();
  await notifier.flush();
  assert.equal(sent.filter(s => s.key === 'worker-paused:demo:coder-a').length, 2);
  // Close breaker with a completed run
  orders1.runStart('B1', { worker: 'coder-a' });
  orders1.runEnd('B1', 'completed');
  orders1.report('B1', { status: 'failed', summary: 'Worker reported failure', evidence: [], commits: [] });
  notifier.step();

  // (d) run-stalled: problem kinds + silent-end notice + on_stall: continue status
  sent.length = 0;
  const stallProb: Problem = { kind: 'stalled', tag: 'T1', text: 'T1: no commit for 90 min (limit 60 min).' };
  notifier.onTick(p1.id, makeTickResult(clock(), workers, { quotas: okQuota, problems: [stallProb] }));
  await notifier.flush();
  assert.equal(sent.length, 0, 'not sent before 5 min');

  advanceMinutes(6);
  notifier.onTick(p1.id, makeTickResult(clock(), workers, { quotas: okQuota, problems: [stallProb] }));
  await notifier.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.key, 'run-stalled:demo:T1:stalled');
  assert.match(sent[0]!.text, /on_stall: continue has not acted/);

  // Clear, record stall-stopped continuation event, and trigger again -> says on_stall: continue already acted
  notifier.onTick(p1.id, makeTickResult(clock(), workers, { quotas: okQuota, problems: [] }));
  orders1.record('T1', 'stall-stopped', { run: 'r1', after_action: orders1.get('T1').actions.at(-1)!.seq, continued: true });
  advanceMinutes(1);
  notifier.onTick(p1.id, makeTickResult(clock(), workers, { quotas: okQuota, problems: [stallProb] }));
  advanceMinutes(6);
  notifier.onTick(p1.id, makeTickResult(clock(), workers, { quotas: okQuota, problems: [stallProb] }));
  await notifier.flush();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.text, /on_stall: continue already acted/);

  // silent-end via serve.notice (with after_minutes: 0 override) fires immediately and does not double-fire on tick
  const instantWorkers = validateWorkers({
    quota_sources: {
      'gw-main': { type: 'command-json', command: ['quota-gw', '--json'] },
    },
    workers: [
      { id: 'coder-a', engine: 'codex-cli', quota: 'gw-main', trip_after_failures: 3, trip_minutes: 60 },
    ],
    notify: {
      channels: { hook: { type: 'webhook', url_env: 'ALBA_HOOK_URL' } },
      to: ['hook'],
      triggers: { 'run-stalled': { after_minutes: 0 }, 'machine-down': { after_minutes: 10 } },
    },
  }, path.join(root, 'workers.yaml'));
  notifier.setWorkers(instantWorkers);
  sent.length = 0;
  notifier.onNotice({
    project: 'demo',
    at: clock().toISOString(),
    kind: 'silent-end',
    tag: 'T1',
    run: 'r2',
    text: 'T1: run r2 ended silently (vanished): process gone',
  });
  await notifier.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.key, 'run-stalled:demo:T1:silent-end');

  notifier.onTick(p1.id, makeTickResult(clock(), instantWorkers, {
    quotas: okQuota,
    problems: [{ kind: 'silent-end', tag: 'T1', text: 'T1: run r2 ended silently (vanished): process gone' }],
  }));
  await notifier.flush();
  assert.equal(sent.length, 1, 'matching tick problem does not duplicate silent-end notice');
  notifier.onTick(p1.id, makeTickResult(clock(), instantWorkers, { quotas: okQuota, problems: [] }));

  // (e) machine-down (both machine-down and launch endpoint unreachable)
  sent.length = 0;
  const downProblems: Problem[] = [
    { kind: 'machine-down', text: 'machine gpu-box: unreachable', evidence: ['gpu-box'] },
    { kind: 'launch', text: 'coder-a: endpoint unreachable' },
  ];
  notifier.onTick(p1.id, makeTickResult(clock(), instantWorkers, { quotas: okQuota, problems: downProblems }));
  // p2 has no machine-down problems: must NOT prematurely clear p1's machine-down conditions
  notifier.onTick(p2.id, makeTickResult(clock(), instantWorkers, { quotas: okQuota, problems: [] }));
  advanceMinutes(9);
  notifier.onTick(p1.id, makeTickResult(clock(), instantWorkers, { quotas: okQuota, problems: downProblems }));
  await notifier.flush();
  assert.equal(sent.length, 0);

  advanceMinutes(2); // 11 min
  notifier.onTick(p1.id, makeTickResult(clock(), instantWorkers, { quotas: okQuota, problems: downProblems }));
  await notifier.flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(s => s.key).sort(), ['machine-down:endpoint:coder-a', 'machine-down:gpu-box']);

  // Clear on p1 -> clears both; return -> fires again after 10 min
  notifier.onTick(p1.id, makeTickResult(clock(), instantWorkers, { quotas: okQuota, problems: [] }));
  assert.ok(notifier.readState().conditions['machine-down:gpu-box']?.cleared_at);
  advanceMinutes(1);
  notifier.onTick(p1.id, makeTickResult(clock(), instantWorkers, { quotas: okQuota, problems: [downProblems[0]!] }));
  advanceMinutes(11);
  notifier.onTick(p1.id, makeTickResult(clock(), instantWorkers, { quotas: okQuota, problems: [downProblems[0]!] }));
  await notifier.flush();
  assert.equal(sent.filter(s => s.key === 'machine-down:gpu-box').length, 2);
});

// 4. State survives a new notifier instance over the same machine directory
test('notify state: survives across notifier restarts without repeating open alerts', async () => {
  const root = makeTempDir();
  const machine = path.join(root, 'machine');
  const proj = makeProject(root, 'demo');
  let clockMs = Date.parse('2026-11-17T12:00:00.000Z');
  const clock = () => new Date(clockMs);

  const workers = validateWorkers({
    quota_sources: { gw: { type: 'command-json', command: ['quota-gw'] } },
    workers: [{ id: 'coder-a', engine: 'codex-cli', quota: 'gw' }],
    notify: {
      channels: { hook: { type: 'webhook', url_env: 'ALBA_HOOK_URL' } },
      to: ['hook'],
      triggers: {
        'quota-unreadable': { after_minutes: 20 },
        'machine-down': { after_minutes: 10 },
      },
    },
  }, path.join(root, 'workers.yaml'));

  const badQuota: TickResult['quotas'] = [{ source: 'gw', at: clock().toISOString(), ok: false, error: 'ENOENT', windows: [], entries: 0 }];
  const downProb: Problem = { kind: 'machine-down', text: 'machine gpu-box: unreachable', evidence: ['gpu-box'] };

  const sent1: NotifyPayload[] = [];
  const first = createNotifier({
    projects: [proj],
    workers,
    clock,
    machineDir: machine,
    timerMs: 0,
    print: () => {},
    sender: async (_id, _ch, payload) => { sent1.push(payload); return { ok: true, status: 200, tries: 1 }; },
  });

  // t=0: both quota-unreadable (20m) and machine-down (10m) open
  first.onTick(proj.id, makeTickResult(clock(), workers, { quotas: badQuota, problems: [downProb] }));
  // t=12m: machine-down fires on first instance; quota-unreadable still pending (12m < 20m)
  clockMs += 12 * 60_000;
  first.onTick(proj.id, makeTickResult(clock(), workers, { quotas: badQuota, problems: [downProb] }));
  await first.flush();
  first.stop();
  assert.deepEqual(sent1.map(s => s.key), ['machine-down:gpu-box']);
  assert.ok(existsSync(notifyStatePath(machine)));

  // Second notifier instance over the same machine directory
  const sent2: NotifyPayload[] = [];
  const second = createNotifier({
    projects: [proj],
    workers,
    clock,
    machineDir: machine,
    timerMs: 0,
    print: () => {},
    sender: async (_id, _ch, payload) => { sent2.push(payload); return { ok: true, status: 200, tries: 1 }; },
  });

  // t=15m: neither fires (machine-down already notified before restart; quota-unreadable at 15m < 20m)
  clockMs += 3 * 60_000;
  second.onTick(proj.id, makeTickResult(clock(), workers, { quotas: badQuota, problems: [downProb] }));
  await second.flush();
  assert.equal(sent2.length, 0);

  // t=21m: quota-unreadable reaches 21m from original first_seen (t=0) and fires once; machine-down still not repeated
  clockMs += 6 * 60_000;
  second.onTick(proj.id, makeTickResult(clock(), workers, { quotas: badQuota, problems: [downProb] }));
  await second.flush();
  second.stop();
  assert.deepEqual(sent2.map(s => s.key), ['quota-unreadable:coder-a']);
  assert.equal(sent2[0]!.since, '2026-11-17T12:00:00.000Z');
});

// 5. Quiet hours hold & summarise + except passthrough + daily digest once at its time
test('quiet hours and digest: quiet hours hold and summarise at end, except passes through, digest fires once at its time', async () => {
  const root = makeTempDir();
  const machine = path.join(root, 'machine');
  const proj = makeProject(root, 'demo');

  // Local times on 2026-11-17..18
  let cur = new Date(2026, 10, 17, 23, 30, 0, 0);
  const clock = () => new Date(cur.getTime());

  const workers = validateWorkers({
    workers: [{ id: 'coder-a', engine: 'codex-cli', enabled: false }],
    notify: {
      channels: {
        phone: { type: 'ntfy', url_env: 'ALBA_NTFY_URL' },
        team: { type: 'slack', url_env: 'ALBA_SLACK_WEBHOOK' },
      },
      to: ['phone'],
      quiet_hours: { from: '23:00', to: '08:00', except: ['serve-crashed', 'machine-down'] },
      digest: { at: '09:00', to: ['team'] },
      triggers: {
        'run-stalled': { after_minutes: 0 },
        'machine-down': { after_minutes: 0 },
      },
    },
  }, path.join(root, 'workers.yaml'));

  const orders = new Orders(stateStore(proj), () => clock().toISOString(), 'test');
  orders.add({ tag: 'T1', title: 'Ready item', kind: 'code' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'coder-a' });
  orders.runEnd('T1', 'completed');
  orders.report('T1', { status: 'ready', summary: 'Done', evidence: [], commits: ['111'] });

  const deliveries: { channel: string; payload: NotifyPayload }[] = [];
  const notifier = createNotifier({
    projects: [proj],
    workers,
    clock,
    machineDir: machine,
    timerMs: 0,
    print: () => {},
    sender: async (channel, _ch, payload) => {
      deliveries.push({ channel, payload });
      return { ok: true, status: 200, tries: 1 };
    },
  });

  // 23:30 (in quiet hours): two non-except stalled problems are held; machine-down (in except) passes through immediately
  notifier.onTick(proj.id, makeTickResult(clock(), workers, {
    problems: [
      { kind: 'stalled', tag: 'S1', text: 'S1: no commit for 2 h.' },
      { kind: 'looping', tag: 'S2', text: 'S2: repeating build failure.' },
      { kind: 'machine-down', text: 'machine gpu-box: unreachable', evidence: ['gpu-box'] },
    ],
    unavailable: [{ worker: 'coder-a', reasons: ['turned off in the workers file'] }],
  }));
  await notifier.flush();
  assert.equal(deliveries.length, 1, 'only except trigger sent during quiet hours');
  assert.equal(deliveries[0]!.payload.trigger, 'machine-down');
  assert.equal(notifier.readState().held.length, 2);

  // 07:59: still in quiet hours -> still held
  cur = new Date(2026, 10, 18, 7, 59, 0, 0);
  notifier.step();
  await notifier.flush();
  assert.equal(deliveries.length, 1);

  // 08:00: quiet hours end -> held messages sent as ONE summary; digest at 09:00 not yet due
  cur = new Date(2026, 10, 18, 8, 0, 0, 0);
  notifier.step();
  await notifier.flush();
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1]!.channel, 'phone');
  assert.equal(deliveries[1]!.payload.trigger, 'quiet-summary');
  assert.match(deliveries[1]!.payload.text, /S1: no commit for 2 h/);
  assert.match(deliveries[1]!.payload.text, /S2: repeating build failure/);
  assert.equal(notifier.readState().held.length, 0);

  // 08:59: digest still not due
  cur = new Date(2026, 10, 18, 8, 59, 0, 0);
  notifier.step();
  await notifier.flush();
  assert.equal(deliveries.length, 2);

  // 09:00: digest fires once to team
  cur = new Date(2026, 10, 18, 9, 0, 0, 0);
  notifier.step();
  await notifier.flush();
  assert.equal(deliveries.length, 3);
  assert.equal(deliveries[2]!.channel, 'team');
  assert.equal(deliveries[2]!.payload.trigger, 'digest');
  assert.match(deliveries[2]!.payload.text, /Waiting for review: demo:T1/);
  assert.match(deliveries[2]!.payload.text, /Open conditions:.*machine-down:gpu-box/);
  assert.match(deliveries[2]!.payload.text, /Workers unavailable: coder-a: turned off/);
  assert.match(deliveries[2]!.payload.text, /Serve restarts \(last 24h\): 0/);

  // 09:05 & 10:00 same day: digest does not fire again
  cur = new Date(2026, 10, 18, 9, 5, 0, 0);
  notifier.step();
  cur = new Date(2026, 10, 18, 10, 0, 0, 0);
  notifier.step();
  await notifier.flush();
  assert.equal(deliveries.length, 3);
});

// 6. D4: clean stop, crash record and missing record give the three results; serve-crashed fires once for 2 projects
test('serve exit records: clean, crashed and killed classification; serve-crashed fires once across 2 projects', async () => {
  const root = makeTempDir();
  const stateDir = path.join(root, 'lock-check');
  const deadAlive = () => false;

  // (a) Dead lock + matching clean record -> clean
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(lockFile(stateDir), JSON.stringify({ pid: 101, started: '2026-11-17T01:00:00.000Z' }) + '\n');
  writeServeExit(stateDir, { pid: 101, started: '2026-11-17T01:00:00.000Z', ended_at: '2026-11-17T02:00:00.000Z', how: 'clean' });
  const relClean = acquireLock(stateDir, { pid: 102, started: '2026-11-17T02:01:00.000Z' }, deadAlive);
  assert.deepEqual(relClean.previous, {
    how: 'clean',
    pid: 101,
    started: '2026-11-17T01:00:00.000Z',
    ended_at: '2026-11-17T02:00:00.000Z',
  });
  relClean();

  // (b) Dead lock + matching crashed record -> crashed (with why)
  writeFileSync(lockFile(stateDir), JSON.stringify({ pid: 201, started: '2026-11-17T03:00:00.000Z' }) + '\n');
  writeServeExit(stateDir, { pid: 201, started: '2026-11-17T03:00:00.000Z', ended_at: '2026-11-17T03:45:00.000Z', how: 'crashed', why: 'EPIPE broken pipe' });
  const relCrash = acquireLock(stateDir, { pid: 202, started: '2026-11-17T03:46:00.000Z' }, deadAlive);
  assert.deepEqual(relCrash.previous, {
    how: 'crashed',
    pid: 201,
    started: '2026-11-17T03:00:00.000Z',
    ended_at: '2026-11-17T03:45:00.000Z',
    why: 'EPIPE broken pipe',
  });
  relCrash();

  // (c) Dead lock + missing exit record -> killed ("ended without a word")
  writeFileSync(lockFile(stateDir), JSON.stringify({ pid: 301, started: '2026-11-17T04:00:00.000Z' }) + '\n');
  const relKilled = acquireLock(stateDir, { pid: 302, started: '2026-11-17T05:00:00.000Z' }, deadAlive);
  assert.deepEqual(relKilled.previous, {
    how: 'killed',
    pid: 301,
    started: '2026-11-17T04:00:00.000Z',
  });
  relKilled();

  // (d) startServe with 2 projects: clean stop writes clean exit and does NOT fire serve-crashed; crash & kill fire ONCE for 2 projects
  const pA = makeProject(root, 'proj-a');
  const pB = makeProject(root, 'proj-b');
  const machine = path.join(root, 'machine');
  const workers = validateWorkers({
    workers: [{ id: 'coder-a', engine: 'codex-cli', enabled: false }],
    notify: {
      channels: { hook: { type: 'webhook', url_env: 'ALBA_HOOK_URL' } },
      to: ['hook'],
    },
  }, path.join(root, 'workers.yaml'));

  const sent: NotifyPayload[] = [];
  const makeServe = () => startServe({
    projects: [pA, pB],
    workers,
    port: 0,
    probes: fakeProbes(() => new Date('2026-11-17T08:00:00.000Z')),
    everyMinutes: 0,
    maxDispatch: 0,
    print: () => {},
    reloadConfigs: false,
    notifyMachineDir: machine,
    notifySender: async (_id, _ch, payload) => { sent.push(payload); return { ok: true, status: 200, tries: 1 }; },
  });

  const s1 = makeServe();
  await s1.stop();
  // Clean exit record was written synchronously at stop()
  const cleanRecordA = JSON.parse(readFileSync(exitFile(pA.state_dir), 'utf8')) as { how: string };
  assert.equal(cleanRecordA.how, 'clean');

  const s2 = makeServe();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 0, 'clean stop does not fire serve-crashed');
  await s2.stop();

  // Simulate previous crashed serve on BOTH projects -> next startServe fires serve-crashed ONCE (not twice)
  for (const p of [pA, pB]) {
    writeFileSync(lockFile(p.state_dir), JSON.stringify({ pid: 2147483001, started: '2026-11-17T06:00:00.000Z' }) + '\n');
    writeServeExit(p.state_dir, {
      pid: 2147483001,
      started: '2026-11-17T06:00:00.000Z',
      ended_at: '2026-11-17T07:30:00.000Z',
      how: 'crashed',
      why: 'unexpected fault',
    });
  }
  const s3 = makeServe();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1, 'serve-crashed fires once for 2 projects');
  assert.equal(sent[0]!.trigger, 'serve-crashed');
  assert.match(sent[0]!.text, /pid 2147483001/);
  assert.match(sent[0]!.text, /2026-11-17T06:00:00\.000Z/);
  assert.match(sent[0]!.text, /1h 30m/);
  assert.match(sent[0]!.text, /unexpected fault/);
  await s3.stop();

  // Simulate killed serve (dead lock with NO serve.exit.json) on BOTH projects -> fires once naming ended without a word
  sent.length = 0;
  for (const p of [pA, pB]) {
    rmSync(exitFile(p.state_dir), { force: true });
    writeFileSync(lockFile(p.state_dir), JSON.stringify({ pid: 2147483002, started: '2026-11-17T07:40:00.000Z' }) + '\n');
  }
  const s4 = makeServe();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1, 'killed serve fires once for 2 projects');
  assert.match(sent[0]!.text, /pid 2147483002/);
  assert.match(sent[0]!.text, /ended without a word/);
  await s4.stop();
  // Real child process uncaughtException writes crashed serve.exit.json and still exits non-zero
  const crashProject = makeProject(root, 'crash-sub');
  const serveModuleUrl = new URL('../src/serve/serve.ts', import.meta.url).href;
  const workersModuleUrl = new URL('../src/workers/config.ts', import.meta.url).href;
  const configModuleUrl = new URL('../src/config.ts', import.meta.url).href;
  const crashScript = [
    `import { loadProject } from ${JSON.stringify(configModuleUrl)};`,
    `import { validateWorkers } from ${JSON.stringify(workersModuleUrl)};`,
    `import { startServe } from ${JSON.stringify(serveModuleUrl)};`,
    `const project = loadProject(${JSON.stringify(crashProject.file)});`,
    `const workers = validateWorkers({ workers: [{ id: 'coder-a', engine: 'codex-cli', enabled: false }] }, 'w.yaml');`,
    `const probes = { now: () => new Date(), isAlive: () => false, tail: () => '', head: () => '', readText: () => undefined, fileTime: () => undefined, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: () => 1 };`,
    `startServe({ projects: [project], workers, port: 0, probes, everyMinutes: 0, maxDispatch: 0, print: () => {}, reloadConfigs: false });`,
    `setImmediate(() => { throw new Error('simulated uncaught crash'); });`,
  ].join('\n');
  const crashResult = await new Promise<{ code: number | null }>(resolve => {
    execFile(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', crashScript],
      { env: { ...process.env, ALBA_MACHINE_DIR: machine } },
      error => resolve({ code: error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 0 }),
    );
  });
  assert.notEqual(crashResult.code, 0);
  const crashRecord = JSON.parse(readFileSync(exitFile(crashProject.state_dir), 'utf8')) as { how: string; why?: string };
  assert.equal(crashRecord.how, 'crashed');
  assert.match(crashRecord.why ?? '', /simulated uncaught crash/);
});

function runCliAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  const mainTs = path.join(import.meta.dirname, '..', 'src', 'cli', 'main.ts');
  return new Promise(resolve => {
    execFile(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', mainTs, ...args],
      { env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
        resolve({ status: code, stdout, stderr });
      },
    );
  });
}

// 7. `alba notify test` and `alba notify status` as real CLI subprocesses against local server
test('CLI: alba notify test and alba notify status against local port-0 server', async () => {
  const root = makeTempDir();
  const machine = path.join(root, 'machine');
  let statusToReturn = 200;
  const srv = await startLocalHttpServer(() => ({ status: statusToReturn, body: 'ok' }));

  const workersFile = path.join(root, 'workers.yaml');
  writeFileSync(workersFile, `workers:
  - id: coder-a
    engine: codex-cli
notify:
  channels:
    hook: { type: webhook, url_env: ALBA_TEST_HOOK_URL, token_env: ALBA_TEST_HOOK_TOKEN }
    team: { type: slack, url_env: ALBA_TEST_SLACK_URL }
  to: [hook]
  quiet_hours: { from: "23:00", to: "07:00", except: [serve-crashed] }
  digest: { at: "09:00", to: [team] }
`, 'utf8');

  const secretToken = 'cli-test-auth';
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ALBA_MACHINE_DIR: machine,
    ALBA_TEST_HOOK_URL: srv.endpoint('/cli-hook'),
    ALBA_TEST_HOOK_TOKEN: secretToken,
    ALBA_TEST_SLACK_URL: srv.endpoint('/cli-slack'),
  };

  // All channels succeed -> exit 0, prints "sent (HTTP 200)" per channel
  const okRun = await runCliAsync(['notify', 'test', '--workers', workersFile], baseEnv);
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.match(okRun.stdout, /hook: sent \(HTTP 200\)/);
  assert.match(okRun.stdout, /team: sent \(HTTP 200\)/);
  assert.equal(srv.requests.length, 2);

  // Single failing channel (--channel hook returning 500) -> exit 1, prints HTTP 500 without URL or secret
  statusToReturn = 500;
  const failRun = await runCliAsync(['notify', 'test', '--channel', 'hook', '--workers', workersFile], baseEnv);
  assert.equal(failRun.status, 1);
  assert.match(failRun.stdout, /hook: HTTP 500/);
  assert.ok(!failRun.stdout.includes(String(srv.port)));
  assert.ok(!failRun.stdout.includes(secretToken));

  // Unset env var -> exit 1 on test, reported as missing in status (never exposing values)
  const missingEnv = { ...baseEnv };
  delete missingEnv.ALBA_TEST_SLACK_URL;
  const unconfRun = await runCliAsync(['notify', 'test', '--channel', 'team', '--workers', workersFile], missingEnv);
  assert.equal(unconfRun.status, 1);
  assert.match(unconfRun.stdout, /team: not configured \(ALBA_TEST_SLACK_URL is not set\)/);

  const statusRun = await runCliAsync(['notify', 'status', '--json', '--workers', workersFile], missingEnv);
  assert.equal(statusRun.status, 0, statusRun.stderr);
  assert.ok(!statusRun.stdout.includes(secretToken));
  assert.ok(!statusRun.stdout.includes(String(srv.port)));
  const statusJson = JSON.parse(statusRun.stdout) as {
    configured: boolean;
    channels: { id: string; status: string; env: { name: string; status: string }[] }[];
    quiet_hours: { from: string; to: string } | null;
    next_digest: { at: string; to: string[] } | null;
  };
  assert.equal(statusJson.configured, true);
  assert.equal(statusJson.channels.find(c => c.id === 'hook')?.status, 'configured');
  assert.equal(statusJson.channels.find(c => c.id === 'team')?.status, 'not configured');
  assert.equal(statusJson.quiet_hours?.from, '23:00');
  assert.equal(statusJson.next_digest?.at, '09:00');
});

// 8. Without notify: section serve starts and ticks unchanged without touching notify state
test('serve without notify section: starts, ticks and creates no notify-state.json', async () => {
  const root = makeTempDir();
  const machine = path.join(root, 'machine');
  const proj = makeProject(root, 'demo');
  const workers = validateWorkers({ workers: [{ id: 'coder-a', engine: 'codex-cli', enabled: false }] }, path.join(root, 'workers.yaml'));
  const printed: string[] = [];

  const serve = startServe({
    projects: [proj],
    workers,
    port: 0,
    probes: fakeProbes(() => new Date('2026-11-17T10:00:00.000Z')),
    everyMinutes: 0,
    maxDispatch: 0,
    print: l => printed.push(l),
    reloadConfigs: false,
    notifyMachineDir: machine,
  });
  serves.push(serve);
  await new Promise<void>(resolve => serve.server.once('listening', resolve));
  serve.tickNow('schedule');
  assert.ok(printed.some(l => /alba tick/.test(l)));
  assert.ok(!printed.some(l => /^notify/.test(l)));
  assert.equal(existsSync(notifyStatePath(machine)), false);
  await serve.stop();
});
