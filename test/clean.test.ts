import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyClean, findLinks, formatClean, planClean, systemClean, unlinkLinks, type CleanEnv } from '../src/clean/clean.ts';
import { validateProject } from './state-helper.ts';
import { Orders } from '../src/orders/service.ts';
import { testStore } from './state-helper.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { git } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';
import { cleanSignature, worktreeSignature } from '../src/clean/safety.ts';

const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';

test('a spent size budget leaves deletion sizes unknown and preserves the selected items', () => {
  const s = setup();
  const wt = s.worktree('SAMPLE', { commit: true });
  mkdirSync(path.join(wt, 'Library')); writeFileSync(path.join(wt, 'Library', 'data'), 'some bytes');
  const plan = planClean(s.cfg, s.orders, { ...s.env, sizeBudgetMs: 0 });
  const item = plan.items.find(i => i.tag === 'SAMPLE')!;
  assert.equal(item.action, 'prune'); assert.equal(item.bytes, undefined);
  assert.match(formatClean(plan, false), /size unknown/);
  // This comparison checks the complete size, independently of machine/Git speed.
  const measured = planClean(s.cfg, s.orders, { ...s.env, sizeBudgetMs: Infinity }).items.find(i => i.tag === 'SAMPLE')!;
  assert.deepEqual(item.targets, measured.targets); assert.equal(measured.bytes, 10);
});

function setup(clean: Record<string, unknown> = {}) {
  const { dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, '.gitignore'), 'Library/\nartifacts/\n');
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const cfg = validateProject({ id: 'demo', name: 'Demo', root, work_orders: root, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: dir, base_ref: 'refs/heads/main' }, clean: { idle_hours: 0, caches: ['Library'], builds: [{ dir: 'artifacts/builds', keep: 2 }], ...clean } }, path.join(dir, 'alba.yaml'));
  const orders = new Orders(testStore(cfg.state_dir), () => '2026-01-01T00:00:00Z');
  const worktree = (tag: string, options: { commit?: boolean } = {}) => {
    const wt = path.join(dir, `game-${tag.toLowerCase()}`);
    git(root, 'worktree', 'add', '-q', '-b', `game-${tag.toLowerCase()}`, wt, 'main');
    if (options.commit) { writeFileSync(path.join(wt, 'work.txt'), tag); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', `${tag} work`); }
    orders.add({ tag, title: tag, kind: 'task', worktree: wt, branch: `game-${tag.toLowerCase()}` });
    return wt;
  };
  // Size assertions need complete counting; the budget test explicitly supplies its own deadline.
  const env: CleanEnv = { ...systemClean({ ...systemProbes, now: () => new Date(Date.now() + 3600000), isAlive: () => true, processStartedAt: () => '2026-01-01T00:00:01Z' }), sizeBudgetMs: Infinity, processes: () => ['explorer.exe', 'node.exe'], executableProcesses: () => [],
    // Keep Git discovery inside the fixture even when the OS temp root is inside a checkout.
    runGit: (cwd, args) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CEILING_DIRECTORIES: dir }, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  };
  return { dir, root, cfg, orders, worktree, env };
}

test('clean plan: merged idle clean worktrees go with their branch; everything else is kept or skipped with a reason', () => {
  const s = setup();
  s.worktree('M1'); s.orders.act('M1', 'approve', { force: true });                       // merged, nothing ahead: removed
  s.worktree('M2', { commit: true }); s.orders.act('M2', 'approve', { force: true });     // "approved", but the branch has a commit the base lacks
  const d1 = s.worktree('D1'); s.orders.act('D1', 'approve', { force: true }); writeFileSync(path.join(d1, 'new.txt'), 'x');   // uncommitted file
  s.worktree('R1');
  s.orders.runStart('R1', { worker: 'w', extra: { pid: 77 } });
  s.orders.act('R1', 'approve', { force: true });                  // fake live process
  const u1 = s.worktree('U1', { commit: true });                                          // work not merged
  mkdirSync(path.join(u1, 'Library', 'cache'), { recursive: true });
  writeFileSync(path.join(u1, 'Library', 'cache', 'big.bin'), 'x'.repeat(1000));
  s.worktree('U2', { commit: true });                                                      // not merged, no cache folder
  const plan = planClean(s.cfg, s.orders, s.env);
  const by = Object.fromEntries(plan.items.filter(i => i.kind === 'worktree').map(i => [i.tag, i]));
  assert.deepEqual(Object.keys(by).sort(), ['D1', 'M1', 'M2', 'R1', 'U1', 'U2']);
  assert.equal(by.M1.action, 'remove');
  assert.equal(by.M1.branch, 'game-m1');
  assert.equal(by.M2.action, 'keep');
  assert.match(by.M2.reason, /commit\(s\) the base branch lacks/);
  assert.equal(by.D1.action, 'skip');
  assert.match(by.D1.reason, /uncommitted/);
  assert.equal(by.R1.action, 'skip');
  assert.match(by.R1.reason, /run of R1 is alive/);
  assert.deepEqual([by.U1.action, by.U1.targets], ['prune', ['Library']]);
  assert.equal(by.U1.bytes, 1000);
  assert.equal(by.U2.action, 'keep');
  assert.ok(plan.items.every(i => i.result === undefined), 'a plan changes nothing');
  assert.ok(existsSync(path.join(u1, 'Library')));
  assert.match(formatClean(plan, false), /Plan only: 2 action\(s\) would be done\. Nothing was deleted/);
  // the plan is only a plan: no event, nothing removed
  assert.equal(s.orders.store.events().filter(e => e.type === 'clean').length, 0);
});

