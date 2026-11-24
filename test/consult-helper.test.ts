import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { closeStateStores, stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { readRunConsults } from '../src/consult/config.ts';
import { CONSULT_ENV, CONSULT_TOKEN_ENV, installConsultHelper, writeConsultSpec, type ConsultSpec } from '../src/consult/spec.ts';
import { pollIndependentChecks, reviewBudgetExhausted, reviewRunsToday, startIndependentCheck } from '../src/review/independent.ts';
import { startRun } from '../src/run/launch.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { testBackend, validateProject } from './state-helper.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const fakeConsultantScript = path.join(import.meta.dirname, 'fixtures', 'fake-consultant.mjs');

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function makeHelperRepo(t: TestContext, limits: Partial<ConsultSpec['limits']> = {}, extraEnv: Record<string, string> = {}) {
  const { orders, dir } = tempOrders();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, 'worktree');
  const stateDir = path.join(dir, 'state');
  mkdirSync(worktree, { recursive: true });
  git(worktree, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(worktree, 'module.ts'), 'export const value = 42;\n', 'utf8');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-qm', 'initial');

  const helperPath = installConsultHelper(worktree);
  const specPath = path.join(stateDir, 'runs', 'ORD1-r1.consult.json');
  const recordsPath = path.join(stateDir, 'runs', 'ORD1-r1.consults.jsonl');
  const secret = 'test-consult-secret-123';
  const spec: ConsultSpec = {
    version: 1,
    project: 'demo',
    state_dir: stateDir,
    state_backend: testBackend(),
    tag: 'ORD1',
    title: 'Fix physics step jitter',
    run: 'r1',
    run_key: 'ORD1:r1',
    worktree,
    consultant: 'claude-advisor',
    engine: 'claude-cli',
    model: 'claude-sonnet-test',
    model_family: 'claude',
    command: {
      program: process.execPath,
      args: [fakeConsultantScript, '--output-last-message', '{last_file}', '{prompt}'],
      env: extraEnv,
      env_unset: [],
    },
    limits: {
      max_per_run: limits.max_per_run ?? 3,
      timeout_minutes: limits.timeout_minutes ?? 1,
      ...(limits.review_runs_per_day !== undefined ? { review_runs_per_day: limits.review_runs_per_day } : {}),
    },
    records_file: recordsPath,
    runtime_module: path.resolve(import.meta.dirname, '../src/consult/runtime.ts'),
    token: secret,
  };
  writeConsultSpec(specPath, spec);

  const invoke = (args: string[], envOverrides: Record<string, string | undefined> = {}) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [CONSULT_ENV]: specPath,
      [CONSULT_TOKEN_ENV]: secret,
      ALBA_CONSULT_NOW: '2026-06-15T12:00:00Z',
    };
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) delete childEnv[k];
      else childEnv[k] = v;
    }
    return spawnSync(process.execPath, [helperPath, ...args], {
      cwd: worktree,
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
  };

  return { orders, dir, worktree, stateDir, helperPath, specPath, recordsPath, secret, invoke };
}

