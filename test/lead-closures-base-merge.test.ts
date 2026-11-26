import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ORDER_ACTIONS } from '../src/api/types.ts';
import { mergeBaseBeforeReview } from '../src/check/base-merge.ts';
import { deliveryChecks } from '../src/check/delivery.ts';
import { closeStateStores } from '../src/orders/backend.ts';
import { closeOrder } from '../src/orders/close.ts';
import { parseReportBlock } from '../src/orders/report.ts';
import { roleResults } from '../src/roles/statistics.ts';
import { workerHistory } from '../src/routing/history.ts';
import { applyFinish } from '../src/run/finish.ts';
import { verifyOrder } from '../src/verify/verify.ts';
import type { WorkerConfig } from '../src/workers/config.ts';
import { fixture as apiFixture } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { tmpDir } from './tmp.ts';

const tempDirs: string[] = [];
after(() => {
  closeStateStores();
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeTempRepo() {
  const { orders, dir } = tempOrders();
  tempDirs.push(dir);
  const root = path.join(dir, 'repo');
  const workOrders = path.join(dir, 'work-orders');
  const wtParent = path.join(dir, 'worktrees');
  mkdirSync(root, { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  mkdirSync(wtParent, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'readme.txt'), 'initial\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial commit');
  const initialSha = git(root, 'rev-parse', 'HEAD');

  const makeProject = (extra: Record<string, unknown> = {}) => {
    const dispatchExtra = (extra.dispatch as Record<string, unknown> | undefined) ?? {};
    const checksExtra = (extra.checks as Record<string, unknown> | undefined) ?? {};
    const rest = { ...extra };
    delete rest.dispatch;
    delete rest.checks;
    return validateProject({
      id: 'demo',
      name: 'Demo',
      root,
      work_orders: workOrders,
      state_dir: path.join(dir, 'state'),
      dispatch: { base_ref: 'main', worktree_parent: wtParent, ...dispatchExtra },
      checks: { clean_worktree: true, ahead_of_base: true, encoding_scan: true, ...checksExtra },
      ...rest,
    }, path.join(dir, 'alba.yaml'));
  };

  return { orders, dir, root, workOrders, wtParent, initialSha, project: makeProject(), makeProject };
}

// 1. Close
test('closeOrder: merged-elsewhere and done-by-lead satisfy needs, record full SHA, refuse invalid states/inputs, and clear cancelled', () => {
  const f = makeTempRepo();
  writeFileSync(path.join(f.root, 'landed.txt'), 'landed in another order\n', 'utf8');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-qm', 'land feature on main');
  const baseSha = git(f.root, 'rev-parse', 'HEAD');

  git(f.root, 'checkout', '-qb', 'unmerged-side', f.initialSha);
  writeFileSync(path.join(f.root, 'side.txt'), 'not merged\n', 'utf8');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-qm', 'side commit');
  const sideSha = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'checkout', '-q', 'main');

  f.orders.add({ tag: 'T1', title: 'Landed elsewhere', kind: 'code' });
  f.orders.add({ tag: 'DEP1', title: 'Depends on T1', kind: 'code', needs: ['T1'] });
  f.orders.act('DEP1', 'queue');
  assert.equal(f.orders.stage(f.orders.get('DEP1')).stage, 'waiting-needs');

  // Commit not on base is refused, naming both the base and the resolved SHA
  assert.throws(
    () => closeOrder(f.project, f.orders, 'T1', { how: 'merged-elsewhere', commit: sideSha.slice(0, 8) }),
    new RegExp(`${sideSha}.*refs/heads/main|refs/heads/main.*${sideSha}`),
  );
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'draft');

  // Closing with a short SHA on the base resolves to full SHA, sets merged, wakes dependent, writes no accept file
  const closed = closeOrder(f.project, f.orders, 'T1', { how: 'merged-elsewhere', commit: baseSha.slice(0, 7), note: 'Landed via fixup' });
  const t1Stage = f.orders.stage(closed);
  assert.equal(t1Stage.stage, 'merged');
  assert.equal(t1Stage.why, `closed by the lead: merged elsewhere in ${baseSha.slice(0, 7)}`);
  assert.equal(f.orders.stage(f.orders.get('DEP1')).stage, 'queued');
  assert.equal(closed.actions.at(-1)?.commit, baseSha);
  assert.equal(existsSync(path.join(f.workOrders, 'T1.accept.md')), false);

  const event = f.orders.store.events({ tag: 'T1' }).find(e => e.type === 'action-merged-elsewhere');
  assert.ok(event);
  assert.equal(event.data?.commit, baseSha);
  assert.equal(event.data?.from, 'draft');
  assert.equal(event.data?.note, 'Landed via fixup');

  // Already merged order is refused
  assert.throws(
    () => closeOrder(f.project, f.orders, 'T1', { how: 'done-by-lead', note: 'Trying to close again' }),
    /cannot close an order that is merged/,
  );

  // Missing or short note for done-by-lead is refused
  f.orders.add({ tag: 'T2', title: 'Done manually', kind: 'code' });
  assert.throws(() => closeOrder(f.project, f.orders, 'T2', { how: 'done-by-lead' }), /at least 10 characters/);
  assert.throws(() => closeOrder(f.project, f.orders, 'T2', { how: 'done-by-lead', note: 'too short' }), /at least 10 characters/);

  // Running order and monitoring order are refused with "stop the run first"
  f.orders.add({ tag: 'RUN1', title: 'Currently running', kind: 'code' });
  f.orders.act('RUN1', 'queue');
  f.orders.runStart('RUN1', { worker: 'coder' });
  assert.throws(
    () => closeOrder(f.project, f.orders, 'RUN1', { how: 'done-by-lead', note: 'Should refuse active run' }),
    /stop the run first/,
  );

  f.orders.add({ tag: 'MON1', title: 'Being monitored', kind: 'code' });
  f.orders.report('MON1', {
    status: 'monitoring',
    summary: 'long build',
    evidence: [],
    commits: [],
    monitor: { check: ['node', '-e', 'process.exit(1)'], done_when: { exit_code: 0 }, deadline_minutes: 30 },
  });
  assert.equal(f.orders.stage(f.orders.get('MON1')).stage, 'monitoring');
  assert.throws(
    () => closeOrder(f.project, f.orders, 'MON1', { how: 'done-by-lead', note: 'Should refuse monitoring order' }),
    /stop the run first/,
  );

  // A cancelled order can be closed (correcting a bookkeeping cancel)
  f.orders.add({ tag: 'CAN1', title: 'Bookkeeping cancel', kind: 'code' });
  f.orders.add({ tag: 'DEP2', title: 'Needs CAN1', kind: 'code', needs: ['CAN1'] });
  f.orders.act('DEP2', 'queue');
  f.orders.act('CAN1', 'cancel');
  assert.equal(f.orders.stage(f.orders.get('CAN1')).stage, 'cancelled');
  const reopened = closeOrder(f.project, f.orders, 'CAN1', {
    how: 'done-by-lead',
    commit: baseSha.slice(0, 8),
    note: 'Done directly by the lead session',
  });
  assert.equal(f.orders.stage(reopened).stage, 'merged');
  assert.equal(f.orders.stage(reopened).why, 'closed by the lead: done by hand');
  assert.equal(f.orders.stage(f.orders.get('DEP2')).stage, 'queued');
  const leadEvent = f.orders.store.events({ tag: 'CAN1' }).find(e => e.type === 'action-done-by-lead');
  assert.ok(leadEvent);
  assert.equal(leadEvent.data?.from, 'cancelled');
  assert.equal(leadEvent.data?.commit, baseSha);
});

// 2. CLI
test('CLI: alba orders close runs as a process both ways and rejects both/neither flags', () => {
  const f = makeTempRepo();
  const yamlPath = path.join(f.dir, 'alba.yaml');
  writeFileSync(
    yamlPath,
    [
      'id: demo',
      'name: Demo',
      `root: ${JSON.stringify(f.root)}`,
      `work_orders: ${JSON.stringify(f.workOrders)}`,
      `state_dir: ${JSON.stringify(path.join(f.dir, 'cli-state'))}`,
      'dispatch:',
      '  base_ref: main',
    ].join('\n') + '\n',
    'utf8',
  );
  const cli = path.resolve(import.meta.dirname, '../src/cli/main.ts');
  const runCli = (...args: string[]) => spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', cli, '--project', yamlPath, ...args],
    { encoding: 'utf8', windowsHide: true },
  );

  assert.equal(runCli('orders', 'add', 'C1', '--title', 'First', '--kind', 'code').status, 0);
  assert.equal(runCli('orders', 'add', 'C2', '--title', 'Second', '--kind', 'code').status, 0);
  assert.equal(runCli('orders', 'add', 'C3', '--title', 'Third', '--kind', 'code').status, 0);

  const neither = runCli('orders', 'close', 'C3');
  assert.notEqual(neither.status, 0);
  assert.match(neither.stderr, /Usage: alba orders close/);

  const both = runCli('orders', 'close', 'C3', '--merged-elsewhere', f.initialSha, '--done-by-lead', '--note', 'Ten chars!!');
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /Usage: alba orders close/);

  const res1 = runCli('orders', 'close', 'C1', '--merged-elsewhere', f.initialSha.slice(0, 7));
  assert.equal(res1.status, 0, res1.stderr);
  assert.match(res1.stdout, /^C1: merged/m);
  assert.match(res1.stdout, new RegExp(`closed by the lead: merged elsewhere in ${f.initialSha.slice(0, 7)}`));

  const res2 = runCli('orders', 'close', 'C2', '--done-by-lead', '--note', 'Completed by the lead by hand');
  assert.equal(res2.status, 0, res2.stderr);
  assert.match(res2.stdout, /^C2: merged/m);
  assert.match(res2.stdout, /closed by the lead: done by hand/);
});