test('clean plan: a merged worktree that changed recently is kept (idle_hours), the main checkout is never listed', () => {
  const s = setup({ idle_hours: 100 });
  s.worktree('M1'); s.orders.act('M1', 'approve', { force: true });
  const plan = planClean(s.cfg, s.orders, s.env);
  assert.deepEqual(plan.items.map(i => [i.tag, i.action]), [['M1', 'keep']]);
  assert.match(plan.items[0].reason, /idle_hours is 100/);
  assert.ok(plan.items.every(i => i.path !== s.root.replace(/\\/g, '/')));
});

test('clean plan: build caches go from idle worktrees that must stay, approved-but-ahead included; review, monitoring and recent work keep them', () => {
  const s = setup();
  const cache = (wt: string) => { mkdirSync(path.join(wt, 'Library'), { recursive: true }); writeFileSync(path.join(wt, 'Library', 'big.bin'), 'x'.repeat(500)); };
  const ahead = s.worktree('AHEAD', { commit: true }); cache(ahead); s.orders.act('AHEAD', 'approve', { force: true });
  const review = s.worktree('REVIEW', { commit: true }); cache(review);
  s.orders.runStart('REVIEW', { worker: 'fake' }); s.orders.runEnd('REVIEW', 'completed');
  s.orders.report('REVIEW', { status: 'ready', summary: 'done', evidence: [], commits: [] });
  assert.equal(s.orders.stage(s.orders.get('REVIEW')).stage, 'awaiting-review');
  const by = Object.fromEntries(planClean(s.cfg, s.orders, s.env).items.map(i => [i.tag, i]));
  assert.deepEqual([by.AHEAD.action, by.AHEAD.targets, by.AHEAD.pathClass], ['prune', ['Library'], 'caches']);
  assert.match(by.AHEAD.reason, /commit\(s\) the base branch lacks: only the cache folders go/);
  assert.equal(by.REVIEW.action, 'keep');
  assert.match(by.REVIEW.reason, /awaiting-review/);
  const recent = planClean({ ...s.cfg, clean: { ...s.cfg.clean!, idle_hours: 100 } }, s.orders, s.env).items.find(i => i.tag === 'AHEAD')!;
  assert.equal(recent.action, 'keep');
  assert.match(recent.reason, /cache folders changed 1 h ago \(idle_hours is 100\)/);
});

test('clean plan: a merged stacked order whose parent branch is gone is compared with the base branch', () => {
  const s = setup();
  git(s.root, 'branch', 'parent', 'main');
  const wt = path.join(s.dir, 'game-child');
  git(s.root, 'worktree', 'add', '-q', '-b', 'game-child', wt, 'parent');
  s.orders.add({ tag: 'CHILD', title: 'CHILD', kind: 'task', worktree: wt, branch: 'game-child', base_ref: 'parent' });
  s.orders.act('CHILD', 'approve', { force: true });
  git(s.root, 'branch', '-D', 'parent');
  const item = planClean(s.cfg, s.orders, s.env).items.find(i => i.tag === 'CHILD')!;
  assert.equal(item.action, 'remove', item.reason);
});

