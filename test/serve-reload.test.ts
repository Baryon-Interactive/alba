import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { spawnDetachedProgram } from '../src/run/spawn.ts';
import { exitFile, lockFile, lockHolder } from '../src/serve/lock.ts';
import { checkGitReadyForReload, handoverFile, isPidAlive, readHandover } from '../src/serve/reload.ts';
import { MachineStore } from '../src/resources/machine-store.ts';
import { keyFile, readKeyFile } from '../src/web/auth.ts';
import { openStream } from './helpers.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const MAIN_TS = path.join(REPO_ROOT, 'src', 'cli', 'main.ts');

const tempDirs: string[] = [];
const trackedPids = new Set<number>();
const trackedStateDirs = new Set<string>();
const helperServers: Server[] = [];
const measuredGaps = new Map<string, number>();

function trackPid(pid: number | undefined): void {
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    trackedPids.add(pid);
  }
}

function collectStatePids(): void {
  for (const dir of trackedStateDirs) {
    const holder = lockHolder(dir);
    if (holder) trackPid(holder.pid);
    const handover = readHandover(handoverFile(dir));
    if (handover) {
      trackPid(handover.from);
      trackPid(handover.to);
      if (handover.state === 'done' && typeof handover.gap_ms === 'number' && handover.to) {
        measuredGaps.set(`${handover.from}->${handover.to}`, handover.gap_ms);
      }
    }
  }
}

async function stopPid(pid: number): Promise<void> {
  if (!isPidAlive(pid) || pid === process.pid) return;
  try { process.kill(pid); } catch { /* already gone */ }
  for (let i = 0; i < 40 && isPidAlive(pid); i++) {
    await sleep(50);
  }
}

async function cleanupTrackedProcesses(): Promise<void> {
  collectStatePids();
  for (const pid of [...trackedPids]) {
    await stopPid(pid);
  }
}

after(async () => {
  await cleanupTrackedProcesses();
  if (measuredGaps.size) {
    const vals = [...measuredGaps.values()];
    console.log(`reload gap_ms across test suite: min=${Math.min(...vals)} max=${Math.max(...vals)} (${vals.join(', ')})`);
  }
  for (const srv of helperServers) {
    try { srv.closeAllConnections(); srv.close(); } catch { /* ignore */ }
  }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort on Windows SQLite */ }
  }
});

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface TempHarness {
  root: string;
  env: NodeJS.ProcessEnv;
  workersFile: string;
  projects: { id: string; file: string; stateDir: string }[];
}

