import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { parse, stringify } from 'yaml';
import type { ProjectConfig } from '../src/config.ts';
import { Orders } from '../src/orders/service.ts';
import { acceptanceCard, trialAcceptance } from '../src/review/acceptance.ts';
import { stopProcessTree } from '../src/run/kill-tree.ts';
import type { Probes } from '../src/tick/gather.ts';
import { decodePng } from '../src/verify/png.ts';
import { createBoard } from '../src/web/server.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { testBackend, testStore, validateProject } from './state-helper.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const exampleYaml = parse(readFileSync(path.resolve('examples/capture/alba.capture.yaml'), 'utf8')) as { capture: Record<string, unknown> };
const fakeGame = path.resolve('examples/capture/fake-game.mjs').replace(/\\/g, '/');
const cliMain = path.resolve('src/cli/main.ts');
const lockHelper = path.resolve('src/run/lock-helper.mjs');

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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

function makeFixture(t: TestContext, extraConfig: Record<string, unknown> = {}) {
  const { dir } = tempOrders();
  const root = path.join(dir, 'repo');
  const worktree = path.join(dir, 'wt-t1');
  const workOrders = path.join(dir, 'orders');
  const stateDir = path.join(dir, 'state');
  const lockDir = path.join(dir, 'locks');
  mkdirSync(root, { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  mkdirSync(lockDir, { recursive: true });

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');

  git(root, 'worktree', 'add', '-qb', 'branch-t1', worktree, 'main');
  writeFileSync(path.join(worktree, 'app.txt'), 'v2\n', 'utf8');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-qm', 'feature');
  const head = git(worktree, 'rev-parse', 'HEAD');

  const rawConfig: Record<string, unknown> = {
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: workOrders,
    state_dir: stateDir,
    state: { backend: testBackend() },
    dispatch: { base_ref: 'main', worktree_parent: dir },
    capture: structuredClone(exampleYaml.capture),
    ...extraConfig,
  };
  const yamlFile = path.join(dir, 'alba.yaml');
  writeFileSync(yamlFile, stringify(rawConfig), 'utf8');
  const project: ProjectConfig = validateProject(rawConfig, yamlFile);
  const orders = new Orders(testStore(stateDir));

  orders.add({ tag: 'T1', title: 'Visual delivery', kind: 'visual', branch: 'branch-t1', worktree });
  writeFileSync(path.join(workOrders, 'T1.md'), '# Visual delivery\n\n## Acceptance\n- Renders scenes.\n', 'utf8');
  orders.runStart('T1', { worker: 'w1' });
  orders.runEnd('T1', 'completed');
  orders.report('T1', { status: 'ready', summary: 'Ready for review', evidence: [], commits: [head] });

  t.after(() => {
    try { git(root, 'worktree', 'remove', '--force', worktree); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, root, worktree, workOrders, stateDir, lockDir, yamlFile, head, project, orders };
}

test('acceptance lock contention: busy lock fails step as busy, marks trial retryable, runs no shot, and succeeds once released', async t => {
  const marker = path.join(tempOrders().dir, 'busy-shot.marker');
  const f = makeFixture(t, {
    capture: {
      recipes: [{
        name: 'locked',
        kinds: ['visual'],
        lock: 'capture',
        lock_wait_minutes: 0,
        launch: [process.execPath, fakeGame, '--out', '{out}', '--marker', marker.replace(/\\/g, '/')],
        shots: [{ name: 'menu', args: ['--scene', 'menu'] }],
      }],
    },
  });

  const holderLaunched = new Date().toISOString();
  const holder = spawn(
    process.execPath,
    [lockHelper, 'capture', '--wait-minutes', '1', '--', process.execPath, '-e', 'setInterval(() => {}, 60000)'],
    { env: { ...process.env, ALBA_LOCK_DIR: f.lockDir }, stdio: 'ignore', windowsHide: true },
  );

  try {
    const lockFile = path.join(f.lockDir, 'capture.lock');
    const deadline = Date.now() + 10_000;
    while (!existsSync(lockFile) && Date.now() < deadline) await pause(50);
    assert.equal(existsSync(lockFile), true, 'helper acquired the capture lock');

    const busyTrial = withLockDir(f.lockDir, () => trialAcceptance(f.project, f.orders, 'T1'));
    assert.equal(busyTrial.status, 'failed');
    assert.equal(busyTrial.retryable, true);
    const step = busyTrial.steps.find(s => s.name === 'capture');
    assert.ok(step);
    assert.equal(step.status, 'failed');
    assert.equal(step.tail, 'capture lock "capture" busy');
    assert.equal(existsSync(marker), false, 'no shot ran while the lock was held');
  } finally {
    if (holder.pid) stopProcessTree(holder.pid, undefined, holderLaunched);
    try { holder.kill(); } catch { /* ignore */ }
    await new Promise<void>(resolve => {
      if (holder.exitCode !== null || holder.signalCode !== null) { resolve(); return; }
      holder.once('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
    rmSync(path.join(f.lockDir, 'capture.lock'), { force: true });
    rmSync(path.dirname(marker), { recursive: true, force: true });
  }

  const retried = withLockDir(f.lockDir, () => trialAcceptance(f.project, f.orders, 'T1'));
  assert.equal(retried.status, 'passed', retried.reason);
});

test('acceptance step: runs capture after configured steps, fails trial on bad capture, invalidates cache on recipe change, and leaves projects without capture unchanged', t => {
  const f = makeFixture(t, {
    accept: {
      steps: [{ name: 'unit', command: [process.execPath, '-e', 'console.log("unit ok")'], timeout_minutes: 1 }],
    },
  });

  // 1. Runs capture after configured steps and records summary
  const trial1 = withLockDir(f.lockDir, () => trialAcceptance(f.project, f.orders, 'T1'));
  assert.equal(trial1.status, 'passed', trial1.reason);
  assert.deepEqual(trial1.steps.map(s => s.name), ['unit', 'capture']);
  const capStep = trial1.steps[1]!;
  assert.ok(capStep.capture);
  assert.ok(path.isAbsolute(capStep.capture.manifest));
  assert.ok(path.isAbsolute(capStep.capture.sheet));
  assert.equal(capStep.capture.revision, f.head);
  assert.equal(acceptanceCard(f.project, f.orders, 'T1')?.capture?.sheet, capStep.capture.sheet);

  // Cached when unchanged
  const cached = withLockDir(f.lockDir, () => trialAcceptance(f.project, f.orders, 'T1'));
  assert.equal(cached.id, trial1.id);

  // 2. Changed recipe gives a new trial
  const changedCfg = validateProject(
    {
      id: 'demo',
      name: 'Demo',
      root: f.root,
      work_orders: f.workOrders,
      state_dir: f.stateDir,
      dispatch: { base_ref: 'main' },
      accept: { steps: [{ name: 'unit', command: [process.execPath, '-e', 'console.log("unit ok")'], timeout_minutes: 1 }] },
      capture: {
        recipes: [{
          name: 'demo',
          kinds: ['visual'],
          launch: [process.execPath, fakeGame, '--out', '{out}', '--size', '320x180'],
          shots: [{ name: 'menu', args: ['--scene', 'menu'] }, { name: 'day', args: ['--scene', 'day'] }],
        }],
      },
    },
    f.yamlFile,
  );
  const trial2 = withLockDir(f.lockDir, () => trialAcceptance(changedCfg, f.orders, 'T1'));
  assert.notEqual(trial2.id, trial1.id);
  assert.equal(trial2.status, 'passed');
  assert.equal(trial2.steps[1]?.capture?.shots.length, 2);

  // 3. Failed capture fails the trial
  const failingCfg = validateProject(
    {
      id: 'demo',
      name: 'Demo',
      root: f.root,
      work_orders: f.workOrders,
      state_dir: f.stateDir,
      dispatch: { base_ref: 'main' },
      accept: { steps: [{ name: 'unit', command: [process.execPath, '-e', 'console.log("unit ok")'], timeout_minutes: 1 }] },
      capture: {
        recipes: [{
          name: 'demo',
          kinds: ['visual'],
          launch: [process.execPath, fakeGame, '--out', '{out}'],
          shots: [{ name: 'broken', args: ['--exit-before', '2'] }],
        }],
      },
    },
    f.yamlFile,
  );
  const trialFail = withLockDir(f.lockDir, () => trialAcceptance(failingCfg, f.orders, 'T1'));
  assert.equal(trialFail.status, 'failed');
  assert.match(trialFail.reason ?? '', /Step capture failed.*broken/);

  // 4. Project without capture gives exact configured steps only
  const noCaptureCfg = validateProject(
    {
      id: 'demo',
      name: 'Demo',
      root: f.root,
      work_orders: f.workOrders,
      state_dir: f.stateDir,
      dispatch: { base_ref: 'main' },
      accept: { steps: [{ name: 'unit', command: [process.execPath, '-e', 'console.log("unit ok")'], timeout_minutes: 1 }] },
    },
    f.yamlFile,
  );
  const plainTrial = withLockDir(f.lockDir, () => trialAcceptance(noCaptureCfg, f.orders, 'T1'));
  assert.equal(plainTrial.status, 'passed');
  assert.deepEqual(plainTrial.steps.map(s => s.name), ['unit']);

  // 5. Project with capture recipe and no accept: section runs only the capture step
  const captureOnlyCfg = validateProject(
    {
      id: 'demo',
      name: 'Demo',
      root: f.root,
      work_orders: f.workOrders,
      state_dir: f.stateDir,
      dispatch: { base_ref: 'main' },
      capture: {
        recipes: [{
          name: 'demo',
          kinds: ['visual'],
          launch: [process.execPath, fakeGame, '--out', '{out}', '--size', '320x180'],
          shots: [{ name: 'menu', args: ['--scene', 'menu'] }],
        }],
      },
    },
    f.yamlFile,
  );
  const captureOnlyTrial = withLockDir(f.lockDir, () => trialAcceptance(captureOnlyCfg, f.orders, 'T1'));
  assert.equal(captureOnlyTrial.status, 'passed');
  assert.deepEqual(captureOnlyTrial.steps.map(s => s.name), ['capture']);
});

test('CLI alba capture exit codes 0/1/2, --dry-run and --json, plus GET /api/orders/:tag and GET /api/files sheet', async t => {
  const dryMarker = path.join(tempOrders().dir, 'dry-run.marker');
  const f = makeFixture(t, {
    capture: {
      recipes: [
        {
          name: 'good',
          kinds: ['visual'],
          launch: [process.execPath, fakeGame, '--out', '{out}', '--size', '320x180', '--marker', dryMarker.replace(/\\/g, '/')],
          shots: [
            { name: 'menu', args: ['--scene', 'menu'] },
            { name: 'day', args: ['--scene', 'day'] },
          ],
        },
        {
          name: 'bad',
          kinds: ['broken-kind'],
          launch: [process.execPath, fakeGame, '--out', '{out}'],
          shots: [{ name: 'crash', args: ['--exit-before', '4'] }],
        },
      ],
    },
  });

  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cliMain, '--project', f.yamlFile, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ALBA_LOCK_DIR: f.lockDir },
    });

  try {
    // 1. --dry-run exits 0 and starts nothing
    const dry = runCli('capture', 'T1', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /recipe good/);
    assert.match(dry.stdout, /menu\.png/);
    assert.equal(existsSync(dryMarker), false, '--dry-run must not start any shot');
    assert.equal(existsSync(path.join(f.stateDir, 'capture')), false);

    // 2. Exit code 2 when recipe does not exist
    const missingRecipe = runCli('capture', 'T1', '--recipe', 'nonexistent');
    assert.equal(missingRecipe.status, 2);

    // 3. Exit code 1 when capture fails
    const failedRun = runCli('capture', 'T1', '--recipe', 'bad');
    assert.equal(failedRun.status, 1);
    assert.match(failedRun.stdout, /crash.*FAILED/);

    // 4. Exit code 0 with --json on passing capture
    const okJson = runCli('capture', 'T1', '--json');
    assert.equal(okJson.status, 0, okJson.stderr);
    const summary = JSON.parse(okJson.stdout) as { status: string; sheet: string; recipe: string; shots: { name: string }[] };
    assert.equal(summary.status, 'passed');
    assert.equal(summary.recipe, 'good');
    assert.equal(summary.shots.length, 2);
    assert.equal(existsSync(summary.sheet), true);

    // 5. API order detail exposes acceptance.capture (from capture-run event) and GET /api/files serves sheet as image/png
    const probes = {
      now: () => new Date(),
      runCommand: () => '[]',
      freeRamGb: () => 32,
      worktrees: () => [{ path: f.root, branch: 'main' }, { path: f.worktree, branch: 'branch-t1' }],
      gitActivity: () => ({}),
      fileTime: () => undefined,
      isAlive: () => false,
      tail: () => '',
      readText: () => undefined,
      spawnDetached: () => 1234,
    } as unknown as Probes;
    const workers = validateWorkers({ workers: [{ id: 'w1', engine: 'claude-session' }] }, 'w.yaml');
    const board = createBoard({ projects: [f.project], workers, probes, port: 0, listen: false });
    await new Promise<void>(resolve => board.server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      board.hub.stop();
      board.server.closeAllConnections();
      board.server.close();
    });
    const port = (board.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const detailRes = await fetch(`${baseUrl}/api/orders/T1?project=demo`);
    assert.equal(detailRes.status, 200);
    const detail = (await detailRes.json()) as { acceptance?: { capture?: { sheet: string; status: string; recipe: string } } };
    assert.equal(detail.acceptance?.capture?.status, 'passed');
    assert.equal(detail.acceptance?.capture?.recipe, 'good');
    assert.equal(detail.acceptance?.capture?.sheet, summary.sheet);

    const fileRes = await fetch(`${baseUrl}/api/files?project=demo&tag=T1&path=${encodeURIComponent(summary.sheet)}`);
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get('content-type'), 'image/png');
    const sheetBytes = Buffer.from(await fileRes.arrayBuffer());
    assert.equal(decodePng(sheetBytes).status, 'ok');
  } finally {
    rmSync(path.dirname(dryMarker), { recursive: true, force: true });
  }
});