test('clean plan: a cache folder with more files than the snapshot budget is still pruned (top two levels are fingerprinted)', () => {
  const s = setup({ snapshot_entries: 10 });
  const wt = s.worktree('BIG', { commit: true });
  const deep = path.join(wt, 'Library', 'ddc', 'aa', 'bb'); mkdirSync(deep, { recursive: true });
  for (let i = 0; i < 50; i++) writeFileSync(path.join(deep, `${i}.udd`), 'x');
  const plan = planClean(s.cfg, s.orders, s.env);
  const item = plan.items.find(i => i.tag === 'BIG')!;
  assert.equal(item.action, 'prune'); assert.ok(item.signature);
  applyClean(s.cfg, s.orders, plan, s.env);
  assert.ok(!existsSync(path.join(wt, 'Library'))); assert.ok(existsSync(path.join(wt, 'work.txt')));
});

test('clean plan: only the newest builds stay', () => {
  const s = setup();
  const builds = path.join(s.root, 'artifacts', 'builds');
  ['b1', 'b2', 'b3', 'b4'].forEach((name, i) => {
    mkdirSync(path.join(builds, name), { recursive: true });
    writeFileSync(path.join(builds, name, 'game.exe'), 'x'.repeat(100));
    const t = new Date(Date.UTC(2026, 0, 1 + i));
    utimesSync(path.join(builds, name), t, t);
  });
  const plan = planClean(s.cfg, s.orders, s.env);
  assert.deepEqual(plan.items.map(i => [path.basename(i.path), i.action]), [['b4', 'keep'], ['b3', 'keep'], ['b2', 'delete'], ['b1', 'delete']]);
  assert.equal(plan.items[2].bytes, 100);
});

test('clean plan: nothing is deleted while a configured program runs, or when the process list cannot be read', () => {
  const s = setup({ busy_processes: ['Godot', 'node'] });
  s.worktree('M1'); s.orders.act('M1', 'approve', { force: true });
  const plan = planClean(s.cfg, s.orders, s.env);
  assert.deepEqual(plan.items.map(i => i.action), ['skip']);
  assert.match(plan.items[0].reason, /node\.exe is running/);
  const broken = planClean(s.cfg, s.orders, { ...s.env, processes: () => { throw new Error('tasklist failed'); } });
  assert.equal(broken.items[0].action, 'skip');
  assert.match(broken.errors[0], /tasklist failed/);
  const quiet = planClean(s.cfg, s.orders, { ...s.env, processes: () => ['explorer.exe'] });
  assert.equal(quiet.items[0].action, 'remove');
});

test('clean apply (in temporary repositories): removes the worktree and its branch, prunes caches, unlinks links before deleting, leaves the rest, records an event per action', () => {
  const s = setup();
  const outside = path.join(s.dir, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
  const m1 = s.worktree('M1'); s.orders.act('M1', 'approve', { force: true });
  mkdirSync(path.join(m1, 'Library'), { recursive: true });
  symlinkSync(outside, path.join(m1, 'Library', 'link'), 'junction');                    // a link out of the worktree, inside an ignored folder
  const u1 = s.worktree('U1', { commit: true });
  mkdirSync(path.join(u1, 'Library', 'deep'), { recursive: true });
  symlinkSync(outside, path.join(u1, 'Library', 'deep', 'link'), 'junction');
  writeFileSync(path.join(u1, 'Library', 'deep', 'x.bin'), 'x');
  const m2 = s.worktree('M2', { commit: true }); s.orders.act('M2', 'approve', { force: true });
  const builds = path.join(s.root, 'artifacts', 'builds');
  ['b1', 'b2', 'b3'].forEach((name, i) => {
    mkdirSync(path.join(builds, name), { recursive: true });
    symlinkSync(outside, path.join(builds, name, 'out'), 'junction');
    const t = new Date(Date.UTC(2026, 0, 1 + i));
    utimesSync(path.join(builds, name), t, t);
  });
  const plan = planClean(s.cfg, s.orders, s.env);
  assert.equal(plan.items.find(i => i.tag === 'M1')!.links, 1);
  applyClean(s.cfg, s.orders, plan, s.env);
  assert.ok(!existsSync(m1), 'the merged worktree is gone');
  assert.equal(git(s.root, 'branch', '--list', 'game-m1').trim(), '', 'and its branch');
  assert.equal(git(s.root, 'worktree', 'list').includes('game-m1'), false);
  assert.ok(existsSync(m2), 'a worktree with unmerged commits stays');
  assert.ok(existsSync(path.join(u1, 'work.txt')) && !existsSync(path.join(u1, 'Library')), 'only the cache folder of the unmerged one went');
  assert.ok(!existsSync(path.join(builds, 'b1')) && existsSync(path.join(builds, 'b2')) && existsSync(path.join(builds, 'b3')));
  assert.equal(readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me', 'what the links pointed at is untouched');
  const results = plan.items.filter(i => ['remove', 'prune', 'delete'].includes(i.action)).map(i => i.result);
  assert.equal(results.length, 3);
  assert.ok(results.every(r => /^(removed|deleted)/.test(r!)), results.join(' | '));
  const events = s.orders.store.events().filter(e => e.type === 'clean');
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(e => (e.data as { action: string }).action).sort(), ['delete', 'prune', 'remove']);
  // a second plan has nothing left to do
  assert.deepEqual(planClean(s.cfg, s.orders, s.env).items.filter(i => ['remove', 'prune', 'delete'].includes(i.action)), []);
});

test('clean: links are found and unlinked without touching their targets', () => {
  const { dir } = tempOrders();
  const target = path.join(dir, 'target');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'f.txt'), 'f');
  const tree = path.join(dir, 'tree');
  mkdirSync(path.join(tree, 'a', 'b'), { recursive: true });
  symlinkSync(target, path.join(tree, 'a', 'b', 'link'), 'junction');
  symlinkSync(target, path.join(tree, 'top'), 'junction');
  assert.equal(findLinks(tree).length, 2);
  assert.equal(findLinks(tree, 1).length, 1);
  assert.equal(unlinkLinks(tree), 2);
  assert.equal(findLinks(tree).length, 0);
  assert.equal(readFileSync(path.join(target, 'f.txt'), 'utf8'), 'f');
});

