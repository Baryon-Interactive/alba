import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendDelivered, appendInbox, ensureInbox, inboxPath, readInbox } from '../src/run/inbox.ts';
import { applyFinish } from '../src/run/finish.ts';
import { startRun } from '../src/run/launch.ts';
import { requeueUndeliveredInbox, threadOf } from '../src/run/messages.ts';
import { REQUEUED_NOTE_NOTICE } from '../src/run/prompt.ts';
import { sayToOrder } from '../src/run/say.ts';
import { stopLoopingRun } from '../src/run/watch.ts';
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

function makeFixture() {
  const { orders, dir } = tempOrders();
  const stateDir = path.join(dir, 'state');
  const root = path.join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'Demo\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders, { recursive: true });
  writeFileSync(path.join(workOrders, 'T1-demo.md'), '# T1\nDemo task.\n');
  const projectFile = path.join(dir, 'alba.yaml');
  const project = validateProject({
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: workOrders,
    state_dir: stateDir,
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
  }, projectFile);
  writeFileSync(projectFile, [
    'id: demo',
    'name: Demo',
    `root: ${root.replace(/\\/g, '/')}`,
    `work_orders: ${workOrders.replace(/\\/g, '/')}`,
    `state_dir: ${stateDir.replace(/\\/g, '/')}`,
    'dispatch:',
    `  worktree_parent: ${path.join(dir, 'trees').replace(/\\/g, '/')}`,
    '  base_ref: refs/heads/main',
    '',
  ].join('\n'), 'utf8');
  const workers = validateWorkers({
    roles: {
      default: { kinds: ['code'] },
    },
    workers: [
      {
        id: 'w1',
        engine: 'claude-cli',
        capabilities: ['edit', 'shell', 'git'],
        launch: { program: 'claude', model: 'sonnet', args: [] },
      },
    ],
  }, path.join(dir, 'workers.yaml'));
  return { orders, dir, root, project, projectFile, workers };
}

function stubProbes(over: Partial<Probes> = {}): Probes {
  return {
    now: () => new Date('2026-01-02T01:00:00Z'),
    runCommand: () => '[]',
    freeRamGb: () => 32,
    worktrees: () => [],
    gitActivity: () => ({}),
    fileTime: () => undefined,
    isAlive: () => false,
    tail: () => '',
    readText: (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : undefined),
    spawnDetached: () => 4242,
    ...over,
  };
}

