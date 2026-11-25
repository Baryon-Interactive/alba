import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { editConfig, readEditable } from '../src/config-edit.ts';
import { Orders } from '../src/orders/service.ts';
import { readProducerOrder } from '../src/producer/order-read.ts';
import { reviewOf } from '../src/producer/producer.ts';
import {
  currentFirstPass,
  FIRST_PASS_INPUTS_DIR,
  firstPasses,
  isFirstPassCheckoutUnchanged,
  parseFirstPassVerdict,
  pollFirstPasses,
  runFirstPass,
} from '../src/review/first-pass.ts';
import { pollIndependentChecks, reviewRunsToday, startIndependentCheck } from '../src/review/independent.ts';
import { rework, reworkCount } from '../src/run/review.ts';
import { executeTick } from '../src/tick/execute.ts';
import { systemProbes, type Probes } from '../src/tick/gather.ts';
import { encodePng } from '../src/review/sheet.ts';
import { validateWorkers, type WorkerConfig } from '../src/workers/config.ts';
import { fixture as apiFixture } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const fpBlock = (payload: unknown) => `--- alba-first-pass ---\n${JSON.stringify(payload)}\n--- end ---\n`;

const validPass = {
  verdict: 'pass',
  confident: true,
  items: [{ item: 'Night scene opens directly', verdict: 'pass', evidence: 'night.png shows moonlight sky and lanterns; src/scene.ts loads night.' }],
  summary: 'All acceptance items verified.',
};

const validSendBack = {
  verdict: 'send-back',
  confident: true,
  items: [{ item: 'Night scene opens directly', verdict: 'fail', evidence: 'night.png still shows the main menu screen instead of the night level.' }],
  note: 'Parse the -Time argument in src/scene.ts and load the night map directly without stopping on the menu.',
  summary: 'Night capture still shows the main menu.',
};

const validUnsure = {
  verdict: 'unsure',
  confident: false,
  items: [{ item: 'Night scene opens directly', verdict: 'doubt', evidence: 'No capture ran and runtime map loading depends on engine assets.' }],
  summary: 'Cannot confirm runtime scene without capture.',
};

function makePng(r: number, g: number, b: number): Buffer {
  const width = 4, height = 4;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return encodePng(width, height, rgb);
}

function makeWorker(id: string, family?: string, engine = 'codex-cli', extra: Partial<WorkerConfig> = {}) {
  return {
    id,
    engine,
    ...(family ? { model_family: family } : {}),
    aliases: [],
    launch: { program: id, args: ['exec', '{prompt_file}'], template: 'synthetic' },
    ...extra,
  };
}