test('api: the clean plan is read only', async () => {
  const { fixture } = await import('./api-fixture.ts');
  const f = await fixture({ project: () => ({ clean: { idle_hours: 0, caches: ['Library'] } }) });
  const plan = (await f.get('/api/clean')).body;
  assert.equal(plan.project, 'demo');
  assert.ok(Array.isArray(plan.items) && Array.isArray(plan.errors) && typeof plan.at === 'string');
  assert.equal((await f.write('/api/clean', { apply: true })).status, 404);      // applying is a command-line step only
  assert.ok(existsSync(f.worktree));
});

test('clean plan: a package rule with a prefix only looks at folders with that prefix and finds the owner after it', () => {
  const s = setup({ packages: [{ dir: 'artifacts/packages', keep: 1, prefix: 'Game-' }] });
  for (const tag of ['OLD', 'NEW', 'OPEN']) s.orders.add({ tag, title: tag, kind: 'task' });
  s.orders.act('OLD', 'approve', { force: true }); s.orders.act('NEW', 'approve', { force: true });
  ['Game-OLD', 'Game-OPEN', 'Game-NEW', 'Other-OLD'].forEach((name, i) => {
    const dir = path.join(s.root, 'artifacts/packages', name); mkdirSync(dir, { recursive: true });
    const at = new Date(Date.UTC(2026, 0, 1 + i)); utimesSync(dir, at, at);
  });
  const plan = planClean(s.cfg, s.orders, s.env).items.filter(i => i.kind === 'package');
  assert.deepEqual(plan.map(i => [path.basename(i.path), i.tag, i.action]), [['Game-NEW', 'NEW', 'keep'], ['Game-OPEN', 'OPEN', 'keep'], ['Game-OLD', 'OLD', 'delete']]);
  assert.throws(() => validateProject({ id: 'x', name: 'x', root: s.root, work_orders: s.root, state_dir: path.join(s.dir, 'st'), clean: { packages: [{ dir: 'artifacts/packages', keep: 1, prefix: 'a/b' }] } }, path.join(s.dir, 'x.yaml')), /prefix/);
});

