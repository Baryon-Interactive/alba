import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installBaseGuard } from '../src/run/ref-guard.ts';
import { removeTreeSync } from '../src/fs/remove-tree.mjs';

const ident = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
/** Runs git; `run` set puts ALBA_RUN into its environment like a worker's. */
function git(cwd: string, args: string[], run?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ALBA_RUN;
  if (run) env.ALBA_RUN = run;
  return spawnSync('git', ['-C', cwd, ...ident, ...args], { encoding: 'utf8', env, windowsHide: true });
}
const head = (cwd: string, ref: string) => git(cwd, ['rev-parse', ref]).stdout.trim();

test('base-branch guard: a worker run cannot move main from anywhere, works normally on its branch (git merge main included); the lead can', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-guard-'));
  try {
    const root = path.join(dir, 'repo'), tree = path.join(dir, 'tree');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    writeFileSync(path.join(root, 'a.txt'), 'a\n');
    assert.equal(git(root, ['add', '.']).status, 0);
    assert.equal(git(root, ['commit', '-q', '-m', 'A']).status, 0);
    assert.equal(git(root, ['worktree', 'add', '-q', '-b', 't1', tree, 'main']).status, 0);
    assert.deepEqual(installBaseGuard(root, 'refs/heads/main'), { installed: true });
    const hook = path.join(root, '.git', 'hooks', 'reference-transaction');
    assert.ok(existsSync(hook));

    // The worker commits on its branch, and merges main into it after the lead moved main.
    writeFileSync(path.join(tree, 'b.txt'), 'b\n');
    assert.equal(git(tree, ['add', '.'], 'T1/r1').status, 0);
    assert.equal(git(tree, ['commit', '-q', '-m', 'B'], 'T1/r1').status, 0);
    writeFileSync(path.join(root, 'c.txt'), 'c\n');
    assert.equal(git(root, ['add', '.']).status, 0);
    assert.equal(git(root, ['commit', '-q', '-m', 'C (the lead)']).status, 0);
    const merged = git(tree, ['merge', '--no-edit', 'main'], 'T1/r1');
    assert.equal(merged.status, 0, merged.stderr);
    assert.ok(existsSync(path.join(tree, 'c.txt')));
    assert.equal(git(tree, ['branch', 't1-spare'], 'T1/r1').status, 0, 'other branches stay writable');
    assert.equal(git(tree, ['pack-refs', '--all'], 'T1/r1').status, 0, 'packing refs rewrites main with the same value');

    // From the worker: merging into main in the main checkout, moving main with branch -f or update-ref, and committing there are refused.
    const mainBefore = head(root, 'main');
    const intoMain = git(root, ['merge', '--no-edit', 't1'], 'T1/r1');
    assert.notEqual(intoMain.status, 0);
    assert.match(intoMain.stderr, /alba: this is the worker run T1\/r1; it may not move refs\/heads\/main/);
    assert.equal(head(root, 'main'), mainBefore);
    // Git has already updated the files when the hook refuses (no hook runs before that): the checkout is left changed, the
    // refusal is logged, and the run's outside-worktree check sees the changed files.
    assert.notEqual(git(root, ['status', '--porcelain', '--untracked-files=no']).stdout.trim(), '');
    assert.match(readFileSync(path.join(root, '.git', 'alba-guard.log'), 'utf8'), /T1\/r1 refs\/heads\/main [0-9a-f]{40} [0-9a-f]{40} /);
    git(root, ['reset', '-q', '--hard']); git(root, ['clean', '-fdq']);
    assert.notEqual(git(tree, ['branch', '-f', 'main', 't1'], 'T1/r1').status, 0);
    assert.notEqual(git(tree, ['update-ref', 'refs/heads/main', 't1'], 'T1/r1').status, 0);
    writeFileSync(path.join(root, 'd.txt'), 'd\n');
    git(root, ['add', 'd.txt'], 'T1/r1');
    assert.notEqual(git(root, ['commit', '-q', '-m', 'D'], 'T1/r1').status, 0);
    assert.equal(head(root, 'main'), mainBefore);
    git(root, ['reset', '-q']);

    // The lead (no ALBA_RUN) merges.
    const lead = git(root, ['merge', '--no-edit', 't1']);
    assert.equal(lead.status, 0, lead.stderr);
    assert.notEqual(head(root, 'main'), mainBefore);

    // Installing again for another base keeps both; the file is only rewritten when it changes.
    installBaseGuard(root, 'refs/heads/release');
    assert.match(readFileSync(hook, 'utf8'), /^# protected: refs\/heads\/main refs\/heads\/release$/m);
    installBaseGuard(root, 'refs/heads/main');
    assert.match(readFileSync(hook, 'utf8'), /^# protected: refs\/heads\/main refs\/heads\/release$/m);

    // Someone else's hook, or a hooks path, is left alone with a warning.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    const foreign = installBaseGuard(root, 'refs/heads/main');
    assert.equal(foreign.installed, false); assert.match(foreign.warning!, /exists and is not Alba's/);
    assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n');
    git(root, ['config', 'core.hooksPath', '.githooks']);
    assert.match(installBaseGuard(root, 'refs/heads/main').warning!, /core\.hooksPath is set \(\.githooks\)/);
  } finally { removeTreeSync(dir); }
});

test('launch: every worker process gets ALBA_RUN=<TAG>/<run>, and a local run installs the guard in the project repository', async () => {
  const { tempOrders } = await import('./helpers.ts');
  const { validateProject } = await import('./state-helper.ts');
  const { startRun } = await import('../src/run/launch.ts');
  const { validateWorkers } = await import('../src/workers/config.ts');
  const { dir, orders } = tempOrders(), root = path.join(dir, 'repo'), orderDir = path.join(dir, 'orders');
  mkdirSync(root); mkdirSync(orderDir);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, ...ident, 'commit', '-q', '--allow-empty', '-m', 'Initial']);
  writeFileSync(path.join(orderDir, 'G1-guard.md'), '# Guard');
  const cfg = validateProject({ id: 'demo', name: 'Demo', root, work_orders: orderDir, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' }, roles: { default: {} } }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({ workers: [{ id: 'fake', engine: 'codex-cli', launch: { program: 'fake-engine', args: ['exec', '{prompt_file}'] } }] }, path.join(dir, 'workers.yaml'));
  let env: Record<string, string> = {};
  const probes = { now: () => new Date(), spawnDetached: (_p: string, _a: string[], o: { env: Record<string, string> }) => { env = o.env; return 123; }, processStartedAt: () => undefined } as unknown as import('../src/tick/gather.ts').Probes;
  orders.add({ tag: 'G1', title: 'Guard', kind: 'code' }); orders.act('G1', 'queue');
  startRun({ project: cfg, orders, workers, probes }, 'G1', 'fake');
  assert.equal(env.ALBA_RUN, 'G1/r1');
  assert.match(readFileSync(path.join(root, '.git', 'hooks', 'reference-transaction'), 'utf8'), /^# protected: refs\/heads\/main$/m);
  assert.deepEqual(orders.get('G1').runs[0]!.role_warnings, []);
});
