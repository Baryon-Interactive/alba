import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { handleApi } from '../src/api/handler.ts';
import { Hub } from '../src/api/hub.ts';
import { appendDelivered, appendInbox, cleanAgyInboxHooks, cleanInboxHooks, deliveredPath, ensureInbox, installInboxHook, readDelivered, readInbox } from '../src/run/inbox.ts';
import { startRun } from '../src/run/launch.ts';
import { LiveFold } from '../src/run/live.ts';
import { threadOf } from '../src/run/messages.ts';
import { sayToOrder } from '../src/run/say.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function makeWorktree(): { dir: string; hook: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-hook-'));
  ensureInbox(dir);
  const hook = installInboxHook(dir);
  return { dir, hook };
}

function runHookAsync(hook: string, engine: string, event: string, stdin: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook, engine, event], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
    else child.stdin.end();
  });
}

function repoFixture() {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'Demo\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-demo.md'), '# T1\nDemo task.\n');
  const project = validateProject({
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: workOrders,
    state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
  }, path.join(dir, 'alba.yaml'));
  return { orders, dir, root, project };
}

function stubProbes(over: Partial<Probes> = {}): Probes & { spawned: { program: string; args: string[] }[] } {
  const spawned: { program: string; args: string[] }[] = [];
  return {
    now: () => new Date('2026-01-02T00:00:00Z'),
    runCommand: () => '[]',
    freeRamGb: () => 32,
    worktrees: () => [],
    gitActivity: () => ({}),
    fileTime: () => undefined,
    isAlive: () => false,
    tail: () => '',
    readText: (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : undefined),
    spawnDetached(program: string, args: string[]) { spawned.push({ program, args: [...args] }); return 4242; },
    ...over,
    spawned,
  };
}