// 3. Statistics
test('statistics: workerHistory and roleResults ignore closed runs while keeping missing-report failures', () => {
  const f = makeTempRepo();
  const workers: WorkerConfig[] = [{
    id: 'coder',
    engine: 'codex-cli',
    paid: false,
    cost: 'included',
    concurrency: 1,
    capabilities: ['shell', 'edit', 'git'],
    enabled: true,
    card_only: false,
    aliases: [],
    disabled_when: [],
  }];

  const addCompletedRun = (tag: string, status: 'ready' | 'failed') => {
    f.orders.add({ tag, title: tag, kind: 'code', role: 'impl' });
    f.orders.act(tag, 'queue');
    const { run } = f.orders.runStart(tag, { worker: 'coder', extra: { role: 'impl', usage: { source: 'codex-json', total_tokens: 1000 } } });
    f.orders.runEnd(tag, 'completed');
    f.orders.report(tag, { status, summary: `${tag} ${status}`, evidence: [], commits: [] });
    return run;
  };

  // Order 1: approved
  addCompletedRun('S1', 'ready');
  f.orders.act('S1', 'approve');

  // Order 2: reworked
  addCompletedRun('S2', 'ready');
  f.orders.act('S2', 'rework', { note: 'Please fix edge case' });

  // Order 3: closed after a failed report (plus an earlier failed run without a report)
  f.orders.add({ tag: 'S3', title: 'S3', kind: 'code', role: 'impl' });
  f.orders.act('S3', 'queue');
  const died = f.orders.runStart('S3', { worker: 'coder', extra: { role: 'impl', missing_report: true } }).run;
  f.orders.runEnd('S3', 'failed', { kind: 'nonzero-exit', detail: 'exit 1', why: 'process died without report' });
  assert.ok(died);
  f.orders.runStart('S3', { worker: 'coder', extra: { role: 'impl', usage: { source: 'codex-json', total_tokens: 1200 } } });
  f.orders.runEnd('S3', 'completed');
  f.orders.report('S3', { status: 'failed', summary: 'worker hit wall', evidence: [], commits: [] });
  closeOrder(f.project, f.orders, 'S3', { how: 'done-by-lead', note: 'Finished manually by the lead' });

  // Check closed order alone without the missing-report run adds nothing to workerHistory
  const s3DeliveredOnly = { ...f.orders.get('S3'), runs: f.orders.get('S3').runs.slice(1) };
  assert.deepEqual(workerHistory([s3DeliveredOnly], workers), {});

  const hist = workerHistory([f.orders.get('S1'), f.orders.get('S2'), s3DeliveredOnly], workers);
  assert.equal(hist.coder.code.accepted, 1);
  assert.equal(hist.coder.code.reworked, 1);
  assert.equal(hist.coder.code.samples, 2);

  // With the missing-report failed run included, failed still counts as failed
  const histWithFailed = workerHistory(f.orders.all(), workers);
  assert.equal(histWithFailed.coder.code.accepted, 1);
  assert.equal(histWithFailed.coder.code.reworked, 1);
  assert.equal(histWithFailed.coder.code.failed, 1);
  assert.equal(histWithFailed.coder.code.samples, 3);

  const roles = roleResults(f.orders.all(), [], '', '2099-01-01T00:00:00.000Z');
  assert.equal(roles.length, 1);
  assert.equal(roles[0].accepted, 1);
  assert.equal(roles[0].reworked, 1);
  assert.equal(roles[0].samples, 2);
});

