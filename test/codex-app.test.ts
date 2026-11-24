import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appendInbox, readDelivered, readInbox } from '../src/run/inbox.ts';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { descendantPids, processSnapshotAsync } from '../src/run/kill-tree.ts';
import { startRun } from '../src/run/launch.ts';
import { LiveFold } from '../src/run/live.ts';
import { TranscriptFold } from '../src/run/transcript.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { parseCodexAppFlags } from '../src/workers/adapters/codex-app.ts';
import { createAppEventTranslator } from '../src/workers/adapters/codex-app-run.mjs';
import { parseStreamLog } from '../src/workers/adapters/stream.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

const fakeApp = path.join(import.meta.dirname, 'fixtures', 'fake-codex-app.mjs');
const runnerPath = path.resolve(import.meta.dirname, '..', 'src', 'workers', 'adapters', 'codex-app-run.mjs');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  });

async function waitUntil(check: () => boolean, timeoutMs = 15000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function setup(mode: string, extraWorker: Record<string, unknown> = {}, extraArgs: string[] = []) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'repo');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'Demo repo\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-demo.md'), '# T1\nBuild and test.\n');
  const codexHome = path.join(dir, 'isolated-codex-home');
  mkdirSync(codexHome);
  const rpcLog = path.join(dir, 'fake-app.jsonl');
  const pidFile = path.join(dir, 'fake-app.pid');
  const project = validateProject({
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: workOrders,
    state_dir: path.join(dir, 'state'),
    dispatch: { base_ref: 'main', worktree_parent: path.join(dir, 'trees') },
  }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({
    workers: [{
      id: 'codex-live',
      engine: 'codex-app',
      model: 'gpt-test',
      ...extraWorker,
      launch: {
        program: fakeApp,
        args: ['-s', 'workspace-write', '-a', 'never', '-c', 'model_reasoning_effort="high"', ...extraArgs],
        env: {
          FAKE_CODEX_APP_MODE: mode,
          FAKE_CODEX_APP_LOG: rpcLog,
          FAKE_CODEX_APP_PID: pidFile,
          CODEX_HOME: codexHome,
        },
      },
    }],
  }, path.join(dir, 'workers.yaml'));
  orders.add({ tag: 'T1', title: 'Demo', kind: 'sim' });
  orders.act('T1', 'queue');
  return { orders, dir, project, workers, rpcLog, pidFile, codexHome };
}

test('codex-app config: maps supported codex exec flags and refuses unmapped flags at config load', () => {
  const parsed = parseCodexAppFlags(['exec', '-C', '{cwd}', '-s', 'workspace-write', '-a', 'never', '-c', 'foo="bar"', '-m', 'gpt-x', '-o', '{last_file}', '--json', '--skip-git-repo-check', 'Read {prompt_file}']);
  assert.deepEqual(parsed, { config: ['foo="bar"'], model: 'gpt-x', sandbox: 'workspace-write', approvalPolicy: 'never' });

  const fullAuto = parseCodexAppFlags(['--full-auto']);
  assert.equal(fullAuto.approvalPolicy, 'on-request');
  assert.equal(fullAuto.sandbox, 'workspace-write');

  const bypass = parseCodexAppFlags(['--dangerously-bypass-approvals-and-sandbox']);
  assert.equal(bypass.approvalPolicy, 'never');
  assert.equal(bypass.sandbox, 'danger-full-access');

  // Unmapped flag refused at validateWorkers config load
  assert.throws(() => validateWorkers({
    workers: [{ id: 'bad', engine: 'codex-app', launch: { program: 'codex', args: ['--profile', 'personal'] } }],
  }, 'workers.yaml'), /cannot map flag "--profile"/);

  assert.throws(() => validateWorkers({
    workers: [{ id: 'bad2', engine: 'codex-app', launch: { program: 'codex', args: ['--sandbox', 'invalid-mode'] } }],
  }, 'workers.yaml'), /unsupported sandbox mode/);
});

test('codex-app event translation: exec fixture and translated app-server fixture produce identical LiveFold and TranscriptFold results', () => {
  const execText = readFileSync(path.join(import.meta.dirname, 'fixtures', 'transcript-codex.jsonl'), 'utf8');
  const appText = readFileSync(path.join(import.meta.dirname, 'fixtures', 'codex-app-notifications.jsonl'), 'utf8');

  const translator = createAppEventTranslator();
  const convertedLines: string[] = [];
  for (const line of appText.trim().split(/\r?\n/)) {
    for (const ev of translator.translate(JSON.parse(line))) {
      convertedLines.push(JSON.stringify(ev));
    }
  }
  const convertedText = convertedLines.join('\n') + '\n';

  const now = new Date('2026-02-10T09:00:20.000Z');
  const execLive = new LiveFold();
  for (const line of execText.trim().split(/\r?\n/)) execLive.event(JSON.parse(line), '2026-02-10T09:00:00.000Z');
  const appLive = new LiveFold();
  for (const line of convertedLines) appLive.event(JSON.parse(line), '2026-02-10T09:00:00.000Z');
  assert.deepEqual(appLive.view(now), execLive.view(now));

  const execTranscript = new TranscriptFold();
  execTranscript.push(execText, '2026-02-10T09:00:00.000Z');
  const appTranscript = new TranscriptFold();
  appTranscript.push(convertedText, '2026-02-10T09:00:00.000Z');
  assert.deepEqual(appTranscript.entries(), execTranscript.entries());

  const appStream = parseStreamLog(convertedText);
  const execStream = parseStreamLog(execText);
  assert.deepEqual(
    { sessionId: appStream.sessionId, finalText: appStream.finalText, ended: appStream.ended, errors: appStream.errors },
    { sessionId: execStream.sessionId, finalText: execStream.finalText, ended: execStream.ended, errors: execStream.errors },
  );
});