test('inbox-hook: Claude PostToolUse and Stop emit exact JSON and record delivery lines', async () => {
  const { dir, hook } = makeWorktree();
  try {
    const id1 = appendInbox(dir, { id: 'm1', at: '2026-01-02T00:01:00Z', author: 'lead', text: 'Switch to mode B.' });
    const id2 = appendInbox(dir, { id: 'm2', at: '2026-01-02T00:02:00Z', author: 'lead', text: 'Run build.ps1 after.' });
    assert.equal(id1, 'm1');
    assert.equal(id2, 'm2');

    const res1 = await runHookAsync(hook, 'claude', 'post-tool-use', {
      session_id: 'sess-1',
      transcript_path: path.join(dir, 't.jsonl'),
      cwd: dir,
      hook_event_name: 'PostToolUse',
    });
    assert.equal(res1.code, 0);
    assert.equal(res1.stderr, '');
    const parsed1 = JSON.parse(res1.stdout);
    const expectedText = [
      '[alba message id=m1 from=lead at=2026-01-02T00:01:00Z]\nSwitch to mode B.\nAfter acting on this message, append m1 to .alba/inbox-ack; if a reply is needed, append a JSON line to .alba/outbox.jsonl with "reply": "m1".',
      '[alba message id=m2 from=lead at=2026-01-02T00:02:00Z]\nRun build.ps1 after.\nAfter acting on this message, append m2 to .alba/inbox-ack; if a reply is needed, append a JSON line to .alba/outbox.jsonl with "reply": "m2".',
    ].join('\n\n');
    assert.deepEqual(parsed1, {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: expectedText,
      },
    });

    const deliveredLines = readFileSync(deliveredPath(dir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(deliveredLines.length, 2);
    assert.equal(deliveredLines[0].id, 'm1');
    assert.equal(deliveredLines[0].via, 'hook');
    assert.equal(deliveredLines[0].event, 'post-tool-use');
    assert.ok(Number.isFinite(Date.parse(deliveredLines[0].at)));
    assert.equal(deliveredLines[1].id, 'm2');

    // Nothing waiting -> prints nothing
    const empty = await runHookAsync(hook, 'claude', 'post-tool-use', { hook_event_name: 'PostToolUse' });
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, '');

    // Stop with stop_hook_active=true and no new message -> prints nothing (no loop)
    const stopLoop = await runHookAsync(hook, 'claude', 'stop', { hook_event_name: 'Stop', stop_hook_active: true });
    assert.equal(stopLoop.code, 0);
    assert.equal(stopLoop.stdout, '');

    // New message arrives -> Stop blocks and hands message to model
    appendInbox(dir, { id: 'm3', at: '2026-01-02T00:03:00Z', author: 'lead', text: 'One more check.' });
    const stopBlock = await runHookAsync(hook, 'claude', 'stop', { hook_event_name: 'Stop', stop_hook_active: false });
    assert.equal(stopBlock.code, 0);
    assert.deepEqual(JSON.parse(stopBlock.stdout), {
      decision: 'block',
      reason: '[alba message id=m3 from=lead at=2026-01-02T00:03:00Z]\nOne more check.\nAfter acting on this message, append m3 to .alba/inbox-ack; if a reply is needed, append a JSON line to .alba/outbox.jsonl with "reply": "m3".',
    });
    const delivered3 = readDelivered(dir).get('m3');
    assert.equal(delivered3?.via, 'hook');
    assert.equal(delivered3?.event, 'stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox-hook: agy PreInvocation and Stop emit exact JSON and handle empty state', async () => {
  const { dir, hook } = makeWorktree();
  try {
    const emptyPre = await runHookAsync(hook, 'agy', 'pre-invocation', { conversationId: 'c1', workspacePaths: [dir], invocationNum: 1 });
    assert.equal(emptyPre.code, 0);
    assert.equal(emptyPre.stdout, '');

    const emptyStop = await runHookAsync(hook, 'agy', 'stop', { conversationId: 'c1', workspacePaths: [dir], continuationActive: true });
    assert.equal(emptyStop.code, 0);
    assert.deepEqual(JSON.parse(emptyStop.stdout), {});

    appendInbox(dir, { id: 'a1', at: '2026-01-02T00:04:00Z', author: 'lead', text: 'Skip step 3.' });
    const pre = await runHookAsync(hook, 'agy', 'pre-invocation', { conversationId: 'c1', workspacePaths: [dir], invocationNum: 2 });
    assert.equal(pre.code, 0);
    assert.deepEqual(JSON.parse(pre.stdout), {
      injectSteps: [{
        userMessage: '[alba message id=a1 from=lead at=2026-01-02T00:04:00Z]\nSkip step 3.\nAfter acting on this message, append a1 to .alba/inbox-ack; if a reply is needed, append a JSON line to .alba/outbox.jsonl with "reply": "a1".',
      }],
    });
    assert.equal(readDelivered(dir).get('a1')?.event, 'pre-invocation');

    appendInbox(dir, { id: 'a2', at: '2026-01-02T00:05:00Z', author: 'lead', text: 'Also update README.' });
    const stop = await runHookAsync(hook, 'agy', 'stop', { conversationId: 'c1', workspacePaths: [dir] });
    assert.equal(stop.code, 0);
    assert.deepEqual(JSON.parse(stop.stdout), {
      decision: 'continue',
      reason: '[alba message id=a2 from=lead at=2026-01-02T00:05:00Z]\nAlso update README.\nAfter acting on this message, append a2 to .alba/inbox-ack; if a reply is needed, append a JSON line to .alba/outbox.jsonl with "reply": "a2".',
    });
    assert.equal(readDelivered(dir).get('a2')?.event, 'stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox-hook: concurrent invocations deliver each entry exactly once', async () => {
  const { dir, hook } = makeWorktree();
  try {
    for (let i = 1; i <= 5; i++) {
      appendInbox(dir, { id: `c${i}`, at: `2026-01-02T00:0${i}:00Z`, author: 'lead', text: `Msg ${i}` });
    }
    const results = await Promise.all([
      runHookAsync(hook, 'claude', 'post-tool-use', { hook_event_name: 'PostToolUse' }),
      runHookAsync(hook, 'claude', 'post-tool-use', { hook_event_name: 'PostToolUse' }),
      runHookAsync(hook, 'claude', 'post-tool-use', { hook_event_name: 'PostToolUse' }),
    ]);
    for (const r of results) assert.equal(r.code, 0);
    const seenIds: string[] = [];
    for (const r of results) {
      if (!r.stdout.trim()) continue;
      const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
      for (const m of ctx.matchAll(/\[alba message id=(\S+)/g)) seenIds.push(m[1]);
    }
    assert.deepEqual(seenIds.sort(), ['c1', 'c2', 'c3', 'c4', 'c5']);
    const lines = readFileSync(deliveredPath(dir), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox-hook: broken inbox file prints nothing and exits 0', async () => {
  const { dir, hook } = makeWorktree();
  try {
    writeFileSync(path.join(dir, '.alba', 'inbox.md'), 'corrupt\x00binary\nnot-a-header\n', 'utf8');
    const garbage = await runHookAsync(hook, 'agy', 'stop', {});
    assert.equal(garbage.code, 0);
    assert.equal(garbage.stdout, '');

    rmSync(path.join(dir, '.alba', 'inbox.md'), { force: true });
    mkdirSync(path.join(dir, '.alba', 'inbox.md'));
    const eisdir = await runHookAsync(hook, 'claude', 'post-tool-use', 'not-json');
    assert.equal(eisdir.code, 0);
    assert.equal(eisdir.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox-hook: 16 KiB payload cap truncates cleanly with pointer to .alba/inbox.md', async () => {
  const { dir, hook } = makeWorktree();
  try {
    const big = 'A'.repeat(24 * 1024);
    appendInbox(dir, { id: 'big1', at: '2026-01-02T00:10:00Z', author: 'lead', text: big });
    const res = await runHookAsync(hook, 'claude', 'post-tool-use', {});
    assert.equal(res.code, 0);
    const text = JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string;
    assert.ok(Buffer.byteLength(text, 'utf8') <= 16 * 1024);
    assert.match(text, /\[alba message id=big1/);
    assert.match(text, /full message is in \.alba\/inbox\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('message states: sent, delivered (hook/steer), read by ack, read by later activity, and answered in readInbox & OrderDetail', async () => {
  const { orders, dir, project } = repoFixture();
  const workers = validateWorkers({
    workers: [
      { id: 'c1', engine: 'claude-cli', concurrency: 1, launch: { program: 'claude', args: ['-p', '{prompt_file}'] } },
      { id: 'cx-app', engine: 'codex-app', concurrency: 1, launch: { program: 'codex', args: [] } },
      { id: 'cx-old', engine: 'codex-cli', concurrency: 1, launch: { program: 'codex', args: ['exec', '{prompt_file}'] } },
    ],
  }, path.join(dir, 'workers.yaml'));

  orders.add({ tag: 'T1', title: 'Demo', kind: 'sim' });
  orders.act('T1', 'queue');
  const wt = path.join(dir, 'wt');
  mkdirSync(wt, { recursive: true });
  ensureInbox(wt);
  orders.update('T1', { worktree: wt });
  const eventsFile = path.join(dir, 'events.jsonl');
  orders.runStart('T1', { worker: 'c1', extra: { engine: 'claude-cli', events_file: eventsFile } });

  appendInbox(wt, { id: 'm-sent', at: '2026-01-02T00:01:00Z', author: 'cli', text: 'Not delivered yet' });
  appendInbox(wt, { id: 'm-ack', at: '2026-01-02T00:04:00Z', author: 'cli', text: 'Acked by worker' });
  appendInbox(wt, { id: 'm-act', at: '2026-01-02T00:05:00Z', author: 'cli', text: 'Followed by model activity' });
  appendInbox(wt, { id: 'm-ans', at: '2026-01-02T00:06:00Z', author: 'cli', text: 'Answered via outbox' });
  appendInbox(wt, { id: 'm-hook', at: '2026-01-02T00:07:00Z', author: 'cli', text: 'Delivered by hook' });
  appendInbox(wt, { id: 'm-steer', at: '2026-01-02T00:08:00Z', author: 'cli', text: 'Delivered by steer' });

  appendDelivered(wt, { id: 'm-ack', at: '2026-01-02T00:04:05Z', via: 'hook', event: 'post-tool-use' });
  appendDelivered(wt, { id: 'm-act', at: '2026-01-02T00:05:05Z', via: 'hook', event: 'post-tool-use' });
  appendDelivered(wt, { id: 'm-ans', at: '2026-01-02T00:06:05Z', via: 'hook', event: 'post-tool-use' });
  appendDelivered(wt, { id: 'm-hook', at: '2026-01-02T00:08:00Z', via: 'hook', event: 'post-tool-use' });
  appendDelivered(wt, { id: 'm-steer', at: '2026-01-02T00:09:00Z', via: 'steer' });

  writeFileSync(path.join(wt, '.alba', 'inbox-ack'), 'm-ack\n', 'utf8');
  orders.receiveOutbox('T1', { id: 'out-1', at: '2026-01-02T00:06:20Z', kind: 'note', text: 'Done!', reply: 'm-ans' });
  writeFileSync(eventsFile, [
    JSON.stringify({ type: 'item.started', item: { id: 'cmd1', type: 'command_execution', command: 'echo ok' }, alba_at: '2026-01-02T00:05:10Z' }),
  ].join('\n') + '\n', 'utf8');

  const msgs = readInbox(wt, { eventsFile });
  const byId = Object.fromEntries(msgs.map(m => [m.id, m]));
  assert.equal(byId['m-sent'].delivery, 'sent');
  assert.equal(byId['m-sent'].delivered_at, undefined);
  assert.equal(byId['m-hook'].delivery, 'delivered');
  assert.equal(byId['m-hook'].via, 'hook');
  assert.equal(byId['m-hook'].delivered_at, '2026-01-02T00:08:00Z');
  assert.equal(byId['m-steer'].delivery, 'delivered');
  assert.equal(byId['m-steer'].via, 'steer');
  assert.equal(byId['m-ack'].delivery, 'read');
  assert.equal(byId['m-act'].delivery, 'read');
  assert.equal(byId['m-act'].seen, '2026-01-02T00:05:10Z');

  // Verify threadOf + OrderDetail via handleApi
  const fold = new LiveFold();
  fold.event(JSON.parse(readFileSync(eventsFile, 'utf8').trim()), '2026-01-02T00:05:10Z');
  const thread = threadOf(orders.get('T1'), fold.view(new Date('2026-01-02T00:10:00Z')));
  const tById = Object.fromEntries(thread.map(e => [e.id, e]));
  assert.equal(tById['m-sent'].delivery, 'sent');
  assert.equal(tById['m-hook'].delivery, 'delivered');
  assert.equal(tById['m-hook'].via, 'hook');
  assert.equal(tById['m-steer'].delivery, 'delivered');
  assert.equal(tById['m-steer'].via, 'steer');
  assert.equal(tById['m-ack'].delivery, 'read');
  assert.equal(tById['m-act'].delivery, 'read');
  assert.equal(tById['m-ans'].delivery, 'answered');

  const probes = stubProbes({ now: () => new Date('2026-01-02T00:10:00Z') });
  const snap = { at: '2026-01-02T00:10:00Z', projects: [{ config: project, orders, rows: [], workers: [] }] };
  const req = new IncomingMessage(new Socket());
  req.method = 'GET';
  req.url = '/api/orders/T1?project=demo';
  req.headers = { host: '127.0.0.1:4000' };
  const chunks: Buffer[] = [];
  const res = new ServerResponse(req);
  res.write = ((chunk: any) => { chunks.push(Buffer.from(chunk)); return true; }) as any;
  res.end = ((chunk?: any) => { if (chunk) chunks.push(Buffer.from(chunk)); return res; }) as any;
  const hub = new Hub([], { ringSize: 16, resolveLog: () => undefined });
  try {
    await handleApi({
      instanceId: 'fixture',
      projects: [project],
      workers,
      probes,
      slow: probes,
      token: '',
      extraOrigins: [],
      snapshot: () => snap,
      peek: () => snap,
      revision: 1,
      invalidate: () => {},
      hub,
      version: '0.1.0',
    }, req, res, new URL('http://127.0.0.1:4000/api/orders/T1?project=demo'), 4000);
    assert.equal(res.statusCode, 200);
    const detail = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(detail.sayDelivery, 'live');
    const dmById = Object.fromEntries(detail.messages.map((m: any) => [m.id, m]));
    assert.equal(dmById['m-sent'].delivery, 'sent');
    assert.equal(dmById['m-hook'].delivery, 'delivered');
    assert.equal(dmById['m-hook'].via, 'hook');
    assert.equal(dmById['m-steer'].delivery, 'delivered');
    assert.equal(dmById['m-steer'].via, 'steer');
    assert.equal(dmById['m-ack'].delivery, 'read');
    assert.equal(dmById['m-act'].delivery, 'read');
    const dtById = Object.fromEntries(detail.thread.map((m: any) => [m.id, m]));
    assert.equal(dtById['m-ans'].delivery, 'answered');
  } finally {
    hub.stop();
  }
});

test('worker config live_messages defaults, validation, warnings, and alba say delivery modes', () => {
  const wf = validateWorkers({
    workers: [
      { id: 'w-claude', engine: 'claude-cli', launch: { program: 'claude', args: ['-p', '{prompt_file}'] } },
      { id: 'w-claude-off', engine: 'claude-cli', live_messages: false, launch: { program: 'claude', args: ['-p', '{prompt_file}'] } },
      { id: 'w-agy', engine: 'agy-cli', launch: { program: 'agy', args: ['-p', '{prompt_file}'] } },
      { id: 'w-codex-app', engine: 'codex-app', launch: { program: 'codex', args: [] } },
      { id: 'w-codex-cli', engine: 'codex-cli', live_messages: true, launch: { program: 'codex', args: ['exec', '{prompt_file}'] } },
      { id: 'w-remote', engine: 'claude-cli', host: 'gpu-box', launch: { program: 'claude', args: ['-p', '{prompt_file}'] } },
    ],
  }, 'workers.yaml');
  assert.equal(wf.workers.find(w => w.id === 'w-claude')?.live_messages, true);
  assert.equal(wf.workers.find(w => w.id === 'w-claude-off')?.live_messages, false);
  assert.equal(wf.workers.find(w => w.id === 'w-agy')?.live_messages, true);
  assert.equal(wf.workers.find(w => w.id === 'w-codex-app')?.live_messages, true);
  assert.equal(wf.workers.find(w => w.id === 'w-codex-cli')?.live_messages, undefined);
  assert.ok(wf.warnings?.some(w => w.includes('live_messages') && w.includes('codex-cli')));
  assert.throws(() => validateWorkers({ workers: [{ id: 'bad', engine: 'claude-cli', live_messages: 'yes' }] }, 'w.yaml'), /live_messages/);

  const { orders, dir, project } = repoFixture();
  const wt = path.join(dir, 'wt'); mkdirSync(wt);
  const ctx = { project, orders, workers: wf, probes: stubProbes() };

  for (const [tag, workerId, expected] of [
    ['T1', 'w-claude', 'live'],
    ['T2', 'w-agy', 'live'],
    ['T3', 'w-codex-app', 'steer'],
    ['T4', 'w-claude-off', 'file'],
    ['T5', 'w-codex-cli', 'file'],
    ['T6', 'w-remote', 'file'],
  ] as const) {
    orders.add({ tag, title: tag, kind: 'sim' });
    orders.act(tag, 'queue');
    orders.update(tag, { worktree: wt });
    const w = wf.workers.find(x => x.id === workerId)!;
    orders.runStart(tag, { worker: workerId, extra: { engine: w.engine, ...(w.host ? { host: w.host } : {}) } });
    const res = sayToOrder(ctx, tag, 'Check status');
    assert.equal(res.delivery, expected, workerId);
    assert.match(res.message, new RegExp(`\\(${expected}:`), workerId);
  }
});

test('launch D2: Claude gets per-run settings file with PostToolUse and Stop when live_messages is on, none when off', () => {
  const { orders, dir, project } = repoFixture();
  const workers = validateWorkers({
    workers: [
      { id: 'c-on', engine: 'claude-cli', concurrency: 2, launch: { program: 'claude', args: ['-p', '{prompt_file}'] } },
      { id: 'c-off', engine: 'claude-cli', live_messages: false, concurrency: 2, launch: { program: 'claude', args: ['-p', '{prompt_file}'] } },
    ],
  }, path.join(dir, 'workers.yaml'));
  const probes = stubProbes();
  const ctx = { project, orders, workers, probes };
  orders.add({ tag: 'T1', title: 'Demo', kind: 'sim' });
  orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'c-on');

  const wt = orders.get('T1').order.worktree!;
  const hookScript = path.resolve(wt, '.alba', 'bin', 'inbox-hook.mjs');
  assert.equal(existsSync(hookScript), true);
  const firstArgs = probes.spawned[0].args;
  const idx = firstArgs.indexOf('--settings');
  assert.ok(idx >= 0, 'Claude launch includes --settings');
  const settingsFile = firstArgs[idx + 1];
  assert.equal(existsSync(settingsFile), true);
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const postCmd: string = settings.hooks.PostToolUse[0].hooks[0].command;
  const stopCmd: string = settings.hooks.Stop[0].hooks[0].command;
  assert.ok(postCmd.includes(path.resolve(process.execPath)) && postCmd.includes(hookScript) && postCmd.endsWith('claude post-tool-use'));
  assert.ok(stopCmd.includes(path.resolve(process.execPath)) && stopCmd.includes(hookScript) && stopCmd.endsWith('claude stop'));

  // Resumed run also gets per-run settings
  orders.runEnd('T1', 'completed');
  orders.report('T1', { status: 'waiting', summary: 'Need input', question: 'Go?', evidence: [], commits: [] });
  orders.patchRun('T1', 'r1', { session: 'sess-1' });
  orders.act('T1', 'answer', { note: 'Proceed.' });
  startRun(ctx, 'T1', 'c-on');
  const resumedArgs = probes.spawned[1].args;
  assert.ok(resumedArgs.includes('--resume'));
  assert.ok(resumedArgs.includes('--settings'));
  assert.notEqual(resumedArgs[resumedArgs.indexOf('--settings') + 1], settingsFile);

  // live_messages: false gets no --settings
  orders.runEnd('T1', 'cancelled');
  startRun(ctx, 'T1', 'c-off', { explicitWorker: true });
  assert.equal(probes.spawned[2].args.includes('--settings'), false);
});

test('launch D2: agy merges into untracked .agents/hooks.json, refuses tracked one with warning, and clean removes only alba', () => {
  const { orders, dir, project } = repoFixture();
  const workers = validateWorkers({
    workers: [
      { id: 'a-on', engine: 'agy-cli', concurrency: 2, launch: { program: 'agy', args: ['-p', '{prompt_file}'] } },
      { id: 'a-off', engine: 'agy-cli', live_messages: false, concurrency: 2, launch: { program: 'agy', args: ['-p', '{prompt_file}'] } },
    ],
  }, path.join(dir, 'workers.yaml'));
  const probes = stubProbes();
  const ctx = { project, orders, workers, probes };
  orders.add({ tag: 'T1', title: 'Demo', kind: 'sim' });
  orders.act('T1', 'queue');

  // Create worktree first with an existing untracked .agents/hooks.json containing another group
  startRun(ctx, 'T1', 'a-on');
  const wt = orders.get('T1').order.worktree!;
  const hooksFile = path.join(wt, '.agents', 'hooks.json');
  assert.equal(existsSync(hooksFile), true);
  // Write a custom group and re-launch to verify merge preserves other groups
  writeFileSync(hooksFile, JSON.stringify({ custom: { Stop: [{ type: 'command', command: 'echo custom' }] } }, null, 2) + '\n', 'utf8');
  orders.runEnd('T1', 'cancelled');
  startRun(ctx, 'T1', 'a-on');
  const merged = JSON.parse(readFileSync(hooksFile, 'utf8'));
  assert.deepEqual(merged.custom, { Stop: [{ type: 'command', command: 'echo custom' }] });
  assert.match(merged.alba.PreInvocation[0].command, /agy pre-invocation$/);
  assert.match(merged.alba.Stop[0].command, /agy stop$/);
  assert.equal(/hooks\.json/.test(git(wt, 'status', '--short')), false, 'excluded locally from git');

  // Cleaning removes only "alba", keeping "custom"
  cleanInboxHooks(wt);
  const afterClean = JSON.parse(readFileSync(hooksFile, 'utf8'));
  assert.equal('alba' in afterClean, false);
  assert.deepEqual(afterClean.custom, { Stop: [{ type: 'command', command: 'echo custom' }] });

  // When "alba" is the only group, cleanAgyInboxHooks removes .agents/hooks.json completely
  writeFileSync(hooksFile, JSON.stringify({ alba: { Stop: [] } }), 'utf8');
  cleanAgyInboxHooks(wt);
  assert.equal(existsSync(hooksFile), false);

  // Tracked .agents/hooks.json: refused with warning and untouched
  const trackedContent = JSON.stringify({ team: { Stop: [{ type: 'command', command: 'echo team' }] } }) + '\n';
  mkdirSync(path.dirname(hooksFile), { recursive: true });
  writeFileSync(hooksFile, trackedContent, 'utf8');
  git(wt, 'add', '-f', '.agents/hooks.json');
  git(wt, 'commit', '-q', '-m', 'track hooks');
  orders.runEnd('T1', 'cancelled');
  startRun(ctx, 'T1', 'a-on');
  assert.equal(readFileSync(hooksFile, 'utf8'), trackedContent, 'tracked hooks.json untouched');
  const lastRun = orders.get('T1').runs.at(-1)!;
  assert.ok(lastRun.role_warnings?.some(w => w.includes('.agents/hooks.json') && w.includes('tracked')));
});

test('launch D2: remote runs install no hooks or settings files', () => {
  const { orders, dir, project } = repoFixture();
  const machinesPath = path.join(dir, 'machines.yaml');
  const remoteWorkspace = `${String.fromCharCode(67)}:/alba-remote/demo`;
  writeFileSync(machinesPath, `machines:\n  - id: gpu-box\n    name: GPU Box\n    os: windows\n    connect:\n      ssh: gpu-box\n    workspace: ${remoteWorkspace}\n`, 'utf8');
  const workers = validateWorkers({
    workers: [
      { id: 'r-claude', engine: 'claude-cli', host: 'gpu-box', launch: { program: 'claude', args: ['-p', '{prompt_file}'] } },
      { id: 'r-agy', engine: 'agy-cli', host: 'gpu-box', launch: { program: 'agy', args: ['-p', '{prompt_file}'] } },
    ],
  }, path.join(dir, 'workers.yaml'));
  const probes = stubProbes();
  const ctx = { project, orders, workers, probes };
  orders.add({ tag: 'T1', title: 'Demo', kind: 'sim' });
  orders.act('T1', 'queue');
  startRun(ctx, 'T1', 'r-claude');
  const wt = orders.get('T1').order.worktree!;
  assert.equal(existsSync(path.join(wt, '.alba', 'bin', 'inbox-hook.mjs')), false);
  const spec = JSON.parse(readFileSync(path.join(project.state_dir, 'runs', 'T1-r1.remote.json'), 'utf8'));
  assert.equal(spec.args.includes('--settings'), false);

  orders.runEnd('T1', 'cancelled');
  startRun(ctx, 'T1', 'r-agy', { explicitWorker: true });
  assert.equal(existsSync(path.join(wt, '.agents', 'hooks.json')), false);
  assert.equal(existsSync(path.join(wt, '.alba', 'bin', 'inbox-hook.mjs')), false);
});
