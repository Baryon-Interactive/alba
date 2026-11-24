import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyClean, formatClean, planClean, systemClean, type CleanEnv } from '../src/clean/clean.ts';
import { atRiskIgnoredPaths } from '../src/clean/safety.ts';
import { DEFAULT_CLEAN_REGENERABLE } from '../src/config.ts';
import { Orders } from '../src/orders/service.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { git } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';
import { testStore, validateProject } from './state-helper.ts';

const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';

function setup(clean: Record<string, unknown> = {}) {
  const { dir } = tempOrders();
  const root = path.join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, '.gitignore'), [
    'node_modules/',
    'Intermediate/',
    'Plugins/*/Binaries/',
    'DerivedDataCache/',
    '__pycache__/',
    '*.log',
    'Library/',
    '*.local.ini',
    'exports/',
    'linked-ext/*',
    '.alba/',
  ].join('\n') + '\n');
  writeFileSync(path.join(root, 'README.md'), 'demo\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const cfg = validateProject({
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: root,
    state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: dir, base_ref: 'refs/heads/main' },
    clean: { idle_hours: 0, caches: ['Library'], ...clean },
  }, path.join(dir, 'alba.yaml'));
  const orders = new Orders(testStore(cfg.state_dir), () => '2026-01-01T00:00:00Z');
  const worktree = (tag: string) => {
    const wt = path.join(dir, `repo-${tag.toLowerCase()}`);
    git(root, 'worktree', 'add', '-q', '-b', `repo-${tag.toLowerCase()}`, wt, 'main');
    orders.add({ tag, title: tag, kind: 'task', worktree: wt, branch: `repo-${tag.toLowerCase()}` });
    orders.act(tag, 'approve', { force: true });
    return wt;
  };
  const env: CleanEnv = {
    ...systemClean({ ...systemProbes, now: () => new Date(Date.now() + 3600000) }),
    sizeBudgetMs: Infinity,
    processes: () => ['explorer.exe'],
    executableProcesses: () => [],
    runGit: (cwd, args) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CEILING_DIRECTORIES: dir }, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  };
  return { dir, root, cfg, orders, worktree, env };
}

test('D3: merged worktree with only regenerable ignored files is removed', () => {
  const s = setup();
  const wt = s.worktree('T1');
  mkdirSync(path.join(wt, '.alba'), { recursive: true });
  writeFileSync(path.join(wt, '.alba', 'inbox.md'), 'msg');
  mkdirSync(path.join(wt, 'Library', 'cache'), { recursive: true });
  writeFileSync(path.join(wt, 'Library', 'cache', 'x.bin'), 'x');
  mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), 'export {}');
  mkdirSync(path.join(wt, 'Intermediate'), { recursive: true });
  writeFileSync(path.join(wt, 'Intermediate', 'a.obj'), 'obj');
  mkdirSync(path.join(wt, 'Plugins', 'Sample', 'Binaries'), { recursive: true });
  writeFileSync(path.join(wt, 'Plugins', 'Sample', 'Binaries', 'p.dll'), 'dll');
  mkdirSync(path.join(wt, 'DerivedDataCache'), { recursive: true });
  writeFileSync(path.join(wt, 'DerivedDataCache', 'd.udd'), 'udd');
  mkdirSync(path.join(wt, '__pycache__'), { recursive: true });
  writeFileSync(path.join(wt, '__pycache__', 'm.pyc'), 'pyc');
  writeFileSync(path.join(wt, 'build.log'), 'log');

  const plan = planClean(s.cfg, s.orders, s.env);
  const item = plan.items.find(i => i.tag === 'T1')!;
  assert.equal(item.action, 'remove', item.reason);
  assert.equal(item.atRiskIgnored, undefined);
  applyClean(s.cfg, s.orders, plan, s.env);
  assert.equal(existsSync(wt), false);
});