test('codex-app: steers a running turn via turn/steer, writes last_file, and writes nothing to CODEX_HOME', async () => {
  const ctx = setup('steer');
  startRun({ ...ctx, probes: systemProbes }, 'T1', 'codex-live');
  const run = ctx.orders.get('T1').runs[0];
  const wt = ctx.orders.get('T1').order.worktree!;

  // Wait for turn 1 to start
  await waitUntil(() => existsSync(ctx.rpcLog) && readFileSync(ctx.rpcLog, 'utf8').includes('"turn/start"'), 15000, 'turn/start');
  appendInbox(wt, { id: 'm-steer-1', at: '2026-01-02T00:00:05Z', author: 'lead', text: 'Use layout B.' });

  await waitUntil(() => !systemProbes.isAlive(run.pid!), 15000, 'codex-app exit');

  const calls = readFileSync(ctx.rpcLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const spawnCall = calls.find(c => c.event === 'spawn');
  assert.ok(spawnCall.args.includes('-c') && spawnCall.args.includes('model_reasoning_effort="high"'));
  assert.equal(spawnCall.args.at(-1), 'app-server');

  const threadStart = calls.find(c => c.method === 'thread/start');
  assert.equal(threadStart.params.model, 'gpt-test');
  assert.equal(threadStart.params.sandbox, 'workspace-write');
  assert.equal(threadStart.params.approvalPolicy, 'never');

  const steerCall = calls.find(c => c.method === 'turn/steer');
  assert.ok(steerCall, 'sent turn/steer during running turn');
  assert.equal(steerCall.params.threadId, 'thread-fake-1');
  assert.equal(steerCall.params.expectedTurnId, 'turn-1');
  assert.match(steerCall.params.input[0].text, /\[alba message id=m-steer-1.*Use layout B\./s);

  const delivered = readDelivered(wt).get('m-steer-1');
  assert.equal(delivered?.via, 'steer');

  assert.match(readFileSync(run.last_file!, 'utf8'), /Steered turn done: Use layout B\./);
  const [fin] = findFinishes(ctx.project, ctx.orders, systemProbes, ctx.workers);
  assert.equal(fin.outcome, 'completed');
  assert.equal(fin.session, 'thread-fake-1');
  assert.match(fin.report?.summary ?? '', /Steered turn done: Use layout B\./);
  assert.deepEqual(readdirSync(ctx.codexHome), [], 'nothing written to CODEX_HOME');
});

test('codex-app: refused steer falls back to turn/start and records via=turn', async () => {
  const ctx = setup('refused-steer');
  startRun({ ...ctx, probes: systemProbes }, 'T1', 'codex-live');
  const run = ctx.orders.get('T1').runs[0];
  const wt = ctx.orders.get('T1').order.worktree!;

  await waitUntil(() => existsSync(ctx.rpcLog) && readFileSync(ctx.rpcLog, 'utf8').includes('"turn/start"'), 15000, 'turn 1 start');
  appendInbox(wt, { id: 'm-refused', at: '2026-01-02T00:00:06Z', author: 'lead', text: 'Retry after turn end.' });

  await waitUntil(() => !systemProbes.isAlive(run.pid!), 15000, 'codex-app exit after fallback turn');

  const calls = readFileSync(ctx.rpcLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(calls.filter(c => c.method === 'turn/steer').length, 1);
  const starts = calls.filter(c => c.method === 'turn/start');
  assert.equal(starts.length, 2, 'fell back to a second turn/start');
  assert.match(starts[1].params.input[0].text, /Retry after turn end\./);
  assert.equal(readDelivered(wt).get('m-refused')?.via, 'turn');
  assert.match(readFileSync(run.last_file!, 'utf8'), /Follow-up turn 2: Retry after turn end\./);
});

test('codex-app: late message arriving during the 3-second post-turn grace window starts a new turn', async () => {
  const ctx = setup('ok');
  startRun({ ...ctx, probes: systemProbes }, 'T1', 'codex-live');
  const run = ctx.orders.get('T1').runs[0];
  const wt = ctx.orders.get('T1').order.worktree!;

  // Wait for turn 1 to finish (turn.completed in events file), then send a message inside the 3-second window
  await waitUntil(() => !!run.events_file && existsSync(run.events_file) && readFileSync(run.events_file, 'utf8').includes('"turn.completed"'), 15000, 'turn 1 completed');
  assert.equal(systemProbes.isAlive(run.pid!), true, 'still alive in 3-second grace window');
  appendInbox(wt, { id: 'm-late', at: '2026-01-02T00:00:07Z', author: 'lead', text: 'Catch this before exit.' });

  await waitUntil(() => !systemProbes.isAlive(run.pid!), 15000, 'exit after late turn');

  const calls = readFileSync(ctx.rpcLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const starts = calls.filter(c => c.method === 'turn/start');
  assert.equal(starts.length, 2, 'late message triggered turn 2');
  assert.match(starts[1].params.input[0].text, /Catch this before exit\./);
  assert.equal(readDelivered(wt).get('m-late')?.via, 'turn');
  assert.equal(readInbox(wt, { eventsFile: run.events_file! })[0].delivery, 'read');
  assert.match(readFileSync(run.last_file!, 'utf8'), /Catch this before exit\./);
});

test('codex-app: resume uses thread/resume with previous thread id', async () => {
  const ctx = setup('ok');
  startRun({ ...ctx, probes: systemProbes }, 'T1', 'codex-live');
  const r1 = ctx.orders.get('T1').runs[0];
  await waitUntil(() => !systemProbes.isAlive(r1.pid!), 15000, 'r1 exit');

  const [fin1] = findFinishes(ctx.project, ctx.orders, systemProbes, ctx.workers);
  assert.equal(fin1.session, 'thread-fake-1');
  applyFinish(ctx.orders, fin1, ctx.project);
  // Make the order waiting so answer triggers a resume
  ctx.orders.report('T1', { status: 'waiting', summary: 'Need confirmation', question: 'Proceed?', evidence: [], commits: [] });
  ctx.orders.act('T1', 'answer', { note: 'Yes, proceed.' });

  startRun({ ...ctx, probes: systemProbes }, 'T1', 'codex-live');
  const r2 = ctx.orders.get('T1').runs[1];
  await waitUntil(() => !systemProbes.isAlive(r2.pid!), 15000, 'r2 exit');

  const calls = readFileSync(ctx.rpcLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const resumeCall = calls.find(c => c.method === 'thread/resume');
  assert.ok(resumeCall, 'called thread/resume on resumed run');
  assert.equal(resumeCall.params.threadId, 'thread-fake-1');
});

test('codex-app: failed turn exits non-zero with error on stderr', async () => {
  const { dir } = tempOrders();
  const wt = path.join(dir, 'wt');
  mkdirSync(wt);
  const promptFile = path.join(dir, 'prompt.md');
  writeFileSync(promptFile, 'Do work.\n', 'utf8');
  const specFile = path.join(dir, 'spec.json');
  writeFileSync(specFile, JSON.stringify({
    codexProgram: fakeApp,
    config: [],
    cwd: wt,
    promptFile,
    lastFile: path.join(dir, 'last.txt'),
    model: 'gpt-test',
    idleGraceMs: 100,
    pollIntervalMs: 50,
  }), 'utf8');

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [runnerPath, '--spec', specFile], {
      env: { ...process.env, FAKE_CODEX_APP_MODE: 'fail' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Synthetic model failure/);
  assert.match(result.stdout, /"type":"turn\.failed"/);
});

test('codex-app: stopping the run from Alba leaves no app-server process behind', async () => {
  const ctx = setup('hang');
  startRun({ ...ctx, probes: systemProbes }, 'T1', 'codex-live');
  const run = ctx.orders.get('T1').runs[0];
  let appPid = 0;
  try {
    await waitUntil(() => existsSync(ctx.pidFile), 15000, 'fake app-server pid');
    appPid = Number(readFileSync(ctx.pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(appPid) && appPid > 0);
    assert.equal(systemProbes.isAlive(appPid), true, 'app-server is running');

    systemProbes.kill!(run.pid!, run.process_started_at, run.started);

    // The stop takes a process snapshot first, which is slow on a loaded machine.
    await waitUntil(() => !systemProbes.isAlive(run.pid!) && !systemProbes.isAlive(appPid), 30000, 'both driver and app-server exited');
    assert.equal(systemProbes.isAlive(appPid), false, 'no app-server left behind');
  } finally {
    // When an assertion above fails, the hanging tree is still there and holds the test runner's pipes: end it here.
    await killLeftovers(run.pid, appPid);
  }
});

/** Ends `rootPid`, everything under it, and `extraPid`, without identity checks: test cleanup of processes this file started. */
async function killLeftovers(rootPid: number | undefined, extraPid: number): Promise<void> {
  const pids = new Set<number>();
  if (rootPid && systemProbes.isAlive(rootPid)) {
    try { for (const pid of descendantPids(await processSnapshotAsync(), rootPid)) pids.add(pid); } catch { /* the snapshot is best effort */ }
    pids.add(rootPid);
  }
  if (extraPid > 0) pids.add(extraPid);
  for (const pid of pids) {
    if (!systemProbes.isAlive(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