function setupFixture(
  t: TestContext,
  options: {
    review?: unknown;
    workerDefs?: Record<string, unknown>[];
    deliveringWorker?: string;
    deliveringModel?: string;
    kind?: string;
    orderReview?: 'manual' | 'auto';
    maxReworks?: number;
    reviewRunsPerDay?: number;
    roles?: Record<string, unknown>;
  } = {},
) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'repo');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(root, { recursive: true });
  mkdirSync(workOrders, { recursive: true });

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(path.join(root, 'scene.ts'), 'export const scene = "menu";\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');

  git(root, 'switch', '-qc', 'order-t1');
  writeFileSync(path.join(root, 'scene.ts'), 'export const scene = "night";\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'T1: add night scene');
  const deliveryCommit = git(root, 'rev-parse', 'order-t1');
  git(root, 'switch', '-q', 'main');

  const albaFile = path.join(dir, 'alba.yaml');
  const project = validateProject({
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: workOrders,
    state_dir: path.join(dir, 'state'),
    review: options.review ?? { mode: 'auto', first_pass: 'advise' },
    dispatch: { ...(options.maxReworks !== undefined ? { max_reworks: options.maxReworks } : {}) },
    ...(options.roles ? { roles: options.roles } : {}),
    producer: {
      enabled: true,
      budgets: { ...(options.reviewRunsPerDay !== undefined ? { review_runs_per_day: options.reviewRunsPerDay } : {}) },
    },
  }, albaFile);

  const workers = validateWorkers({
    workers: options.workerDefs ?? [
      makeWorker('gpt-author', 'gpt'),
      makeWorker('gpt-peer', 'GPT'),
      makeWorker('claude-reviewer', 'claude', 'claude-cli'),
    ],
  }, path.join(dir, 'workers.yaml'));

  orders.add({
    tag: 'T1',
    title: 'Night scene lighting',
    kind: options.kind ?? 'visual',
    branch: 'order-t1',
    ...(options.orderReview ? { review: options.orderReview } : {}),
  });
  writeFileSync(
    path.join(workOrders, 'T1.md'),
    '# T1 Night scene\n\n## Acceptance\n- Night scene opens directly without stopping on the menu.\n\n## Notes\nInternal task notes.\n',
    'utf8',
  );
  const deliveringWorker = options.deliveringWorker ?? 'gpt-author';
  orders.runStart('T1', {
    worker: deliveringWorker,
    ...(options.deliveringModel ? { extra: { model: options.deliveringModel } } : {}),
  });
  orders.runEnd('T1');
  orders.report('T1', {
    status: 'ready',
    summary: 'Night scene implemented',
    evidence: [],
    commits: [deliveryCommit],
    delivery_text: 'Implemented night scene loading in scene.ts.',
  });

  let nowMs = Date.parse('2026-06-01T12:00:00Z');
  let alive = true;
  const spawned: { program: string; args: string[]; cwd: string }[] = [];
  const probes: Probes = {
    now: () => new Date(nowMs),
    runCommand: () => '[]',
    freeRamGb: () => 32,
    worktrees: () => [],
    gitActivity: () => ({}),
    fileTime: () => undefined,
    isAlive: () => alive,
    tail: () => '',
    readText: file => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
    processStartedAt: () => new Date(nowMs).toISOString(),
    spawnDetached: (program, args, opts) => {
      spawned.push({ program, args, cwd: opts.cwd });
      alive = true;
      return 24680;
    },
  };

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const ctx = { project, orders, workers, probes };
  const finishReview = (output: string) => {
    const running = firstPasses(orders, 'T1').at(-1)!;
    assert.equal(running.status, 'running');
    writeFileSync(running.lastFile!, output, 'utf8');
    alive = false;
    pollFirstPasses(ctx);
    return firstPasses(orders, 'T1').at(-1)!;
  };

  return {
    ...ctx,
    dir,
    root,
    workOrders,
    deliveryCommit,
    spawned,
    setAlive: (v: boolean) => { alive = v; },
    advanceMinutes: (m: number) => { nowMs += m * 60_000; },
    finishReview,
  };
}

