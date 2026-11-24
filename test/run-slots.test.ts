import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { detail } from '../src/api/views.ts';
import { Orders } from '../src/orders/service.ts';
import { bindProjectMachineStore, closeMachineStores, machineStoreAt, unbindProjectMachineStore } from '../src/resources/machine-store.ts';
import { workerEnvironment } from '../src/run/environment.ts';
import { computePortBase, startRun, type RunContext } from '../src/run/launch.ts';
import { systemProbes, type Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { git } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';
import { testStore, validateProject } from './state-helper.ts';

function setupProject(opts: { id?: string; dir?: string; dispatch?: Record<string, unknown> } = {}) {
  const dir = opts.dir ?? tempOrders().dir;
  const id = opts.id ?? 'demo';
  const root = path.join(dir, `${id}-repo`);
  const ordersDir = path.join(dir, `${id}-orders`);
  const stateDir = path.join(dir, `${id}-state`);
  mkdirSync(root, { recursive: true });
  mkdirSync(ordersDir, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'hello\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const project = validateProject({
    id,
    name: `Demo ${id}`,
    root,
    work_orders: ordersDir,
    state_dir: stateDir,
    dispatch: { worktree_parent: path.join(dir, `${id}-wt`), base_ref: 'refs/heads/main', ...opts.dispatch },
    roles: { coder: { default: true } },
  }, path.join(dir, `${id}.yaml`));
  const workers = validateWorkers({
    workers: [{
      id: 'w1',
      engine: 'script',
      concurrency: 10,
      launch: { program: process.execPath, args: ['-e', 'process.exit(0)'] },
    }],
  }, path.join(dir, 'workers.yaml'));
  const orders = new Orders(testStore(stateDir), () => '2026-01-01T00:00:00Z');
  const spawned: { program: string; args: string[]; env: Record<string, string>; cwd: string; pid: number }[] = [];
  const alive = new Set<number>();
  let nextPid = 1000;
  const probes: Probes = {
    ...systemProbes,
    now: () => new Date('2026-01-01T00:00:00Z'),
    isAlive: pid => alive.has(pid),
    processStartedAt: () => '2026-01-01T00:00:00Z',
    spawnDetached: (program, args, options) => {
      const pid = ++nextPid;
      alive.add(pid);
      const effectiveEnv = workerEnvironment(process.env, options.env, options.envUnset);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(effectiveEnv)) if (v !== undefined) env[k] = v;
      spawned.push({ program, args, env, cwd: options.cwd, pid });
      return pid;
    },
  };
  const ctx: RunContext = { project, orders, workers, probes };
  const addQueued = (tag: string) => {
    writeFileSync(path.join(ordersDir, `${tag}-task.md`), `# ${tag}\nDo work.\n`);
    orders.add({ tag, title: tag, kind: 'task' });
    orders.act(tag, 'queue');
  };
  return { dir, project, orders, ctx, spawned, alive, addQueued };
}