// 4. Base merge
test('mergeBaseBeforeReview: clean no-ff merge in linked worktree, main checkout untouched, conflict aborted, skip conditions honored', () => {
  const f = makeTempRepo();
  const project = f.makeProject({
    dispatch: { auto_merge_base: true },
    checks: { base_merged: { max_behind: 1 }, revision_is_head: true },
  });

  // Create linked worktree for T1
  const wt1 = path.join(f.wtParent, 'demo-t1');
  git(f.root, 'worktree', 'add', '-b', 'demo-t1', wt1, 'main');
  writeFileSync(path.join(wt1, 'feature.txt'), 'worker work\n', 'utf8');
  git(wt1, 'add', '.');
  git(wt1, 'commit', '-qm', 'T1 feature work');
  const workerSha = git(wt1, 'rev-parse', 'HEAD');

  // Advance main by 3 commits in root
  for (let i = 1; i <= 3; i++) {
    writeFileSync(path.join(f.root, `base-${i}.txt`), `base ${i}\n`, 'utf8');
    git(f.root, 'add', '.');
    git(f.root, 'commit', '-qm', `base commit ${i}`);
  }
  const baseHead = git(f.root, 'rev-parse', 'HEAD');

  // Snapshot main checkout HEAD, .git/index bytes, and status --porcelain before mergeBaseBeforeReview
  const rootHeadBefore = git(f.root, 'rev-parse', 'HEAD');
  const rootIndexBefore = readFileSync(path.join(f.root, '.git', 'index'));
  const rootStatusBefore = execFileSync('git', ['-C', f.root, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });

  f.orders.add({ tag: 'T1', title: 'Auto base merge', kind: 'code', worktree: wt1, branch: 'demo-t1' });
  f.orders.act('T1', 'queue');
  const { run } = f.orders.runStart('T1', { worker: 'coder', extra: { cwd: wt1 } });
  f.orders.runEnd('T1', 'completed');
  f.orders.report('T1', { status: 'ready', summary: 'done', revision: workerSha, evidence: [], commits: [workerSha] });

  // Negative checks first before merging:
  // a) auto_merge_base: false -> does nothing
  mergeBaseBeforeReview(f.makeProject({ dispatch: { auto_merge_base: false }, checks: { base_merged: { max_behind: 1 } } }), f.orders, 'T1', run);
  assert.equal(git(wt1, 'rev-parse', 'HEAD'), workerSha);
  assert.equal(f.orders.store.events({ tag: 'T1' }).some(e => e.type.startsWith('base-merge')), false);

  // b) base_merged off -> does nothing
  mergeBaseBeforeReview(f.makeProject({ dispatch: { auto_merge_base: true }, checks: { base_merged: false } }), f.orders, 'T1', run);
  assert.equal(git(wt1, 'rev-parse', 'HEAD'), workerSha);

  // c) behind within allowance (max_behind: 3) -> does nothing
  mergeBaseBeforeReview(f.makeProject({ dispatch: { auto_merge_base: true }, checks: { base_merged: { max_behind: 3 } } }), f.orders, 'T1', run);
  assert.equal(git(wt1, 'rev-parse', 'HEAD'), workerSha);

  // d) dirty tracked file -> no merge commit, records base-merge-skipped
  writeFileSync(path.join(wt1, 'feature.txt'), 'dirty tracked edit\n', 'utf8');
  mergeBaseBeforeReview(project, f.orders, 'T1', run);
  assert.equal(git(wt1, 'rev-parse', 'HEAD'), workerSha);
  const skipped = f.orders.store.events({ tag: 'T1' }).find(e => e.type === 'base-merge-skipped');
  assert.ok(skipped);
  assert.equal(skipped.data?.run, run.id);
  git(wt1, 'checkout', '--', 'feature.txt');

  // e) clean linked worktree 3 behind (max_behind: 1) -> creates no-ff merge commit in wt1
  mergeBaseBeforeReview(project, f.orders, 'T1', run);
  const mergedHead = git(wt1, 'rev-parse', 'HEAD');
  assert.notEqual(mergedHead, workerSha);
  const parents = git(wt1, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
  assert.deepEqual(parents, [mergedHead, workerSha, baseHead]);
  assert.equal(git(wt1, 'log', '-1', '--format=%s'), 'Merge main into demo-t1 before review of T1 (Alba)');

  const mergedEvent = f.orders.store.events({ tag: 'T1' }).find(e => e.type === 'base-merged-by-alba');
  assert.ok(mergedEvent);
  assert.deepEqual(mergedEvent.data, {
    run: run.id,
    base: 'main',
    base_head: baseHead,
    from: workerSha,
    to: mergedHead,
    behind: 3,
  });

  // Delivery lint passes both base_merged and revision_is_head
  const lint = deliveryChecks(project, f.orders.get('T1'), wt1);
  const revCheck = lint.find(i => i.name === 'revision_is_head');
  const baseCheck = lint.find(i => i.name === 'base_merged');
  assert.equal(revCheck?.ok, true, revCheck?.detail);
  assert.match(revCheck?.detail ?? '', /Alba/);
  assert.equal(baseCheck?.ok, true, baseCheck?.detail);

  // Main checkout HEAD, index bytes, and status are byte-for-byte unchanged
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), rootHeadBefore);
  assert.equal(Buffer.compare(readFileSync(path.join(f.root, '.git', 'index')), rootIndexBefore), 0);
  assert.equal(execFileSync('git', ['-C', f.root, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }), rootStatusBefore);

  // Conflicting base change in a second linked worktree: aborted cleanly and conflicted file listed
  const wt2 = path.join(f.wtParent, 'demo-t2');
  git(f.root, 'worktree', 'add', '-b', 'demo-t2', wt2, 'main');
  writeFileSync(path.join(wt2, 'conflict.txt'), 'worker version\n', 'utf8');
  git(wt2, 'add', '.');
  git(wt2, 'commit', '-qm', 'T2 conflicting change');
  const wt2BeforeHead = git(wt2, 'rev-parse', 'HEAD');
  const wt2BeforeStatus = execFileSync('git', ['-C', wt2, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });

  writeFileSync(path.join(f.root, 'conflict.txt'), 'main version\n', 'utf8');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-qm', 'main conflicting change 1');
  writeFileSync(path.join(f.root, 'extra.txt'), 'main change 2\n', 'utf8');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-qm', 'main change 2');

  f.orders.add({ tag: 'T2', title: 'Conflicting merge', kind: 'code', worktree: wt2, branch: 'demo-t2' });
  f.orders.act('T2', 'queue');
  const { run: run2 } = f.orders.runStart('T2', { worker: 'coder', extra: { cwd: wt2 } });
  f.orders.runEnd('T2', 'completed');
  f.orders.report('T2', { status: 'ready', summary: 'done', revision: wt2BeforeHead, evidence: [], commits: [wt2BeforeHead] });

  mergeBaseBeforeReview(project, f.orders, 'T2', run2);
  assert.equal(git(wt2, 'rev-parse', 'HEAD'), wt2BeforeHead);
  assert.equal(execFileSync('git', ['-C', wt2, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }), wt2BeforeStatus);
  const conflictEvent = f.orders.store.events({ tag: 'T2' }).find(e => e.type === 'base-merge-conflicted');
  assert.ok(conflictEvent);
  assert.deepEqual(conflictEvent.data, { run: run2.id, base: 'main', files: ['conflict.txt'] });
  const verified = verifyOrder(project, f.orders, 'T2');
  assert.match(verified.results.find(r => r.name === 'merge readiness')?.reason ?? '', /conflict\.txt/);
});

