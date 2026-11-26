import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadProject, validateProject } from '../src/config.ts';
import { withLang } from '../src/i18n.ts';
import { zh as translated } from '../src/i18n-zh.ts';
import { removeTreeSync } from '../src/fs/remove-tree.mjs';
import { primeStartedAt, processStartedAtAsync, resetStartedAtCache } from '../src/monitor/process.ts';
import { closeStateStores, stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import {
  acquireAcceptanceResources, acquireLeases, acquireNightlyLeases, acquireToolLeases, activeLeases,
  machineLeaseProcessActive, ordinal, reconcileLeases, releaseAcceptanceResources, releaseLease,
  releaseNightlyLeases, releaseToolLeases, resourceViews, startBlocked,
} from '../src/resources/leases.ts';
import { closeMachineStores, machineStoreAt, machineStorePath } from '../src/resources/machine-store.ts';
import { startRun } from '../src/run/launch.ts';
import { listNamedLocks } from '../src/run/named-lock.mjs';
import { tick, type Probes } from '../src/tick/gather.ts';
import { createBoard } from '../src/web/server.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { alba } from './cli-helper.ts';
import { ready } from './helpers.ts';
import { tmpDir } from './tmp.ts';

const helper = fileURLToPath(new URL('../src/run/lock-helper.mjs', import.meta.url));
const repoUrl = new URL('../', import.meta.url).href;
type LockWithQueue = ReturnType<typeof listNamedLocks>[number] & { run?: string; queue: { position: number; pid?: number; run?: string; cwd?: string; command?: string; since: string }[] };
const readLocks = () => listNamedLocks() as LockWithQueue[];

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

function withIsolatedMachineEnv<T>(fn: (dirs: { root: string; machineDir: string; lockDir: string }) => T | Promise<T>): Promise<T> {
  const root = tmpDir('alba-mq-');
  const machineDir = path.join(root, 'machine');
  const lockDir = path.join(root, 'locks');
  mkdirSync(lockDir, { recursive: true });
  const prevMachine = process.env.ALBA_MACHINE_DIR;
  const prevLock = process.env.ALBA_LOCK_DIR;
  process.env.ALBA_MACHINE_DIR = machineDir;
  process.env.ALBA_LOCK_DIR = lockDir;
  const cleanup = () => {
    closeMachineStores();
    closeStateStores();
    resetStartedAtCache();
    if (prevMachine === undefined) delete process.env.ALBA_MACHINE_DIR; else process.env.ALBA_MACHINE_DIR = prevMachine;
    if (prevLock === undefined) delete process.env.ALBA_LOCK_DIR; else process.env.ALBA_LOCK_DIR = prevLock;
    removeTreeSync(root);
  };
  return Promise.resolve().then(() => fn({ root, machineDir, lockDir })).finally(cleanup);
}

function makeProject(
  baseDir: string,
  id: string,
  resources: Record<string, unknown>,
  tags: string[] = ['A1', 'A2', 'B1', 'B2', 'H1', 'N1', 'N2', 'R1', 'U1', 'U2'],
  backend: 'sqlite' | 'files' = 'sqlite',
) {
  const dir = path.join(baseDir, id);
  const repo = path.join(dir, 'repo');
  const workOrders = path.join(dir, 'orders');
  const stateDir = path.join(dir, 'state');
  const trees = path.join(dir, 'trees');
  mkdirSync(repo, { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), `# ${id}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  for (const tag of tags) writeFileSync(path.join(workOrders, `${tag}-task.md`), `# ${tag}\nWork for ${tag}.\n`);
  const file = path.join(dir, 'alba.yaml');
  const project = validateProject({
    id,
    name: id,
    root: repo,
    work_orders: workOrders,
    state_dir: stateDir,
    state: { backend },
    resources,
    dispatch: { worktree_parent: trees, base_ref: 'refs/heads/main' },
  }, file);
  let minute = 0;
  const orders = new Orders(stateStore(project), () => new Date(Date.UTC(2026, 0, 1, 0, minute++)).toISOString());
  return { dir, repo, workOrders, stateDir, trees, file, project, orders };
}

const dummyWorkers = () =>
  validateWorkers({ workers: [{ id: 'coder', engine: 'x', concurrency: 5, launch: { template: 'c1', program: 'coder', args: ['run', '{prompt_file}'] } }] }, 'w.yaml');

function mockProbes(nowIso = '2026-01-01T00:30:00Z', over: Partial<Probes> = {}): Probes {
  return {
    now: () => new Date(nowIso),
    runCommand: () => '[]',
    freeRamGb: () => 32,
    worktrees: () => [],
    gitActivity: () => ({}),
    fileTime: () => undefined,
    isAlive: () => false,
    tail: () => '',
    readText: () => undefined,
    spawnDetached: () => 4242,
    ...over,
  } as Probes;
}

test('1. config: scope accepted, default project (lazy store), unknown value refused, machine with exclusive refused', () =>
  withIsolatedMachineEnv(({ root }) => {
    mkdirSync(path.join(root, 'orders'), { recursive: true });
    const writeCfg = (yaml: string) => {
      const f = path.join(root, 'alba.yaml');
      writeFileSync(f, `id: demo\nname: Demo\nroot: .\nwork_orders: orders\nstate_dir: state\n${yaml}`);
      return f;
    };

    const ok = loadProject(writeCfg('resources:\n  local-default: { slots: 2 }\n  local-explicit: { slots: 1, scope: project }\n  shared-gpu: { slots: 3, scope: machine }\n'));
    assert.equal(ok.resources!['local-default'].scope, undefined);
    assert.equal(ok.resources!['local-explicit'].scope, 'project');
    assert.equal(ok.resources!['shared-gpu'].scope, 'machine');

    assert.throws(() => loadProject(writeCfg('resources:\n  x: { slots: 1, scope: cluster }\n')), /"resources\.x\.scope" must be "project" or "machine"/);
    assert.throws(() => loadProject(writeCfg('resources:\n  x: { slots: 1, scope: machine, exclusive: true }\n')), /exclusive cannot be machine-scoped yet/);

    // Lazy store creation: a project with only project-scope resources never creates machine.sqlite
    const localOnly = makeProject(root, 'local-only', { 'unity-main': { slots: 1 } });
    localOnly.orders.add({ tag: 'A1', title: 'Local build', kind: 'sim', uses: ['unity-main'] });
    localOnly.orders.act('A1', 'queue');
    assert.equal(activeLeases(localOnly.project, localOnly.orders).length, 0);
    acquireLeases(localOnly.project, localOnly.orders, localOnly.orders.get('A1'), 'r1', new Date('2026-01-01T00:00:00Z'));
    const views = resourceViews(localOnly.project, localOnly.orders, new Date('2026-01-01T00:05:00Z'));
    assert.equal(views[0].scope, 'project');
    reconcileLeases(localOnly.project, localOnly.orders, new Date('2026-01-01T00:10:00Z'));
    assert.equal(existsSync(machineStorePath()), false, 'project-only resources must never create machine.sqlite');
  }));

test('2. cross-project blocking: machine-scoped pkg blocks project B and names A\'s tag; same-named project-scoped resource does not', () =>
  withIsolatedMachineEnv(({ root }) => {
    const res = {
      pkg: { slots: 1, scope: 'machine', lease_minutes: 30 },
      'unity-main': { slots: 1 },
    };
    const a = makeProject(root, 'proj-a', res);
    const b = makeProject(root, 'proj-b', res);
    const w = dummyWorkers();

    a.orders.add({ tag: 'A1', title: 'Package A', kind: 'sim', uses: ['pkg'] });
    a.orders.act('A1', 'queue');
    b.orders.add({ tag: 'B1', title: 'Package B', kind: 'sim', uses: ['pkg'] });
    b.orders.act('B1', 'queue');

    startRun({ project: a.project, orders: a.orders, workers: w, probes: mockProbes('2026-01-01T00:10:00Z') }, 'A1', 'coder');
    const acquiredEvent = a.orders.store.events({ tag: 'A1' }).find(e => e.type === 'lease-acquired');
    assert.equal(acquiredEvent?.data?.scope, 'machine');

    const bLeases = activeLeases(b.project, b.orders, new Date('2026-01-01T00:25:00Z'));
    const reason = startBlocked(b.project.resources!, bLeases, [], { tag: 'B1', kind: 'sim', uses: ['pkg'] });
    assert.ok(reason);
    assert.match(reason!, /waiting for pkg slot \(1st in queue, unknown; held by proj-a:A1 for 15 min\)/);
    assert.throws(
      () => startRun({ project: b.project, orders: b.orders, workers: w, probes: mockProbes('2026-01-01T00:25:00Z') }, 'B1', 'coder'),
      /B1 cannot start now: waiting for pkg slot.*proj-a:A1/,
    );

    // Even past A1's lease_minutes (30 min), foreign leases do not trigger lease-expired in project B's tick
    const lateTickB = tick(b.project, b.orders, w, mockProbes('2026-01-01T01:00:00Z'), { record: false }).report;
    assert.deepEqual(lateTickB.problems.filter(p => p.kind === 'lease-expired'), []);
    assert.match(lateTickB.heldBack.find(h => h.tag === 'B1')!.why, /proj-a:A1/);

    // Same-named project-scope resource ('unity-main') stays separate across proj-a and proj-b
    a.orders.add({ tag: 'U1', title: 'Unity A', kind: 'sim', uses: ['unity-main'] });
    a.orders.act('U1', 'queue');
    b.orders.add({ tag: 'U2', title: 'Unity B', kind: 'sim', uses: ['unity-main'] });
    b.orders.act('U2', 'queue');
    startRun({ project: a.project, orders: a.orders, workers: w, probes: mockProbes('2026-01-01T00:10:00Z') }, 'U1', 'coder');
    startRun({ project: b.project, orders: b.orders, workers: w, probes: mockProbes('2026-01-01T00:10:00Z') }, 'U2', 'coder');
    assert.equal(b.orders.get('U2').runs.length, 1);

    // Releasing A1 records a hold and lets B1 start
    a.orders.runEnd('A1');
    a.orders.report('A1', ready);
    const rel = reconcileLeases(a.project, a.orders, new Date('2026-01-01T00:40:00Z'));
    assert.equal(rel.length, 1);
    const releasedEvent = a.orders.store.events({ tag: 'A1' }).find(e => e.type === 'lease-released');
    assert.equal(releasedEvent?.data?.scope, 'machine');
    assert.equal(machineStoreAt().holdsFor('pkg').length, 1);
    assert.equal(machineStoreAt().holdsFor('pkg')[0].minutes, 30);

    startRun({ project: b.project, orders: b.orders, workers: w, probes: mockProbes('2026-01-01T00:41:00Z') }, 'B1', 'coder');
    assert.equal(b.orders.get('B1').runs.length, 1);

    // Acceptance, tool, and nightly machine-scoped helpers also route through the shared store
    const extra = makeProject(root, 'proj-c', { gate: { slots: 1, scope: 'machine' } });
    assert.equal(acquireAcceptanceResources(a.project, a.orders, 'A2', ['pkg'], new Date('2026-01-01T00:42:00Z'))?.includes('proj-b:B1'), true);
    assert.equal(acquireToolLeases(extra.project, extra.orders, 'tool:j1', ['gate'], new Date('2026-01-01T00:42:00Z')), undefined);
    assert.ok(acquireNightlyLeases(extra.project, extra.orders, 'nightly:g1', ['gate'], new Date('2026-01-01T02:00:00Z'), 'sim', new Date('2026-01-01T00:42:00Z')));
    releaseToolLeases(extra.project, extra.orders, 'tool:j1', new Date('2026-01-01T00:50:00Z'));
    assert.equal(acquireNightlyLeases(extra.project, extra.orders, 'nightly:g1', ['gate'], new Date('2026-01-01T02:00:00Z'), 'sim', new Date('2026-01-01T00:51:00Z')), undefined);
    releaseNightlyLeases(extra.project, extra.orders, 'nightly:g1', true, new Date('2026-01-01T01:00:00Z'));
    assert.equal(acquireAcceptanceResources(extra.project, extra.orders, 'A1', ['gate'], new Date('2026-01-01T01:01:00Z')), undefined);
    releaseAcceptanceResources(extra.project, extra.orders, 'A1', new Date('2026-01-01T01:05:00Z'));
  }));

test('3. two child processes race for the last machine slot (sqlite and files backends): one wins, loser rolls back run and lease', async () => {
  for (const backend of ['sqlite', 'files'] as const) {
    await withIsolatedMachineEnv(async ({ root, machineDir, lockDir }) => {
      const res = { pkg: { slots: 1, scope: 'machine' } };
      const a = makeProject(root, 'proj-a', res, ['A1'], backend);
      const b = makeProject(root, 'proj-b', res, ['B1'], backend);
      a.orders.add({ tag: 'A1', title: 'Race A', kind: 'sim', uses: ['pkg'] });
      a.orders.act('A1', 'queue');
      b.orders.add({ tag: 'B1', title: 'Race B', kind: 'sim', uses: ['pkg'] });
      b.orders.act('B1', 'queue');
      closeStateStores();

      const workersYaml = path.join(root, 'workers.yaml');
      writeFileSync(workersYaml, [
        'workers:',
        '  - id: dummy',
        '    engine: other',
        '    concurrency: 4',
        '    launch:',
        '      template: d1',
        `      program: ${JSON.stringify(process.execPath)}`,
        '      args: ["-e", "setTimeout(() => {}, 300)"]',
        '',
      ].join('\n'));
      writeFileSync(
        a.file,
        [
          `id: proj-a`, `name: proj-a`, `root: ${JSON.stringify(a.repo)}`, `work_orders: ${JSON.stringify(a.workOrders)}`,
          `state_dir: ${JSON.stringify(a.stateDir)}`, `state: { backend: ${backend} }`, `workers: ${JSON.stringify(workersYaml)}`,
          `resources: { pkg: { slots: 1, scope: machine } }`,
          `dispatch: { worktree_parent: ${JSON.stringify(a.trees)}, base_ref: refs/heads/main }`, '',
        ].join('\n'),
      );
      writeFileSync(
        b.file,
        [
          `id: proj-b`, `name: proj-b`, `root: ${JSON.stringify(b.repo)}`, `work_orders: ${JSON.stringify(b.workOrders)}`,
          `state_dir: ${JSON.stringify(b.stateDir)}`, `state: { backend: ${backend} }`, `workers: ${JSON.stringify(workersYaml)}`,
          `resources: { pkg: { slots: 1, scope: machine } }`,
          `dispatch: { worktree_parent: ${JSON.stringify(b.trees)}, base_ref: refs/heads/main }`, '',
        ].join('\n'),
      );

      const barrierDir = path.join(root, 'barrier');
      mkdirSync(barrierDir, { recursive: true });
      const childScript = `
        import { existsSync, writeFileSync } from 'node:fs';
        import path from 'node:path';
        const [cfgFile, tag, peerReady, myReady] = process.argv.slice(1);
        const { loadProject } = await import(${JSON.stringify(new URL('src/config.ts', repoUrl).href)});
        const { stateStore, closeStateStores } = await import(${JSON.stringify(new URL('src/orders/backend.ts', repoUrl).href)});
        const { Orders } = await import(${JSON.stringify(new URL('src/orders/service.ts', repoUrl).href)});
        const { loadWorkers } = await import(${JSON.stringify(new URL('src/workers/config.ts', repoUrl).href)});
        const { systemProbes } = await import(${JSON.stringify(new URL('src/tick/gather.ts', repoUrl).href)});
        const { startRun } = await import(${JSON.stringify(new URL('src/run/launch.ts', repoUrl).href)});
        const { closeMachineStores } = await import(${JSON.stringify(new URL('src/resources/machine-store.ts', repoUrl).href)});
        const project = loadProject(cfgFile);
        const orders = new Orders(stateStore(project));
        const workers = loadWorkers(project.workers);
        // Ensure worktrees first via dryRun, then synchronize right before the real startRun
        startRun({ project, orders, workers, probes: systemProbes }, tag, 'dummy', { dryRun: true, explicitWorker: true });
        writeFileSync(myReady, '1');
        const deadline = Date.now() + 5000;
        while (!existsSync(peerReady) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        try {
          const out = startRun({ project, orders, workers, probes: systemProbes }, tag, 'dummy', { explicitWorker: true });
          console.log(JSON.stringify({ ok: true, pid: out.pid, run: out.run }));
        } catch (err) {
          console.error(err.message);
          process.exitCode = 1;
        } finally {
          closeMachineStores();
          closeStateStores();
        }
      `;

      const runChild = (cfgFile: string, tag: string, mine: string, peer: string) =>
        new Promise<{ code: number | null; out: string; err: string }>(resolve => {
          const p = spawn(
            process.execPath,
            ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', childScript, cfgFile, tag, path.join(barrierDir, peer), path.join(barrierDir, mine)],
            { env: { ...process.env, ALBA_MACHINE_DIR: machineDir, ALBA_LOCK_DIR: lockDir, ALBA_LANG: 'en' }, windowsHide: true },
          );
          let out = '', err = '';
          p.stdout.on('data', d => { out += d; });
          p.stderr.on('data', d => { err += d; });
          p.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
        });

      const [resA, resB] = await Promise.all([
        runChild(a.file, 'A1', 'a.ready', 'b.ready'),
        runChild(b.file, 'B1', 'b.ready', 'a.ready'),
      ]);

      const winners = [resA, resB].filter(r => r.code === 0);
      const losers = [resA, resB].filter(r => r.code !== 0);
      assert.equal(winners.length, 1, `expected 1 winner on ${backend}, got A=${JSON.stringify(resA)}, B=${JSON.stringify(resB)}`);
      assert.equal(losers.length, 1);
      assert.match(losers[0].err, /cannot start now: waiting for pkg slot/);

      // Clean up winner's dummy child process if still alive
      const winInfo = JSON.parse(winners[0].out) as { pid?: number };
      if (winInfo.pid) { try { process.kill(winInfo.pid, 'SIGTERM'); } catch { /* already exited */ } }

      const freshA = new Orders(stateStore(loadProject(a.file)));
      const freshB = new Orders(stateStore(loadProject(b.file)));
      const [winDoc, loseDoc, loseOrders] = resA.code === 0
        ? [freshA.get('A1'), freshB.get('B1'), freshB]
        : [freshB.get('B1'), freshA.get('A1'), freshA];

      assert.equal(winDoc.runs.length, 1);
      assert.equal(loseDoc.runs.length, 0, `loser on ${backend} must record no run`);
      assert.equal(loseOrders.stage(loseDoc).stage, 'queued');
      assert.equal(loseOrders.store.events().some(e => e.type === 'lease-acquired'), false, `loser on ${backend} must record no lease event`);

      const leasesInStore = machineStoreAt(path.join(machineDir, 'machine.sqlite')).allLeases();
      assert.equal(leasesInStore.length, 1);
      assert.equal(leasesInStore[0].tag, winDoc.order.tag);
    });
  }
});

test('4. queue order: three waiters across two projects, rework enqueued last goes first, exact reason text and removal', () =>
  withIsolatedMachineEnv(({ root }) => {
    const res = { 'ue-package': { slots: 1, scope: 'machine' } };
    const a = makeProject(root, 'proj-a', res);
    const b = makeProject(root, 'proj-b', res);
    const w = dummyWorkers();

    // Seed 3 historical holds of 25 min -> median = 25 min
    const store = machineStoreAt();
    store.recordHold('ue-package', 'proj-a', 'OLD1', 25, '2025-12-31T20:00:00Z');
    store.recordHold('ue-package', 'proj-a', 'OLD2', 25, '2025-12-31T21:00:00Z');
    store.recordHold('ue-package', 'proj-b', 'OLD3', 25, '2025-12-31T22:00:00Z');

    // H1 in proj-a holds ue-package starting at 00:00
    a.orders.add({ tag: 'H1', title: 'Holder', kind: 'sim', uses: ['ue-package'] });
    a.orders.act('H1', 'queue');
    startRun({ project: a.project, orders: a.orders, workers: w, probes: mockProbes('2026-01-01T00:00:00Z') }, 'H1', 'coder');
    reconcileLeases(a.project, a.orders, new Date('2026-01-01T00:25:00Z'));

    // Enqueue N1 (proj-a, new) at 00:32
    a.orders.add({ tag: 'N1', title: 'New 1', kind: 'sim', uses: ['ue-package'] });
    a.orders.act('N1', 'queue');
    reconcileLeases(a.project, a.orders, new Date('2026-01-01T00:32:00Z'));

    // Enqueue N2 (proj-b, new) at 00:35
    b.orders.add({ tag: 'N2', title: 'New 2', kind: 'sim', uses: ['ue-package'] });
    b.orders.act('N2', 'queue');
    reconcileLeases(b.project, b.orders, new Date('2026-01-01T00:35:00Z'));

    // Enqueue R1 (proj-b, rework) LAST at 00:40 (within the 10-min waiter refresh window)
    b.orders.add({ tag: 'R1', title: 'Rework 1', kind: 'sim', uses: ['ue-package'] });
    b.orders.act('R1', 'queue');
    b.orders.runStart('R1', { worker: 'coder' });
    b.orders.runEnd('R1');
    b.orders.report('R1', ready);
    b.orders.act('R1', 'rework', { note: 'fix packaging flags' });
    reconcileLeases(b.project, b.orders, new Date('2026-01-01T00:40:00Z'));
    // Refresh proj-a at 00:40 too: N1 must keep its original 00:32 enqueued_at
    reconcileLeases(a.project, a.orders, new Date('2026-01-01T00:40:00Z'));

    const viewA = resourceViews(a.project, a.orders, new Date('2026-01-01T00:40:00Z'))[0];
    assert.deepEqual(
      viewA.queue?.map(q => ({ pos: q.position, who: `${q.project}:${q.tag}`, prio: q.priority, eta: q.etaMinutes })),
      [
        { pos: 1, who: 'proj-b:R1', prio: 'rework', eta: 0 },
        { pos: 2, who: 'proj-a:N1', prio: 'new', eta: 25 },
        { pos: 3, who: 'proj-b:N2', prio: 'new', eta: 50 },
      ],
    );
    assert.equal(viewA.queue![1].enqueuedAt, '2026-01-01T00:32:00.000Z');

    const leasesA = activeLeases(a.project, a.orders, new Date('2026-01-01T00:40:00Z'));
    const whyN1 = startBlocked(a.project.resources!, leasesA, [], { tag: 'N1', kind: 'sim', uses: ['ue-package'] });
    assert.equal(whyN1, 'waiting for ue-package slot (2nd in queue, about 25 min; held by proj-a:H1 for 40 min)');

    const whyZh = withLang('zh', () => startBlocked(a.project.resources!, leasesA, [], { tag: 'N1', kind: 'sim', uses: ['ue-package'] }));
    assert.ok(whyZh?.includes(translated['No. {n} in queue'].replace('{n}', '2')), whyZh);

    // Even if H1 finishes and frees the 1 slot, N1 (2nd in queue) stays blocked behind proj-b:R1 (1st in queue)
    a.orders.runEnd('H1');
    a.orders.report('H1', ready);
    reconcileLeases(a.project, a.orders, new Date('2026-01-01T00:40:00Z'));
    const afterReleaseA = activeLeases(a.project, a.orders, new Date('2026-01-01T00:40:00Z'));
    assert.match(startBlocked(a.project.resources!, afterReleaseA, [], { tag: 'N1', kind: 'sim', uses: ['ue-package'] })!, /2nd in queue/);
    const afterReleaseB = activeLeases(b.project, b.orders, new Date('2026-01-01T00:40:00Z'));
    assert.equal(startBlocked(b.project.resources!, afterReleaseB, [], { tag: 'R1', kind: 'sim', uses: ['ue-package'] }), undefined);

    // Waiters that stop waiting (cancelled / held) are removed on reconcileLeases
    b.orders.act('R1', 'cancel');
    a.orders.act('N1', 'hold');
    reconcileLeases(b.project, b.orders, new Date('2026-01-01T00:42:00Z'));
    reconcileLeases(a.project, a.orders, new Date('2026-01-01T00:42:00Z'));
    const viewAfter = resourceViews(b.project, b.orders, new Date('2026-01-01T00:42:00Z'))[0];
    assert.deepEqual(viewAfter.queue?.map(q => `${q.position}:${q.project}:${q.tag}`), ['1:proj-b:N2']);

    //Ordinal helper edge cases
    assert.deepEqual([ordinal(1), ordinal(2), ordinal(3), ordinal(4), ordinal(11), ordinal(12), ordinal(13), ordinal(21), ordinal(22), ordinal(23)], [
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd',
    ]);
  }));

test('5. estimate from injected holds: fewer than 3 gives "unknown", numbers rounded up to 5, keeps last 50 and uses last 20', () =>
  withIsolatedMachineEnv(({ root }) => {
    const a = makeProject(root, 'proj-a', { 'gpu-box': { slots: 1, scope: 'machine' } });
    const w = dummyWorkers();
    a.orders.add({ tag: 'H1', title: 'Hold', kind: 'sim', uses: ['gpu-box'] });
    a.orders.act('H1', 'queue');
    startRun({ project: a.project, orders: a.orders, workers: w, probes: mockProbes('2026-01-01T00:00:00Z') }, 'H1', 'coder');

    a.orders.add({ tag: 'N1', title: 'Wait 1', kind: 'sim', uses: ['gpu-box'] });
    a.orders.act('N1', 'queue');
    a.orders.add({ tag: 'N2', title: 'Wait 2', kind: 'sim', uses: ['gpu-box'] });
    a.orders.act('N2', 'queue');
    reconcileLeases(a.project, a.orders, new Date('2026-01-01T00:05:00Z'));

    const store = machineStoreAt();
    store.recordHold('gpu-box', 'proj-a', 'X1', 11, '2025-12-31T01:00:00Z');
    store.recordHold('gpu-box', 'proj-a', 'X2', 13, '2025-12-31T02:00:00Z');

    // Only 2 holds -> "unknown"
    const twoHoldsLeases = activeLeases(a.project, a.orders, new Date('2026-01-01T00:05:00Z'));
    assert.match(startBlocked(a.project.resources!, twoHoldsLeases, [], { tag: 'N1', kind: 'sim', uses: ['gpu-box'] })!, /\(1st in queue, unknown; held by proj-a:H1 for 5 min\)/);
    assert.equal(resourceViews(a.project, a.orders, new Date('2026-01-01T00:05:00Z'))[0].queue![0].etaMinutes, undefined);

    // 3rd hold -> median of [11, 13, 18] is 13; H1 held 5 min -> pos 1: 13 - 5 = 8 -> rounded up to 10; pos 2: 8 + 13 = 21 -> rounded up to 25
    store.recordHold('gpu-box', 'proj-a', 'X3', 18, '2025-12-31T03:00:00Z');
    const threeHoldsView = resourceViews(a.project, a.orders, new Date('2026-01-01T00:05:00Z'))[0];
    assert.deepEqual(threeHoldsView.queue?.map(q => q.etaMinutes), [10, 25]);
    const threeHoldsLeases = activeLeases(a.project, a.orders, new Date('2026-01-01T00:05:00Z'));
    assert.match(startBlocked(a.project.resources!, threeHoldsLeases, [], { tag: 'N1', kind: 'sim', uses: ['gpu-box'] })!, /about 10 min/);
    assert.match(startBlocked(a.project.resources!, threeHoldsLeases, [], { tag: 'N2', kind: 'sim', uses: ['gpu-box'] })!, /about 25 min/);

    // Record 55 more holds: table keeps at most 50, and median uses last 20
    for (let i = 0; i < 55; i++) {
      store.recordHold('gpu-box', 'proj-a', `P${i}`, i >= 35 ? 31 : 100, new Date(Date.UTC(2025, 11, 31, 4, i)).toISOString());
    }
    assert.equal(store.holdsFor('gpu-box', 100).length, 50);
    assert.equal(store.medianHoldMinutes('gpu-box'), 31);
  }));

test('6. stale recovery: dead pid and live pid with another start time are removed; live holder past heartbeat is kept', () =>
  withIsolatedMachineEnv(async ({ root }) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
    try {
      assert.ok(child.pid);
      const actualStarted = await processStartedAtAsync(child.pid!);
      assert.ok(actualStarted, 'expected OS process creation time for spawned child');
      await primeStartedAt(child.pid!);

      const store = machineStoreAt();
      const now = new Date('2026-06-01T12:00:00Z');
      const twoHoursAgo = new Date('2026-06-01T10:00:00Z').toISOString();
      const freshHeartbeat = new Date('2026-06-01T11:59:00Z').toISOString();

      store.transaction(() => {
        // 1. Dead PID
        store.upsertLeaseInTx({
          resource: 'pkg', project: 'proj-a', state_dir: path.join(root, 'sa'), tag: 'DEAD1',
          since: twoHoursAgo, expires: '2026-06-01T18:00:00Z',
          pid: 99999999, started_at: twoHoursAgo, kind: 'acceptance', heartbeat_at: freshHeartbeat,
        });
        // 2. Live PID, but recorded with another start time (PID reuse)
        store.upsertLeaseInTx({
          resource: 'pkg', project: 'proj-b', state_dir: path.join(root, 'sb'), tag: 'REUSED1',
          since: twoHoursAgo, expires: '2026-06-01T18:00:00Z',
          pid: child.pid!, started_at: '2000-01-01T00:00:00.000Z', kind: 'tool', heartbeat_at: freshHeartbeat,
        });
        // 3. Live holder with matching start time, even though its heartbeat is 2 hours old (> 30 min)
        store.upsertLeaseInTx({
          resource: 'pkg', project: 'proj-c', state_dir: path.join(root, 'sc'), tag: 'LIVE1',
          since: twoHoursAgo, expires: '2026-06-01T18:00:00Z',
          pid: child.pid!, started_at: actualStarted, kind: 'dispatch', heartbeat_at: twoHoursAgo,
        });
        // 4. Dispatch lease with unknown pid and stale heartbeat (> 30 min)
        store.upsertLeaseInTx({
          resource: 'pkg', project: 'proj-d', state_dir: path.join(root, 'sd'), tag: 'GHOST1',
          since: twoHoursAgo, expires: '2026-06-01T18:00:00Z',
          kind: 'dispatch', heartbeat_at: twoHoursAgo,
        });
        // Waiters: one stale (15 min old > 10 min), one fresh (2 min old)
        store.db.prepare('INSERT INTO waiters(resource, project, tag, priority, enqueued_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('pkg', 'proj-a', 'W_OLD', 'new', twoHoursAgo, new Date('2026-06-01T11:45:00Z').toISOString());
        store.db.prepare('INSERT INTO waiters(resource, project, tag, priority, enqueued_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('pkg', 'proj-b', 'W_FRESH', 'new', twoHoursAgo, new Date('2026-06-01T11:58:00Z').toISOString());
      });

      const printed: string[] = [];
      const removed = store.recoverStale(now, machineLeaseProcessActive, { print: line => printed.push(line), everyMinutes: 5 });
      assert.deepEqual(removed.map(r => r.tag).sort(), ['DEAD1', 'GHOST1', 'REUSED1']);
      assert.equal(printed.length, 3);
      assert.deepEqual(store.allLeases().map(l => `${l.project}:${l.tag}`), ['proj-c:LIVE1']);
      assert.deepEqual(store.waitersFor('pkg').map(w => `${w.project}:${w.tag}`), ['proj-b:W_FRESH']);
    } finally {
      child.kill('SIGKILL');
    }
  }));

test('7. slot mismatch picks the smallest live declaration and is reported in views and CLI', () =>
  withIsolatedMachineEnv(({ root }) => {
    const a = makeProject(root, 'proj-a', { 'tripo-wallet': { slots: 3, scope: 'machine' } });
    const b = makeProject(root, 'proj-b', { 'tripo-wallet': { slots: 2, scope: 'machine' } });
    const w = dummyWorkers();
    const now = new Date();

    resourceViews(a.project, a.orders, now);
    const viewB = resourceViews(b.project, b.orders, now)[0];
    const viewA = resourceViews(a.project, a.orders, now)[0];

    assert.equal(viewA.slots, 2);
    assert.equal(viewB.slots, 2);
    assert.equal(viewA.slotMismatch, 'tripo-wallet: proj-a says 3, proj-b says 2; using 2');
    assert.equal(viewB.slotMismatch, 'tripo-wallet: proj-a says 3, proj-b says 2; using 2');

    // Enforce effective cap of 2 even in proj-a (which declared 3)
    for (const tag of ['A1', 'A2', 'H1']) {
      a.orders.add({ tag, title: tag, kind: 'sim', uses: ['tripo-wallet'] });
      a.orders.act(tag, 'queue');
    }
    startRun({ project: a.project, orders: a.orders, workers: w, probes: mockProbes(now.toISOString()) }, 'A1', 'coder');
    startRun({ project: a.project, orders: a.orders, workers: w, probes: mockProbes(now.toISOString()) }, 'A2', 'coder');
    assert.throws(
      () => startRun({ project: a.project, orders: a.orders, workers: w, probes: mockProbes(now.toISOString()) }, 'H1', 'coder'),
      /H1 cannot start now: waiting for tripo-wallet slot/,
    );

    writeFileSync(a.file, [
      'id: proj-a', 'name: proj-a', `root: ${JSON.stringify(a.repo)}`, `work_orders: ${JSON.stringify(a.workOrders)}`,
      `state_dir: ${JSON.stringify(a.stateDir)}`, 'resources:', '  tripo-wallet: { slots: 3, scope: machine }', '',
    ].join('\n'));
    const cliOut = alba(a.file, ['resources'], { ALBA_MACHINE_DIR: process.env.ALBA_MACHINE_DIR!, ALBA_LOCK_DIR: process.env.ALBA_LOCK_DIR! });
    assert.equal(cliOut.code, 0);
    assert.match(cliOut.out, /tripo-wallet: proj-a says 3, proj-b says 2; using 2/);
  }));

test('8. named locks: three helpers queue FIFO, killed waiter cleaned, exit codes preserved, listNamedLocks returns run and queue', () =>
  withIsolatedMachineEnv(async ({ root, lockDir }) => {
    const orderFile = path.join(root, 'fifo.txt');
    const step = (label: string, holdMs: number, exit = 0) =>
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(orderFile)},'${label} start\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(orderFile)},'${label} end\\n');process.exit(${exit})},${holdMs})`;

    const spawnHelper = (label: string, runTag: string, holdMs: number, exit = 0, extraArgs: string[] = []) => {
      const p = spawn(process.execPath, [helper, 'capture', ...extraArgs, '--', process.execPath, '-e', step(label, holdMs, exit)], {
        env: { ...process.env, ALBA_LOCK_DIR: lockDir, ALBA_RUN: runTag },
        windowsHide: true,
      });
      let err = '';
      p.stderr.on('data', d => { err += d; });
      const done = new Promise<{ code: number | null; err: string }>(resolve => p.on('close', code => resolve({ code, err })));
      return { proc: p, done };
    };

    const p1 = spawnHelper('p1', 'A1/r1', 900, 0);
    await new Promise(r => setTimeout(r, 150));
    const p2 = spawnHelper('p2', 'B1/r1', 300, 3);
    await new Promise(r => setTimeout(r, 250));
    const p3 = spawnHelper('p3', 'C1/r1', 200, 0);

    // Wait until both p2 and p3 are visible in the queue
    const deadline = Date.now() + 5000;
    let snapshot: LockWithQueue[] = [];
    while (Date.now() < deadline) {
      snapshot = readLocks();
      if (snapshot[0]?.queue?.length === 2) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].run, 'A1/r1');
    assert.deepEqual(snapshot[0].queue.map(q => [q.position, q.run]), [[1, 'B1/r1'], [2, 'C1/r1']]);

    const [r1, r2, r3] = await Promise.all([p1.done, p2.done, p3.done]);
    assert.equal(r1.code, 0);
    assert.equal(r2.code, 3);
    assert.equal(r3.code, 0);
    assert.match(r2.err, /\[lock\] waiting for "capture" \(1st in queue\)/);
    assert.match(r3.err, /\[lock\] waiting for "capture" \(2nd in queue\)/);
    assert.deepEqual(readFileSync(orderFile, 'utf8').trim().split('\n'), [
      'p1 start', 'p1 end', 'p2 start', 'p2 end', 'p3 start', 'p3 end',
    ]);

    // Killed waiter's entry is cleaned and does not block the waiter behind it
    const holder = spawnHelper('h', 'H1/r1', 700, 0);
    await new Promise(r => setTimeout(r, 150));
    const killed = spawnHelper('dead', 'D1/r1', 100, 0);
    await new Promise(r => setTimeout(r, 200));
    const survivor = spawnHelper('live', 'L1/r1', 100, 0);
    const waitTwo = Date.now() + 5000;
    while (Date.now() < waitTwo && (readLocks()[0]?.queue?.length ?? 0) < 2) await new Promise(r => setTimeout(r, 50));
    killed.proc.kill('SIGKILL');
    const [hRes, sRes] = await Promise.all([holder.done, survivor.done]);
    await killed.done;
    assert.equal(hRes.code, 0);
    assert.equal(sRes.code, 0);
    assert.deepEqual(readLocks(), []);
    const remainingQueueFiles = existsSync(path.join(lockDir, 'capture.queue'))
      ? readdirSync(path.join(lockDir, 'capture.queue')).filter(f => f.endsWith('.json'))
      : [];
    assert.deepEqual(remainingQueueFiles, []);

    // Exit codes: 2 usage, 75 timeout, 130 stopped on signal
    assert.equal(spawnSync(process.execPath, [helper, 'bad name!', '--', 'x'], { env: { ...process.env, ALBA_LOCK_DIR: lockDir }, windowsHide: true }).status, 2);
    const blocker = spawnHelper('block', 'X1/r1', 800, 0);
    await new Promise(r => setTimeout(r, 150));
    const timedOut = spawnSync(
      process.execPath,
      [helper, 'capture', '--wait-minutes', '0', '--', process.execPath, '-e', 'process.exit(0)'],
      { env: { ...process.env, ALBA_LOCK_DIR: lockDir }, windowsHide: true },
    );
    assert.equal(timedOut.status, 75);
    const sigScript = `
      const { runNamedLock } = await import(${JSON.stringify(new URL('../src/run/named-lock.mjs', import.meta.url).href)});
      setTimeout(() => process.emit('SIGINT', 'SIGINT'), 120);
      process.exitCode = await runNamedLock(['capture', '--', process.execPath, '-e', 'process.exit(0)']);
    `;
    const stopped = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', sigScript],
      { env: { ...process.env, ALBA_LOCK_DIR: lockDir }, windowsHide: true },
    );
    assert.equal(stopped.status, 130);
    await blocker.done;
  }));