test('consult helper answers plain and --json, folds engine usage, caps 4 KiB questions, and refuses wrong tokens', t => {
  const f = makeHelperRepo(t, {}, { FAKE_CONSULTANT_FORMAT: 'claude' });

  // Wrong token is refused and recorded
  const badTok = f.invoke(['--question', 'Why does step drift?'], { [CONSULT_TOKEN_ENV]: 'wrong' });
  assert.notEqual(badTok.status, 0);
  assert.match(badTok.stderr, /invalid or missing ALBA_CONSULT_TOKEN/);

  // Valid call answers, echoes question and files, folds Claude usage, and caps >4 KiB question in record
  const longSuffix = 'x'.repeat(5000);
  const ok = f.invoke(['--question', `Inspect drift ${longSuffix}`, '--file', 'module.ts', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout.trim());
  assert.equal(parsed.consultant, 'claude-advisor');
  assert.equal(parsed.model, 'claude-sonnet-test');
  assert.equal(typeof parsed.seconds, 'number');
  assert.match(parsed.answer, /Files=\[module\.ts\]/);
  assert.match(parsed.answer, /Read=\[module\.ts:export const value = 42;\]/);

  const records = readRunConsults(f.stateDir, 'ORD1', 'r1');
  assert.equal(records.length, 2);
  assert.equal(records[0].outcome, 'refused');
  assert.equal(records[1].outcome, 'ok');
  assert.equal(Buffer.byteLength(records[1].question, 'utf8'), 4096);
  assert.equal(records[1].usage?.source, 'claude-json');
  assert.equal(records[1].usage?.total_tokens, 570);
  assert.equal(records[1].usage?.cost_usd, 0.0125);
});

test('consult helper enforces max_per_run: 3 and refuses the 4th consult with a record line', t => {
  const f = makeHelperRepo(t, { max_per_run: 3 });
  for (let i = 1; i <= 3; i++) {
    const res = f.invoke(['--question', `Question ${i}`]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`Asked="Question ${i}"`));
  }
  const fourth = f.invoke(['--question', 'Question 4']);
  assert.notEqual(fourth.status, 0);
  assert.match(fourth.stderr, /max_per_run.*3/);

  const records = readRunConsults(f.stateDir, 'ORD1', 'r1');
  assert.equal(records.length, 4);
  assert.deepEqual(records.map(r => r.outcome), ['ok', 'ok', 'ok', 'refused']);
});