function makeHarness(projectIds = ['demo'], extraWorkersYaml = ''): TempHarness {
  const root = mkdtempSync(path.join(os.tmpdir(), 'alba-reload-test-'));
  tempDirs.push(root);
  const machineDir = path.join(root, 'machine');
  const lockDir = path.join(root, 'locks');
  const runtimeDir = path.join(root, 'runtime');
  mkdirSync(machineDir, { recursive: true });
  mkdirSync(lockDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  const workersFile = path.join(root, 'workers.yaml');
  writeFileSync(
    workersFile,
    `workers:\n  - id: coder-a\n    engine: codex-cli\n    enabled: false\n${extraWorkersYaml}`,
    'utf8',
  );

  const projects = projectIds.map(id => {
    const pDir = path.join(root, id);
    const gameDir = path.join(pDir, 'game');
    const ordersDir = path.join(pDir, 'orders');
    const stateDir = path.join(pDir, 'state');
    mkdirSync(gameDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });
    const file = path.join(pDir, 'alba.yaml');
    writeFileSync(
      file,
      `id: ${id}\nname: ${id}\nroot: game\nwork_orders: orders\nstate_dir: state\nresources:\n  gpu-box:\n    slots: 1\n`,
      'utf8',
    );
    trackedStateDirs.add(stateDir);
    return { id, file, stateDir };
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ALBA_MACHINE_DIR: machineDir,
    ALBA_LOCK_DIR: lockDir,
    ALBA_RUNTIME_DIR: runtimeDir,
  };
  delete env.ALBA_PROJECT;
  delete env.ALBA_WORKERS;

  return { root, env, workersFile, projects };
}

function makeTempCodeCopy(parentDir: string): { codeRoot: string; entry: string } {
  const codeRoot = path.join(parentDir, 'code-copy');
  mkdirSync(codeRoot, { recursive: true });
  for (const item of ['src', 'bin', 'templates', 'plugins', 'schema', 'package.json', 'tsconfig.json']) {
    const from = path.join(REPO_ROOT, item);
    if (existsSync(from)) {
      cpSync(from, path.join(codeRoot, item), { recursive: true });
    }
  }
  writeFileSync(path.join(codeRoot, '.gitignore'), 'node_modules/\n', 'utf8');
  execFileSync('git', ['init', '-b', 'main'], { cwd: codeRoot, windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: codeRoot, windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: codeRoot, windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: codeRoot, windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Initial copy'], { cwd: codeRoot, windowsHide: true, stdio: 'ignore' });
  symlinkSync(
    path.join(REPO_ROOT, 'node_modules'),
    path.join(codeRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return { codeRoot, entry: path.join(codeRoot, 'src', 'cli', 'main.ts') };
}

interface StartedSubprocessServe {
  pid: number;
  port: number;
  stdout: () => string;
  stderr: () => string;
  sendSigterm: () => void;
  waitForExit: (timeoutMs?: number) => Promise<number | null>;
}

async function spawnServeProcess(opts: {
  entry?: string;
  cwd?: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  firstStateDir: string;
  withIpcStop?: boolean;
}): Promise<StartedSubprocessServe> {
  const entry = opts.entry ?? MAIN_TS;
  const cwd = opts.cwd ?? REPO_ROOT;
  const execArgs = ['--disable-warning=ExperimentalWarning'];
  if (opts.withIpcStop && process.platform === 'win32') {
    const preload = `data:text/javascript,${encodeURIComponent(
      "process.on('message', m => { if (m === 'test-sigterm') process.emit('SIGTERM', 'SIGTERM'); });",
    )}`;
    execArgs.push('--import', preload);
  }
  execArgs.push(entry, 'serve', ...opts.args);

  let out = '';
  let err = '';
  const child = spawn(process.execPath, execArgs, {
    cwd,
    env: opts.env,
    windowsHide: true,
    stdio: opts.withIpcStop && process.platform === 'win32' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  assert.ok(child.pid, 'serve child must have a pid');
  trackPid(child.pid);
  child.stdout?.on('data', chunk => { out += chunk.toString('utf8'); });
  child.stderr?.on('data', chunk => { err += chunk.toString('utf8'); });

  let exitCode: number | null | undefined;
  const exitPromise = new Promise<number | null>(resolve => {
    child.once('exit', code => {
      exitCode = code;
      resolve(code);
    });
  });

  const deadline = Date.now() + 25_000;
  let listeningPort: number | undefined;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      throw new Error(`alba serve exited early (${exitCode}): ${err || out}`);
    }
    const holder = lockHolder(opts.firstStateDir);
    if (holder && holder.pid === child.pid && holder.port && holder.port > 0) {
      const keyRec = readKeyFile(holder.port, opts.env);
      if (keyRec && keyRec.pid === child.pid) {
        listeningPort = holder.port;
        break;
      }
    }
    await sleep(40);
  }
  if (!listeningPort) {
    await stopPid(child.pid);
    throw new Error(`alba serve did not publish lock port within 25s: ${err || out}`);
  }

  return {
    pid: child.pid,
    port: listeningPort,
    stdout: () => out,
    stderr: () => err,
    sendSigterm: () => {
      if (opts.withIpcStop && process.platform === 'win32') {
        child.send('test-sigterm');
      } else {
        child.kill('SIGTERM');
      }
    },
    waitForExit: async (timeoutMs = 20_000) => {
      let timer: NodeJS.Timeout | undefined;
      return Promise.race([
        exitPromise,
        new Promise<number | null>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`serve pid ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
          timer.unref();
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
    },
  };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { entry?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const entry = opts.entry ?? MAIN_TS;
  const cwd = opts.cwd ?? REPO_ROOT;
  return new Promise(resolve => {
    execFile(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', entry, ...args],
      { cwd, env, encoding: 'utf8', timeout: opts.timeoutMs ?? 90_000, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }) .code
          : error ? 1 : 0;
        resolve({ status: code, stdout, stderr });
      },
    );
  });
}

function listServePidsForMarker(markerPath: string): number[] {
  try {
    if (process.platform === 'win32') {
      const escaped = markerPath.replace(/'/g, "''");
      const ps = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') -and $_.CommandLine.Contains(' serve ') } | ForEach-Object { $_.ProcessId }`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      return out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
    }
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10_000 });
    return out
      .split('\n')
      .filter(line => line.includes(markerPath) && line.includes(' serve '))
      .map(line => Number(line.trim().split(/\s+/)[0]))
      .filter(n => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

// 1. Handover end to end, as processes (+ --log check)
test('handover end to end: port 0 serve reloads onto same port with new pid, locks updated, old pid gone, open detached run untouched, gap < 5 s, one serve process', async () => {
  const h = makeHarness(['demo', 'demo-two']);
  const [p1, p2] = h.projects;

  // Detached dummy "run" sleeper started the same way Alba launches worker runs
  const dummyLog = path.join(h.root, 'dummy-run.log');
  const dummyPid = spawnDetachedProgram(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { cwd: h.root, env: {}, envUnset: [], logFile: dummyLog },
  );
  trackPid(dummyPid);
  assert.equal(isPidAlive(dummyPid), true);

  const p1Cfg = loadProject(p1!.file);
  const orders = new Orders(stateStore(p1Cfg));
  orders.add({ tag: 'T1', title: 'Sleeper order', kind: 'code' });
  orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'coder-a', extra: { pid: dummyPid, log: dummyLog } });

  const first = await spawnServeProcess({
    args: ['--port', '0', '--every', '0', '--project', p1!.file, '--project', p2!.file, '--workers', h.workersFile],
    env: h.env,
    firstStateDir: p1!.stateDir,
  });
  const port = first.port;
  const oldPid = first.pid;

  try {
    const beforeSession = await fetch(`http://127.0.0.1:${port}/api/session`);
    assert.equal(beforeSession.status, 200);

    const reloadRes = await runCli(
      ['serve', 'reload', '--project', p1!.file, '--project', p2!.file],
      h.env,
    );
    assert.equal(reloadRes.status, 0, `reload failed: ${reloadRes.stderr}\n${reloadRes.stdout}`);

    const handover = readHandover(handoverFile(p1!.stateDir));
    assert.ok(handover, 'serve-handover.json must be written');
    assert.equal(handover.state, 'done');
    assert.equal(handover.from, oldPid);
    const newPid = handover.to!;
    trackPid(newPid);
    assert.ok(Number.isInteger(newPid) && newPid > 0 && newPid !== oldPid, `expected new pid != ${oldPid}, got ${newPid}`);

    // CLI printed old pid, new pid and measured gap < 5 s
    assert.ok(reloadRes.stdout.includes(String(oldPid)), reloadRes.stdout);
    assert.ok(reloadRes.stdout.includes(String(newPid)), reloadRes.stdout);
    const gapMatch = /gap (\d+) ms/.exec(reloadRes.stdout);
    assert.ok(gapMatch, `expected gap in stdout: ${reloadRes.stdout}`);
    const reportedGapMs = Number(gapMatch[1]);
    assert.ok(reportedGapMs < 5_000, `expected handover gap < 5000 ms, got ${reportedGapMs} ms`);
    assert.ok((handover.gap_ms ?? Infinity) < 5_000, `expected handover.gap_ms < 5000, got ${handover.gap_ms}`);

    // Same port now served by new pid
    const afterSession = await fetch(`http://127.0.0.1:${port}/api/session`);
    assert.equal(afterSession.status, 200);
    assert.equal(readKeyFile(port, h.env)?.pid, newPid);

    // Every serve lock names the new pid and same port
    for (const proj of [p1!, p2!]) {
      const holder = lockHolder(proj.stateDir);
      assert.ok(holder, `expected live serve.lock in ${proj.stateDir}`);
      assert.equal(holder.pid, newPid);
      assert.equal(holder.port, port);
    }

    // Old pid is gone
    assert.equal(isPidAlive(oldPid), false, `old serve pid ${oldPid} should be gone`);

    // Dummy run is still alive and its run record is still open
    assert.equal(isPidAlive(dummyPid), true, 'detached dummy run process must survive reload');
    const detailRes = await fetch(`http://127.0.0.1:${port}/api/orders/T1?project=demo`);
    assert.equal(detailRes.status, 200);
    const detail = (await detailRes.json()) as { stage: string; runs: { id: string; ended?: string; pid?: number }[] };
    assert.equal(detail.stage, 'running');
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0]!.ended, undefined);
    assert.equal(detail.runs[0]!.pid, dummyPid);

    // Without --log, reloaded serve wrote its output to <first state_dir>/serve.log
    const defaultReloadLog = path.join(p1!.stateDir, 'serve.log');
    assert.equal(existsSync(defaultReloadLog), true);
    assert.match(readFileSync(defaultReloadLog, 'utf8'), /Reloaded alba serve on port/);

    // Exactly one serve process exists for this temp project
    const liveServePids = listServePidsForMarker(p1!.file);
    assert.deepEqual(liveServePids, [newPid]);

    // Also verify --log <file> appends across first and reloaded serve without stdout output
    await stopPid(newPid);
    const customLog = path.join(h.root, 'logs', 'custom-serve.log');
    const withLog = await spawnServeProcess({
      args: ['--port', '0', '--every', '0', '--log', customLog, '--project', p1!.file, '--workers', h.workersFile],
      env: h.env,
      firstStateDir: p1!.stateDir,
    });
    assert.equal(withLog.stdout(), '', 'with --log, first serve writes nothing to stdout');
    assert.match(readFileSync(customLog, 'utf8'), new RegExp(`http://127\\.0\\.0\\.1:${withLog.port}/`));
    const reloadWithLog = await runCli(['serve', 'reload', '--project', p1!.file], h.env);
    assert.equal(reloadWithLog.status, 0, reloadWithLog.stderr);
    const handover2 = readHandover(handoverFile(p1!.stateDir))!;
    trackPid(handover2.to);
    assert.ok((handover2.gap_ms ?? Infinity) < 5_000);
    const logLines = readFileSync(customLog, 'utf8');
    assert.ok(logLines.includes(`pid ${withLog.pid} -> pid ${handover2.to}`), logLines);
  } finally {
    await stopPid(dummyPid);
    await cleanupTrackedProcesses();
  }
});

// 2. A new serve that fails preflight leaves the old one serving and records reload-failed
test('new serve failing preflight on invalid project config leaves old serve running and records reload-failed', async () => {
  const h = makeHarness(['demo']);
  const [p1] = h.projects;
  const first = await spawnServeProcess({
    args: ['--port', '0', '--every', '0', '--project', p1!.file, '--workers', h.workersFile],
    env: h.env,
    firstStateDir: p1!.stateDir,
  });

  const key = readKeyFile(first.port, h.env)!.key;
  const stream = await openStream(`http://127.0.0.1:${first.port}`, 'project=demo', { 'x-alba-token': key });

  try {
    assert.equal((await stream.next()).event, 'hello');

    // Make the project file invalid after the first serve started
    writeFileSync(
      p1!.file,
      'id: INVALID_UPPERCASE_ID\nname: Broken\nroot: game\nwork_orders: orders\nstate_dir: state\n',
      'utf8',
    );

    const res = await runCli(['serve', 'reload', '--project', p1!.file], h.env);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Reload failed|lower-case/);

    // Old serve is still alive and serving on the same port
    assert.equal(isPidAlive(first.pid), true);
    assert.equal(lockHolder(p1!.stateDir)?.pid, first.pid);
    const sessionRes = await fetch(`http://127.0.0.1:${first.port}/api/session`);
    assert.equal(sessionRes.status, 200);

    // Handover file and SSE / durable events recorded reload-failed
    const handover = readHandover(handoverFile(p1!.stateDir));
    assert.equal(handover?.state, 'failed');
    assert.match(handover?.why ?? '', /lower-case/);

    let sawFailedNotice = false;
    for (let i = 0; i < 8 && !sawFailedNotice; i++) {
      const evt = await stream.next(5_000);
      if (evt.event === 'serve.notice' && evt.data.kind === 'reload-failed') {
        sawFailedNotice = true;
      }
    }
    assert.equal(sawFailedNotice, true, 'expected reload-failed serve.notice on SSE stream');

    const eventsRes = await fetch(`http://127.0.0.1:${first.port}/api/events?project=demo&tag=*`);
    const eventsJson = (await eventsRes.json()) as { events: { type: string }[] };
    assert.ok(eventsJson.events.some(e => e.type === 'reload-failed'));
  } finally {
    stream.close();
    await cleanupTrackedProcesses();
  }
});

// 3. Refusals: held acceptance lease without --force; second reload while one runs; failing smoke in copied code tree
test('refusals: held acceptance lease without --force, concurrent second reload, and failing code smoke each refuse with exit 1 and reason', async () => {
  const h = makeHarness(['demo']);
  const [p1] = h.projects;
  const code = makeTempCodeCopy(h.root);

  const first = await spawnServeProcess({
    entry: code.entry,
    cwd: code.codeRoot,
    args: ['--port', '0', '--every', '0', '--project', p1!.file, '--workers', h.workersFile],
    env: h.env,
    firstStateDir: p1!.stateDir,
  });

  try {
    // (a) Held acceptance lease without --force -> exit 1 naming the lease
    const cfg = loadProject(p1!.file);
    const now = new Date();
    writeStateFile(
      cfg,
      '_leases.json',
      JSON.stringify({
        leases: [
          {
            resource: 'gpu-box',
            tag: 'T1',
            since: now.toISOString(),
            expires: new Date(now.getTime() + 600_000).toISOString(),
            acceptance: { pid: first.pid, unverified: true },
          },
        ],
      }) + '\n',
    );

    const leaseRefused = await runCli(['serve', 'reload', '--project', p1!.file], h.env, { entry: code.entry, cwd: code.codeRoot });
    assert.equal(leaseRefused.status, 1);
    assert.match(leaseRefused.stderr, /acceptance lease gpu-box \(demo:T1\)/);
    assert.match(leaseRefused.stderr, /--force/);
    assert.equal(isPidAlive(first.pid), true);

    // Clear the lease for test (c) failing smoke
    writeStateFile(cfg, '_leases.json', JSON.stringify({ leases: [] }) + '\n');

    // (c1) Failing smoke in worker.ts (not imported by CLI main.ts, caught by worker-dependency smoke child)
    const workerTs = path.join(code.codeRoot, 'src', 'serve', 'worker.ts');
    const backupWorkerTs = path.join(h.root, 'worker.ts.bak');
    copyFileSync(workerTs, backupWorkerTs);
    appendFileSync(workerTs, '\nexport const brokenWorker = {{{;\n', 'utf8');

    const workerSmokeRefused = await runCli(['serve', 'reload', '--project', p1!.file], h.env, { entry: code.entry, cwd: code.codeRoot });
    assert.equal(workerSmokeRefused.status, 1);
    assert.match(workerSmokeRefused.stderr, /code smoke failed/i);
    assert.match(workerSmokeRefused.stderr, /SyntaxError|Unexpected/i);
    assert.equal(isPidAlive(first.pid), true);
    copyFileSync(backupWorkerTs, workerTs);

    // (c2) Failing smoke in CLI module graph (caught by --help smoke child on the running serve)
    const targetTs = path.join(code.codeRoot, 'src', 'serve', 'fleet.ts');
    const backupTs = path.join(h.root, 'fleet.ts.bak');
    copyFileSync(targetTs, backupTs);
    appendFileSync(targetTs, '\nexport const brokenSyntax = {{{;\n', 'utf8');

    const smokeRefused = await runCli(['serve', 'reload', '--project', p1!.file], h.env);
    assert.equal(smokeRefused.status, 1);
    assert.match(smokeRefused.stderr, /code smoke failed/i);
    assert.match(smokeRefused.stderr, /SyntaxError|Unexpected/i);
    assert.equal(isPidAlive(first.pid), true);

    // Restore valid code, then test (b) a second reload while one is already running (plus --force with lease)
    copyFileSync(backupTs, targetTs);
    writeStateFile(
      cfg,
      '_leases.json',
      JSON.stringify({
        leases: [
          {
            resource: 'gpu-box',
            tag: 'T1',
            since: now.toISOString(),
            expires: new Date(now.getTime() + 600_000).toISOString(),
            acceptance: { pid: first.pid, unverified: true },
          },
        ],
      }) + '\n',
    );

    const r1Promise = runCli(['serve', 'reload', '--project', p1!.file, '--force'], h.env, { entry: code.entry, cwd: code.codeRoot });
    await sleep(350); // r1 is now inside preflight smoke / handover
    const r2Res = await runCli(['serve', 'reload', '--project', p1!.file, '--force'], h.env, { entry: code.entry, cwd: code.codeRoot });
    const r1Res = await r1Promise;
    trackPid(readHandover(handoverFile(p1!.stateDir))?.to);

    assert.equal(r1Res.status, 0, `first reload should succeed: ${r1Res.stderr}`);
    assert.equal(r2Res.status, 1, 'concurrent second reload must exit 1');
    assert.match(r2Res.stderr, /already in progress/i);
  } finally {
    await cleanupTrackedProcesses();
  }
});

// 4. API: request without key in no-sign-in mode is refused 401/403; with key is accepted 202
test('API POST /api/serve/reload refuses missing key in no-sign-in mode and accepts valid key on loopback', async () => {
  const h = makeHarness(['demo']);
  const [p1] = h.projects;
  const first = await spawnServeProcess({
    args: ['--port', '0', '--every', '0', '--project', p1!.file, '--workers', h.workersFile],
    env: h.env,
    firstStateDir: p1!.stateDir,
  });

  try {
    // Open no-sign-in mode lets plain reads in without a key
    const openSession = await fetch(`http://127.0.0.1:${first.port}/api/session`);
    assert.equal(openSession.status, 200);

    // Without key -> refused 401
    const noKey = await fetch(`http://127.0.0.1:${first.port}/api/serve/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.ok(noKey.status === 401 || noKey.status === 403, `expected 401/403 without key, got ${noKey.status}`);

    // With key + disallowed Origin -> refused 403
    const key = readKeyFile(first.port, h.env)!.key;
    const badOrigin = await fetch(`http://127.0.0.1:${first.port}/api/serve/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alba-token': key, origin: 'https://invalid.example' },
      body: '{}',
    });
    assert.equal(badOrigin.status, 403);

    // With valid key -> accepted 202 { from, state: "starting" }
    const accepted = await fetch(`http://127.0.0.1:${first.port}/api/serve/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alba-token': key },
      body: '{}',
    });
    assert.equal(accepted.status, 202);
    const body = (await accepted.json()) as { from: number; state: string };
    assert.equal(body.from, first.pid);
    assert.equal(body.state, 'starting');

    // Wait for handover to complete so we track and stop the reloaded process cleanly
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const handover = readHandover(handoverFile(p1!.stateDir));
      if (handover?.state === 'done') {
        trackPid(handover.to);
        break;
      }
      await sleep(50);
    }
    assert.equal(readHandover(handoverFile(p1!.stateDir))?.state, 'done');
  } finally {
    await cleanupTrackedProcesses();
  }
});

// 5. --watch-code on a temp copy of the code: branch switch refused, syntax error refused, valid change reloads
test('--watch-code on temp code copy: refuses branch switch and syntax error, then reloads after a valid change settles', async () => {
  const h = makeHarness(['demo']);
  h.env.ALBA_WATCH_CODE_DEBOUNCE_MS = '1500';
  const [p1] = h.projects;
  const code = makeTempCodeCopy(h.root);
  const targetTs = path.join(code.codeRoot, 'src', 'serve', 'fleet.ts');
  const backupTs = path.join(h.root, 'watch-fleet.bak');
  copyFileSync(targetTs, backupTs);

  const first = await spawnServeProcess({
    entry: code.entry,
    cwd: code.codeRoot,
    args: ['--port', '0', '--every', '0', '--watch-code', '--project', p1!.file, '--workers', h.workersFile],
    env: h.env,
    firstStateDir: p1!.stateDir,
  });

  const getEvents = async () => {
    const res = await fetch(`http://127.0.0.1:${first.port}/api/events?project=demo&tag=*`);
    const json = (await res.json()) as { events: { type: string; data?: { text?: string } }[] };
    return json.events;
  };

  try {
    // (a) Branch switch is refused after the quiet window
    execFileSync('git', ['checkout', '-b', 'feature-branch'], { cwd: code.codeRoot, windowsHide: true, stdio: 'ignore' });
    appendFileSync(targetTs, '\nexport const WATCH_STEP_BRANCH = 1;\n', 'utf8');

    let branchRefused = false;
    const branchDeadline = Date.now() + 20_000;
    while (Date.now() < branchDeadline) {
      const evts = await getEvents();
      if (evts.some(e => e.type === 'reload-refused' && /git branch changed/.test(e.data?.text ?? ''))) {
        branchRefused = true;
        break;
      }
      await sleep(250);
    }
    assert.equal(branchRefused, true, 'expected reload-refused on branch switch');
    assert.equal(isPidAlive(first.pid), true);

    // Switch back to main and introduce a syntax error -> refused after the quiet window
    copyFileSync(backupTs, targetTs);
    execFileSync('git', ['checkout', 'main'], { cwd: code.codeRoot, windowsHide: true, stdio: 'ignore' });
    await sleep(300);
    appendFileSync(targetTs, '\nexport const WATCH_BAD = (((;\n', 'utf8');

    let syntaxRefused = false;
    const syntaxDeadline = Date.now() + 25_000;
    while (Date.now() < syntaxDeadline) {
      const evts = await getEvents();
      if (evts.some(e => e.type === 'reload-refused' && /code smoke failed/i.test(e.data?.text ?? ''))) {
        syntaxRefused = true;
        break;
      }
      await sleep(250);
    }
    assert.equal(syntaxRefused, true, 'expected reload-refused on syntax error');
    assert.equal(isPidAlive(first.pid), true);

    // Fix syntax error with a valid change on main -> reloads cleanly after the quiet window
    copyFileSync(backupTs, targetTs);
    appendFileSync(targetTs, '\nexport const WATCH_OK = 42;\n', 'utf8');

    let reloadedTo: number | undefined;
    const reloadDeadline = Date.now() + 30_000;
    while (Date.now() < reloadDeadline) {
      const handover = readHandover(handoverFile(p1!.stateDir));
      if (handover?.from === first.pid && handover.state === 'done' && handover.to) {
        reloadedTo = handover.to;
        trackPid(reloadedTo);
        break;
      }
      await sleep(250);
    }
    assert.ok(reloadedTo && reloadedTo !== first.pid, 'expected --watch-code to reload into a new pid');
    for (let i = 0; i < 40 && isPidAlive(first.pid); i++) await sleep(50);
    assert.equal(isPidAlive(first.pid), false);
    assert.equal(lockHolder(p1!.stateDir)?.pid, reloadedTo);
    assert.equal((await fetch(`http://127.0.0.1:${first.port}/api/session`)).status, 200);
  } finally {
    await cleanupTrackedProcesses();
  }
});

// 6 & 7. SIGTERM releases serve locks before process exit, and serve-crashed notification does not fire after reload or clean stop
test('SIGTERM stop releases serve locks before exit, and serve-crashed notification does not fire after reload or clean stop', async () => {
  const webhookCalls: { trigger?: string; text?: string }[] = [];
  const hookServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try { webhookCalls.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  helperServers.push(hookServer);
  await new Promise<void>(resolve => hookServer.listen(0, '127.0.0.1', resolve));
  const hookPort = (hookServer.address() as AddressInfo).port;

  const notifyYaml = `notify:\n  channels:\n    hook: { type: webhook, url_env: ALBA_TEST_HOOK_URL }\n  to: [hook]\n  triggers:\n    serve-crashed: {}\n`;
  const h = makeHarness(['demo', 'demo-two'], notifyYaml);
  h.env.ALBA_TEST_HOOK_URL = `http://127.0.0.1:${hookPort}/alert`;
  const [p1, p2] = h.projects;

  // Start first serve with notify configured
  const first = await spawnServeProcess({
    args: ['--port', '0', '--every', '0', '--project', p1!.file, '--project', p2!.file, '--workers', h.workersFile],
    env: h.env,
    firstStateDir: p1!.stateDir,
  });

  try {
    // Reload first -> second: notifier must NOT fire serve-crashed
    const reloadRes = await runCli(['serve', 'reload', '--project', p1!.file, '--project', p2!.file], h.env);
    assert.equal(reloadRes.status, 0, reloadRes.stderr);
    const handover = readHandover(handoverFile(p1!.stateDir))!;
    const secondPid = handover.to!;
    trackPid(secondPid);
    await sleep(300);
    assert.equal(webhookCalls.filter(c => c.trigger === 'serve-crashed').length, 0, 'reload must not fire serve-crashed');

    await stopPid(secondPid);
    // Remove dead locks left by forced stopPid(secondPid) and test real SIGTERM clean stop on a fresh serve
    rmSync(lockFile(p1!.stateDir), { force: true });
    rmSync(lockFile(p2!.stateDir), { force: true });
    rmSync(exitFile(p1!.stateDir), { force: true });
    rmSync(exitFile(p2!.stateDir), { force: true });

    const third = await spawnServeProcess({
      args: ['--port', '0', '--every', '0', '--project', p1!.file, '--project', p2!.file, '--workers', h.workersFile],
      env: h.env,
      firstStateDir: p1!.stateDir,
      withIpcStop: true,
    });
    assert.equal(existsSync(lockFile(p1!.stateDir)), true);
    assert.equal(existsSync(lockFile(p2!.stateDir)), true);

    // Send SIGTERM and wait for normal shutdown
    third.sendSigterm();
    const code = await third.waitForExit(20_000);
    assert.equal(code, 0);

    // Every serve lock and key file was released BEFORE the process exited
    assert.equal(existsSync(lockFile(p1!.stateDir)), false, 'p1 serve.lock must be removed before SIGTERM exit');
    assert.equal(existsSync(lockFile(p2!.stateDir)), false, 'p2 serve.lock must be removed before SIGTERM exit');
    assert.equal(existsSync(keyFile(third.port, h.env)), false, 'console key file must be removed on clean stop');

    // Clean exit records were written
    const exit1 = JSON.parse(readFileSync(exitFile(p1!.stateDir), 'utf8')) as { how: string };
    const exit2 = JSON.parse(readFileSync(exitFile(p2!.stateDir), 'utf8')) as { how: string };
    assert.equal(exit1.how, 'clean');
    assert.equal(exit2.how, 'clean');

    // Start fourth serve after SIGTERM clean stop -> notifier must NOT fire serve-crashed
    const fourth = await spawnServeProcess({
      args: ['--port', '0', '--every', '0', '--project', p1!.file, '--project', p2!.file, '--workers', h.workersFile],
      env: h.env,
      firstStateDir: p1!.stateDir,
      withIpcStop: true,
    });
    await sleep(300);
    assert.equal(webhookCalls.filter(c => c.trigger === 'serve-crashed').length, 0, 'clean SIGTERM stop must not fire serve-crashed');
    fourth.sendSigterm();
    await fourth.waitForExit(20_000);
  } finally {
    await cleanupTrackedProcesses();
  }
});

// Additional coverage: machine-scoped tool lease refusal and git merge/rebase/cherry-pick/revert state refusal
test('machine-scoped tool lease refuses reload without --force, and git in-progress markers refuse watch-code reload', async () => {
  const h = makeHarness(['demo']);
  const [p1] = h.projects;
  writeFileSync(
    p1!.file,
    'id: demo\nname: demo\nroot: game\nwork_orders: orders\nstate_dir: state\nresources:\n  gpu-box:\n    slots: 1\n    scope: machine\n',
    'utf8',
  );

  const first = await spawnServeProcess({
    args: ['--port', '0', '--every', '0', '--project', p1!.file, '--workers', h.workersFile],
    env: h.env,
    firstStateDir: p1!.stateDir,
  });

  try {
    const now = new Date();
    const mStore = new MachineStore(path.join(h.env.ALBA_MACHINE_DIR!, 'machine.sqlite'));
    try {
      mStore.transaction(() => {
        mStore.upsertLeaseInTx({
          resource: 'gpu-box',
          project: 'demo',
          state_dir: path.resolve(p1!.stateDir),
          tag: 'tool:job-1',
          since: now.toISOString(),
          expires: new Date(now.getTime() + 600_000).toISOString(),
          pid: first.pid,
          unverified: true,
          kind: 'tool',
          heartbeat_at: now.toISOString(),
        });
      });
    } finally {
      mStore.close();
    }

    const refused = await runCli(['serve', 'reload', '--project', p1!.file], h.env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /tool lease gpu-box \(demo:tool:job-1\)/);
    assert.equal(isPidAlive(first.pid), true);

    // Git in-progress state markers (MERGE_HEAD, rebase-merge, CHERRY_PICK_HEAD, REVERT_HEAD)
    const gitRepo = path.join(h.root, 'git-check');
    mkdirSync(gitRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: gitRepo, windowsHide: true, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: gitRepo, windowsHide: true, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepo, windowsHide: true, stdio: 'ignore' });
    writeFileSync(path.join(gitRepo, 'README.md'), 'init\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: gitRepo, windowsHide: true, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: gitRepo, windowsHide: true, stdio: 'ignore' });
    assert.equal(checkGitReadyForReload(gitRepo, 'main').ok, true);

    const gitDir = path.join(gitRepo, '.git');
    for (const [marker, isDir, expectedText] of [
      ['MERGE_HEAD', false, 'merge is in progress'],
      ['rebase-merge', true, 'rebase is in progress'],
      ['CHERRY_PICK_HEAD', false, 'cherry-pick is in progress'],
      ['REVERT_HEAD', false, 'revert is in progress'],
    ] as const) {
      const target = path.join(gitDir, marker);
      if (isDir) mkdirSync(target, { recursive: true });
      else writeFileSync(target, 'deadbeef\n', 'utf8');
      const res = checkGitReadyForReload(gitRepo, 'main');
      assert.equal(res.ok, false);
      if (!res.ok) assert.ok(res.why.includes(expectedText), res.why);
      rmSync(target, { recursive: true, force: true });
    }
    assert.equal(checkGitReadyForReload(gitRepo, 'main').ok, true);
  } finally {
    await cleanupTrackedProcesses();
  }
});