test('clean fixture dry-run: reused PID, unrelated live run and junction are eligible', t => {
  const s = setup({ packages: [{ dir: 'artifacts/packages', keep: 0 }] });
  s.worktree('MERGED');
  s.orders.runStart('MERGED', { worker: 'fake', extra: { pid: 88, process_started_at: '2025-12-31T23:00:00Z' } });
  s.orders.act('MERGED', 'approve', { force: true });
  s.orders.add({ tag: 'DELIVERY', title: 'Package owner', kind: 'task' }); s.orders.act('DELIVERY', 'approve', { force: true });
  const pkg = path.join(s.root, 'artifacts/packages/DELIVERY-old'); mkdirSync(pkg, { recursive: true });
  s.orders.add({ tag: 'BUSY', title: 'Unrelated work', kind: 'task' });
  s.orders.runStart('BUSY', { worker: 'fake', extra: { pid: 99, process_started_at: '2026-01-01T00:00:01Z' } });
  const toolchain = path.join(s.dir, 'toolchain'); mkdirSync(toolchain);
  writeFileSync(path.join(toolchain, 'precious.txt'), 'preserve');
  const wt = s.worktree('LINKED'); s.orders.act('LINKED', 'approve', { force: true });
  mkdirSync(path.join(wt, 'Library')); symlinkSync(toolchain, path.join(wt, 'Library/toolchain'), directoryLink);
  const plan = planClean(s.cfg, s.orders, s.env);
  const reused = plan.items.find(i => i.tag === 'MERGED' && i.kind === 'worktree')!;
  const work = plan.items.find(i => i.tag === 'LINKED' && i.kind === 'worktree')!;
  const pack = plan.items.find(i => i.kind === 'package')!;
  t.diagnostic(`fixture dry-run | reused-pid worktree: ${reused.action} (${reused.reason}) | unrelated-run package: ${pack.action} (${pack.reason}) | junction worktree: ${work.action}, ${work.links} link`);
  assert.equal(reused.action, 'remove'); assert.match(reused.reason, /pid 88 belongs to another process now/);
  assert.equal(work.action, 'remove'); assert.equal(work.links, 1); assert.ok(work.signature);
  assert.equal(pack.action, 'delete');
  let checked = false;
  const env = { ...s.env, runGit: (cwd: string, args: string[]) => {
    if (args[0] === 'worktree' && args[1] === 'remove' && path.resolve(args.at(-1)!) === wt) {
      assert.equal(findLinks(wt).length, 0, 'junction is unlinked before git removes the worktree'); checked = true;
    }
    return s.env.runGit(cwd, args);
  } };
  applyClean(s.cfg, s.orders, plan, env);
  assert.ok(checked); assert.ok(!existsSync(wt)); assert.ok(!existsSync(pkg));
  assert.equal(readFileSync(path.join(toolchain, 'precious.txt'), 'utf8'), 'preserve');
});

test('clean run identity: ended runs never veto, recorded creation time tolerates precision, old unrecorded PID is reused', () => {
  const s = setup(); s.worktree('MERGED');
  s.orders.runStart('MERGED', { worker: 'fake', extra: { pid: 88, process_started_at: '2026-01-01T00:00:00.500Z' } });
  s.orders.act('MERGED', 'approve', { force: true });
  assert.equal(planClean(s.cfg, s.orders, s.env).items[0].action, 'skip');
  s.orders.runEnd('MERGED');
  assert.equal(planClean(s.cfg, s.orders, s.env).items[0].action, 'remove');
  s.orders.act('MERGED', 'rework', { force: true });
  s.orders.runStart('MERGED', { worker: 'fake', extra: { pid: 89 } });
  s.orders.act('MERGED', 'approve', { force: true });
  const older = { ...s.env, probes: { ...s.env.probes, processStartedAt: () => '2025-12-31T23:00:00Z' } };
  assert.match(planClean(s.cfg, s.orders, older).items[0].reason, /pid 89 belongs to another process now/);
  assert.equal(planClean(s.cfg, s.orders, older).items[0].action, 'remove');
  assert.equal(planClean(s.cfg, s.orders, s.env).items[0].action, 'skip', 'legacy PID started after its run');
});

