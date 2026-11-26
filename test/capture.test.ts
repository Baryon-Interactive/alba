import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { parse } from 'yaml';
import { runCapture } from '../src/capture/run.ts';
import type { ProjectConfig } from '../src/config.ts';
import { decodePng } from '../src/verify/png.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { tmpDir } from './tmp.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const exampleYaml = parse(readFileSync(path.resolve('examples/capture/alba.capture.yaml'), 'utf8')) as { capture: Record<string, unknown> };
const fakeGame = path.resolve('examples/capture/fake-game.mjs').replace(/\\/g, '/');

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function withLockDir<T>(lockDir: string, fn: () => T): T {
  const prev = process.env.ALBA_LOCK_DIR;
  process.env.ALBA_LOCK_DIR = lockDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ALBA_LOCK_DIR;
    else process.env.ALBA_LOCK_DIR = prev;
  }
}

function makeCaptureFixture(t: TestContext, extraProject: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'repo');
  const worktree = path.join(dir, 'wt-t1');
  const workOrders = path.join(dir, 'orders');
  const lockDir = path.join(dir, 'locks');
  mkdirSync(root, { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  mkdirSync(lockDir, { recursive: true });

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'README.md'), 'demo\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');

  git(root, 'worktree', 'add', '-qb', 'order-t1', worktree, 'main');
  writeFileSync(path.join(worktree, 'scene.txt'), 'battle scene\n', 'utf8');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-qm', 'add scene');
  const head = git(worktree, 'rev-parse', 'HEAD');

  const project: ProjectConfig = validateProject(
    {
      id: 'demo',
      name: 'Demo',
      root,
      work_orders: workOrders,
      state_dir: path.join(dir, 'state'),
      dispatch: { base_ref: 'main' },
      capture: structuredClone(exampleYaml.capture),
      ...extraProject,
    },
    path.join(dir, 'alba.yaml'),
  );

  orders.add({ tag: 'T1', title: 'Visual scene', kind: 'visual', branch: 'order-t1', worktree });
  writeFileSync(path.join(workOrders, 'T1.md'), '# Visual scene\n\n## Acceptance\n- Renders menu, day and night.\n', 'utf8');
  orders.runStart('T1', { worker: 'w1' });
  orders.runEnd('T1', 'completed');
  orders.report('T1', { status: 'ready', summary: 'Scene ready', evidence: [], commits: [head] });

  t.after(() => {
    try { git(root, 'worktree', 'remove', '--force', worktree); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  return { orders, dir, root, worktree, workOrders, lockDir, head, project };
}

test('capture config refuses shell strings, duplicate shot names, missing {out}, unknown placeholders and unknown keys with the key named', () => {
  const dir = tmpDir('alba-cap-cfg-');
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const base = { id: 'demo', name: 'Demo', root: dir, work_orders: 'orders', state_dir: 'state' };
  const checkThrows = (capture: unknown, expectedKey: RegExp) => {
    assert.throws(() => validateProject({ ...base, capture }, path.join(dir, 'alba.yaml')), expectedKey);
  };

  try {
    // 1. Shell strings refused
    checkThrows(
      { recipes: [{ name: 'r1', kinds: ['visual'], launch: 'node fake.mjs {out}', shots: [{ name: 's1' }] }] },
      /capture\.recipes\[0\]\.launch/,
    );
    checkThrows(
      { recipes: [{ name: 'r1', kinds: ['visual'], build: 'python package.py', launch: ['node', 'fake.mjs', '{out}'], shots: [{ name: 's1' }] }] },
      /capture\.recipes\[0\]\.build/,
    );
    checkThrows(
      { recipes: [{ name: 'r1', kinds: ['visual'], shots: [{ name: 's1', command: 'node fake.mjs {out}' }] }] },
      /capture\.recipes\[0\]\.shots\[0\]\.command/,
    );

    // 2. Duplicate shot name refused
    checkThrows(
      {
        recipes: [{
          name: 'r1',
          kinds: ['visual'],
          launch: ['node', 'fake.mjs', '{out}'],
          shots: [{ name: 'menu' }, { name: 'menu' }],
        }],
      },
      /capture\.recipes\[0\]\.shots\[1\]\.name/,
    );

    // 3. Shot without {out} refused
    checkThrows(
      {
        recipes: [{
          name: 'r1',
          kinds: ['visual'],
          launch: ['node', 'fake.mjs'],
          shots: [{ name: 'menu', args: ['--scene', 'menu'] }],
        }],
      },
      /capture\.recipes\[0\]\.shots\[0\]\.args/,
    );
    checkThrows(
      {
        recipes: [{
          name: 'r1',
          kinds: ['visual'],
          launch: ['node', 'fake.mjs', '{out}'],
          shots: [{ name: 'night', command: ['node', 'night.mjs'] }],
        }],
      },
      /capture\.recipes\[0\]\.shots\[0\]\.command/,
    );

    // 4. Unknown placeholder refused
    checkThrows(
      {
        recipes: [{
          name: 'r1',
          kinds: ['visual'],
          launch: ['node', '{bogus}/fake.mjs', '{out}'],
          shots: [{ name: 'menu' }],
        }],
      },
      /capture\.recipes\[0\]\.launch.*\{bogus\}/,
    );
    checkThrows(
      {
        recipes: [{
          name: 'r1',
          kinds: ['visual'],
          build: ['node', '{out}'],
          launch: ['node', 'fake.mjs', '{out}'],
          shots: [{ name: 'menu' }],
        }],
      },
      /capture\.recipes\[0\]\.build.*\{out\}/,
    );

    // 5. Unknown keys refused
    checkThrows({ extra_flag: true, recipes: [] }, /capture\.extra_flag/);
    checkThrows(
      { recipes: [{ name: 'r1', bogus: 1, launch: ['node', 'fake.mjs', '{out}'], shots: [{ name: 'menu' }] }] },
      /capture\.recipes\[0\]\.bogus/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture happy path: three shots pass, manifest records revision, sha256, size and timing, sheet decodes, lock is cleaned up', t => {
  const f = makeCaptureFixture(t, {
    verify: {
      screenshots: {
        duplicate_diff: 0.015,
        blank_std: 0.02,
        dark_mean: 0.12,
        dark_fraction: 0.85,
        luminance: [{ match: 'day.png', mean_min: 0.25 }],
        motion: [{ a: 'day.png', b: 'night.png', min: 10 }],
      },
    },
  });
  // Uncommitted file warns without failing, recorded in manifest.dirty
  writeFileSync(path.join(f.worktree, 'untracked-note.txt'), 'scratch\n', 'utf8');

  const outDir = path.join(f.dir, 'out-happy');
  const res = withLockDir(f.lockDir, () => runCapture(f.project, f.orders, 'T1', { outDir }));

  assert.equal(res.busy, false);
  assert.equal(res.summary.status, 'passed', res.summary.reason);
  assert.equal(res.manifest.version, 1);
  assert.equal(res.manifest.tag, 'T1');
  assert.equal(res.manifest.recipe, 'demo');
  assert.equal(res.manifest.report, 2);
  assert.equal(res.manifest.revision, f.head);
  assert.deepEqual(res.manifest.dirty, ['untracked-note.txt']);
  assert.equal(res.warnings.length, 1);
  assert.equal(res.manifest.lock.name, 'capture');
  assert.ok(typeof res.manifest.lock.waited_ms === 'number' && res.manifest.lock.waited_ms >= 0);
  assert.equal(existsSync(path.join(f.lockDir, 'capture.lock')), false, 'lock file removed after capture');

  assert.deepEqual(res.manifest.shots.map(s => s.name), ['menu', 'day', 'night']);
  for (const shot of res.manifest.shots) {
    assert.equal(shot.status, 'ok');
    assert.equal(shot.width, 320);
    assert.equal(shot.height, 180);
    assert.ok(typeof shot.duration_ms === 'number' && shot.duration_ms >= 0);
    assert.ok(Number.isFinite(Date.parse(shot.started)));
    const raw = readFileSync(path.join(outDir, shot.file));
    assert.equal(shot.bytes, raw.length);
    assert.equal(shot.sha256, createHash('sha256').update(raw).digest('hex'));
  }

  assert.equal(res.manifest.sheet, 'sheet.png');
  const sheetDecoded = decodePng(readFileSync(res.summary.sheet));
  assert.equal(sheetDecoded.status, 'ok');

  const gateNames = res.manifest.gates.map(g => g.name);
  for (const expected of ['identical', 'blank', 'dark', 'size', 'baseline', 'luminance', 'motion']) {
    assert.ok(gateNames.includes(expected), `missing gate ${expected}`);
  }
  assert.ok(res.manifest.gates.every(g => g.status === 'pass'));
});

test('capture rejects invalid evidence naming the shot, fails on stale artifact and HEAD mismatch, and stops hung or keep-running processes', t => {
  const f = makeCaptureFixture(t);

  const runWithRecipe = (name: string, recipeOverride: Record<string, unknown>) => {
    const baseRecipe = structuredClone((exampleYaml.capture.recipes as Record<string, unknown>[])[0]);
    const cfg = validateProject(
      {
        id: 'demo',
        name: 'Demo',
        root: f.root,
        work_orders: f.workOrders,
        state_dir: path.join(f.dir, 'state'),
        dispatch: { base_ref: 'main' },
        capture: { recipes: [{ ...baseRecipe, ...recipeOverride }] },
      },
      path.join(f.dir, `alba-${name}.yaml`),
    );
    return withLockDir(f.lockDir, () => runCapture(cfg, f.orders, 'T1', { outDir: path.join(f.dir, `out-${name}`) }));
  };

  // 1. --ignore-scene -> identical fails naming shots
  const identicalRes = runWithRecipe('identical', {
    shots: [
      { name: 'menu', args: ['--scene', 'menu', '--ignore-scene'] },
      { name: 'day', args: ['--scene', 'day', '--ignore-scene'] },
    ],
  });
  assert.equal(identicalRes.summary.status, 'failed');
  assert.equal(identicalRes.manifest.gates.find(g => g.name === 'identical')?.status, 'fail');
  assert.match(identicalRes.summary.reason ?? '', /menu.*day/);

  // 2. --black -> blank fails naming the shot
  const blankRes = runWithRecipe('blank', {
    shots: [
      { name: 'menu', args: ['--scene', 'menu'] },
      { name: 'voidshot', args: ['--scene', 'day', '--black'] },
    ],
  });
  assert.equal(blankRes.summary.status, 'failed');
  assert.equal(blankRes.manifest.gates.find(g => g.name === 'blank')?.status, 'fail');
  assert.match(blankRes.summary.reason ?? '', /voidshot/);

  // 3. wrong size -> size gate fails naming shots
  const sizeRes = runWithRecipe('size', {
    size: [1600, 900],
    shots: [{ name: 'menu', args: ['--scene', 'menu'] }],
  });
  assert.equal(sizeRes.summary.status, 'failed');
  assert.equal(sizeRes.manifest.gates.find(g => g.name === 'size')?.status, 'fail');
  assert.match(sizeRes.summary.reason ?? '', /menu/);

  // 4. shot too close / equal to baseline -> baseline gate fails naming shot and baseline
  const baselineRes = runWithRecipe('baseline', {
    baseline: 'menu',
    min_change: 250,
    shots: [
      { name: 'menu', args: ['--scene', 'menu'] },
      { name: 'day', args: ['--scene', 'day'] },
    ],
  });
  assert.equal(baselineRes.summary.status, 'failed');
  assert.equal(baselineRes.manifest.gates.find(g => g.name === 'baseline')?.status, 'fail');
  assert.match(baselineRes.summary.reason ?? '', /day looks like menu/);

  // 5. --exit-before 3 -> fails with "exited with code 3 before" and shot named
  const exitBeforeRes = runWithRecipe('exit-before', {
    baseline: undefined,
    shots: [{ name: 'crashshot', args: ['--scene', 'menu', '--exit-before', '3'] }],
  });
  assert.equal(exitBeforeRes.summary.status, 'failed');
  assert.match(exitBeforeRes.summary.reason ?? '', /crashshot.*exited with code 3 before/);

  // 6. --hang -> timeout, fails naming shot, process is gone afterwards
  const hangMarker = path.join(f.dir, 'hang.marker');
  const hangRes = runWithRecipe('hang', {
    baseline: undefined,
    shots: [{ name: 'hungshot', command: [process.execPath, fakeGame, '--out', '{out}', '--hang', '--marker', hangMarker.replace(/\\/g, '/')], timeout_seconds: 1 }],
  });
  assert.equal(hangRes.summary.status, 'failed');
  assert.match(hangRes.summary.reason ?? '', /hungshot.*no picture after 1 s \(stopped\)/);
  const hungPid = Number(readFileSync(hangMarker, 'utf8').trim().split(/\s+/)[0]);
  assert.ok(Number.isInteger(hungPid) && hungPid > 0);
  assert.equal(processAlive(hungPid), false, 'hung shot process must be stopped');

  // 7. done: file with --keep-running -> passes AND process is stopped afterwards
  const keepMarker = path.join(f.dir, 'keep.marker');
  const keepRes = runWithRecipe('keep-running', {
    done: 'file',
    baseline: undefined,
    shots: [{ name: 'liveview', command: [process.execPath, fakeGame, '--out', '{out}', '--size', '320x180', '--scene', 'day', '--keep-running', '--marker', keepMarker.replace(/\\/g, '/')], timeout_seconds: 15 }],
  });
  assert.equal(keepRes.summary.status, 'passed', keepRes.summary.reason);
  const keepPid = Number(readFileSync(keepMarker, 'utf8').trim().split(/\s+/)[0]);
  assert.ok(Number.isInteger(keepPid) && keepPid > 0);
  assert.equal(processAlive(keepPid), false, 'done:file process must be stopped once {out} is written');

  // 8. stale artifact (older than build start) -> fails as stale
  const staleBin = path.join(f.worktree, 'dist', 'Game.bin');
  mkdirSync(path.dirname(staleBin), { recursive: true });
  writeFileSync(staleBin, 'old build', 'utf8');
  const oldDate = new Date(Date.now() - 60_000);
  utimesSync(staleBin, oldDate, oldDate);
  const staleRes = runWithRecipe('stale', {
    build: [process.execPath, '-e', 'process.exit(0)'],
    artifact: 'dist/Game.bin',
    shots: [{ name: 'menu', args: ['--scene', 'menu'] }],
  });
  assert.equal(staleRes.summary.status, 'failed');
  assert.match(staleRes.summary.reason ?? '', /stale/i);

  // 9. worktree HEAD moved off the branch tip -> fails with HEAD mismatch
  git(f.worktree, 'checkout', '-q', '--detach', 'HEAD~1');
  const headRes = runWithRecipe('head-mismatch', {
    shots: [{ name: 'menu', args: ['--scene', 'menu'] }],
  });
  assert.equal(headRes.summary.status, 'failed');
  assert.match(headRes.summary.reason ?? '', /HEAD.*not the tip/i);
});