// 1. Config
test('config: plain review string, mapping form with first_pass, bad values and console editing', t => {
  const { dir } = tempOrders();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo'), workOrders = path.join(dir, 'orders');
  mkdirSync(root, { recursive: true }); mkdirSync(workOrders, { recursive: true });
  const baseRaw = { id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state') };
  const cfgFile = path.join(dir, 'alba.yaml');

  const manualPlain = validateProject({ ...baseRaw, review: 'manual' }, cfgFile);
  assert.equal(manualPlain.review, 'manual');
  assert.equal(manualPlain.first_pass, undefined);
  assert.equal(reviewOf(manualPlain, {}), 'manual');
  assert.equal(reviewOf(manualPlain, { review: 'auto' }), 'auto');

  const mapped = validateProject({
    ...baseRaw,
    review: { mode: 'manual', first_pass: 'bounce', first_pass_kinds: ['visual', 'art'], first_pass_minutes: 25 },
  }, cfgFile);
  assert.equal(mapped.review, 'manual');
  assert.equal(reviewOf(mapped, {}), 'manual');
  assert.deepEqual(mapped.first_pass, { mode: 'bounce', kinds: ['visual', 'art'], minutes: 25 });

  const defaultsMapped = validateProject({ ...baseRaw, review: {} }, cfgFile);
  assert.equal(defaultsMapped.review, undefined);
  assert.equal(reviewOf(defaultsMapped, {}), 'auto');
  assert.deepEqual(defaultsMapped.first_pass, { mode: 'off', minutes: 30 });

  for (const [bad, pattern] of [
    ['sometimes', /review/],
    [123, /review/],
    [{ extra: true }, /review\.extra/],
    [{ mode: 'wrong' }, /review\.mode/],
    [{ first_pass: 'always' }, /review\.first_pass/],
    [{ first_pass_kinds: [] }, /review\.first_pass_kinds/],
    [{ first_pass_kinds: 'visual' }, /review\.first_pass_kinds/],
    [{ first_pass_minutes: 0 }, /review\.first_pass_minutes/],
    [{ first_pass_minutes: -10 }, /review\.first_pass_minutes/],
  ] as const) {
    assert.throws(() => validateProject({ ...baseRaw, review: bad }, cfgFile), pattern);
  }

  // Console config editing preserves mapping-form review without regression.
  writeFileSync(
    cfgFile,
    `id: demo\nname: Demo\nroot: repo\nwork_orders: orders\nstate_dir: state\nreview:\n  mode: manual\n  first_pass: advise\n  first_pass_kinds: [visual]\n  first_pass_minutes: 20\ndispatch:\n  stall_minutes: 45\n`,
    'utf8',
  );
  const out = editConfig(cfgFile, 'project', [{ path: ['dispatch', 'stall_minutes'], value: 60 }], {});
  assert.deepEqual(out.changed, ['dispatch.stall_minutes']);
  assert.equal(readEditable(cfgFile, 'project').dispatch && (readEditable(cfgFile, 'project').dispatch as Record<string, unknown>).stall_minutes, 60);
});

// 2. Choice
test('reviewer choice: selects different model_family, skips same-family pool, and skips missing model_family', t => {
  // gpt deliverer with another gpt worker, a worker without family, a script worker, a same-model worker, and a claude worker -> claude chosen
  const f1 = setupFixture(t, {
    deliveringWorker: 'gpt-author',
    deliveringModel: 'shared-custom-model',
    workerDefs: [
      makeWorker('gpt-author', 'gpt'),
      makeWorker('gpt-peer', 'GPT'),
      makeWorker('no-family-worker', undefined),
      makeWorker('script-worker', 'gemini', 'script'),
      makeWorker('same-model-worker', 'gemini', 'codex-cli', { model: 'shared-custom-model' }),
      makeWorker('claude-reviewer', 'claude', 'claude-cli'),
    ],
  });
  runFirstPass(f1);
  assert.equal(f1.spawned.length, 1);
  assert.equal(f1.spawned[0].program, 'claude-reviewer');
  const r1 = firstPasses(f1.orders, 'T1')[0];
  assert.equal(r1.status, 'running');
  assert.equal(r1.worker, 'claude-reviewer');
  assert.equal(r1.model_family, 'claude');
  assert.equal(r1.delivering_worker, 'gpt-author');
  assert.equal(r1.delivering_family, 'gpt');
  f1.finishReview(fpBlock(validPass));

  // Only gpt workers -> skipped
  const f2 = setupFixture(t, {
    deliveringWorker: 'gpt-author',
    workerDefs: [makeWorker('gpt-author', 'gpt'), makeWorker('gpt-other', 'gpt')],
  });
  runFirstPass(f2);
  assert.equal(f2.spawned.length, 0);
  const r2 = firstPasses(f2.orders, 'T1')[0];
  assert.equal(r2.status, 'skipped');
  assert.match(r2.reason ?? '', /No eligible reviewer/);

  // Delivering worker without model_family -> skipped with exact sentence of D2
  const f3 = setupFixture(t, {
    deliveringWorker: 'plain-worker',
    workerDefs: [makeWorker('plain-worker', undefined), makeWorker('claude-reviewer', 'claude', 'claude-cli')],
  });
  runFirstPass(f3);
  assert.equal(f3.spawned.length, 0);
  const r3 = firstPasses(f3.orders, 'T1')[0];
  assert.equal(r3.status, 'skipped');
  assert.match(r3.reason ?? '', /set model_family on plain-worker to allow a first pass/);
});

test('reviewer choice: an agy worker reviews another family\'s delivery through its restricted read-only launch', t => {
  const f = setupFixture(t, {
    deliveringWorker: 'gpt-author',
    workerDefs: [makeWorker('gpt-author', 'gpt'), { ...makeWorker('agy-carbon', 'gemini-4', 'agy-cli'), launch: { program: 'agy-carbon', args: [], model: 'gemini-4-carbon-high', template: 'synthetic' } }],
  });
  runFirstPass(f);
  assert.equal(f.spawned.length, 1);
  const { program, args, cwd } = f.spawned[0];
  const run = firstPasses(f.orders, 'T1')[0];
  assert.deepEqual([program, run.worker, run.model_family], ['agy-carbon', 'agy-carbon', 'gemini-4']);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.match(args[args.indexOf('--agent') + 1], /^alba-read-only-/);
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-4-carbon-high');
  assert.equal(args.at(-2), '-p');
  assert.equal(cwd, run.cwd);
  const done = f.finishReview(fpBlock(validPass));
  assert.deepEqual([done.status, done.verdict?.verdict], ['done', 'pass']);
});

// 3. Verdict parser
test('parseFirstPassVerdict: accepts valid pass, send-back and unsure, and rejects invalid or contradictory blocks', () => {
  const p = parseFirstPassVerdict(`Checked everything.\n${fpBlock(validPass)}`);
  assert.equal(p.verdict, 'pass');
  assert.equal(p.confident, true);
  assert.equal(p.items.length, 1);

  const sb = parseFirstPassVerdict(fpBlock(validSendBack));
  assert.equal(sb.verdict, 'send-back');
  assert.equal(sb.confident, true);
  assert.ok((sb.note?.length ?? 0) >= 40);

  const u = parseFirstPassVerdict(fpBlock(validUnsure));
  assert.equal(u.verdict, 'unsure');
  assert.equal(u.confident, false);

  const invalidCases: [string, string][] = [
    ['pass with a failed item', fpBlock({ ...validPass, items: [{ item: 'x', verdict: 'fail', evidence: 'broken' }] })],
    ['send-back without a note', fpBlock({ verdict: 'send-back', confident: true, items: [{ item: 'x', verdict: 'fail', evidence: 'broken' }], summary: 'bad' })],
    ['send-back with short note', fpBlock({ ...validSendBack, note: 'too short' })],
    ['send-back without failed item', fpBlock({ ...validSendBack, items: [{ item: 'x', verdict: 'doubt', evidence: 'unsure' }] })],
    ['empty evidence', fpBlock({ ...validPass, items: [{ item: 'x', verdict: 'pass', evidence: '   ' }] })],
    ['empty items', fpBlock({ ...validPass, items: [] })],
    ['non-boolean confident', fpBlock({ ...validPass, confident: 'yes' })],
    ['missing block (plain text)', 'Everything looks great, ship it!'],
    ['missing block (bare JSON)', JSON.stringify(validPass)],
  ];
  for (const [label, text] of invalidCases) {
    const parsed = parseFirstPassVerdict(text);
    assert.equal(parsed.verdict, 'unsure', label);
    assert.equal(parsed.summary, 'invalid verdict', label);
  }
});

// 4. Inputs and unchanged-checkout pathspec check
test('inputs: writes capture manifest, sheet, shots, acceptance, diffstat and report; unchanged check excludes .alba-first-pass only', t => {
  const f = setupFixture(t);
  const capSource = path.join(f.dir, 'trial-cap');
  mkdirSync(capSource, { recursive: true });
  const sheetPath = path.join(capSource, 'sheet.png');
  const menuPath = path.join(capSource, 'menu.png');
  const nightPath = path.join(capSource, 'night.png');
  const manifestPath = path.join(capSource, 'manifest.json');
  writeFileSync(sheetPath, makePng(40, 40, 60));
  writeFileSync(menuPath, makePng(100, 100, 120));
  writeFileSync(nightPath, makePng(20, 25, 50));
  const manifest = { version: 1, tag: 'T1', recipe: 'scene', status: 'passed', sheet: 'sheet.png', shots: [{ name: 'menu', file: 'menu.png', status: 'ok' }, { name: 'night', file: 'night.png', status: 'ok' }] };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const reportSeq = f.orders.get('T1').reports.at(-1)!.seq;
  f.orders.record('T1', 'accept-trial', {
    id: 'trial-1',
    fingerprint: 'tfp',
    report: reportSeq,
    base: 'main',
    branch: f.deliveryCommit,
    status: 'passed',
    at: '2026-06-01T11:59:00Z',
    changed: ['scene.ts'],
    conflicts: [],
    steps: [
      {
        name: 'capture',
        status: 'passed',
        duration_ms: 100,
        tail: 'captured 2 shots',
        capture: {
          recipe: 'scene',
          manifest: manifestPath,
          sheet: sheetPath,
          revision: f.deliveryCommit,
          status: 'passed',
          shots: [
            { name: 'menu', file: menuPath, status: 'ok', width: 4, height: 4 },
            { name: 'night', file: nightPath, status: 'ok', width: 4, height: 4 },
          ],
          gates: [],
        },
      },
      {
        name: 'target',
        status: 'passed',
        duration_ms: 10,
        tail: 'targets ok',
        target: [{ id: 'night-lum', ok: true }],
      },
    ],
  });

  runFirstPass(f);
  const running = firstPasses(f.orders, 'T1')[0];
  assert.equal(running.status, 'running');
  const inDir = path.join(running.cwd!, FIRST_PASS_INPUTS_DIR);
  for (const rel of [
    'acceptance.md',
    'diffstat.txt',
    'report.json',
    'final-message.txt',
    'targets.json',
    'capture/manifest.json',
    'capture/sheet.png',
    'capture/menu.png',
    'capture/night.png',
  ]) {
    assert.equal(existsSync(path.join(inDir, rel)), true, `expected ${rel} in .alba-first-pass`);
  }
  assert.match(readFileSync(path.join(inDir, 'acceptance.md'), 'utf8'), /Night scene opens directly/);
  assert.match(readFileSync(path.join(inDir, 'diffstat.txt'), 'utf8'), /scene\.ts/);
  assert.equal(JSON.parse(readFileSync(path.join(inDir, 'report.json'), 'utf8')).seq, reportSeq);
  assert.deepEqual(readFileSync(path.join(inDir, 'capture/night.png')), readFileSync(nightPath));

  // Unchanged check passes with .alba-first-pass populated
  assert.equal(isFirstPassCheckoutUnchanged(running.cwd!, running.commit), true);

  // Changing a file outside .alba-first-pass fails the unchanged check and causes pollFirstPasses to distrust the verdict
  writeFileSync(path.join(running.cwd!, 'scene.ts'), 'export const scene = "tampered";\n');
  assert.equal(isFirstPassCheckoutUnchanged(running.cwd!, running.commit), false);
  const finished = f.finishReview(fpBlock(validPass));
  assert.equal(finished.verdict?.verdict, 'unsure');
  assert.match(finished.reason ?? '', /checkout changed/);
  try { git(f.root, 'worktree', 'remove', '-f', running.cwd!); } catch { /* cleanup tampered checkout */ }
});

// 5. Modes (advise, bounce, all non-apply guards, and two ticks idempotency)
test('modes: advise records without acting; bounce reworks once on confident send-back and records reason when not applied', t => {
  // advise: no action, exposed to producer read
  const adviseFix = setupFixture(t, { review: { mode: 'auto', first_pass: 'advise' } });
  runFirstPass(adviseFix);
  const advised = adviseFix.finishReview(fpBlock(validSendBack));
  assert.equal(advised.verdict?.verdict, 'send-back');
  assert.equal(advised.applied, undefined);
  assert.equal(adviseFix.orders.get('T1').actions.length, 0);
  assert.equal(adviseFix.orders.stage(adviseFix.orders.get('T1')).stage, 'awaiting-review');
  assert.equal(readProducerOrder(adviseFix.project, adviseFix.orders, 'T1').firstPass?.id, advised.id);

  // bounce + confident send-back + two ticks -> one review, one rework, first-pass-applied, reworkCount + 1
  const bounceFix = setupFixture(t, { review: { mode: 'auto', first_pass: 'bounce' } });
  executeTick(bounceFix, { maxDispatch: 0 });
  executeTick(bounceFix, { maxDispatch: 0 }); // second tick while still running starts no second review
  assert.equal(bounceFix.spawned.length, 1);
  writeFileSync(firstPasses(bounceFix.orders, 'T1')[0].lastFile!, fpBlock(validSendBack), 'utf8');
  bounceFix.setAlive(false);
  executeTick(bounceFix, { maxDispatch: 0 });
  executeTick(bounceFix, { maxDispatch: 0 }); // extra tick after bounce applies no second rework
  assert.equal(bounceFix.spawned.length, 1);
  assert.equal(reworkCount(bounceFix.orders.get('T1')), 1);
  const appliedRun = firstPasses(bounceFix.orders, 'T1')[0];
  assert.equal(appliedRun.applied, true);
  const reworkAction = bounceFix.orders.get('T1').actions.at(-1)!;
  assert.equal(reworkAction.kind, 'rework');
  assert.match(reworkAction.note ?? '', /^First-pass review by claude-reviewer \(claude\):/);
  assert.match(reworkAction.note ?? '', /Parse the -Time argument/);
  const appliedEvents = bounceFix.orders.store.events({ tag: 'T1' }).filter(e => e.type === 'first-pass-applied');
  assert.equal(appliedEvents.length, 1);
  assert.equal(appliedEvents[0].data?.id, appliedRun.id);
  assert.equal(appliedEvents[0].data?.action, reworkAction.seq);

  // Second first-pass bounce in a row on the next report -> refused, reason recorded
  git(bounceFix.root, 'switch', '-q', 'order-t1');
  writeFileSync(path.join(bounceFix.root, 'scene.ts'), 'export const scene = "still-menu";\n');
  git(bounceFix.root, 'add', '.');
  git(bounceFix.root, 'commit', '-qm', 'T1: second attempt');
  const secondCommit = git(bounceFix.root, 'rev-parse', 'order-t1');
  git(bounceFix.root, 'switch', '-q', 'main');
  bounceFix.orders.runStart('T1', { worker: 'gpt-author' });
  bounceFix.orders.runEnd('T1');
  bounceFix.orders.report('T1', { status: 'ready', summary: 'Attempt 2', evidence: [], commits: [secondCommit] });
  runFirstPass(bounceFix);
  const secondBounce = bounceFix.finishReview(fpBlock(validSendBack));
  assert.equal(secondBounce.applied, undefined);
  assert.match(secondBounce.not_applied ?? '', /previous send-back was a first-pass bounce/);
  assert.equal(reworkCount(bounceFix.orders.get('T1')), 1);

  // Guard: held
  const heldFix = setupFixture(t, { review: { mode: 'auto', first_pass: 'bounce' } });
  runFirstPass(heldFix);
  heldFix.orders.act('T1', 'hold', { note: 'Pause while checking design' });
  const heldDone = heldFix.finishReview(fpBlock(validSendBack));
  assert.equal(heldDone.applied, undefined);
  assert.match(heldDone.not_applied ?? '', /held/);
  assert.equal(reworkCount(heldFix.orders.get('T1')), 0);

  // Guard: review: manual
  const manualFix = setupFixture(t, { review: { mode: 'manual', first_pass: 'bounce' } });
  runFirstPass(manualFix);
  const manualDone = manualFix.finishReview(fpBlock(validSendBack));
  assert.equal(manualDone.applied, undefined);
  assert.match(manualDone.not_applied ?? '', /manual/);
  assert.equal(reworkCount(manualFix.orders.get('T1')), 0);

  // Guard: max_reworks reached
  const maxFix = setupFixture(t, { review: { mode: 'auto', first_pass: 'bounce' }, maxReworks: 1 });
  rework(maxFix.orders, 'T1', 'Human send-back before second delivery', { max: 1 });
  git(maxFix.root, 'switch', '-q', 'order-t1');
  writeFileSync(path.join(maxFix.root, 'scene.ts'), 'export const scene = "night-v2";\n');
  git(maxFix.root, 'add', '.');
  git(maxFix.root, 'commit', '-qm', 'T1: after human rework');
  const maxCommit = git(maxFix.root, 'rev-parse', 'order-t1');
  git(maxFix.root, 'switch', '-q', 'main');
  maxFix.orders.runStart('T1', { worker: 'gpt-author' });
  maxFix.orders.runEnd('T1');
  maxFix.orders.report('T1', { status: 'ready', summary: 'Ready again', evidence: [], commits: [maxCommit] });
  assert.equal(reworkCount(maxFix.orders.get('T1')), 1);
  runFirstPass(maxFix);
  const maxDone = maxFix.finishReview(fpBlock(validSendBack));
  assert.equal(maxDone.applied, undefined);
  assert.match(maxDone.not_applied ?? '', /max_reworks/);
  assert.equal(reworkCount(maxFix.orders.get('T1')), 1);

  // Guard: lead action after the report (superseded)
  const leadFix = setupFixture(t, { review: { mode: 'auto', first_pass: 'bounce' } });
  runFirstPass(leadFix);
  leadFix.orders.act('T1', 'rework', { note: 'Lead already sent this back manually.' });
  const leadDone = leadFix.finishReview(fpBlock(validSendBack));
  assert.equal(leadDone.applied, undefined);
  assert.equal(leadDone.not_applied, 'superseded');
  assert.equal(reworkCount(leadFix.orders.get('T1')), 1);

  // Guard: non-confident send-back
  const shyFix = setupFixture(t, { review: { mode: 'auto', first_pass: 'bounce' } });
  runFirstPass(shyFix);
  const shyDone = shyFix.finishReview(fpBlock({ ...validSendBack, confident: false }));
  assert.equal(shyDone.applied, undefined);
  assert.match(shyDone.not_applied ?? '', /not confident/);
  assert.equal(reworkCount(shyFix.orders.get('T1')), 0);
});

// 6. Timeout and shared review_runs_per_day budget
test('timeout stops a real reviewer process and records unsure; review_runs_per_day is shared both ways', t => {
  const timeoutFix = setupFixture(t, { review: { mode: 'auto', first_pass: 'bounce', first_pass_minutes: 5 } });
  let realPid = 0;
  let nowMs = Date.now();
  timeoutFix.probes.now = () => new Date(nowMs);
  timeoutFix.probes.isAlive = systemProbes.isAlive;
  timeoutFix.probes.processStartedAt = systemProbes.processStartedAt;
  timeoutFix.probes.spawnDetached = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    realPid = child.pid!;
    return realPid;
  };
  t.after(() => { if (realPid) { try { process.kill(realPid); } catch { /* already stopped */ } } });

  runFirstPass(timeoutFix);
  assert.ok(realPid > 0 && systemProbes.isAlive(realPid), 'reviewer process started');
  nowMs += 6 * 60_000;
  runFirstPass(timeoutFix);
  assert.equal(systemProbes.isAlive(realPid), false, 'timed-out reviewer process must be stopped');
  const timedOut = firstPasses(timeoutFix.orders, 'T1').at(-1)!;
  assert.equal(timedOut.status, 'done');
  assert.equal(timedOut.verdict?.verdict, 'unsure');
  assert.equal(timedOut.reason, 'timed out');

  // Budget direction 1: review_runs_per_day: 1 used by an independent check refuses the first pass
  const b1 = setupFixture(t, {
    review: { mode: 'auto', first_pass: 'advise' },
    reviewRunsPerDay: 1,
    roles: { verifier: { workers: { prefer: ['claude-reviewer'] } } },
  });
  b1.orders.update('T1', { check: 'independent' });
  const ic = startIndependentCheck(b1, 'T1');
  assert.equal(ic.status, 'running');
  writeFileSync(ic.lastFile, '--- alba-independent-check ---\n{"checked":[{"item":"Night scene opens directly","verdict":"pass","evidence":"ok"}],"pass":true,"summary":"ok"}\n--- end ---\n', 'utf8');
  b1.setAlive(false);
  pollIndependentChecks(b1);
  assert.equal(reviewRunsToday(b1.orders, b1.probes.now()), 1);
  runFirstPass(b1);
  assert.equal(b1.spawned.length, 1, 'first pass must not spawn after budget used by independent check');
  const skippedFp = firstPasses(b1.orders, 'T1').at(-1)!;
  assert.equal(skippedFp.status, 'skipped');
  assert.match(skippedFp.reason ?? '', /review_runs_per_day/);

  // Budget direction 2: review_runs_per_day: 1 used by a first pass refuses the independent check
  const b2 = setupFixture(t, {
    review: { mode: 'auto', first_pass: 'advise' },
    reviewRunsPerDay: 1,
    roles: { verifier: { workers: { prefer: ['claude-reviewer'] } } },
  });
  b2.orders.update('T1', { check: 'independent' });
  runFirstPass(b2);
  assert.equal(firstPasses(b2.orders, 'T1')[0].status, 'running');
  assert.equal(reviewRunsToday(b2.orders, b2.probes.now()), 1);
  assert.throws(() => startIndependentCheck(b2, 'T1'), /review_runs_per_day budget exhausted/);
  b2.finishReview(fpBlock(validPass));
});