test('clean scopes owner runs, monitors, executable paths, and open logs; apply rechecks them', () => {
  const s = setup({ builds: [{ dir: 'artifacts/builds', keep: 0 }], packages: [{ dir: 'artifacts/packages', keep: 0 }], logs_days: 0 });
  s.orders.add({ tag: 'OWNER', title: 'Owner', kind: 'task' });
  const pkg = path.join(s.root, 'artifacts/packages/OWNER-old'), build = path.join(s.root, 'artifacts/builds/OWNER-old');
  for (const dir of [pkg, build]) mkdirSync(dir, { recursive: true });
  const log = path.join(s.cfg.state_dir, 'runs/owner.log'), otherLog = path.join(s.cfg.state_dir, 'runs/other.log');
  mkdirSync(path.dirname(log), { recursive: true }); writeFileSync(log, 'own'); writeFileSync(otherLog, 'closed');
  s.orders.runStart('OWNER', { worker: 'fake', extra: { pid: 77, log } });
  s.orders.act('OWNER', 'approve', { force: true });
  let plan = planClean(s.cfg, s.orders, s.env);
  assert.equal(plan.items.find(i => i.path === log)!.action, 'keep');
  assert.equal(plan.items.find(i => i.path === otherLog)!.action, 'delete');
  assert.ok(plan.items.filter(i => ['package', 'build'].includes(i.kind)).every(i => i.action === 'skip'));
  s.orders.runEnd('OWNER');
  const eligible = planClean(s.cfg, s.orders, s.env);
  const launched = { ...s.env, executableProcesses: () => [{ pid: 44, executable: path.join(pkg, 'game.exe') }] };
  plan = planClean(s.cfg, s.orders, launched);
  assert.equal(plan.items.find(i => i.kind === 'package')!.action, 'skip');
  assert.equal(plan.items.find(i => i.kind === 'build')!.action, 'delete');
  assert.throws(() => applyClean(s.cfg, s.orders, eligible, launched), /stale plan/); assert.ok(existsSync(build));
  const spec = { check: ['fake-status'], done_when: { exit_code: 0 }, deadline_minutes: 60 };
  s.orders.report('OWNER', { status: 'monitoring', summary: 'Detached job', evidence: [], commits: [], monitor: spec });
  assert.ok(planClean(s.cfg, s.orders, s.env).items.filter(i => ['package', 'build'].includes(i.kind)).every(i => i.action === 'skip'));
  const resolved = s.orders.get('OWNER');
  resolved.monitor!.resolved = { at: '2026-01-01T00:30:00Z', result: 'done', tail: 'done' }; s.orders.store.write(resolved);
  assert.ok(planClean(s.cfg, s.orders, s.env).items.filter(i => ['package', 'build'].includes(i.kind)).every(i => i.action === 'delete'));
});

test('clean signature fingerprints links, never their toolchain contents, and refuses linked ancestors', () => {
  const { dir } = tempOrders(); const tree = path.join(dir, 'tree'), target = path.join(dir, 'toolchain');
  mkdirSync(tree); mkdirSync(target); writeFileSync(path.join(target, 'file'), 'first');
  const link = path.join(tree, 'link'); symlinkSync(target, link, directoryLink);
  const first = cleanSignature([tree]); assert.ok(first);
  writeFileSync(path.join(target, 'file'), 'external content changed');
  assert.equal(cleanSignature([tree]), first);
  assert.equal(cleanSignature([path.join(link, 'file')]), undefined);
  const second = path.join(dir, 'other'); mkdirSync(second);
  unlinkSync(link); symlinkSync(second, link, directoryLink);
  assert.notEqual(cleanSignature([tree]), first);
});

test('clean worktrees exceed full snapshot limits but are planned and removed after unlinking deep junctions', t => {
  const s = setup({ snapshot_entries: 1, snapshot_seconds: 0.001 });
  const wt = s.worktree('MERGED'); s.orders.act('MERGED', 'approve', { force: true });
  const deep = path.join(wt, 'Library', 'cache', 'engine', 'generated'); mkdirSync(deep, { recursive: true });
  for (let i = 0; i < 32; i++) writeFileSync(path.join(deep, `${i}.bin`), 'ignored engine cache');
  const outside = path.join(s.dir, 'toolchain'); mkdirSync(outside); writeFileSync(path.join(outside, 'keep'), 'preserve');
  symlinkSync(outside, path.join(deep, 'toolchain'), directoryLink);
  assert.equal(cleanSignature([wt], undefined, { entries: 1 }), undefined, 'the former full fingerprint exceeds the configured limit');
  const plan = planClean(s.cfg, s.orders, s.env), item = plan.items.find(i => i.tag === 'MERGED')!;
  assert.equal(item.action, 'remove'); assert.ok(item.signature);
  // A change below the shallow snapshot is expected for ignored engine output.
  writeFileSync(path.join(deep, '0.bin'), 'updated ignored cache');
  let unlinked = false;
  applyClean(s.cfg, s.orders, plan, { ...s.env, runGit: (cwd, args) => {
    if (args[0] === 'worktree' && args[1] === 'remove') {
      assert.ok(args.includes('--force')); assert.deepEqual(findLinks(wt, Infinity), []); unlinked = true;
    }
    return s.env.runGit(cwd, args);
  } });
  assert.ok(unlinked); assert.ok(!existsSync(wt)); assert.match(item.result!, /^removed/);
  assert.equal(readFileSync(path.join(outside, 'keep'), 'utf8'), 'preserve');
  t.diagnostic('large-worktree dry-run | full snapshot: skip (entry limit) | shallow Git fingerprint: remove | apply: removed; deep junction unlinked first; destination preserved');
});