// 5. Finish path
test('applyFinish: ready report on a branch 3 behind auto-merges base and stays awaiting-review with no lint send-back', () => {
  const f = makeTempRepo();
  const project = f.makeProject({
    dispatch: { auto_merge_base: true },
    checks: { base_merged: true, revision_is_head: true },
    producer: { enabled: true, rules: [{ id: 'lint', instruction: 'Send lint failures back', action: 'lint-bounce', mode: 'auto' }] },
  });

  const wt = path.join(f.wtParent, 'demo-f1');
  git(f.root, 'worktree', 'add', '-b', 'demo-f1', wt, 'main');
  writeFileSync(path.join(wt, 'work.txt'), 'delivered feature\n', 'utf8');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'F1 delivery');
  const deliveredSha = git(wt, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.workOrders, 'F1-finish.md'), '# F1\n\n## Acceptance\n- Feature works.\n', 'utf8');

  for (let i = 1; i <= 3; i++) {
    writeFileSync(path.join(f.root, `upstream-${i}.txt`), `u${i}\n`, 'utf8');
    git(f.root, 'add', '.');
    git(f.root, 'commit', '-qm', `upstream ${i}`);
  }

  const lastFile = path.join(f.workOrders, 'F1.last.txt');
  const rawReport = `Summary\n--- alba-report ---\n${JSON.stringify({ status: 'ready', summary: 'Feature delivered', evidence: [], commits: [deliveredSha] })}\n--- end ---\n`;
  writeFileSync(lastFile, rawReport, 'utf8');

  f.orders.add({ tag: 'F1', title: 'Finish path', kind: 'code', worktree: wt, branch: 'demo-f1' });
  f.orders.act('F1', 'queue');
  const { run } = f.orders.runStart('F1', { worker: 'coder', extra: { cwd: wt, last_file: lastFile } });

  applyFinish(f.orders, {
    tag: 'F1',
    run: run.id,
    outcome: 'completed',
    report: parseReportBlock(rawReport),
    why: 'process ended, report block read',
  }, project);

  const afterDoc = f.orders.get('F1');
  assert.equal(f.orders.stage(afterDoc).stage, 'awaiting-review');
  assert.equal(afterDoc.actions.some(a => a.lint), false, 'must not bounce for base_merged or revision_is_head');
  assert.ok(f.orders.store.events({ tag: 'F1' }).some(e => e.type === 'base-merged-by-alba'));
  const checkEvent = f.orders.store.events({ tag: 'F1' }).find(e => e.type === 'check' && e.data?.delivery === true);
  assert.equal(checkEvent?.data?.ok, true);
});