test('9. alba resources --json, alba lock list, alba leases release --project, and GET /api/resources (port 0) show scope, foreign holders and queue', () =>
  withIsolatedMachineEnv(async ({ root, machineDir, lockDir }) => {
    const res = { 'gpu-box': { slots: 1, scope: 'machine' }, 'local-lane': { slots: 2 } };
    const a = makeProject(root, 'proj-a', res);
    const b = makeProject(root, 'proj-b', res);
    const w = dummyWorkers();

    const baseMs = Date.now();
    const t0 = new Date(baseMs - 8 * 60_000);
    const t1 = new Date(baseMs - 5 * 60_000);
    const t2 = new Date(baseMs - 2 * 60_000);

    const store = machineStoreAt();
    store.recordHold('gpu-box', 'proj-a', 'P1', 20, new Date(baseMs - 60 * 60_000).toISOString());
    store.recordHold('gpu-box', 'proj-a', 'P2', 20, new Date(baseMs - 50 * 60_000).toISOString());
    store.recordHold('gpu-box', 'proj-b', 'P3', 20, new Date(baseMs - 40 * 60_000).toISOString());

    // proj-a holds gpu-box with A1; proj-b has B1 (rework) and proj-a has A2 (new) queued
    a.orders.add({ tag: 'A1', title: 'Holder A1', kind: 'sim', uses: ['gpu-box'] });
    a.orders.act('A1', 'queue');
    startRun({ project: a.project, orders: a.orders, workers: w, probes: mockProbes(t0.toISOString()) }, 'A1', 'coder');

    a.orders.add({ tag: 'A2', title: 'Queued A2', kind: 'sim', uses: ['gpu-box'] });
    a.orders.act('A2', 'queue');
    reconcileLeases(a.project, a.orders, t1);

    b.orders.add({ tag: 'B1', title: 'Rework B1', kind: 'sim', uses: ['gpu-box'] });
    b.orders.act('B1', 'queue');
    b.orders.runStart('B1', { worker: 'coder' });
    b.orders.runEnd('B1');
    b.orders.report('B1', ready);
    b.orders.act('B1', 'rework', { note: 'retry capture' });
    reconcileLeases(b.project, b.orders, t2);

    for (const p of [a, b]) {
      writeFileSync(p.file, [
        `id: ${p.project.id}`, `name: ${p.project.name}`, `root: ${JSON.stringify(p.repo)}`,
        `work_orders: ${JSON.stringify(p.workOrders)}`, `state_dir: ${JSON.stringify(p.stateDir)}`,
        'resources:', '  gpu-box: { slots: 1, scope: machine }', '  local-lane: { slots: 2 }', '',
      ].join('\n'));
    }

    // Also hold a named lock with one queued waiter while running CLI checks. The held command lasts until its helper is
    // killed in the finally block (a fixed few seconds ran out on a busy machine before the checks read the lock).
    const holdUntilParentDies = 'const p=process.ppid; setInterval(()=>{try{process.kill(p,0)}catch{process.exit(0)}},200)';
    const lockHolder = spawn(process.execPath, [helper, 'capture', '--', process.execPath, '-e', holdUntilParentDies], {
      env: { ...process.env, ALBA_LOCK_DIR: lockDir, ALBA_RUN: 'A1/r1' }, windowsHide: true,
    });
    await new Promise(r => setTimeout(r, 150));
    const lockWaiter = spawn(process.execPath, [helper, 'capture', '--', process.execPath, '-e', 'process.exit(0)'], {
      env: { ...process.env, ALBA_LOCK_DIR: lockDir, ALBA_RUN: 'B1/r2' }, windowsHide: true,
    });
    // Listen now: on a busy machine both helpers can exit before the checks below finish.
    const helpersClosed = Promise.all([lockHolder, lockWaiter].map(c => new Promise(r => c.once('close', r))));
    const waitLock = Date.now() + 5000;
    while (Date.now() < waitLock && (readLocks()[0]?.queue?.length ?? 0) < 1) await new Promise(r => setTimeout(r, 50));

    try {
      closeMachineStores();
      closeStateStores();

      const env = { ALBA_MACHINE_DIR: machineDir, ALBA_LOCK_DIR: lockDir };
      const cliJson = alba(b.file, ['resources', '--json'], env);
      assert.equal(cliJson.code, 0, cliJson.err);
      const parsed = JSON.parse(cliJson.out);
      const gpu = parsed.resources.find((r: any) => r.name === 'gpu-box');
      const local = parsed.resources.find((r: any) => r.name === 'local-lane');
      assert.equal(gpu.scope, 'machine');
      assert.equal(local.scope, 'project');
      assert.equal(gpu.leases.length, 1);
      assert.deepEqual([gpu.leases[0].project, gpu.leases[0].tag, gpu.leases[0].run], ['proj-a', 'A1', 'r1']);
      assert.deepEqual(gpu.queue.map((q: any) => [q.position, q.project, q.tag, q.priority]), [
        [1, 'proj-b', 'B1', 'rework'],
        [2, 'proj-a', 'A2', 'new'],
      ]);
      assert.equal(parsed.locks[0].name, 'capture');
      assert.equal(parsed.locks[0].run, 'A1/r1');
      assert.equal(parsed.locks[0].queue[0].run, 'B1/r2');

      const lockListOut = alba(b.file, ['lock', 'list'], env);
      assert.equal(lockListOut.code, 0);
      assert.match(lockListOut.out, /capture.*\(A1\/r1\)/);
      assert.match(lockListOut.out, /queue #1 \(1st\).*\(B1\/r2\)/);

      // HTTP GET /api/resources on port 0
      const cfgA = loadProject(a.file);
      const cfgB = loadProject(b.file);
      const board = createBoard({
        projects: [cfgA, cfgB],
        workers: w,
        port: 0,
        probes: mockProbes(new Date().toISOString()),
        snapshotTtlMs: 0,
        uiDir: path.join(root, 'no-ui'),
        signIn: false,
      });
      await new Promise<void>(resolve => board.server.once('listening', resolve));
      try {
        const port = (board.server.address() as AddressInfo).port;
        const resp = await fetch(`http://127.0.0.1:${port}/api/resources?project=proj-b`, { headers: { connection: 'close' } });
        assert.equal(resp.status, 200);
        const body = await resp.json() as any;
        assert.equal(body.project, 'proj-b');
        const apiGpu = body.resources.find((r: any) => r.name === 'gpu-box');
        assert.equal(apiGpu.scope, 'machine');
        assert.deepEqual([apiGpu.leases[0].project, apiGpu.leases[0].tag], ['proj-a', 'A1']);
        assert.deepEqual(apiGpu.queue.map((q: any) => ({ position: q.position, project: q.project, tag: q.tag, priority: q.priority })), [
          { position: 1, project: 'proj-b', tag: 'B1', priority: 'rework' },
          { position: 2, project: 'proj-a', tag: 'A2', priority: 'new' },
        ]);
      } finally {
        board.hub.stop();
        board.server.closeAllConnections();
        board.server.close();
      }

      closeMachineStores();
      closeStateStores();

      // Release proj-a's machine lease from proj-b's CLI via --project proj-a
      const relOut = alba(b.file, ['leases', 'release', 'gpu-box', 'A1', '--project', 'proj-a'], env);
      assert.equal(relOut.code, 0, relOut.err);
      assert.match(relOut.out, /A1: released gpu-box/);

      const afterJson = JSON.parse(alba(b.file, ['resources', '--json'], env).out);
      assert.equal(afterJson.resources.find((r: any) => r.name === 'gpu-box').used, 0);
    } finally {
      lockHolder.kill('SIGKILL');
      lockWaiter.kill('SIGKILL');
      await helpersClosed;
    }
  }));