test('clean worktree apply rechecks HEAD, branch, full untracked status and shallow metadata', () => {
  for (const change of ['HEAD', 'branch', 'untracked', 'metadata', 'link']) {
    const s = setup(); const wt = s.worktree('MERGED'); s.orders.act('MERGED', 'approve', { force: true });
    const cache = path.join(wt, 'Library'); mkdirSync(cache); writeFileSync(path.join(cache, 'file'), 'initial');
    const outside = path.join(s.dir, 'toolchain'); mkdirSync(outside);
    const link = path.join(cache, 'toolchain'); symlinkSync(outside, link, directoryLink);
    const plan = planClean(s.cfg, s.orders, s.env); assert.equal(plan.items[0].action, 'remove');
    const old = worktreeSignature(wt, s.env.runGit); assert.ok(old);
    if (change === 'HEAD') git(wt, 'commit', '--allow-empty', '-q', '-m', 'new head');
    if (change === 'branch') git(wt, 'checkout', '-q', '-b', 'renamed');
    if (change === 'untracked') {
      mkdirSync(path.join(wt, 'source', 'nested'), { recursive: true }); writeFileSync(path.join(wt, 'source', 'nested', 'new.txt'), 'untracked');
    }
    if (change === 'metadata') writeFileSync(path.join(cache, 'file'), 'changed shallow ignored output');
    if (change === 'link') { unlinkSync(link); symlinkSync(s.root, link, directoryLink); }
    assert.notEqual(worktreeSignature(wt, s.env.runGit), old, change);
    assert.throws(() => applyClean(s.cfg, s.orders, plan, s.env), /stale plan/, change);
    assert.ok(existsSync(wt)); assert.ok(lstatSync(link).isSymbolicLink(), 'stale plans do not unlink anything');
  }
});

test('clean full snapshot budgets remain configurable for builds, packages and cache pruning', () => {
  const s = setup({ snapshot_entries: 1, snapshot_seconds: 5, builds: [{ dir: 'artifacts/builds', keep: 0 }], packages: [{ dir: 'artifacts/packages', keep: 0 }] });
  const wt = s.worktree('ACTIVE', { commit: true });
  s.orders.add({ tag: 'OWNER', title: 'Owner', kind: 'task' }); s.orders.act('OWNER', 'approve', { force: true });
  const targets = [path.join(wt, 'Library'), path.join(s.root, 'artifacts/builds/OWNER-old'), path.join(s.root, 'artifacts/packages/OWNER-old')];
  for (const dir of targets) { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'file'), 'artifact'); }
  const limited = planClean(s.cfg, s.orders, s.env);
  assert.equal(limited.items.length, 3);
  assert.ok(limited.items.every(i => i.action === 'skip' && /Snapshot limit/.test(i.reason)));
  s.cfg.clean!.snapshot_entries = 100;
  const plan = planClean(s.cfg, s.orders, s.env);
  assert.deepEqual(plan.items.map(i => i.action), ['prune', 'delete', 'delete']);
  applyClean(s.cfg, s.orders, plan, s.env);
  assert.ok(targets.every(dir => !existsSync(dir))); assert.ok(existsSync(wt));
});

test('clean snapshot time budget and config validation', t => {
  const s = setup(); const file = path.join(s.root, 'a.txt');
  const validate = (clean: Record<string, unknown>) => validateProject({ id: 'demo', name: 'Demo', root: s.root, work_orders: s.root, state_dir: s.cfg.state_dir, clean }, s.cfg.file).clean!;
  assert.equal(validate({ snapshot_entries: 12, snapshot_seconds: 0.5 }).snapshot_entries, 12);
  assert.equal(validate({ snapshot_seconds: 0.5 }).snapshot_seconds, 0.5);
  assert.equal(validate({}).snapshot_entries ?? 100000, 100000);
  for (const value of [0, -1, 1.5, Infinity, '100']) assert.throws(() => validate({ snapshot_entries: value }), /snapshot_entries/);
  for (const value of [0, -1, Infinity, NaN, '5']) assert.throws(() => validate({ snapshot_seconds: value }), /snapshot_seconds/);
  let clock = 0; t.mock.method(Date, 'now', () => clock += 100);
  assert.equal(cleanSignature([file], undefined, { seconds: 0.05 }), undefined);
  assert.ok(cleanSignature([file], undefined, { seconds: 1 }));
});