test('consult helper shares review_runs_per_day budget with independent checks and refuses when exhausted', t => {
  const f = makeHelperRepo(t, { max_per_run: 5, review_runs_per_day: 2 });
  const root = path.join(f.dir, 'main-repo');
  const workOrders = path.join(f.dir, 'orders');
  mkdirSync(root, { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'base\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  git(root, 'switch', '-qc', 'branch-1');
  writeFileSync(path.join(root, 'a.txt'), 'next\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'delivery');
  const sha = git(root, 'rev-parse', 'branch-1');
  git(root, 'switch', '-q', 'main');

  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: f.stateDir,
    accept: {}, roles: { verifier: { workers: { prefer: ['claude-advisor'] } } },
    producer: { enabled: true, budgets: { review_runs_per_day: 2 } },
  }, path.join(f.dir, 'alba.yaml'));
  const workers = validateWorkers({
    workers: [
      { id: 'gpt-author', engine: 'codex-cli', model_family: 'gpt', aliases: [], launch: { program: 'gpt', args: ['exec'], template: 'synthetic' } },
      { id: 'claude-advisor', engine: 'claude-cli', model_family: 'claude', aliases: [], launch: { program: 'claude', args: ['-p'], template: 'synthetic' } },
    ],
  }, path.join(f.dir, 'workers.yaml'));

  // 1st slot spent by consult
  assert.equal(f.invoke(['--question', 'First consult']).status, 0);
  // 2nd slot spent by independent check in the same state_dir
  t.after(() => closeStateStores());
  const orders = new Orders(stateStore(project));
  orders.add({ tag: 'IC1', title: 'Check target', kind: 'code', branch: 'branch-1', check: 'independent' });
  writeFileSync(path.join(workOrders, 'IC1.md'), '# IC1\n\n## Acceptance\n- Verify a.txt.\n', 'utf8');
  orders.runStart('IC1', { worker: 'gpt-author' });
  orders.runEnd('IC1');
  orders.report('IC1', { status: 'ready', summary: 'done', evidence: [], commits: [sha], delivery_text: 'done' });
  let alive = true;
  const probes: Probes = {
    now: () => new Date('2026-06-15T12:00:00Z'),
    runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => alive, tail: () => '',
    readText: file => existsSync(file) ? readFileSync(file, 'utf8') : undefined,
    spawnDetached: () => 2222,
  };
  const ic = startIndependentCheck({ project, orders, workers, probes }, 'IC1');
  writeFileSync(ic.lastFile, '--- alba-independent-check ---\n{"checked":[{"item":"Verify a.txt","verdict":"pass","evidence":"ok"}],"pass":true,"summary":"ok"}\n--- end ---\n', 'utf8');
  alive = false;
  pollIndependentChecks({ project, orders, probes });

  assert.equal(reviewRunsToday(orders, new Date('2026-06-15T12:00:00Z')), 2);
  assert.equal(reviewBudgetExhausted(project, orders, new Date('2026-06-15T12:00:00Z')), true);

  // 3rd attempt via consult helper is refused because daily budget 2 is exhausted
  const refused = f.invoke(['--question', 'Second consult over daily cap']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /review_runs_per_day.*exhausted/);
  const records = readRunConsults(f.stateDir, 'ORD1', 'r1');
  assert.equal(records.at(-1)?.outcome, 'refused');
});

test('consult helper stops timed-out consultant, exits non-zero, and reports worktree writes', t => {
  const pidFile = path.join(t.name ? '' : '', '');
  const fTimeout = makeHelperRepo(t, { timeout_minutes: 0.02 }, {});
  const spawnedPidFile = path.join(fTimeout.dir, 'consultant.pid');
  const timedOut = fTimeout.invoke(['--question', 'Slow question'], {
    FAKE_CONSULTANT_PID_FILE: spawnedPidFile,
    FAKE_CONSULTANT_SLEEP_MS: '30000',
  });
  void pidFile;
  assert.notEqual(timedOut.status, 0);
  assert.match(timedOut.stderr, /timed out/i);
  const childPid = Number(readFileSync(spawnedPidFile, 'utf8').trim());
  assert.equal(isPidAlive(childPid), false, 'timed-out consultant process must be stopped');
  const timeoutRec = readRunConsults(fTimeout.stateDir, 'ORD1', 'r1');
  assert.equal(timeoutRec.length, 1);
  assert.equal(timeoutRec[0].outcome, 'timeout');

  // Consultant that tampers with the worktree is reported in output and record
  const fTamper = makeHelperRepo(t, {}, { FAKE_CONSULTANT_TAMPER: 'rogue.txt' });
  const tampered = fTamper.invoke(['--question', 'Check purity']);
  assert.equal(tampered.status, 0);
  assert.match(tampered.stdout, /worktree git status changed/i);
  const tamperRec = readRunConsults(fTamper.stateDir, 'ORD1', 'r1');
  assert.equal(tamperRec.length, 1);
  assert.equal(tamperRec[0].worktree_changed, true);
  assert.match(tamperRec[0].reason ?? '', /worktree git status changed/i);
});

test('startRun writes helper, spec, env vars, and prompt section only when consult is enabled and kind matches', t => {
  const { orders, dir } = tempOrders();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const workOrders = path.join(dir, 'orders');
  const trees = path.join(dir, 'trees');
  mkdirSync(root, { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'Demo\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');

  for (const tag of ['C1', 'D1', 'OFF1']) {
    writeFileSync(path.join(workOrders, `${tag}.md`), `# ${tag}\n\n## Acceptance\n- Done.\n`, 'utf8');
  }

  const makeProject = (enabled: boolean) => validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, enabled ? 'state-on' : 'state-off'),
    dispatch: { base_ref: 'main', worktree_parent: trees },
    consult: { enabled, kinds: ['code'], max_per_run: 2, timeout_minutes: 8 },
  }, path.join(dir, 'alba.yaml'));

  const workers = validateWorkers({
    workers: [
      { id: 'gpt-coder', engine: 'codex-cli', model_family: 'gpt', aliases: [], launch: { program: 'codex', args: ['exec', '{prompt_file}'], template: 'synthetic' } },
      { id: 'claude-consultant', engine: 'claude-cli', model_family: 'claude', model: 'claude-sonnet-4-6', aliases: [], launch: { program: 'claude', args: ['--dangerously-skip-permissions', '{prompt_file}'], template: 'synthetic' } },
    ],
  }, path.join(dir, 'workers.yaml'));

  const spawned: { cwd: string; env: Record<string, string> }[] = [];
  const makeProbes = (): Probes => ({
    now: () => new Date('2026-06-15T12:00:00Z'),
    runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined,
    spawnDetached: (_program, _args, opts) => { spawned.push({ cwd: opts.cwd, env: opts.env }); return 4000 + spawned.length; },
  });

  // 1. Enabled + matching kind ('code'): helper, spec, env, and prompt section are present
  const projOn = makeProject(true);
  orders.add({ tag: 'C1', title: 'Code feature', kind: 'code' });
  orders.act('C1', 'queue');
  const startedCode = startRun({ project: projOn, orders, workers, probes: makeProbes() }, 'C1', 'gpt-coder', { explicitWorker: true });
  assert.equal(startedCode.mode, 'start');
  const codeSpecPath = path.join(projOn.state_dir, 'runs', 'C1-r1.consult.json');
  assert.equal(existsSync(path.join(startedCode.cwd, '.alba', 'bin', 'consult.mjs')), true);
  assert.equal(existsSync(codeSpecPath), true);
  const spec = JSON.parse(readFileSync(codeSpecPath, 'utf8')) as ConsultSpec;
  assert.equal(spec.consultant, 'claude-consultant');
  assert.ok(spec.command.args.includes('Read,Glob,Grep'));
  assert.ok(!spec.command.args.includes('--dangerously-skip-permissions'));
  assert.equal(spawned[0].env[CONSULT_ENV], codeSpecPath.replace(/\\/g, '/'));
  assert.equal(spawned[0].env[CONSULT_TOKEN_ENV], spec.token);
  const codePrompt = readFileSync(path.join(projOn.state_dir, 'runs', 'C1-r1.prompt.md'), 'utf8');
  assert.match(codePrompt, /## Consulting another model/);
  assert.match(codePrompt, /consult\.mjs --question/);
  assert.match(codePrompt, /at most 2 consult\(s\)/);
  assert.match(codePrompt, /advice, not an order/);

  // 2. Enabled + non-matching kind ('docs'): no helper, no spec, no env vars, no prompt section
  orders.add({ tag: 'D1', title: 'Write docs', kind: 'docs' });
  orders.act('D1', 'queue');
  const startedDocs = startRun({ project: projOn, orders, workers, probes: makeProbes() }, 'D1', 'gpt-coder', { explicitWorker: true });
  assert.equal(startedDocs.mode, 'start');
  assert.equal(existsSync(path.join(startedDocs.cwd, '.alba', 'bin', 'consult.mjs')), false);
  assert.equal(existsSync(path.join(projOn.state_dir, 'runs', 'D1-r1.consult.json')), false);
  assert.equal(spawned[1].env[CONSULT_ENV], undefined);
  assert.equal(spawned[1].env[CONSULT_TOKEN_ENV], undefined);
  const docsPrompt = readFileSync(path.join(projOn.state_dir, 'runs', 'D1-r1.prompt.md'), 'utf8');
  assert.doesNotMatch(docsPrompt, /## Consulting another model/);

  // 3. Disabled ('consult.enabled: false') + matching kind ('code'): no helper, no spec, no env vars, no prompt section
  const projOff = makeProject(false);
  const { orders: ordersOff } = tempOrders();
  ordersOff.add({ tag: 'OFF1', title: 'Disabled consult code', kind: 'code' });
  ordersOff.act('OFF1', 'queue');
  const startedOff = startRun({ project: projOff, orders: ordersOff, workers, probes: makeProbes() }, 'OFF1', 'gpt-coder', { explicitWorker: true });
  assert.equal(startedOff.mode, 'start');
  assert.equal(existsSync(path.join(startedOff.cwd, '.alba', 'bin', 'consult.mjs')), false);
  assert.equal(existsSync(path.join(projOff.state_dir, 'runs', 'OFF1-r1.consult.json')), false);
  assert.equal(spawned[2].env[CONSULT_ENV], undefined);
  const offPrompt = readFileSync(path.join(projOff.state_dir, 'runs', 'OFF1-r1.prompt.md'), 'utf8');
  assert.doesNotMatch(offPrompt, /## Consulting another model/);
});
