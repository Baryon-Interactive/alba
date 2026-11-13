import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { applyFinish } from '../src/run/finish.ts';
import { startRun } from '../src/run/launch.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture() {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'Map.uasset'), 'map');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-theme.md'), '# T1\nTheme.\n');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', launch: { template: 'c', program: 'coder', args: ['{prompt_file}'] } }] }, 'w.yaml');
  const probes: Probes = {
    now: () => new Date(), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => 4242,
  };
  orders.add({ tag: 'T1', title: 'Theme', kind: 'ue' });
  orders.act('T1', 'queue');
  const r = startRun({ project, orders, workers, probes }, 'T1', 'coder');
  assert.ok(r.mode === 'start');
  return { orders, project, root, worktree: r.cwd };
}

test('the prompt names the worktree as the only place to work, and not the main checkout', () => {
  const f = fixture();
  const prompt = readFileSync(f.orders.get('T1').runs[0]!.prompt_file!, 'utf8');
  assert.match(prompt, /## Where you work/);
  assert.ok(prompt.includes(`Your working folder is ${f.worktree.replaceAll('\\', '/')}`));
  assert.ok(prompt.includes(`Never change, build in or commit to ${f.root.replaceAll('\\', '/')}`));
});

test('a run that committed on the main checkout is stopped at review; an unrelated change there is only a warning', () => {
  const f = fixture();
  // The worker worked in the main checkout: a commit on main and a changed asset left there.
  writeFileSync(path.join(f.root, 'Theme.txt'), 'theme');
  git(f.root, 'add', 'Theme.txt'); git(f.root, 'commit', '-q', '-m', 'Theme work');
  const commit = git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.root, 'Map.uasset'), 'changed map');
  applyFinish(f.orders, { tag: 'T1', run: 'r1', outcome: 'completed', report: { status: 'ready', summary: 'Theme done', evidence: [], commits: [commit.slice(0, 8)] }, why: 'done' }, f.project);
  const doc = f.orders.get('T1');
  assert.equal(f.orders.stage(doc).stage, 'blocked');
  assert.match(doc.reports.at(-1)!.summary, /changed the main checkout .* 1 commit\(s\) on the base branch \(\w{9} Theme work\) and 1 changed file\(s\) \(Map\.uasset\)\. .*The worker said: Theme done/);
  assert.ok(f.orders.store.events({ tag: 'T1' }).some(e => e.type === 'outside-worktree'));
});

test('a commit on main that the run does not report (the lead\'s own) only warns', () => {
  const f = fixture();
  writeFileSync(path.join(f.root, 'alba.txt'), 'lead config');
  git(f.root, 'add', 'alba.txt'); git(f.root, 'commit', '-q', '-m', 'Lead config');
  applyFinish(f.orders, { tag: 'T1', run: 'r1', outcome: 'completed', report: { status: 'ready', summary: 'Theme done', evidence: [], commits: [] }, why: 'done' }, f.project);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'awaiting-review');
  assert.ok(f.orders.store.events({ tag: 'T1' }).some(e => e.type === 'accept-warning' && e.data?.name === 'outside-worktree'));
});