test('D4: three open runs get 0, 1, 2; when 1 ends a new run gets 1; resumed run keeps its slot; ALBA_PORT_BASE computed only when port_base set', () => {
  const s = setupProject({ dispatch: { port_base: 9000, port_block: 20 } });
  try {
    for (const tag of ['T0', 'T1', 'T2', 'T3']) s.addQueued(tag);

    // Three open runs get 0, 1, 2
    const r0 = startRun(s.ctx, 'T0', 'w1');
    const r1 = startRun(s.ctx, 'T1', 'w1');
    const r2 = startRun(s.ctx, 'T2', 'w1');
    assert.equal(r0.mode, 'start'); assert.equal(r0.slot, 0);
    assert.equal(r1.mode, 'start'); assert.equal(r1.slot, 1);
    assert.equal(r2.mode, 'start'); assert.equal(r2.slot, 2);

    assert.equal(s.spawned[0].env.ALBA_SLOT, '0');
    assert.equal(s.spawned[0].env.ALBA_PORT_BASE, '9000');
    assert.equal(s.spawned[1].env.ALBA_SLOT, '1');
    assert.equal(s.spawned[1].env.ALBA_PORT_BASE, '9020');
    assert.equal(s.spawned[2].env.ALBA_SLOT, '2');
    assert.equal(s.spawned[2].env.ALBA_PORT_BASE, '9040');

    // Prompt mentions both ALBA_SLOT and ALBA_PORT_BASE in one line
    const prompt1 = readFileSync(s.orders.get('T1').runs[0].prompt_file!, 'utf8');
    assert.match(prompt1, /ALBA_SLOT=1.*ALBA_PORT_BASE=9020/);

    // Order detail exposes slot on runs
    const view1 = detail({ config: s.project, orders: s.orders }, 'T1', { probes: s.ctx.probes });
    assert.equal(view1.runs[0].slot, 1);

    // When run 1 ends, a new run T3 gets slot 1
    s.orders.runEnd('T1', 'completed');
    const r3 = startRun(s.ctx, 'T3', 'w1');
    assert.equal(r3.mode, 'start'); assert.equal(r3.slot, 1);
    assert.equal(s.spawned[3].env.ALBA_SLOT, '1');
    assert.equal(s.spawned[3].env.ALBA_PORT_BASE, '9020');

    // Resumed run keeps its previous slot when free (even when slot 0 is also free!)
    s.orders.runEnd('T0', 'completed'); // slot 0 is now free
    s.orders.runEnd('T2', 'capacity');  // T2 had slot 2; ending with capacity leaves T2 queued
    const r2Resume = startRun(s.ctx, 'T2', 'w1');
    assert.equal(r2Resume.mode, 'start');
    assert.equal(r2Resume.slot, 2, 'resumed run keeps its previous slot 2 even though slot 0 is free');
    assert.equal(s.spawned[4].env.ALBA_SLOT, '2');
    assert.equal(s.spawned[4].env.ALBA_PORT_BASE, '9040');
    assert.equal(s.orders.get('T2').runs[1].slot, 2);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('D4: ALBA_PORT_BASE is omitted when dispatch.port_base is not set, and default port_block is 10', () => {
  const s = setupProject();
  try {
    s.addQueued('T1');
    const res = startRun(s.ctx, 'T1', 'w1');
    assert.equal(res.mode, 'start');
    assert.equal(res.slot, 0);
    assert.equal(s.spawned[0].env.ALBA_SLOT, '0');
    assert.equal(s.spawned[0].env.ALBA_PORT_BASE, undefined);
    const prompt = readFileSync(s.orders.get('T1').runs[0].prompt_file!, 'utf8');
    assert.match(prompt, /ALBA_SLOT=0/);
    assert.doesNotMatch(prompt, /ALBA_PORT_BASE/);

    assert.equal(computePortBase({ port_base: 8000, port_block: 10 }, 3), 8030);
    assert.equal(computePortBase({ port_block: 10 }, 3), undefined);
    // Inherited parent ALBA_PORT_BASE / ALBA_SLOT never leak
    const filtered = workerEnvironment({ ...process.env, ALBA_SLOT: '99', ALBA_PORT_BASE: '12345' }, { ALBA_SLOT: '0' }, []);
    assert.equal(filtered.ALBA_SLOT, '0');
    assert.equal(filtered.ALBA_PORT_BASE, undefined);

    // Config validation
    assert.throws(
      () => validateProject({ id: 'demo', name: 'Demo', root: s.project.root, work_orders: s.project.work_orders, state_dir: s.project.state_dir, dispatch: { port_base: 0 } }, s.project.file),
      /dispatch\.port_base/,
    );
    assert.throws(
      () => validateProject({ id: 'demo', name: 'Demo', root: s.project.root, work_orders: s.project.work_orders, state_dir: s.project.state_dir, dispatch: { port_block: 0 } }, s.project.file),
      /dispatch\.port_block/,
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('D4: projects sharing an existing machine store coordinate slots across projects', () => {
  const { dir } = tempOrders();
  const machineFile = path.join(dir, 'machine.sqlite');
  const a = setupProject({ id: 'proj-a', dir });
  const b = setupProject({ id: 'proj-b', dir });
  // Create the machine store first so both projects find an existing machine store
  machineStoreAt(machineFile);
  bindProjectMachineStore(a.project, { file: machineFile });
  bindProjectMachineStore(b.project, { file: machineFile });
  try {
    a.addQueued('A1');
    b.addQueued('B1');
    b.addQueued('B2');

    const ra1 = startRun(a.ctx, 'A1', 'w1');
    assert.equal(ra1.mode, 'start'); assert.equal(ra1.slot, 0);

    // Project B sees slot 0 is held by project A's live process, so B1 gets slot 1
    // Share the alive PID tracking between probes so B sees A's process is alive
    b.alive.add(ra1.pid!);
    const rb1 = startRun(b.ctx, 'B1', 'w1');
    assert.equal(rb1.mode, 'start'); assert.equal(rb1.slot, 1);

    // Once A1's process exits, B2 reclaims slot 0
    b.alive.delete(ra1.pid!);
    const rb2 = startRun(b.ctx, 'B2', 'w1');
    assert.equal(rb2.mode, 'start'); assert.equal(rb2.slot, 0);
    assert.equal(existsSync(machineFile), true);
  } finally {
    unbindProjectMachineStore(a.project);
    unbindProjectMachineStore(b.project);
    closeMachineStores();
    rmSync(dir, { recursive: true, force: true });
  }
});
