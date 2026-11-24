import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { detail } from '../src/api/views.ts';
import { loadProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { worktreePrompt } from '../src/run/launch.ts';
import { ensureWorktree, planWorktree, worktreeSparseDirs } from '../src/run/worktree.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { git } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

function setupRepo(dispatch: Record<string, unknown> = {}) {
  const { dir } = tempOrders();
  const root = path.join(dir, 'repo');
  mkdirSync(path.join(root, 'alpha'), { recursive: true });
  mkdirSync(path.join(root, 'beta'), { recursive: true });
  mkdirSync(path.join(root, 'gamma'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), 'root file\n');
  writeFileSync(path.join(root, 'alpha', 'a.txt'), 'alpha\n');
  writeFileSync(path.join(root, 'beta', 'b.txt'), 'beta\n');
  writeFileSync(path.join(root, 'gamma', 'g.txt'), 'gamma\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const projectFile = path.join(dir, 'alba.yaml');
  writeFileSync(projectFile, [
    'id: demo',
    'name: Demo',
    `root: ${JSON.stringify(root)}`,
    `work_orders: ${JSON.stringify(root)}`,
    `state_dir: ${JSON.stringify(path.join(dir, 'state'))}`,
    'dispatch:',
    `  worktree_parent: ${JSON.stringify(dir)}`,
    '  base_ref: refs/heads/main',
    ...(Array.isArray(dispatch.sparse) ? [`  sparse: ${JSON.stringify(dispatch.sparse)}`] : []),
    ...(typeof dispatch.checkout_workers === 'number' ? [`  checkout_workers: ${dispatch.checkout_workers}`] : []),
  ].join('\n') + '\n');
  const cfg = loadProject(projectFile);
  const store = stateStore(cfg);
  const orders = new Orders(store, () => '2026-01-01T00:00:00Z');
  const cleanup = () => {
    (store as { close?: () => void }).close?.();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows temp cleanup */ }
  };
  return { dir, root, cfg, orders, cleanup };
}

test('D1: sparse worktree checks out only listed folders plus root files, order [] gives full checkout, and reuse is unchanged', () => {
  const s = setupRepo({ sparse: ['alpha', 'gamma'], checkout_workers: 2 });
  try {
    // Project default sparse checkout
    const t1 = s.orders.add({ tag: 'T1', title: 'Sparse default', kind: 'task' });
    const plan1 = planWorktree(s.cfg, t1.order);
    assert.deepEqual(plan1.sparse, ['alpha', 'gamma']);
    const r1 = ensureWorktree(s.cfg, plan1);
    assert.equal(r1.created, true);
    assert.equal(existsSync(path.join(plan1.path, 'README.md')), true);
    assert.equal(existsSync(path.join(plan1.path, 'alpha', 'a.txt')), true);
    assert.equal(existsSync(path.join(plan1.path, 'gamma', 'g.txt')), true);
    assert.equal(existsSync(path.join(plan1.path, 'beta')), false);
    assert.deepEqual(worktreeSparseDirs(plan1.path), ['alpha', 'gamma']);

    // Order detail and prompt line report sparse directories
    s.orders.update('T1', { worktree: plan1.path, branch: plan1.branch });
    const view = detail({ config: s.cfg, orders: s.orders }, 'T1', { probes: systemProbes });
    assert.deepEqual(view.sparseWorktree, ['alpha', 'gamma']);
    const prompt = worktreePrompt(plan1.path, plan1.branch, s.root, worktreeSparseDirs(plan1.path));
    assert.match(prompt, /sparse worktree.*alpha, gamma.*absent on purpose/i);

    // CLI `alba orders show` reports sparse worktree and directories
    const cliOut = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/main.ts', '--project', s.cfg.file, 'orders', 'show', 'T1'], { encoding: 'utf8', windowsHide: true });
    assert.match(cliOut, /sparse worktree: alpha, gamma/i);

    // Order override widening/narrowing sparse
    const t2 = s.orders.add({ tag: 'T2', title: 'Sparse narrowed', kind: 'task', sparse: ['beta'] });
    const plan2 = planWorktree(s.cfg, t2.order);
    ensureWorktree(s.cfg, plan2);
    assert.equal(existsSync(path.join(plan2.path, 'beta', 'b.txt')), true);
    assert.equal(existsSync(path.join(plan2.path, 'alpha')), false);
    assert.equal(existsSync(path.join(plan2.path, 'gamma')), false);
    assert.deepEqual(worktreeSparseDirs(plan2.path), ['beta']);

    // Order field [] gives a full checkout even when dispatch.sparse is set
    const t3 = s.orders.add({ tag: 'T3', title: 'Full checkout', kind: 'task', sparse: [] });
    const plan3 = planWorktree(s.cfg, t3.order);
    assert.equal(plan3.sparse, undefined);
    ensureWorktree(s.cfg, plan3);
    assert.equal(existsSync(path.join(plan3.path, 'alpha', 'a.txt')), true);
    assert.equal(existsSync(path.join(plan3.path, 'beta', 'b.txt')), true);
    assert.equal(existsSync(path.join(plan3.path, 'gamma', 'g.txt')), true);
    assert.equal(worktreeSparseDirs(plan3.path), undefined);

    // Reuse of an existing worktree is unchanged regardless of sparse config change
    const reused = ensureWorktree(s.cfg, { ...plan3, sparse: ['alpha'] });
    assert.equal(reused.created, false);
    assert.equal(existsSync(path.join(plan3.path, 'beta', 'b.txt')), true);
  } finally {
    s.cleanup();
  }
});

test('D1: failing sparse checkout step removes the half-made worktree and newly created branch', () => {
  const s = setupRepo({ sparse: ['alpha'] });
  try {
    // Commit .gitattributes first, then enable a required failing smudge filter so checkout fails
    writeFileSync(path.join(s.root, '.gitattributes'), 'alpha/*.txt filter=failtest\n');
    git(s.root, 'add', '.gitattributes');
    git(s.root, 'commit', '-q', '-m', 'add failing filter');
    git(s.root, 'config', 'filter.failtest.smudge', 'exit 1');
    git(s.root, 'config', 'filter.failtest.clean', 'cat');
    git(s.root, 'config', 'filter.failtest.required', 'true');

    const tFail = s.orders.add({ tag: 'TFAIL', title: 'Fail checkout', kind: 'task' });
    const plan = planWorktree(s.cfg, tFail.order);
    assert.throws(() => ensureWorktree(s.cfg, plan), /git .* failed/);
    assert.equal(existsSync(plan.path), false, 'half-made worktree folder must be removed');
    assert.equal(git(s.root, 'branch', '--list', plan.branch).trim(), '', 'newly created branch must be deleted');
    assert.equal(git(s.root, 'worktree', 'list').includes(plan.branch), false, 'worktree record must be pruned');

    // Also verify invalid sparse paths are rejected in config and order validation
    assert.throws(
      () => validateProject({ id: 'demo', name: 'Demo', root: s.root, work_orders: s.root, state_dir: s.cfg.state_dir, dispatch: { sparse: ['../escape'] } }, s.cfg.file),
      /dispatch\.sparse/,
    );
    assert.throws(
      () => s.orders.add({ tag: 'TBAD', title: 'Bad sparse', kind: 'task', sparse: ['../escape'] }),
      /sparse/,
    );
    assert.throws(
      () => s.orders.add({ tag: 'TBAD2', title: 'Abs sparse', kind: 'task', sparse: ['/abs'] }),
      /sparse/,
    );
  } finally {
    s.cleanup();
  }
});

test('D1: Git LFS filter smudges only files inside sparse paths', () => {
  const s = setupRepo({ sparse: ['alpha'] });
  try {
    const logFile = path.join(s.dir, 'lfs-smudge.log').replace(/\\/g, '/');
    const filterScript = path.join(s.dir, 'fake-lfs-process.mjs').replace(/\\/g, '/');
    writeFileSync(filterScript, [
      'import fs from "node:fs";',
      'const logFile = process.argv[2];',
      'const pkt = (data) => {',
      '  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");',
      '  return Buffer.concat([Buffer.from((buf.length + 4).toString(16).padStart(4, "0")), buf]);',
      '};',
      'const flush = Buffer.from("0000");',
      'const write = (b) => fs.writeSync(1, b);',
      'let acc = Buffer.alloc(0);',
      'function readPkt() {',
      '  while (acc.length < 4) {',
      '    const chunk = Buffer.alloc(4096);',
      '    let n = 0;',
      '    try { n = fs.readSync(0, chunk, 0, chunk.length, null); } catch { return null; }',
      '    if (n === 0) return null;',
      '    acc = Buffer.concat([acc, chunk.subarray(0, n)]);',
      '  }',
      '  const len = parseInt(acc.subarray(0, 4).toString("ascii"), 16);',
      '  if (len === 0) { acc = acc.subarray(4); return ""; }',
      '  while (acc.length < len) {',
      '    const chunk = Buffer.alloc(4096);',
      '    const n = fs.readSync(0, chunk, 0, chunk.length, null);',
      '    if (n === 0) return null;',
      '    acc = Buffer.concat([acc, chunk.subarray(0, n)]);',
      '  }',
      '  const body = acc.subarray(4, len);',
      '  acc = acc.subarray(len);',
      '  return body;',
      '}',
      'function readUntilFlush() {',
      '  const parts = [];',
      '  for (;;) {',
      '    const p = readPkt();',
      '    if (p === null) return null;',
      '    if (p === "") return parts;',
      '    parts.push(p);',
      '  }',
      '}',
      '// Handshake',
      'if (readUntilFlush() === null) process.exit(0);',
      'write(Buffer.concat([pkt("git-filter-server\\n"), pkt("version=2\\n"), flush]));',
      'if (readUntilFlush() === null) process.exit(0);',
      'write(Buffer.concat([pkt("capability=clean\\n"), pkt("capability=smudge\\n"), flush]));',
      'for (;;) {',
      '  const headers = readUntilFlush();',
      '  if (headers === null) break;',
      '  const meta = Object.fromEntries(headers.map(h => h.toString("utf8").trim().split("=")));',
      '  const payload = readUntilFlush();',
      '  if (payload === null) break;',
      '  const content = Buffer.concat(payload);',
      '  let out = content;',
      '  if (meta.command === "smudge") {',
      '    fs.appendFileSync(logFile, `${meta.pathname}\\n`);',
      '    out = Buffer.concat([Buffer.from("SMUDGED:"), content]);',
      '  }',
      '  write(Buffer.concat([pkt("status=success\\n"), flush, ...(out.length ? [pkt(out)] : []), flush, flush]));',
      '}',
    ].join('\n'));
    const nodeCmd = `"${process.execPath.replace(/\\/g, '/')}" "${filterScript}" "${logFile}"`;
    git(s.root, 'config', 'filter.lfs.process', nodeCmd);
    git(s.root, 'config', 'filter.lfs.required', 'true');
    writeFileSync(path.join(s.root, '.gitattributes'), '*.bin filter=lfs\n');
    writeFileSync(path.join(s.root, 'alpha', 'asset.bin'), 'alpha-pointer');
    writeFileSync(path.join(s.root, 'beta', 'huge.bin'), 'beta-pointer');
    git(s.root, 'add', '.gitattributes', 'alpha/asset.bin', 'beta/huge.bin');
    git(s.root, 'commit', '-q', '-m', 'add lfs files');

    const tLfs = s.orders.add({ tag: 'TLFS', title: 'LFS sparse', kind: 'task' });
    const plan = planWorktree(s.cfg, tLfs.order);
    ensureWorktree(s.cfg, plan);

    assert.equal(existsSync(path.join(plan.path, 'alpha', 'asset.bin')), true);
    assert.equal(existsSync(path.join(plan.path, 'beta', 'huge.bin')), false);
    assert.equal(readFileSync(path.join(plan.path, 'alpha', 'asset.bin'), 'utf8'), 'SMUDGED:alpha-pointer');
    const smudged = readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.deepEqual(smudged, ['alpha/asset.bin']);
  } finally {
    s.cleanup();
  }
});