test('D1: finish requeues only untouched inbox message once and next prompt includes notice', () => {
  const { orders, dir, project, projectFile, workers } = makeFixture();
  try {
    orders.add({ tag: 'T1', title: 'Demo task', kind: 'code' });
    orders.act('T1', 'queue');
    const probes = stubProbes();
    const first = startRun({ project, orders, workers, probes }, 'T1', 'w1');
    assert.equal(first.mode, 'start');
    const worktree = first.cwd;
    const run1 = orders.get('T1').runs[0]!;
    ensureInbox(worktree);

    const t1 = '2026-01-02T00:05:00.000Z';
    const t2 = '2026-01-02T00:06:00.000Z';
    const t3 = '2026-01-02T00:07:00.000Z';
    const t4 = '2026-01-02T00:08:00.000Z';

    // 1. delivered message
    appendInbox(worktree, { id: 'msg-delivered', at: t1, author: 'alice', text: 'Already delivered.' });
    appendDelivered(worktree, { id: 'msg-delivered', at: '2026-01-02T00:05:10.000Z', via: 'hook', event: 'post-tool-use' });

    // 2. acked message
    appendInbox(worktree, { id: 'msg-acked', at: t2, author: 'alice', text: 'Already acked.' });
    writeFileSync(path.join(worktree, '.alba', 'inbox-ack'), 'msg-acked\n', 'utf8');

    // 3. legacy seen message
    appendFileSync(inboxPath(worktree), `## msg-seen ${t3} alice\nseen 2026-01-02T00:07:30.000Z\n\nAlready seen.\n\n`, 'utf8');

    // 4. untouched message
    appendInbox(worktree, { id: 'msg-untouched', at: t4, author: 'bob', text: 'Please also update build.ps1.' });

    // End run 1 with capacity (so the order stays queued for the next run)
    applyFinish(orders, {
      tag: 'T1',
      run: run1.id,
      outcome: 'capacity',
      limit: 'capacity',
      why: 'transient error',
    }, project);

    const afterFinish = orders.get('T1');
    const requeuedActions = afterFinish.actions.filter(a => a.kind === 'message' && a.requeued_from);
    assert.equal(requeuedActions.length, 1, 'only the untouched message should be requeued');
    assert.equal(requeuedActions[0]!.requeued_from, 'msg-untouched');
    assert.equal(requeuedActions[0]!.note, 'Please also update build.ps1.');
    assert.equal(requeuedActions[0]!.author, 'bob');
    assert.equal(requeuedActions[0]!.queued, true);

    // Repeating finish/requeue does NOT requeue twice
    const secondPass = requeueUndeliveredInbox(orders, 'T1', afterFinish.runs[0]);
    assert.deepEqual(secondPass, { requeued: 0, dropped: 0 });
    assert.equal(orders.get('T1').actions.filter(a => a.requeued_from === 'msg-untouched').length, 1);

    // Message state on readInbox and threadOf shows `requeued` with time and action_seq
    const inbox = readInbox(worktree);
    const untouched = inbox.find(m => m.id === 'msg-untouched');
    assert.equal(untouched?.delivery, 'requeued');
    assert.ok(untouched?.requeued_at);
    assert.equal(untouched?.action_seq, requeuedActions[0]!.seq);
    assert.equal(inbox.find(m => m.id === 'msg-delivered')?.delivery, 'delivered');
    assert.equal(inbox.find(m => m.id === 'msg-acked')?.delivery, 'read');
    assert.equal(inbox.find(m => m.id === 'msg-seen')?.delivery, 'read');

    const threadBeforeRun2 = threadOf(orders.get('T1'));
    const inboxEntry = threadBeforeRun2.find(e => e.id === 'msg-untouched');
    assert.equal(inboxEntry?.delivery, 'requeued');
    assert.ok(inboxEntry?.requeued_at);
    const actionEntryBefore = threadBeforeRun2.find(e => e.id === `action-${requeuedActions[0]!.seq}`);
    assert.equal(actionEntryBefore?.delivery, 'sent');

    // Launch next run and verify prompt contains the requeued message AND the "may already be handled" notice
    const second = startRun({ project, orders, workers, probes }, 'T1', 'w1');
    assert.equal(second.mode, 'start');
    const run2 = orders.get('T1').runs[1]!;
    assert.ok(run2.prompt_file);
    const promptText = readFileSync(run2.prompt_file!, 'utf8');
    assert.ok(promptText.includes('Please also update build.ps1.'), 'next prompt must include the requeued message text');
    assert.ok(promptText.includes(REQUEUED_NOTE_NOTICE), 'next prompt must include the may-already-be-handled sentence');

    // Requeued action now transitions through normal states (delivered while run2 is open, read once run2 completes with a report)
    const threadDuringRun2 = threadOf(orders.get('T1'));
    assert.equal(threadDuringRun2.find(e => e.id === `action-${requeuedActions[0]!.seq}`)?.delivery, 'delivered');

    applyFinish(orders, {
      tag: 'T1',
      run: run2.id,
      outcome: 'completed',
      report: { status: 'ready', summary: 'Done', evidence: [], commits: [] },
      why: 'completed',
    }, project);

    // Ending run 2 must NOT requeue msg-untouched a second time
    assert.equal(orders.get('T1').actions.filter(a => a.requeued_from === 'msg-untouched').length, 1);
    const threadAfterRun2 = threadOf(orders.get('T1'));
    assert.equal(threadAfterRun2.find(e => e.id === `action-${requeuedActions[0]!.seq}`)?.delivery, 'read');
    void projectFile;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D1: merged, cancelled, and dropped orders mark untouched inbox messages as dropped', () => {
  const { orders, dir, project, workers } = makeFixture();
  try {
    const probes = stubProbes();

    // Case 1: merged order
    orders.add({ tag: 'T1', title: 'Merged order', kind: 'code' });
    orders.act('T1', 'queue');
    const r1 = startRun({ project, orders, workers, probes }, 'T1', 'w1');
    assert.equal(r1.mode, 'start');
    appendInbox(r1.cwd, { id: 'msg-merged', at: '2026-01-02T00:05:00.000Z', author: 'lead', text: 'Late note.' });
    orders.act('T1', 'approve', { force: true, note: 'Merged directly' });
    applyFinish(orders, {
      tag: 'T1',
      run: orders.get('T1').runs[0]!.id,
      outcome: 'completed',
      why: 'ended after merge',
    }, project);

    assert.equal(orders.get('T1').actions.filter(a => a.requeued_from === 'msg-merged').length, 0);
    const msgMerged = readInbox(r1.cwd).find(m => m.id === 'msg-merged');
    assert.equal(msgMerged?.delivery, 'dropped');
    assert.ok(msgMerged?.dropped_at);
    assert.match(msgMerged?.drop_reason ?? '', /merged/);

    // Case 2: dropped report
    writeFileSync(path.join(project.work_orders, 'T2-demo.md'), '# T2\nDemo 2.\n');
    orders.add({ tag: 'T2', title: 'Dropped order', kind: 'code' });
    orders.act('T2', 'queue');
    const r2 = startRun({ project, orders, workers, probes }, 'T2', 'w1');
    assert.equal(r2.mode, 'start');
    appendInbox(r2.cwd, { id: 'msg-dropped', at: '2026-01-02T00:10:00.000Z', author: 'lead', text: 'Note on dropped.' });
    applyFinish(orders, {
      tag: 'T2',
      run: orders.get('T2').runs[0]!.id,
      outcome: 'completed',
      report: { status: 'dropped', summary: 'Not needed', evidence: [], commits: [] },
      why: 'worker dropped',
    }, project);
    assert.equal(orders.get('T2').actions.filter(a => a.requeued_from === 'msg-dropped').length, 0);
    const msgDropped = readInbox(r2.cwd).find(m => m.id === 'msg-dropped');
    assert.equal(msgDropped?.delivery, 'dropped');
    assert.match(msgDropped?.drop_reason ?? '', /dropped/);

    // Case 3: cancelled order (via orders.act('T3', 'cancel'))
    writeFileSync(path.join(project.work_orders, 'T3-demo.md'), '# T3\nDemo 3.\n');
    orders.add({ tag: 'T3', title: 'Cancelled order', kind: 'code' });
    orders.act('T3', 'queue');
    const r3 = startRun({ project, orders, workers, probes }, 'T3', 'w1');
    assert.equal(r3.mode, 'start');
    appendInbox(r3.cwd, { id: 'msg-cancelled', at: '2026-01-02T00:20:00.000Z', author: 'lead', text: 'Note on cancelled.' });
    orders.act('T3', 'cancel');
    assert.equal(orders.get('T3').actions.filter(a => a.requeued_from === 'msg-cancelled').length, 0);
    const msgCancelled = readInbox(r3.cwd).find(m => m.id === 'msg-cancelled');
    assert.equal(msgCancelled?.delivery, 'dropped');
    assert.match(msgCancelled?.drop_reason ?? '', /cancelled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D1: killed-by-alba and say --restart requeue untouched messages, and alba orders show displays states', async () => {
  const { orders, dir, project, projectFile, workers } = makeFixture();
  try {
    const probes = stubProbes({
      isAlive: () => true,
      processStartedAt: () => '2026-01-02T00:00:00.000Z',
      kill: (pid) => [pid],
    });

    // 1. killed-by-alba via stopLoopingRun
    orders.add({ tag: 'T1', title: 'Loop stop', kind: 'code' });
    orders.act('T1', 'queue');
    const r1 = startRun({ project, orders, workers, probes }, 'T1', 'w1');
    assert.equal(r1.mode, 'start');
    appendInbox(r1.cwd, { id: 'msg-loop', at: '2026-01-02T00:05:00.000Z', author: 'lead', text: 'Try another approach.' });
    stopLoopingRun(project, orders, probes, 'T1', ['repeated command']);
    assert.equal(orders.get('T1').actions.filter(a => a.requeued_from === 'msg-loop').length, 1);
    assert.equal(readInbox(r1.cwd).find(m => m.id === 'msg-loop')?.delivery, 'requeued');

    // 2. say --restart requeues earlier untouched message before the restart message
    writeFileSync(path.join(project.work_orders, 'T2-demo.md'), '# T2\nRestart test.\n');
    orders.add({ tag: 'T2', title: 'Restart test', kind: 'code' });
    orders.act('T2', 'queue');
    const r2 = startRun({ project, orders, workers, probes }, 'T2', 'w1');
    assert.equal(r2.mode, 'start');
    appendInbox(r2.cwd, { id: 'msg-before-restart', at: '2026-01-02T00:15:00.000Z', author: 'lead', text: 'Earlier note.' });
    const sayRes = sayToOrder({ project, orders, workers, probes }, 'T2', 'New urgent direction.', { restart: true });
    assert.equal(sayRes.restarted, true);
    const t2Actions = orders.get('T2').actions.filter(a => a.kind === 'message');
    assert.equal(t2Actions.length, 2);
    assert.equal(t2Actions[0]!.requeued_from, 'msg-before-restart');
    assert.equal(t2Actions[1]!.note, 'New urgent direction.');

    // Verify `alba orders show` prints the Messages section with requeued state
    const cliEntry = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
    const runCli = (...args: string[]) => execFileSync(process.execPath, [cliEntry, ...args], { encoding: 'utf8', windowsHide: true });
    runCli('orders', 'add', 'T9', '--title', 'Show test', '--kind', 'code', '--project', projectFile);
    const wt = path.join(dir, 'wt-show');
    mkdirSync(wt, { recursive: true });
    runCli('orders', 'set', 'T9', '--worktree', wt, '--project', projectFile);
    runCli('orders', 'run-start', 'T9', '--worker', 'w1', '--project', projectFile);
    appendInbox(wt, { id: 'msg-show', at: new Date(Date.now() + 1000).toISOString(), author: 'lead', text: 'Check CLI show.' });
    runCli('orders', 'run-end', 'T9', '--outcome', 'failed', '--project', projectFile);
    const shown = runCli('orders', 'show', 'T9', '--project', projectFile);
    assert.match(shown, /Messages:/);
    assert.match(shown, /requeued/);
    assert.match(shown, /Check CLI show\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