// 6. API and console
test('API and console: POST /api/orders/:tag/actions close returns 200/409/400, OrderDetail.unavailable covers close, visibleActions includes close', async () => {
  const f = await apiFixture();
  const project = f.board.ctx.projects[0];
  const mainSha = git(project.root, 'rev-parse', 'HEAD');
  git(project.root, 'checkout', '-qb', 'orphan-side');
  writeFileSync(path.join(project.root, 'unmerged.txt'), 'unmerged\n', 'utf8');
  git(project.root, 'add', '.');
  git(project.root, 'commit', '-qm', 'unmerged commit');
  const unmergedSha = git(project.root, 'rev-parse', 'HEAD');
  git(project.root, 'checkout', '-q', 'main');

  // Running order W1 has close unavailable and refuses POST close with 409
  const runningDetail = (await f.get('/api/orders/W1')).body;
  assert.equal(runningDetail.actions.includes('close'), false);
  assert.match(runningDetail.unavailable.close, /stop the run first/);
  const runningRefused = await f.write('/api/orders/W1/actions', { action: 'close', how: 'done-by-lead', note: 'Attempt on running order' });
  assert.equal(runningRefused.status, 409);
  assert.match(runningRefused.body.error.message, /stop the run first/);

  // Bad bodies return 400
  assert.equal((await f.write('/api/orders/D1/actions', { action: 'close' })).status, 400);
  assert.equal((await f.write('/api/orders/D1/actions', { action: 'close', how: 'unknown' })).status, 400);
  assert.equal((await f.write('/api/orders/D1/actions', { action: 'close', how: 'merged-elsewhere' })).status, 400);

  // Refusals return 409: commit not on base, missing note for done-by-lead
  const badCommit = await f.write('/api/orders/D1/actions', { action: 'close', how: 'merged-elsewhere', commit: unmergedSha });
  assert.equal(badCommit.status, 409);
  assert.match(badCommit.body.error.message, new RegExp(unmergedSha));

  const missingNote = await f.write('/api/orders/D1/actions', { action: 'close', how: 'done-by-lead' });
  assert.equal(missingNote.status, 409);
  assert.match(missingNote.body.error.message, /at least 10 characters/);

  // Valid merged-elsewhere returns 200 and marks order merged; second close returns 409 and unavailable.close is populated
  const okElsewhere = await f.write('/api/orders/D1/actions', { action: 'close', how: 'merged-elsewhere', commit: mainSha.slice(0, 7) });
  assert.equal(okElsewhere.status, 200);
  assert.equal(okElsewhere.body.stage, 'merged');
  assert.equal(okElsewhere.body.why, `closed by the lead: merged elsewhere in ${mainSha.slice(0, 7)}`);

  const mergedDetail = (await f.get('/api/orders/D1')).body;
  assert.equal(mergedDetail.actions.includes('close'), false);
  assert.match(mergedDetail.unavailable.close, /cannot close an order that is merged/);
  assert.equal((await f.write('/api/orders/D1/actions', { action: 'close', how: 'done-by-lead', note: 'Already merged order' })).status, 409);

  // Valid done-by-lead on a failed order returns 200
  f.orders.add({ tag: 'FAIL1', title: 'Failed order', kind: 'task' });
  f.orders.report('FAIL1', { status: 'failed', summary: 'build broke', evidence: [], commits: [] });
  const failDetail = (await f.get('/api/orders/FAIL1')).body;
  assert.equal(failDetail.actions.includes('close'), true);
  assert.equal(failDetail.unavailable.close, undefined);
  const okLead = await f.write('/api/orders/FAIL1/actions', { action: 'close', how: 'done-by-lead', note: 'Fixed manually by the lead' });
  assert.equal(okLead.status, 200);
  assert.equal(okLead.body.stage, 'merged');
  assert.equal(okLead.body.why, 'closed by the lead: done by hand');

  assert.equal(ORDER_ACTIONS.includes('close'), true);
});

