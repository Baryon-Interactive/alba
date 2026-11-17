import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { removeTreeSync } from '../src/fs/remove-tree.mjs';
import { closeStateStores, stateStore } from '../src/orders/backend.ts';
import { planOrder } from '../src/orders/planned.ts';
import { preflight } from '../src/orders/preflight.ts';
import { Orders } from '../src/orders/service.ts';
import { BUILTIN_DRAFTING_TEMPLATE, fillOrderBody } from '../src/orders/templates.ts';
import { acceptDraft, draftingContext, planFingerprint } from '../src/producer/drafting.ts';
import { humanAction } from '../src/service/actions.ts';
import { createOrder } from '../src/service/new-order.ts';
import { tick, type Probes } from '../src/tick/gather.ts';
import { planTick, type TickOrder } from '../src/tick/plan.ts';
import { parseOrderSections } from '../src/verify/verify.ts';
import { validateWorkers, type WorkerConfig } from '../src/workers/config.ts';
import { alba, projectDir } from './cli-helper.ts';
import { tempOrders } from './helpers.ts';
import { loadProject, validateProject } from './state-helper.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function repoFixture(ordersConfig?: unknown) {
  const { dir, orders } = tempOrders();
  const root = path.join(dir, 'repo');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'src', 'ui', 'hud.ts'), 'export const hud = 1;\n');
  writeFileSync(path.join(root, 'src', 'core', 'locked.ts'), 'export const locked = 2;\n');
  writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const project = validateProject(
    {
      id: 'demo',
      name: 'Demo',
      root,
      work_orders: workOrders,
      state_dir: path.join(dir, 'state'),
      dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
      ...(ordersConfig !== undefined ? { orders: ordersConfig } : {}),
    },
    path.join(dir, 'alba.yaml'),
  );
  return { dir, root, workOrders, orders, project };
}

const fakeWorker = (): WorkerConfig => ({
  id: 'coder',
  engine: 'codex-cli',
  paid: false,
  concurrency: 4,
  capabilities: [],
  cost: 'included',
  aliases: [],
  enabled: true,
  disabled_when: [],
  card_only: false,
  launch: { id: 'coder', program: 'codex', args: ['exec', '{prompt_file}'], env: {}, env_unset: [] },
});

const workersFile = () =>
  validateWorkers(
    { workers: [{ id: 'coder', engine: 'codex-cli', concurrency: 4, launch: { program: 'codex', args: ['exec', '{prompt_file}'] } }] },
    'workers.yaml',
  );

const fakeProbes = (now = new Date('2026-01-01T12:00:00Z')): Probes =>
  ({
    now: () => now,
    runCommand: () => '[]',
    freeRamGb: () => 32,
    worktrees: () => [],
    gitActivity: () => ({}),
    fileTime: () => undefined,
    isAlive: () => false,
    tail: () => '',
    readText: () => undefined,
    spawnDetached: () => 4242,
  }) as unknown as Probes;