test('D3: ignored settings file skips worktree with count and first 10 paths; --include-ignored removes it', () => {
  const s = setup();
  const wt = s.worktree('T2');
  writeFileSync(path.join(wt, 'editor.local.ini'), 'secret=1\n');
  for (let i = 1; i <= 11; i++) {
    writeFileSync(path.join(wt, `extra-${String(i).padStart(2, '0')}.local.ini`), 'x\n');
  }
  mkdirSync(path.join(wt, 'exports', 'big'), { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(path.join(wt, 'exports', 'big', `f${i}.bin`), 'data');

  const plan = planClean(s.cfg, s.orders, s.env);
  const item = plan.items.find(i => i.tag === 'T2')!;
  assert.equal(item.action, 'skip');
  assert.ok(item.atRiskIgnored);
  // 12 .local.ini files + 1 exports/ folder (listed as folder, not 20 files) = 13
  assert.equal(item.atRiskIgnored.count, 13);
  assert.equal(item.atRiskIgnored.paths.length, 10);
  assert.ok(item.atRiskIgnored.paths.includes('editor.local.ini'));
  assert.ok(item.atRiskIgnored.paths.includes('exports/'));
  assert.ok(!item.atRiskIgnored.paths.some(p => p.startsWith('exports/big')));
  const formatted = formatClean(plan, false);
  assert.match(formatted, /13 ignored path\(s\)/);
  assert.match(formatted, /editor\.local\.ini/);
  assert.match(formatted, /--include-ignored/);

  // Applying the normal plan leaves the worktree intact
  applyClean(s.cfg, s.orders, plan, s.env);
  assert.equal(existsSync(wt), true);

  // With --include-ignored it is removed
  const forcedEnv = { ...s.env, includeIgnored: true };
  const forcedPlan = planClean(s.cfg, s.orders, forcedEnv);
  const forcedItem = forcedPlan.items.find(i => i.tag === 'T2')!;
  assert.equal(forcedItem.action, 'remove');
  assert.equal(forcedItem.atRiskIgnored?.count, 13);
  applyClean(s.cfg, s.orders, forcedPlan, forcedEnv);
  assert.equal(existsSync(wt), false);
});

test('D3: linked folder is not followed and its target is untouched on removal', () => {
  const s = setup();
  const outside = path.join(s.dir, 'outside-assets');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'a.local.ini'), 'keep-a');
  writeFileSync(path.join(outside, 'b.local.ini'), 'keep-b');
  const wt = s.worktree('T3');
  symlinkSync(outside, path.join(wt, 'linked-ext'), directoryLink);

  const atRisk = atRiskIgnoredPaths(wt, s.env.runGit, { caches: ['Library'], regenerable: DEFAULT_CLEAN_REGENERABLE });
  // Collapsed to the link itself without listing files inside outside/
  assert.equal(atRisk.count, 1);
  assert.deepEqual(atRisk.paths, ['linked-ext/']);

  const skipped = planClean(s.cfg, s.orders, s.env).items.find(i => i.tag === 'T3')!;
  assert.equal(skipped.action, 'skip');
  assert.deepEqual(skipped.atRiskIgnored?.paths, ['linked-ext/']);

  const forcedEnv = { ...s.env, includeIgnored: true };
  const forcedPlan = planClean(s.cfg, s.orders, forcedEnv);
  applyClean(s.cfg, s.orders, forcedPlan, forcedEnv);
  assert.equal(existsSync(wt), false);
  assert.equal(readFileSync(path.join(outside, 'a.local.ini'), 'utf8'), 'keep-a');
  assert.equal(readFileSync(path.join(outside, 'b.local.ini'), 'utf8'), 'keep-b');
});

test('D3: clean.regenerable config validation and custom override', () => {
  const s = setup({ regenerable: ['exports/'] });
  const wt = s.worktree('T4');
  mkdirSync(path.join(wt, 'exports'), { recursive: true });
  writeFileSync(path.join(wt, 'exports', 'out.bin'), 'ok');
  const plan = planClean(s.cfg, s.orders, s.env);
  assert.equal(plan.items.find(i => i.tag === 'T4')!.action, 'remove');

  assert.throws(
    () => validateProject({ id: 'demo', name: 'Demo', root: s.root, work_orders: s.root, state_dir: s.cfg.state_dir, clean: { regenerable: ['../escape'] } }, s.cfg.file),
    /clean\.regenerable/,
  );
  assert.throws(
    () => validateProject({ id: 'demo', name: 'Demo', root: s.root, work_orders: s.root, state_dir: s.cfg.state_dir, clean: { regenerable: [path.resolve(s.root)] } }, s.cfg.file),
    /clean\.regenerable/,
  );
});