test('mergeBaseBeforeReview falls back to Alba <alba@localhost> when repository and global git identity are unset', () => {
  const emptyHome = tmpDir('alba-empty-home-');
  tempDirs.push(emptyHome);
  const f = makeTempRepo();
  const project = f.makeProject({
    dispatch: { auto_merge_base: true },
    checks: { base_merged: true, revision_is_head: true },
  });
  const wt = path.join(f.wtParent, 'demo-id1');
  git(f.root, 'worktree', 'add', '-b', 'demo-id1', wt, 'main');
  writeFileSync(path.join(wt, 'id.txt'), 'work\n', 'utf8');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'work');
  const fromSha = git(wt, 'rev-parse', 'HEAD');

  writeFileSync(path.join(f.root, 'main-next.txt'), 'next\n', 'utf8');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-qm', 'next');

  f.orders.add({ tag: 'ID1', title: 'Identity fallback', kind: 'code', worktree: wt, branch: 'demo-id1' });
  const emptyGitConfig = path.join(emptyHome, '.gitconfig');
  writeFileSync(emptyGitConfig, '', 'utf8');
  const prevHome = process.env.HOME, prevUserProfile = process.env.USERPROFILE, prevGlobal = process.env.GIT_CONFIG_GLOBAL, prevNoSys = process.env.GIT_CONFIG_NOSYSTEM;
  try {
    process.env.HOME = emptyHome;
    process.env.USERPROFILE = emptyHome;
    process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    mergeBaseBeforeReview(project, f.orders, 'ID1', { id: 'r1', cwd: wt });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevNoSys === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = prevNoSys;
  }
  assert.notEqual(git(wt, 'rev-parse', 'HEAD'), fromSha, JSON.stringify(f.orders.store.events({ tag: 'ID1' })));
  assert.equal(git(wt, 'log', '-1', '--format=%an <%ae>'), 'Alba <alba@localhost>');

  // Guard checks: never acts on main checkout (project.root) or on a worktree with another branch checked out
  assert.throws(() => f.makeProject({ dispatch: { auto_merge_base: 'yes' } }), /"dispatch\.auto_merge_base" must be true or false/);
  const mainHeadBefore = git(f.root, 'rev-parse', 'HEAD');
  f.orders.add({ tag: 'ROOT1', title: 'Points at root', kind: 'code', worktree: f.root, branch: 'main' });
  mergeBaseBeforeReview(project, f.orders, 'ROOT1', { id: 'r1', cwd: f.root });
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), mainHeadBefore);
  assert.equal(f.orders.store.events({ tag: 'ROOT1' }).some(e => e.type.startsWith('base-merge')), false);

  f.orders.add({ tag: 'WRONG1', title: 'Wrong branch', kind: 'code', worktree: wt, branch: 'other-branch' });
  const wtHeadNow = git(wt, 'rev-parse', 'HEAD');
  mergeBaseBeforeReview(project, f.orders, 'WRONG1', { id: 'r1', cwd: wt });
  assert.equal(git(wt, 'rev-parse', 'HEAD'), wtHeadNow);
  assert.equal(f.orders.store.events({ tag: 'WRONG1' }).some(e => e.type.startsWith('base-merge')), false);
});