// 8. Order detail API exposes firstPass and acceptance card for the console
test('order detail API exposes firstPass and ensures acceptance card is present for review rendering', async () => {
  const f = await apiFixture({ populate: true });
  const reportSeq = f.orders.get('R1').reports.at(-1)!.seq;
  f.orders.record('R1', 'first-pass', {
    id: 'fp-web-1',
    tag: 'R1',
    report: reportSeq,
    fingerprint: 'fp-web',
    commit: 'abc1234567890',
    worker: 'claude-reviewer',
    model_family: 'claude',
    delivering_worker: 'coder',
    delivering_family: 'gpt',
    status: 'done',
    started: '2026-06-01T10:00:00Z',
    ended: '2026-06-01T10:02:00Z',
    applied: true,
    verdict: validSendBack,
    reason: validSendBack.summary,
  });
  f.orders.record('R1', 'first-pass-applied', { id: 'fp-web-1', report: reportSeq, action: 99 });

  const detailRes = await f.get('/api/orders/R1');
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.body.firstPass.id, 'fp-web-1');
  assert.equal(detailRes.body.firstPass.model_family, 'claude');
  assert.equal(detailRes.body.firstPass.verdict.verdict, 'send-back');
  assert.ok(detailRes.body.acceptance, 'acceptance card must be present when firstPass exists');
  assert.equal(currentFirstPass(f.orders, f.orders.get('R1'))?.id, 'fp-web-1');
});