test('1. fill: numbered Acceptance stays byte-for-byte unchanged, docs: {} fills nothing, default applies, placeholders expand, trailing Report stays last', () => {
  const { dir, project } = repoFixture({
    templates: {
      ue: {
        file: path.join(REPO_ROOT, 'templates', 'orders', 'ue.md'),
        evidence: ['artifacts/{tag_lower}/shot-{tag}.png: capture for {kind}'],
        paths: ['allow: src/ui/**'],
      },
      docs: {},
      default: {
        acceptance: ['Default check for {tag} ({tag_lower}) in {kind} passes.'],
        paths: ['allow: src/**'],
      },
    },
  });
  try {
    const acceptanceSlice = '## 4. Acceptance (lead)\n- Frame time stays below 16.6 ms.\n  Note: keep exact spacing   \n- Menu closes cleanly.';
    const reportSlice = '## 5. Report\nAt most 20 lines.\n';
    const rawBody = `# U1: HUD polish\n\n## Task\nUpdate \`src/ui/hud.ts\`.\n\n${acceptanceSlice}\n\n${reportSlice}`;

    const ueFilled = fillOrderBody(project, 'ue', 'U1', rawBody);
    assert.deepEqual(ueFilled.filled, ['Evidence', 'Paths', 'Standing rules']);
    // Written numbered Acceptance is byte-for-byte unchanged.
    assert.ok(ueFilled.body.includes(acceptanceSlice));
    // Inline evidence/paths win over file, while Standing rules come from ue.md, and placeholders are replaced.
    assert.match(ueFilled.body, /## Evidence\n\n- artifacts\/u1\/shot-U1\.png: capture for ue/);
    assert.match(ueFilled.body, /## Paths\n\n- allow: src\/ui\/\*\*/);
    assert.doesNotMatch(ueFilled.body, /allow: Source\/\*\*/);
    assert.match(ueFilled.body, /## Standing rules\n\n- Run at most one engine build/);
    // Trailing ## 5. Report stays at the very end after the filled sections.
    assert.ok(ueFilled.body.endsWith(`\n\n${reportSlice}`));
    assert.ok(ueFilled.body.indexOf('## Standing rules') < ueFilled.body.indexOf('## 5. Report'));

    // An empty written heading counts as present and is never modified.
    const withEmptyEvidence = fillOrderBody(project, 'ue', 'U2', '# U2\n\n## Acceptance\n- Works in package.\n\n## Evidence\n');
    assert.ok(!withEmptyEvidence.filled.includes('Evidence'));
    assert.deepEqual(withEmptyEvidence.filled, ['Paths', 'Standing rules']);

    // `docs: {}` is declared and empty: fills nothing (does not fall back to default).
    const docsInput = '# D1\n\nWrite docs.\n';
    const docsFilled = fillOrderBody(project, 'docs', 'D1', docsInput);
    assert.deepEqual(docsFilled, { body: docsInput, filled: [] });

    // `default` applies to an unlisted kind (`sim`) and replaces {tag}, {tag_lower}, {kind}.
    const simFilled = fillOrderBody(project, 'sim', 'SM7', '# SM7\n\nSimulate.\n');
    assert.deepEqual(simFilled.filled, ['Acceptance', 'Paths']);
    assert.match(simFilled.body, /- Default check for SM7 \(sm7\) in sim passes\./);
    assert.match(simFilled.body, /- allow: src\/\*\*/);

    // Shipped code.md and docs.md templates also parse and fill cleanly; docs.md has no Evidence.
    const shipped = validateProject(
      {
        id: 'shipped',
        name: 'Shipped',
        root: project.root,
        work_orders: project.work_orders,
        state_dir: path.join(dir, 'state-shipped'),
        orders: {
          templates: {
            code: { file: path.join(REPO_ROOT, 'templates', 'orders', 'code.md') },
            docs: { file: path.join(REPO_ROOT, 'templates', 'orders', 'docs.md') },
          },
        },
      },
      path.join(dir, 'shipped.yaml'),
    );
    assert.deepEqual(fillOrderBody(shipped, 'code', 'C1', '# C1\n\nFix parser.\n').filled, ['Acceptance', 'Evidence', 'Paths', 'Standing rules']);
    assert.deepEqual(fillOrderBody(shipped, 'docs', 'D2', '# D2\n\nUpdate guide.\n').filled, ['Acceptance', 'Paths', 'Standing rules']);
  } finally {
    closeStateStores();
    removeTreeSync(dir);
  }
});

test('2. entry points: createOrder, CLI orders add --body-file, acceptDraft and draftingContext apply templates and record events', () => {
  const { dir, orders, project } = repoFixture({
    templates: {
      code: {
        acceptance: ['Typecheck and unit tests for {tag} exit 0.'],
        evidence: ['artifacts/{tag_lower}/tests.txt: test output'],
        paths: ['allow: src/**'],
        rules: ['Do not weaken assertions.'],
      },
      bare: {},
    },
  });
  try {
    // createOrder with a body fills missing sections and records order-template-filled.
    const made = createOrder(project, orders, { tag: 'C1', title: 'Add helper', kind: 'code', body: '# C1\n\n## Task\nImplement helper.\n' });
    assert.ok(made.file);
    const written = readFileSync(made.file!, 'utf8');
    assert.match(written, /## Acceptance\n\n- Typecheck and unit tests for C1 exit 0\./);
    assert.match(written, /## Evidence\n\n- artifacts\/c1\/tests\.txt: test output/);
    const filledEvent = orders.store.events({ tag: 'C1' }).find(e => e.type === 'order-template-filled');
    assert.deepEqual(filledEvent?.data, { kind: 'code', sections: ['Acceptance', 'Evidence', 'Paths', 'Standing rules'] });

    // createOrder without a body is not filled and records no template event.
    createOrder(project, orders, { tag: 'C2', title: 'No body yet', kind: 'code' });
    assert.equal(orders.store.events({ tag: 'C2' }).some(e => e.type === 'order-template-filled'), false);

    // CLI `alba orders add --body-file` run as a subprocess does the same.
    const cliDir = path.join(dir, 'cli-proj');
    mkdirSync(cliDir, { recursive: true });
    const cliYaml = projectDir(
      cliDir,
      [
        'orders:',
        '  templates:',
        '    code:',
        '      acceptance: ["CLI check for {tag} exits 0."]',
        '      paths: ["allow: src/**"]',
      ].join('\n') + '\n',
    );
    const bodyInput = path.join(cliDir, 'input.md');
    writeFileSync(bodyInput, '# C3\n\n## Task\nBuild CLI path.\n');
    const cliAdd = alba(cliYaml, ['orders', 'add', 'C3', '--title', 'CLI order', '--kind', 'code', '--body-file', bodyInput]);
    assert.equal(cliAdd.code, 0, cliAdd.err);
    const cliCfg = loadProject(cliYaml);
    const cliOrders = new Orders(stateStore(cliCfg));
    const c3Text = readFileSync(path.join(cliCfg.work_orders, 'C3-cli-order.md'), 'utf8');
    assert.match(c3Text, /## Acceptance\n\n- CLI check for C3 exits 0\./);
    assert.match(c3Text, /## Paths\n\n- allow: src\/\*\*/);
    assert.deepEqual(
      cliOrders.store.events({ tag: 'C3' }).find(e => e.type === 'order-template-filled')?.data,
      { kind: 'code', sections: ['Acceptance', 'Paths'] },
    );

    // draftingContext replaces empty Acceptance/Evidence with the kind's sections when drafting.template is unset.
    planOrder(project, orders, { tag: 'P1', title: 'Planned code task', kind: 'code', needs: [], intent: 'Ship P1.' });
    const ctxCode = draftingContext(project, orders, 'P1');
    assert.match(ctxCode.template, /## Acceptance\n\n- Typecheck and unit tests for P1 exit 0\./);
    assert.match(ctxCode.template, /## Standing rules\n\n- Do not weaken assertions\./);

    planOrder(project, orders, { tag: 'P2', title: 'Planned bare task', kind: 'bare', needs: [], intent: 'Ship P2.' });
    const ctxBare = draftingContext(project, orders, 'P2');
    assert.equal(ctxBare.template, BUILTIN_DRAFTING_TEMPLATE);

    // acceptDraft of a draft without Acceptance passes when the template supplies Acceptance, and records order-template-filled.
    const fp1 = planFingerprint(orders.get('P1'));
    const acceptedFile = acceptDraft(
      project,
      orders,
      { tag: 'P1', title: 'Planned code task', kind: 'code', needs: [], body: '# P1\n\n## Task\nWrite the code.\n' },
      fp1,
    );
    assert.equal(orders.stage(orders.get('P1')).stage, 'queued');
    assert.match(readFileSync(acceptedFile, 'utf8'), /## Acceptance\n\n- Typecheck and unit tests for P1 exit 0\./);
    assert.ok(orders.store.events({ tag: 'P1' }).some(e => e.type === 'order-template-filled'));

    // acceptDraft of an order without an Acceptance-providing template still fails as today.
    const fp2 = planFingerprint(orders.get('P2'));
    assert.throws(
      () => acceptDraft(project, orders, { tag: 'P2', title: 'Planned bare task', kind: 'bare', needs: [], body: '# P2\n\n## Task\nNo acceptance.\n' }, fp2),
      /A draft needs a body with an Acceptance section/,
    );
  } finally {
    closeStateStores();
    removeTreeSync(dir);
  }
});

test('3. preflight: exercises file, sections, paths (including reading-only exclusions), needs, tool-dirs and scratch checks without touching base', () => {
  const { dir, root, workOrders, orders, project } = repoFixture({
    templates: {
      ue: {
        acceptance: ['Packaged autoplay exits 0.'],
        evidence: ['artifacts/{tag_lower}/shot.png: capture'],
        paths: ['allow: src/ui/**'],
      },
    },
    preflight: {
      mode: 'hold',
      run_checks: true,
      check_timeout_seconds: 30,
      tool_dirs: {
        'image-gen': { dir: '~/.codex/generated_images', kinds: ['ue'] },
      },
    },
  });
  try {
    const baseHeadBefore = git(root, 'rev-parse', 'HEAD').trim();
    const branchesBefore = git(root, 'branch', '--list').trim();

    // Cancelled dependency for check 4 (`needs`).
    orders.add({ tag: 'DEP1', title: 'Cancelled dependency', kind: 'code' });
    orders.act('DEP1', 'cancel');

    // (a) Missing work-order file -> `file` hold; cancelled need -> `needs` hold.
    orders.add({ tag: 'PF1', title: 'Missing file', kind: 'ue', needs: ['DEP1'] });
    orders.act('PF1', 'queue');
    const rMissingFile = preflight(project, orders, 'PF1');
    assert.equal(rMissingFile.ok, false);
    assert.deepEqual(rMissingFile.problems.map(p => [p.code, p.severity]), [
      ['file', 'hold'],
      ['needs', 'hold'],
    ]);
    assert.match(rMissingFile.problems[1].fix, /Drop "DEP1"/);

    // (b) File without Acceptance bullets + missing template Evidence & Paths + missing tool folder.
    writeFileSync(path.join(workOrders, 'PF2-no-accept.md'), '# PF2\n\n## Task\nTouch UI.\n');
    orders.add({ tag: 'PF2', title: 'No acceptance', kind: 'ue' });
    orders.act('PF2', 'queue');
    const rNoAccept = preflight(project, orders, 'PF2');
    assert.equal(rNoAccept.ok, false);
    assert.ok(rNoAccept.problems.some(p => p.code === 'file' && p.severity === 'hold'));
    const secWarn = rNoAccept.problems.filter(p => p.code === 'sections' && p.severity === 'warn');
    assert.equal(secWarn.length, 2);
    assert.match(secWarn[0].fix, /- artifacts\/pf2\/shot\.png: capture/);
    assert.match(secWarn[1].fix, /- allow: src\/ui\/\*\*/);
    const toolWarn = rNoAccept.problems.find(p => p.code === 'tool-dirs' && p.severity === 'warn');
    assert.ok(toolWarn);
    assert.equal(toolWarn!.fix, '- tool-dir: ~/.codex/generated_images (image-gen)');

    // (c) `paths`: existing base path named under Task outside `allow:` holds with exact `- allow: <path>`,
    // while an existing path named ONLY under "## Files to read" is not a problem; `parseOrderSections` ignores `- tool-dir:`.
    const pf3Body = [
      '# PF3',
      '',
      '## Files to read',
      'Read `docs/guide.md` first for context.',
      '',
      '## Task',
      'Update `src/ui/hud.ts` and `src/core/locked.ts`.',
      '',
      '## Acceptance',
      '- HUD updates cleanly.',
      '',
      '## Evidence',
      '- artifacts/pf3/shot.png: capture',
      '',
      '## Paths',
      '- allow: src/ui/**',
      '- tool-dir: ~/.codex/generated_images (image-gen)',
      '',
    ].join('\n');
    assert.deepEqual(parseOrderSections(pf3Body).allow, ['src/ui/**']);
    writeFileSync(path.join(workOrders, 'PF3-paths.md'), pf3Body);
    orders.add({ tag: 'PF3', title: 'Paths check', kind: 'ue' });
    orders.act('PF3', 'queue');
    const rPaths = preflight(project, orders, 'PF3');
    assert.equal(rPaths.ok, false);
    const pathProblems = rPaths.problems.filter(p => p.code === 'paths');
    assert.equal(pathProblems.length, 1);
    assert.match(pathProblems[0].text, /src\/core\/locked\.ts/);
    assert.equal(pathProblems[0].fix, '- allow: src/core/locked.ts');
    assert.equal(rPaths.problems.some(p => p.text.includes('docs/guide.md')), false, 'path only under Files to read is allowed');
    assert.equal(rPaths.problems.some(p => p.code === 'tool-dirs'), false);

    // Deny rule in ## Paths also holds when an allowed path matches deny:, while `- deny: ...` itself in ## Paths does not self-trigger.
    writeFileSync(
      path.join(workOrders, 'PF3B-deny.md'),
      '# PF3B\n\n## Task\nEdit `src/ui/hud.ts`.\n\n## Acceptance\n- Works.\n\n## Paths\n- allow: src/**\n- deny: src/ui/hud.ts\n',
    );
    orders.add({ tag: 'PF3B', title: 'Deny check', kind: 'code' });
    orders.act('PF3B', 'queue');
    const rDeny = preflight(project, orders, 'PF3B');
    assert.equal(rDeny.ok, false);
    assert.equal(rDeny.problems.filter(p => p.code === 'paths').length, 1);
    assert.match(rDeny.problems[0].text, /matches a deny:/);

    // (d) `checks`: skipped command (absent path), passing command, failing command (`exit 3`), scratch checkout removed, base intact.
    writeFileSync(
      path.join(workOrders, 'PF4-checks.md'),
      [
        '# PF4',
        '',
        '## Task',
        'Update `src/ui/hud.ts`.',
        '',
        '## Acceptance',
        '- HUD compiles.',
        '- command: `node -e "process.stdout.write(\'ok-pass\\n\')"`',
        '- command: `node --test test/created-by-order.test.ts`',
        '',
        '## Checks',
        '```sh',
        'node -e "console.error(\'bad-line-1\\nbad-line-2\'); process.exit(3)"',
        'node -e "process.exit(9)"',
        '```',
        '',
        '## Evidence',
        '- artifacts/pf4/shot.png: capture',
        '',
        '## Paths',
        '- allow: src/ui/**',
        '- tool-dir: ~/.codex/generated_images (image-gen)',
        '',
      ].join('\n'),
    );
    orders.add({ tag: 'PF4', title: 'Checks order', kind: 'ue' });
    orders.act('PF4', 'queue');
    const rChecks = preflight(project, orders, 'PF4', { record: true });
    assert.equal(rChecks.ok, false);
    assert.ok(rChecks.checks);
    assert.deepEqual(
      rChecks.checks!.map(c => [c.status, c.reason ?? c.code]),
      [
        ['skipped', 'skipped: tests what the order creates'],
        ['failed', 3],
      ],
    );
    // Note: `extractCheckCommands` runs Checks fenced block lines then Acceptance `command:` bullets, stopping at the first failure!
    const checkHold = rChecks.problems.find(p => p.code === 'checks' && p.severity === 'hold');
    assert.ok(checkHold);
    assert.match(checkHold!.fix, /process\.exit\(3\)/);
    assert.match(checkHold!.fix, /exit 3/);
    assert.match(checkHold!.fix, /bad-line-2/);

    // Now test a clean passing check command order.
    writeFileSync(
      path.join(workOrders, 'PF5-pass.md'),
      [
        '# PF5',
        '',
        '## Acceptance',
        '- command: `node -e "const fs = require(\'node:fs\'); if (!fs.existsSync(\'src/ui/hud.ts\')) process.exit(2);"`',
        '- command: `node scripts/future-verify.mjs`',
        '',
        '## Evidence',
        '- artifacts/pf5/shot.png: capture',
        '',
        '## Paths',
        '- allow: src/ui/**',
        '- tool-dir: ~/.codex/generated_images (image-gen)',
        '',
      ].join('\n'),
    );
    orders.add({ tag: 'PF5', title: 'Passing checks', kind: 'ue' });
    orders.act('PF5', 'queue');
    const rPass = preflight(project, orders, 'PF5', { record: true });
    assert.equal(rPass.ok, true, JSON.stringify(rPass.problems));
    assert.deepEqual(
      rPass.checks!.map(c => [c.status, c.reason ?? c.code]),
      [
        ['skipped', 'skipped: tests what the order creates'],
        ['passed', 0],
      ],
    );

    // Scratch checkout is gone afterwards, and base checkout + branches are unchanged.
    assert.equal(existsSync(path.join(project.state_dir, 'preflight', 'PF4')), false);
    assert.equal(existsSync(path.join(project.state_dir, 'preflight', 'PF5')), false);
    assert.equal(git(root, 'rev-parse', 'HEAD').trim(), baseHeadBefore);
    assert.equal(git(root, 'branch', '--list').trim(), branchesBefore);
    assert.equal(git(root, 'status', '--porcelain').trim(), '');
    const worktreeLines = git(root, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/).filter(Boolean);
    assert.equal(worktreeLines.length, 1);
  } finally {
    closeStateStores();
    removeTreeSync(dir);
  }
});

test('4. tick: planTick holds and formats (+N more) + override, warn mode dispatches, dry-run runs no command, legacy run-orders skip, override holds per file hash', () => {
  // Direct `planTick` assertions: hold vs warn.
  const baseOrder = (over: Partial<TickOrder> = {}): TickOrder => ({
    role: { id: 'default' },
    tag: 'T1',
    stage: 'queued',
    kind: 'code',
    row: 1,
    rework: false,
    resume: false,
    endedWithoutReport: false,
    ...over,
  });
  const heldPlan = planTick({
    now: new Date('2026-01-01T12:00:00Z'),
    orders: [
      baseOrder({
        preflight: [
          { code: 'file', text: 'T1.md has no Acceptance.', fix: 'Add ## Acceptance' },
          { code: 'paths', text: 'src/core/locked.ts outside allow.', fix: '- allow: src/core/locked.ts' },
        ],
      }),
    ],
    activity: {},
    workers: [{ config: fakeWorker(), available: true, reasons: [], running: 0, runsToday: 0 }],
    caps: {},
    reworkReserve: 1,
    alerts: [],
  });
  assert.deepEqual(heldPlan.moves, []);
  assert.deepEqual(heldPlan.heldBack, [{ tag: 'T1', why: 'preflight: T1.md has no Acceptance. (+1 more)' }]);
  assert.equal(heldPlan.problems.length, 1);
  assert.equal(heldPlan.problems[0].kind, 'preflight');
  assert.ok(heldPlan.problems[0].text.endsWith('Fix: Add ## Acceptance; - allow: src/core/locked.ts Override: alba orders act T1 queue --override --note "<why>"'));

  const warnPlan = planTick({
    now: new Date('2026-01-01T12:00:00Z'),
    orders: [
      baseOrder({
        preflight: [{ code: 'file', text: 'T1.md has no Acceptance.', fix: 'Add ## Acceptance', mode: 'warn' }],
      }),
    ],
    activity: {},
    workers: [{ config: fakeWorker(), available: true, reasons: [], running: 0, runsToday: 0 }],
    caps: {},
    reworkReserve: 1,
    alerts: [],
  });
  assert.deepEqual(warnPlan.moves.map(m => m.tag), ['T1']);
  assert.deepEqual(warnPlan.heldBack, []);
  assert.equal(warnPlan.problems[0].kind, 'preflight');

  // Full `tick()` gather + override lifecycle in a temp git repository.
  const marker = path.join(REPO_ROOT, '.alba'); // not written; use temp dir below!
  void marker;
  const { dir, workOrders, orders, project } = repoFixture({
    preflight: { mode: 'hold', run_checks: true, check_timeout_seconds: 30 },
  });
  try {
    const markerFile = path.join(dir, 'ran-check.txt');
    // Legacy order with an earlier run and no preflight event is NOT held even without Acceptance.
    writeFileSync(path.join(workOrders, 'OLD1-legacy.md'), '# OLD1\n\nLegacy work without Acceptance.\n');
    orders.add({ tag: 'OLD1', title: 'Legacy', kind: 'code' });
    orders.act('OLD1', 'queue');
    orders.runStart('OLD1', { worker: 'coder' });
    orders.runEnd('OLD1', 'completed');
    orders.report('OLD1', { status: 'ready', summary: 'done', evidence: [], commits: [] });
    orders.act('OLD1', 'rework', { note: 'adjust spacing' });

    // Order with a check command that writes `markerFile`: dry-run tick MUST NOT execute it or create `<state_dir>/preflight`.
    const markerPosix = markerFile.replace(/\\/g, '/');
    const cmdLine = `node -e "require('node:fs').writeFileSync('${markerPosix}', 'ran')"`;
    writeFileSync(
      path.join(workOrders, 'CHK1-cmd.md'),
      `# CHK1\n\n## Acceptance\n- command: \`${cmdLine}\`\n`,
    );
    orders.add({ tag: 'CHK1', title: 'Has check command', kind: 'code' });
    orders.act('CHK1', 'queue');

    // Second order with check command to verify at-most-one check run per real tick pass.
    writeFileSync(
      path.join(workOrders, 'CHK2-cmd.md'),
      '# CHK2\n\n## Acceptance\n- command: `node -e "process.exit(0)"`\n',
    );
    orders.add({ tag: 'CHK2', title: 'Second check order', kind: 'code' });
    orders.act('CHK2', 'queue');

    // Order missing Acceptance: held on both dry-run and real tick.
    const badFile = path.join(workOrders, 'BAD1-missing.md');
    writeFileSync(badFile, '# BAD1\n\nMissing acceptance.\n');
    orders.add({ tag: 'BAD1', title: 'Bad order', kind: 'code' });
    orders.act('BAD1', 'queue');

    // Dry-run tick (`record: true` without `nudge`/`real`, matching `alba tick --dry-run`): runs no check command, makes no checkout.
    const dry = tick(project, orders, workersFile(), fakeProbes(), { record: true });
    assert.equal(existsSync(markerFile), false, 'dry-run tick must never execute check commands');
    assert.equal(existsSync(path.join(project.state_dir, 'preflight')), false);
    assert.ok(dry.report.moves.some(m => m.tag === 'OLD1'), 'legacy order with earlier runs and no preflight event is not held');
    assert.ok(dry.report.heldBack.some(h => h.tag === 'BAD1' && h.why.startsWith('preflight:')));

    // Real tick pass 1: runs check command for CHK1 only; CHK2 shows "preflight checks waiting"; BAD1 records preflight-held once.
    const real1 = tick(project, orders, workersFile(), fakeProbes(), { record: true, nudge: true });
    assert.equal(existsSync(markerFile), true, 'real tick executes check command for first eligible order');
    assert.ok(real1.report.moves.some(m => m.tag === 'CHK1'));
    assert.deepEqual(
      real1.report.heldBack.find(h => h.tag === 'CHK2'),
      { tag: 'CHK2', why: 'preflight checks waiting' },
    );
    assert.equal(orders.store.events({ tag: 'BAD1' }).filter(e => e.type === 'preflight-held').length, 1);

    // Real tick pass 2: CHK1 uses cached check result for its hash, so CHK2 now runs its check command and moves; BAD1 does NOT duplicate preflight-held.
    const real2 = tick(project, orders, workersFile(), fakeProbes(), { record: true, nudge: true });
    assert.ok(real2.report.moves.some(m => m.tag === 'CHK2'));
    assert.equal(orders.store.events({ tag: 'BAD1' }).filter(e => e.type === 'preflight-held').length, 1);

    // Mode `warn` in gather does not hold BAD1.
    const warnProject = { ...project, orders: { ...project.orders!, preflight: { ...project.orders!.preflight, mode: 'warn' as const } } };
    const warnTick = tick(warnProject, orders, workersFile(), fakeProbes(), { record: false });
    assert.ok(warnTick.report.moves.some(m => m.tag === 'BAD1'));
    assert.ok(warnTick.report.problems.some(p => p.kind === 'preflight' && p.tag === 'BAD1'));

    // Override on BAD1: short note fails, >= 10 char note records preflight-overridden without adding an action, and BAD1 dispatches!
    const actionsBefore = orders.get('BAD1').actions.length;
    assert.throws(() => humanAction(project, orders, 'BAD1', 'queue', 'too short', undefined, true), /at least 10 characters/);
    assert.equal(humanAction(project, orders, 'BAD1', 'queue', 'Approved one-off exploratory spike.', undefined, true), 'queued');
    assert.equal(orders.get('BAD1').actions.length, actionsBefore, 'queue --override on queued order adds no action');
    assert.ok(orders.store.events({ tag: 'BAD1' }).some(e => e.type === 'preflight-overridden'));

    const afterOverride = tick(project, orders, workersFile(), fakeProbes(), { record: false });
    assert.ok(afterOverride.report.moves.some(m => m.tag === 'BAD1'));
    assert.equal(afterOverride.report.heldBack.some(h => h.tag === 'BAD1'), false);

    // Editing BAD1's file changes its SHA-256 hash -> BAD1 is held again!
    writeFileSync(badFile, '# BAD1\n\nEdited text still missing acceptance.\n');
    const afterEdit = tick(project, orders, workersFile(), fakeProbes(), { record: false });
    assert.equal(afterEdit.report.moves.some(m => m.tag === 'BAD1'), false);
    assert.ok(afterEdit.report.heldBack.some(h => h.tag === 'BAD1' && h.why.startsWith('preflight:')));

    // `queue --override` on a non-queued (`draft`) order queues it as today AND records `preflight-overridden`.
    writeFileSync(path.join(workOrders, 'DRF1-draft.md'), '# DRF1\n\nDraft without acceptance.\n');
    orders.add({ tag: 'DRF1', title: 'Draft order', kind: 'code' });
    assert.equal(orders.stage(orders.get('DRF1')).stage, 'draft');
    assert.equal(humanAction(project, orders, 'DRF1', 'queue', 'Queue draft and override preflight.', undefined, true), 'queued');
    assert.ok(orders.store.events({ tag: 'DRF1' }).some(e => e.type === 'preflight-overridden'));
    assert.ok(tick(project, orders, workersFile(), fakeProbes(), { record: false }).report.moves.some(m => m.tag === 'DRF1'));

    // `waiting-needs` order gets check 4 (`needs`) only in tick: cancelled need surfaces as a `preflight` problem without `file` hold.
    orders.add({ tag: 'CANC1', title: 'Cancelled', kind: 'code' });
    orders.act('CANC1', 'cancel');
    orders.add({ tag: 'WN1', title: 'Waiting on cancelled', kind: 'code', needs: ['CANC1'] });
    orders.act('WN1', 'queue');
    assert.equal(orders.stage(orders.get('WN1')).stage, 'waiting-needs');
    const wnReport = tick(project, orders, workersFile(), fakeProbes(), { record: false }).report;
    const wnProblem = wnReport.problems.find(p => p.kind === 'preflight' && p.tag === 'WN1');
    assert.ok(wnProblem);
    assert.match(wnProblem!.text, /Needed order "CANC1" is cancelled/);
    assert.doesNotMatch(wnProblem!.text, /work-order file/);
  } finally {
    closeStateStores();
    removeTreeSync(dir);
  }
});

test('5. CLI: alba orders preflight exits 1 with fix line when held, and exits 0 after the order is fixed', () => {
  const { dir } = tempOrders();
  try {
    git(dir, 'init', '-q', '-b', 'main');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = true;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');

    const cfgFile = projectDir(dir, 'orders:\n  preflight:\n    mode: hold\n');
    const orderPath = path.join(dir, 'orders', 'T1-app.md');
    writeFileSync(
      orderPath,
      '# T1\n\n## Task\nEdit `src/app.ts`.\n\n## Acceptance\n- App runs.\n\n## Paths\n- allow: docs/**\n',
    );
    assert.equal(alba(cfgFile, ['orders', 'add', 'T1', '--title', 'App change', '--kind', 'code', '--queue']).code, 0);

    const held = alba(cfgFile, ['orders', 'preflight', 'T1']);
    assert.equal(held.code, 1, held.err);
    assert.match(held.out, /\[hold\] paths:.*- allow: src\/app\.ts/);
    assert.match(held.out, /alba orders act T1 queue --override --note/);

    const heldJson = JSON.parse(alba(cfgFile, ['orders', 'preflight', 'T1', '--json']).out);
    assert.equal(heldJson.ok, false);
    assert.equal(heldJson.problems[0].fix, '- allow: src/app.ts');

    // Fix the order file and re-run CLI preflight -> exit 0!
    writeFileSync(
      orderPath,
      '# T1\n\n## Task\nEdit `src/app.ts`.\n\n## Acceptance\n- App runs.\n\n## Paths\n- allow: src/**\n',
    );
    const fixed = alba(cfgFile, ['orders', 'preflight', 'T1']);
    assert.equal(fixed.code, 0, fixed.err);
    assert.match(fixed.out, /T1: preflight ok/);
  } finally {
    closeStateStores();
    removeTreeSync(dir);
  }
});

test('6. config: bad orders keys and wrong types fail with the file name; omitting orders leaves project.orders undefined', () => {
  const { dir } = tempOrders();
  try {
    mkdirSync(path.join(dir, 'orders'), { recursive: true });
    const writeCfg = (name: string, extra: string) => {
      const f = path.join(dir, name);
      writeFileSync(f, `id: demo\nname: Demo\nroot: .\nwork_orders: orders\nstate_dir: state\n${extra}`);
      return f;
    };

    const plain = loadProject(writeCfg('plain.yaml', ''));
    assert.equal(plain.orders, undefined);

    const badCases: [string, string, RegExp][] = [
      ['bad-top.yaml', 'orders: 123\n', /bad-top\.yaml.*"orders" must be a mapping/],
      ['bad-key.yaml', 'orders:\n  unknown_block: {}\n', /bad-key\.yaml.*unknown key\(s\) under "orders": unknown_block/],
      ['bad-tpl.yaml', 'orders:\n  templates:\n    ue:\n      extra: ["x"]\n', /bad-tpl\.yaml.*unknown key\(s\) under "orders\.templates\.ue": extra/],
      ['bad-list.yaml', 'orders:\n  templates:\n    ue:\n      acceptance: "not-a-list"\n', /bad-list\.yaml.*"orders\.templates\.ue\.acceptance" must be a list/],
      ['bad-mode.yaml', 'orders:\n  preflight:\n    mode: block\n', /bad-mode\.yaml.*"orders\.preflight\.mode" must be hold, warn or off/],
      ['bad-bool.yaml', 'orders:\n  preflight:\n    run_checks: "yes"\n', /bad-bool\.yaml.*"orders\.preflight\.run_checks" must be true or false/],
      ['bad-timeout.yaml', 'orders:\n  preflight:\n    check_timeout_seconds: 0\n', /bad-timeout\.yaml.*"orders\.preflight\.check_timeout_seconds" must be a whole number >= 1/],
      ['bad-tool.yaml', 'orders:\n  preflight:\n    tool_dirs:\n      gen:\n        dir: ""\n', /bad-tool\.yaml.*"orders\.preflight\.tool_dirs\.gen\.dir" must be a non-empty folder path/],
    ];
    for (const [fileName, yaml, pattern] of badCases) {
      const filePath = writeCfg(fileName, yaml);
      assert.throws(() => loadProject(filePath), pattern);
    }
  } finally {
    closeStateStores();
    removeTreeSync(dir);
  }
});