test('CLI orders run-end auto-merges base before lintDelivery when the log ends with a ready report', async () => {
  const f = makeTempRepo();
  const wt = path.join(f.wtParent, 'demo-re1');
  git(f.root, 'worktree', 'add', '-b', 'demo-re1', wt, 'main');
  writeFileSync(path.join(wt, 're1.txt'), 'done\n', 'utf8');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'RE1 work');
  const rev = git(wt, 'rev-parse', 'HEAD');

  for (let i = 1; i <= 2; i++) {
    writeFileSync(path.join(f.root, `re-base-${i}.txt`), `${i}\n`, 'utf8');
    git(f.root, 'add', '.');
    git(f.root, 'commit', '-qm', `re-base-${i}`);
  }

  const stateDir = path.join(f.dir, 're-state');
  const yamlPath = path.join(f.dir, 'alba-re.yaml');
  writeFileSync(
    yamlPath,
    [
      'id: demo',
      'name: Demo',
      `root: ${JSON.stringify(f.root)}`,
      `work_orders: ${JSON.stringify(f.workOrders)}`,
      `state_dir: ${JSON.stringify(stateDir)}`,
      'dispatch:',
      '  base_ref: main',
      '  auto_merge_base: true',
      'checks:',
      '  base_merged: true',
      '  revision_is_head: true',
      'producer:',
      '  enabled: true',
      '  rules:',
      '    - { id: lint, instruction: "Bounce lint failures", action: lint-bounce, mode: auto }',
    ].join('\n') + '\n',
    'utf8',
  );

  const cfg = validateProject({
    id: 'demo',
    name: 'Demo',
    root: f.root,
    work_orders: f.workOrders,
    state_dir: stateDir,
    state: { backend: 'sqlite' },
    dispatch: { base_ref: 'main', auto_merge_base: true },
    checks: { base_merged: true, revision_is_head: true },
  }, yamlPath);
  closeStateStores();

  const cli = path.resolve(import.meta.dirname, '../src/cli/main.ts');
  const runCli = (...args: string[]) => spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', cli, '--project', yamlPath, ...args],
    { encoding: 'utf8', windowsHide: true },
  );

  assert.equal(runCli('orders', 'add', 'RE1', '--title', 'Run-end merge', '--kind', 'code', '--worktree', wt, '--branch', 'demo-re1').status, 0);
  assert.equal(runCli('orders', 'act', 'RE1', 'queue').status, 0);
  assert.equal(runCli('orders', 'run-start', 'RE1', '--worker', 'coder').status, 0);

  // Attach a log ending with turn.completed + ready report block to r1
  const logFile = path.join(f.dir, 're1.events.jsonl');
  const reportBlock = `--- alba-report ---\n${JSON.stringify({ status: 'ready', summary: 'RE1 ready', revision: rev, evidence: [], commits: [rev] })}\n--- end ---`;
  writeFileSync(
    logFile,
    [
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: reportBlock } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join('\n') + '\n',
    'utf8',
  );
  // Patch log/events_file onto the open run via SqliteStore
  const { Orders } = await import('../src/orders/service.ts');
  const { stateStore } = await import('../src/orders/backend.ts');
  const reOrders = new Orders(stateStore(cfg));
  reOrders.patchRun('RE1', 'r1', { cwd: wt, events_file: logFile, log: logFile });
  closeStateStores();

  const ended = runCli('orders', 'run-end', 'RE1');
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.stdout, /^RE1: awaiting-review/m);
  assert.notEqual(git(wt, 'rev-parse', 'HEAD'), rev);
});