test('clean external package roots retain ownership, keep-N and processes; unlink only exact configured references', () => {
  const s = setup({ builds: [] }); const packages = path.join(s.dir, 'deliveries'), links = path.join(s.dir, 'launchers');
  mkdirSync(packages); mkdirSync(links);
  s.cfg.clean!.packages = [{ dir: packages, keep: 1, links_from: [links] }];
  // Exercise validation too, including roots that do not exist yet.
  const config = (dir: string) => validateProject({ id: 'demo', name: 'Demo', root: s.root, work_orders: s.root, state_dir: s.cfg.state_dir, clean: { packages: [{ dir, keep: 0, links_from: [links] }] } }, s.cfg.file);
  assert.equal(config(packages).clean!.packages![0].dir, packages);
  assert.ok(config(path.join(s.dir, 'future')));
  for (const bad of [path.parse(packages).root, s.root, s.dir]) assert.throws(() => config(bad), /clean.packages dir/);
  const rootLink = path.join(s.dir, 'linked-packages'); symlinkSync(packages, rootLink, directoryLink);
  assert.throws(() => config(rootLink), /clean.packages dir/);
  s.orders.add({ tag: 'OWNER', title: 'Owner', kind: 'task' }); s.orders.act('OWNER', 'approve', { force: true });
  const old = path.join(packages, 'OWNER-old'), newest = path.join(packages, 'OWNER-new'), unknown = path.join(packages, 'unknown');
  for (const [i, dir] of [unknown, old, newest].entries()) { mkdirSync(dir); utimesSync(dir, i + 1, i + 1); }
  const removedLink = path.join(links, 'old'), keptLink = path.join(links, 'new'), childLink = path.join(links, 'child');
  const sub = path.join(old, 'sub'); mkdirSync(sub); utimesSync(old, 2, 2);
  symlinkSync(old, removedLink, directoryLink); symlinkSync(newest, keptLink, directoryLink); symlinkSync(sub, childLink, directoryLink);
  writeFileSync(path.join(links, 'regular.txt'), old);
  const nested = path.join(links, 'nested'); mkdirSync(nested); symlinkSync(old, path.join(nested, 'old'), directoryLink);
  const plan = planClean(s.cfg, s.orders, s.env);
  assert.equal(plan.items.find(i => i.path === old)!.action, 'delete');
  assert.equal(plan.items.find(i => i.path === unknown)!.action, 'keep');
  const processEnv = { ...s.env, executableProcesses: () => [{ pid: 44, executable: path.join(old, 'game.exe') }] };
  assert.equal(planClean(s.cfg, s.orders, processEnv).items.find(i => i.path === old)!.action, 'skip');
  applyClean(s.cfg, s.orders, plan, s.env);
  assert.ok(!existsSync(old)); assert.throws(() => lstatSync(removedLink), /ENOENT/);
  assert.match(plan.items.find(i => i.path === old)!.result!, /1 package reference link\(s\) removed/);
  assert.ok(lstatSync(keptLink).isSymbolicLink()); assert.ok(lstatSync(childLink).isSymbolicLink());
  assert.ok(lstatSync(path.join(nested, 'old')).isSymbolicLink());
  assert.equal(readFileSync(path.join(links, 'regular.txt'), 'utf8'), old);
  assert.ok(existsSync(newest)); assert.ok(existsSync(unknown));
  const foreign = path.join(s.dir, 'foreign-checkout'); mkdirSync(foreign); git(foreign, 'init', '-q');
  const foreignPackages = path.join(foreign, 'deliveries'); mkdirSync(foreignPackages);
  const foreignPackage = path.join(foreignPackages, 'OWNER-old'); mkdirSync(foreignPackage);
  s.cfg.clean!.packages!.push({ dir: foreignPackages, keep: 0 });
  assert.equal(planClean(s.cfg, s.orders, s.env).items.find(i => i.path === foreignPackage)!.action, 'skip', 'a real nested Git checkout remains protected');
});
