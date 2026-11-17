import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { LESSON_PACKS, lessonPacks } from '../src/config.ts';
import { lessonsForOrder, parseLessons, readLessons } from '../src/lessons/lessons.ts';
import { selectLessons } from '../src/lessons/select.ts';
import { formatLessonStats, lessonStats } from '../src/lessons/stats.ts';
import type { OrderDoc } from '../src/orders/model.ts';
import { Orders } from '../src/orders/service.ts';
import { stateStore } from '../src/orders/backend.ts';
import { startRun } from '../src/run/launch.ts';
import { buildPrompt, promptFor } from '../src/run/prompt.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { git } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

function makeProject(dir: string, lessonsCfg: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const root = path.join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  return validateProject({
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: path.join(dir, 'orders'),
    state_dir: path.join(dir, 'state'),
    lessons: lessonsCfg,
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
    ...extra,
  }, path.join(dir, 'alba.yaml'));
}

test('D1 fields and config: priority and added parsed, bad values rejected, readLessons sets path, pack musts set', () => {
  const parsed = parseLessons([
    '## L-CFG-01 Critical rule',
    '- tags: build',
    '- priority: MUST',
    '- added: 2026-11-05',
    '- level: checklist',
    '- rule: Always verify exit code.',
    '',
    '## L-CFG-02 Plain rule',
    '- tags: all',
    '- rule: Keep tree clean.',
  ].join('\n'), 'rules.md');

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].priority, 'must');
  assert.equal(parsed[0].added, '2026-11-05');
  assert.equal(parsed[0].level, 'checklist');
  assert.equal(parsed[0].path, undefined);
  assert.equal('priority' in parsed[1], false);
  assert.equal('added' in parsed[1], false);

  assert.throws(
    () => parseLessons('## L-BAD-01 Bad priority\n- tags: all\n- priority: urgent\n- rule: nope\n', 'bad.md'),
    /bad\.md \(L-BAD-01\): "priority" must be must, high, normal or low/,
  );
  assert.throws(
    () => parseLessons('## L-BAD-02 Bad date\n- tags: all\n- added: 2026-02-30\n- rule: nope\n', 'dates.md'),
    /dates\.md \(L-BAD-02\): "added" must be YYYY-MM-DD/,
  );

  const { dir } = tempOrders();
  const lessonsDir = path.join(dir, 'repo', 'docs', 'lessons');
  mkdirSync(lessonsDir, { recursive: true });
  const lessonFile = path.join(lessonsDir, 'core.md');
  writeFileSync(lessonFile, '## L-CORE-01 Check output\n- tags: all\n- priority: high\n- added: 2026-11-01\n- rule: Inspect output.\n');

  const defaults = makeProject(dir, { dir: lessonsDir });
  assert.equal(defaults.lessons?.max_bytes, 6000);
  assert.equal(defaults.lessons?.max_items, 15);
  assert.equal(defaults.lessons?.level_order, undefined);
  const loaded = readLessons(defaults.lessons, defaults);
  assert.equal(loaded[0].path, lessonFile);
  assert.equal(loaded[0].priority, 'high');
  assert.equal(loaded[0].added, '2026-11-01');

  const custom = makeProject(dir, { dir: lessonsDir, max_bytes: 0, max_items: 0, level_order: ['rule', 'checklist', 'record'] });
  assert.equal(custom.lessons?.max_bytes, 0);
  assert.equal(custom.lessons?.max_items, 0);
  assert.deepEqual(custom.lessons?.level_order, ['rule', 'checklist', 'record']);

  assert.throws(() => makeProject(dir, { dir: lessonsDir, max_bytes: -1 }), /"lessons\.max_bytes" must be a whole number >= 0/);
  assert.throws(() => makeProject(dir, { dir: lessonsDir, max_bytes: 1.5 }), /"lessons\.max_bytes" must be a whole number >= 0/);
  assert.throws(() => makeProject(dir, { dir: lessonsDir, max_items: -2 }), /"lessons\.max_items" must be a whole number >= 0/);
  assert.throws(() => makeProject(dir, { dir: lessonsDir, max_items: '10' }), /"lessons\.max_items" must be a whole number >= 0/);
  assert.throws(() => makeProject(dir, { dir: lessonsDir, level_order: 'rule' }), /"lessons\.level_order" must be a list of non-empty strings/);
  assert.throws(() => makeProject(dir, { dir: lessonsDir, level_order: ['rule', '  '] }), /"lessons\.level_order" must be a list of non-empty strings/);

  const mustIds: string[] = [];
  for (const pack of lessonPacks()) {
    const folder = path.join(LESSON_PACKS, pack);
    for (const f of readdirSync(folder)) {
      for (const l of parseLessons(readFileSync(path.join(folder, f), 'utf8'), f)) {
        if (l.priority) mustIds.push(`${l.id}:${l.priority}`);
      }
    }
  }
  assert.deepEqual(mustIds.sort(), ['ALBA-WIN-01:must', 'ALBA-WIN-03:must']);
});

test('D2 selection: 48-lesson synthetic library caps at 6000 bytes, ranks classes/levels/dates, keeps musts, and formats listed trailer', () => {
  const { dir, orders } = tempOrders();
  const root = path.join(dir, 'repo');
  const insideDir = path.join(root, 'docs', 'lessons');
  const outsideDir = path.join(dir, 'shared-pack');
  mkdirSync(insideDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const longLine = (idx: number, extra = 'verify target binary output deterministic') =>
    `  - Step ${idx}: ${extra} across clean build folders before reporting ready to review.`;

  const engineEntries: string[] = [];
  // Direct order-tag / kind matches (tag class 3) with tie-breakers on priority, level_order and added
  engineEntries.push(
    '## L-OWN-01 Older checklist\n- tags: shader\n- level: checklist\n- added: 2026-11-01\n- rule:\n' + [1, 2].map(i => longLine(i)).join('\n'),
    '## L-OWN-02 Newer checklist\n- tags: shader\n- level: checklist\n- added: 2026-11-10\n- rule:\n' + [1, 2].map(i => longLine(i)).join('\n'),
    '## L-OWN-03 Rule level wins\n- tags: shader\n- level: rule\n- added: 2026-11-01\n- rule:\n' + [1, 2].map(i => longLine(i)).join('\n'),
    '## L-OWN-04 High priority wins\n- tags: shader\n- priority: high\n- level: record\n- added: 2026-10-01\n- rule:\n' + [1, 2].map(i => longLine(i)).join('\n'),
  );
  // Mapped `engine` lessons (tag class 1): 20 engine-only, plus 10 art+engine and 6 sim+engine
  for (let i = 1; i <= 20; i++) {
    const id = `L-ENG-${String(i).padStart(2, '0')}`;
    engineEntries.push(`## ${id} Engine build rule ${i}\n- tags: engine\n- rule:\n${[1, 2, 3, 4].map(k => longLine(k, `engine check ${i}`)).join('\n')}`);
  }
  for (let i = 1; i <= 10; i++) {
    const id = `L-ART-${String(i).padStart(2, '0')}`;
    engineEntries.push(`## ${id} Art pipeline rule ${i}\n- tags: art, engine\n- rule:\n${[1, 2, 3].map(k => longLine(k, `art check ${i}`)).join('\n')}`);
  }
  for (let i = 1; i <= 6; i++) {
    const id = `L-SIM-${String(i).padStart(2, '0')}`;
    engineEntries.push(`## ${id} Sim determinism rule ${i}\n- tags: sim, engine\n- rule:\n${[1, 2, 3].map(k => longLine(k, `sim check ${i}`)).join('\n')}`);
  }
  writeFileSync(path.join(insideDir, 'engine.md'), engineEntries.join('\n\n') + '\n');

  // Run-tag (`codex`) and `all` lessons, including two `must` lessons on `all`
  const workerEntries = [
    '## L-ALL-01 Pipe encoding guard\n- tags: all\n- priority: must\n- rule: Never pipe non-ASCII text through a shell.',
    '## L-ALL-02 No desktop input\n- tags: all\n- priority: must\n- rule: Never automate mouse or keyboard input.',
    '## L-ALL-03 General hygiene A\n- tags: all\n- rule:\n' + [1, 2, 3].map(k => longLine(k, 'general A')).join('\n'),
    '## L-ALL-04 General hygiene B\n- tags: all\n- rule:\n' + [1, 2, 3].map(k => longLine(k, 'general B')).join('\n'),
    '## L-ALL-05 General hygiene C\n- tags: all\n- rule:\n' + [1, 2, 3].map(k => longLine(k, 'general C')).join('\n'),
    '## L-CDX-01 Codex shell quoting\n- tags: codex\n- rule: Quote paths cleanly in Codex runs.',
    '## L-CDX-02 Codex multi-tag\n- tags: codex, engine\n- rule: Prefer project scripts in Codex engine runs.',
  ];
  writeFileSync(path.join(outsideDir, 'workers.md'), workerEntries.join('\n\n') + '\n');

  const cfg = makeProject(dir, {
    dir: [insideDir, outsideDir],
    level_order: ['rule', 'checklist', 'record'],
    kind_tags: { ue: ['engine'] },
  });
  orders.add({ tag: 'UE1', title: 'Shader pass', kind: 'ue', tags: ['shader'] });
  const doc = orders.get('UE1');

  const sel = selectLessons(cfg, doc, { engine: 'codex-cli', os: 'windows' });
  const rendered = sel.section.join('\n');
  assert.equal(Buffer.byteLength(rendered, 'utf8'), sel.bytes);
  assert.ok(sel.bytes <= 6000, `expected <= 6000 bytes, got ${sel.bytes}`);
  assert.ok(sel.mounted.length <= 15, `expected <= 15 items, got ${sel.mounted.length}`);
  assert.equal(sel.over_budget, false);

  const mountedIds = sel.mounted.map(l => l.id);
  const allRankedIds = [...sel.mounted, ...sel.listed].map(l => l.id);
  // 4 + 20 + 10 + 6 + 7 = 47 matching candidates -> >= 32 listed when <= 15 mounted
  assert.equal(allRankedIds.length, 47);
  // (1) `must` first, and (6) later in workers.md puts L-ALL-02 (index 1) before L-ALL-01 (index 0)
  assert.deepEqual(mountedIds.slice(0, 2), ['L-ALL-02', 'L-ALL-01']);
  // (2)-(6) order-tag class 3 ranks above run-tag class 2, which ranks above mapped `engine` class 1, and `all` class 0 is last;
  // within class 3: high priority > level_order ('rule' > 'checklist') > newer `added`
  assert.deepEqual(allRankedIds.slice(2, 6), ['L-OWN-04', 'L-OWN-03', 'L-OWN-02', 'L-OWN-01']);
  // Run-tag class 2: L-CDX-02 matches 2 tags (codex + engine) before L-CDX-01 (codex only)
  assert.deepEqual(allRankedIds.slice(6, 8), ['L-CDX-02', 'L-CDX-01']);
  // Mapped class 1 comes before `all`-only class 0
  assert.deepEqual(allRankedIds.slice(-3), ['L-ALL-05', 'L-ALL-04', 'L-ALL-03']); // file recency puts later in file first among ties

  // Listed lines carry id, title and project-relative path (inside repo) or absolute path (outside repo); 31st+ becomes "and N more"
  assert.ok(sel.listed.length >= 31, `expected at least 31 listed lessons, got ${sel.listed.length}`);
  assert.ok(rendered.includes('Also on file; read the ones that touch your work:'));
  const alsoIdx = sel.section.indexOf('Also on file; read the ones that touch your work:');
  const trailer = sel.section.slice(alsoIdx + 1);
  const bullets = trailer.filter(l => l.startsWith('- '));
  assert.equal(bullets.length, 30);
  assert.match(bullets[0], /^- L-(?:ART|ENG|SIM)-\d\d .+ \(docs\/lessons\/engine\.md\)$/);
  assert.equal(trailer[trailer.length - 1], `and ${sel.listed.length - 30} more: alba lessons --order UE1`);

  // Remote run writes `(on the alba machine)` for files outside the project root, while keeping relative path inside the project
  const remoteSel = selectLessons(cfg, doc, { engine: 'codex-cli', os: 'windows', remote: true });
  const tightCfg = makeProject(dir, { dir: [insideDir, outsideDir], max_items: 3, kind_tags: { ue: ['engine'] } });
  const tightRemote = selectLessons(tightCfg, doc, { engine: 'codex-cli', os: 'windows', remote: true });
  assert.equal(tightRemote.mounted.length, 3);
  assert.ok(tightRemote.section.some(l => l.includes('L-CDX-01 Codex shell quoting (on the alba machine)')));
  assert.ok(remoteSel.section.some(l => l.includes('(docs/lessons/engine.md)')));

  // Skipping an oversized lesson lets a smaller later lesson mount; must lessons exceeding budget set over_budget: true
  const skipDir = path.join(dir, 'skip-lib');
  mkdirSync(skipDir, { recursive: true });
  writeFileSync(path.join(skipDir, 'skip.md'), [
    `## L-SKP-01 Huge lesson\n- tags: shader\n- priority: high\n- rule:\n${[1, 2, 3, 4, 5, 6].map(i => `  - ${'very-long-word-'.repeat(8)}${i}`).join('\n')}`,
    '## L-SKP-02 Tiny lesson\n- tags: shader\n- priority: low\n- rule: Short rule.',
  ].join('\n\n') + '\n');
  const skipCfg = makeProject(dir, { dir: skipDir, max_bytes: 320, max_items: 15 });
  const skipSel = selectLessons(skipCfg, doc, {});
  assert.deepEqual(skipSel.mounted.map(l => l.id), ['L-SKP-02']);
  assert.deepEqual(skipSel.listed.map(l => l.id), ['L-SKP-01']);
  assert.ok(skipSel.bytes <= 320);

  const overDir = path.join(dir, 'over-lib');
  mkdirSync(overDir, { recursive: true });
  writeFileSync(path.join(overDir, 'over.md'), '## L-OVR-01 Must 1\n- tags: all\n- priority: must\n- rule: First mandatory rule.\n\n## L-OVR-02 Must 2\n- tags: all\n- priority: must\n- rule: Second mandatory rule.\n');
  const overCfg = makeProject(dir, { dir: overDir, max_bytes: 120, max_items: 1 });
  const overSel = selectLessons(overCfg, doc, {});
  assert.deepEqual(overSel.mounted.map(l => l.id), ['L-OVR-02', 'L-OVR-01']);
  assert.equal(overSel.over_budget, true);

  // (7) ID tie-breaker when two files each hold a single identical-score lesson at file index 0
  const tieDir = path.join(dir, 'tie-lib');
  mkdirSync(tieDir, { recursive: true });
  writeFileSync(path.join(tieDir, 'first.md'), '## L-TIE-10 Ten\n- tags: shader\n- added: 2026-11-05\n- rule: Rule ten.\n');
  writeFileSync(path.join(tieDir, 'second.md'), '## L-TIE-02 Two\n- tags: shader\n- added: 2026-11-05\n- rule: Rule two.\n');
  const tieCfg = makeProject(dir, { dir: tieDir });
  assert.deepEqual(selectLessons(tieCfg, doc, {}).mounted.map(l => l.id), ['L-TIE-02', 'L-TIE-10']);
});

test('D2/D3 run tags and D2 no-limit byte-for-byte compatibility', () => {
  const { dir, orders } = tempOrders();
  const lessonsDir = path.join(dir, 'repo', 'lessons');
  mkdirSync(lessonsDir, { recursive: true });
  writeFileSync(path.join(lessonsDir, 'run.md'), [
    '## L-RUN-01 Codex specific\n- tags: codex\n- rule: Use codex flags.',
    '## L-RUN-02 Claude specific\n- tags: claude\n- rule: Use claude flags.',
    '## L-RUN-03 Windows specific\n- tags: windows\n- rule: Watch Windows file locks.',
    '## L-RUN-04 Family specific\n- tags: gpt-family\n- rule: Keep concise structured steps.',
    '## L-RUN-05 Core task\n- tags: task\n- priority: high\n- rule: Follow the work order.',
    '## L-RUN-00 Alpha all\n- tags: all\n- rule: Commit cleanly.',
  ].join('\n\n') + '\n');

  const cfg = makeProject(dir, { dir: lessonsDir });
  orders.add({ tag: 'T1', title: 'Task one', kind: 'task' });
  const doc = orders.get('T1');
  writeFileSync(path.join(dir, 'orders', 'T1-one.md'), '# T1\n');

  const codexWin = selectLessons(cfg, doc, { engine: 'codex-cli', family: 'gpt-family', os: 'windows' }).mounted.map(l => l.id);
  const claudeLinux = selectLessons(cfg, doc, { engine: 'claude-cli', os: 'linux' }).mounted.map(l => l.id);
  assert.ok(codexWin.includes('L-RUN-01'), 'codex-cli matches codex');
  assert.ok(!codexWin.includes('L-RUN-02'));
  assert.ok(codexWin.includes('L-RUN-03'), 'windows machine matches windows');
  assert.ok(codexWin.includes('L-RUN-04'), 'model_family matches');
  assert.ok(claudeLinux.includes('L-RUN-02'), 'claude-cli matches claude');
  assert.ok(!claudeLinux.includes('L-RUN-01'), 'claude-cli does not get codex lesson');
  assert.ok(!claudeLinux.includes('L-RUN-03'), 'linux machine does not get windows lesson');

  // `alba prompt` follows the worker's engine and the machine registry's OS
  const workersFile = path.join(dir, 'workers.yaml');
  const machinesFile = path.join(dir, 'machines.yaml');
  writeFileSync(workersFile, [
    'workers:',
    '  - id: w-codex',
    '    engine: codex-cli',
    '    launch: { program: codex, args: [exec, "{prompt_file}"] }',
    '  - id: w-claude',
    '    engine: claude-cli',
    '    launch: { program: claude, args: ["{prompt_file}"] }',
  ].join('\n') + '\n');
  writeFileSync(machinesFile, [
    'machines:',
    '  - id: dev-linux',
    '    name: Dev Linux',
    '    os: linux',
    '    connect: { local: true }',
  ].join('\n') + '\n');

  const cliDir = path.join(dir, 'cli');
  const cliProject = projectDir(cliDir, `workers: ${workersFile.replace(/\\/g, '/')}\nmachines: ${machinesFile.replace(/\\/g, '/')}\nlessons:\n  dir: ${lessonsDir.replace(/\\/g, '/')}\n`);
  writeFileSync(path.join(cliDir, 'orders', 'T1-one.md'), '# T1\n');
  assert.equal(alba(cliProject, ['orders', 'add', 'T1', '--title', 'Task', '--kind', 'task']).code, 0);
  const noWorkerPrompt = alba(cliProject, ['prompt', 'T1']).out;
  assert.doesNotMatch(noWorkerPrompt, /L-RUN-01/);
  assert.doesNotMatch(noWorkerPrompt, /L-RUN-03/);
  const codexLinuxPrompt = alba(cliProject, ['prompt', 'T1', '--worker', 'w-codex']).out;
  assert.match(codexLinuxPrompt, /L-RUN-01 Codex specific/);
  assert.doesNotMatch(codexLinuxPrompt, /L-RUN-03 Windows specific/, 'local machine in machines.yaml is linux');
  const claudeLinuxPrompt = alba(cliProject, ['prompt', 'T1', '--worker', 'w-claude']).out;
  assert.match(claudeLinuxPrompt, /L-RUN-02 Claude specific/);
  assert.doesNotMatch(claudeLinuxPrompt, /L-RUN-01 Codex specific/);

  // No-limit mode: max_bytes: 0 and max_items: 0 equals today's buildPrompt output byte for byte
  const unlimitedCfg = makeProject(dir, { dir: lessonsDir, max_bytes: 0, max_items: 0 });
  const unlimitedSel = selectLessons(unlimitedCfg, doc, { engine: 'codex-cli', family: 'gpt-family', os: 'windows' });
  const fromSelection = promptFor(unlimitedCfg.work_orders, doc, unlimitedSel, [], unlimitedCfg.lessons?.max_rule_lines);
  const legacyPrompt = buildPrompt({
    orderFile: `${unlimitedCfg.work_orders.replace(/\\/g, '/')}/T1-one.md`,
    lessons: lessonsForOrder(unlimitedCfg, doc),
    recovery: false,
    lessonLines: unlimitedCfg.lessons?.max_rule_lines,
  });
  assert.equal(fromSelection, legacyPrompt);
  assert.equal(Buffer.compare(Buffer.from(fromSelection, 'utf8'), Buffer.from(legacyPrompt, 'utf8')), 0);
});

test('D4 & 4.6 recording and alba orders show: Run.lessons, prompt_bytes sum to file size, lessons-mounted event, handoff and CLI show', () => {
  const { dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'demo\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  const lessonsDir = path.join(root, 'docs', 'lessons');
  mkdirSync(lessonsDir, { recursive: true });
  writeFileSync(path.join(lessonsDir, 'rules.md'), [
    '## L-REC-01 Must rule\n- tags: all\n- priority: must\n- rule: Keep build deterministic.',
    '## L-REC-02 Task rule\n- tags: task\n- priority: high\n- rule: Test the real entry point.',
    '## L-REC-03 Extra rule\n- tags: all\n- rule: Leave the worktree clean.',
  ].join('\n\n') + '\n');

  const rulesFile = path.join(dir, 'role-rules.md');
  writeFileSync(rulesFile, 'Follow role instructions carefully.\n');
  const workersFile = path.join(dir, 'workers.yaml');
  writeFileSync(workersFile, [
    'workers:',
    '  - id: w1',
    '    engine: codex-cli',
    '    launch: { program: stub-worker, args: ["{prompt_file}"] }',
    '  - id: w2',
    '    engine: claude-cli',
    '    launch: { program: stub-worker, args: ["{prompt_file}"] }',
  ].join('\n') + '\n');

  const projectFile = path.join(dir, 'alba.yaml');
  writeFileSync(projectFile, [
    'id: demo',
    'name: Demo',
    `root: ${root.replace(/\\/g, '/')}`,
    `work_orders: ${path.join(dir, 'orders').replace(/\\/g, '/')}`,
    `state_dir: ${path.join(dir, 'state').replace(/\\/g, '/')}`,
    `workers: ${workersFile.replace(/\\/g, '/')}`,
    'roles:',
    '  default:',
    '    default: true',
    `    rules: ${rulesFile.replace(/\\/g, '/')}`,
    'lessons:',
    `  dir: ${lessonsDir.replace(/\\/g, '/')}`,
    '  max_items: 2',
    'dispatch:',
    `  worktree_parent: ${path.join(dir, 'trees').replace(/\\/g, '/')}`,
    '  base_ref: refs/heads/main',
  ].join('\n') + '\n');
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  writeFileSync(path.join(dir, 'orders', 'T1-work.md'), '# Work order T1\n');

  const project = validateProject({
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: path.join(dir, 'orders'),
    state_dir: path.join(dir, 'state'),
    workers: workersFile,
    roles: { default: { default: true, rules: rulesFile } },
    lessons: { dir: lessonsDir, max_items: 2 },
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
  }, projectFile);
  const orders = new Orders(stateStore(project));
  const workers = validateWorkers({
    workers: [
      { id: 'w1', engine: 'codex-cli', launch: { program: 'stub-worker', args: ['{prompt_file}'] } },
      { id: 'w2', engine: 'claude-cli', launch: { program: 'stub-worker', args: ['{prompt_file}'] } },
    ],
  }, workersFile);
  const probes = {
    now: () => new Date('2026-11-17T00:00:00Z'),
    runCommand: () => '[]',
    freeRamGb: () => 32,
    worktrees: () => [],
    gitActivity: () => ({}),
    fileTime: () => undefined,
    isAlive: () => false,
    tail: () => 'log tail line',
    readText: () => undefined,
    spawnDetached: () => 4242,
  } as unknown as Probes;

  orders.add({ tag: 'T1', title: 'Recorded work', kind: 'task' });
  orders.act('T1', 'queue');
  const res1 = startRun({ project, orders, workers, probes }, 'T1', 'w1');
  assert.equal(res1.mode, 'start');

  const run1 = orders.get('T1').runs[0];
  assert.ok(run1.lessons);
  // L-REC-01 is must; L-REC-02 matches order kind `task` (class 3); L-REC-03 is `all` only (class 0)
  assert.deepEqual(run1.lessons.mounted, ['L-REC-01', 'L-REC-02']);
  assert.deepEqual(run1.lessons.listed, ['L-REC-03']);
  assert.ok(run1.lessons.bytes > 0);

  const pb1 = run1.prompt_bytes!;
  assert.ok(pb1);
  assert.equal(pb1.file, 'prompt');
  assert.ok(pb1.rules > 0 && pb1.lessons === run1.lessons.bytes && pb1.order > 0 && pb1.alba > 0);
  assert.equal(pb1.rules + pb1.lessons + pb1.skills + pb1.notes + pb1.order + pb1.alba, pb1.total);
  assert.equal(pb1.total, statSync(run1.prompt_file!).size);

  const events1 = orders.store.events({ tag: 'T1' }).filter(e => e.type === 'lessons-mounted');
  assert.equal(events1.length, 1);
  assert.deepEqual(events1[0].data, { run: 'r1', mounted: ['L-REC-01', 'L-REC-02'], listed: ['L-REC-03'], bytes: run1.lessons.bytes });

  // End r1 with capacity (leaves T1 queued) and start r2 as a hand-over rotation to w2
  orders.runEnd('T1', 'capacity');
  const res2 = startRun({ project, orders, workers, probes }, 'T1', 'w2', { rotate: { from: 'w1', reason: 'its usage window was used up' } });
  assert.equal(res2.mode, 'start');

  const run2 = orders.get('T1').runs[1];
  assert.ok(run2.handoff_file);
  assert.ok(run2.lessons);
  assert.deepEqual(run2.lessons.mounted, ['L-REC-01', 'L-REC-02']);
  const pb2 = run2.prompt_bytes!;
  assert.equal(pb2.file, 'handoff');
  assert.equal(pb2.rules + pb2.lessons + pb2.skills + pb2.notes + pb2.order + pb2.alba, pb2.total);
  assert.equal(pb2.total, statSync(run2.handoff_file!).size);

  const events2 = orders.store.events({ tag: 'T1' }).filter(e => e.type === 'lessons-mounted');
  assert.equal(events2.length, 2);
  assert.equal(events2[1].data?.run, 'r2');

  // Resumed answer continuation records mounted: [] and accurate prompt_bytes
  orders.patchRun('T1', 'r2', { session: 'sess-2' });
  orders.report('T1', { status: 'waiting', summary: 'Need choice', question: 'Which mode?', evidence: [], commits: [] });
  orders.runEnd('T1', 'completed');
  orders.act('T1', 'answer', { note: 'Use fast mode.' });
  const res3 = startRun({ project, orders, workers, probes }, 'T1', 'w2');
  assert.equal(res3.mode, 'start');
  assert.equal(res3.resumed, true);
  const run3 = orders.get('T1').runs[2];
  assert.deepEqual(run3.lessons, { mounted: [], listed: [], bytes: 0 });
  const pb3 = run3.prompt_bytes!;
  assert.equal(pb3.file, 'prompt');
  assert.equal(pb3.lessons, 0);
  assert.equal(pb3.order, 0);
  assert.ok(pb3.notes > 0);
  assert.equal(pb3.rules + pb3.lessons + pb3.skills + pb3.notes + pb3.order + pb3.alba, pb3.total);
  assert.equal(pb3.total, statSync(run3.prompt_file!).size);
  const events3 = orders.store.events({ tag: 'T1' }).filter(e => e.type === 'lessons-mounted');
  assert.equal(events3.length, 3);
  assert.deepEqual(events3[2].data, { run: 'r3', mounted: [], listed: [], bytes: 0 });

  // 4.6: `alba orders show` run as a child process prints the prompt breakdown line for each run
  const shown = alba(projectFile, ['orders', 'show', 'T1']);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /r1\s+prompt \d+\.\d KB: lessons \d+\.\d \(2 in, 1 listed\) \| rules \d+(?:\.\d)? \| skills \d+(?:\.\d)? \| notes 0 \| order \d+\.\d \| alba \d+\.\d/);
  assert.match(shown.out, /r2\s+prompt \d+\.\d KB: lessons \d+\.\d \(2 in, 1 listed\)/);
});

test('D5 stats: synthetic docs produce exact counts and every label, and legacy runs read from prompt_file', () => {
  const { dir } = tempOrders();
  const lessonsDir = path.join(dir, 'repo', 'lessons');
  const runsDir = path.join(dir, 'state', 'runs');
  mkdirSync(lessonsDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  writeFileSync(path.join(lessonsDir, 'stats.md'), [
    '## L-HI-01 Helps first pass\n- tags: ue\n- rule: Check before submitting.',
    '## L-LO-01 Hurts first pass\n- tags: ue\n- rule: Over-constrained step.',
    '## L-NO-01 Within noise\n- tags: ue\n- rule: Minor formatting rule.',
    '## L-EV-01 Always mounted\n- tags: art\n- rule: Check colour space.',
    '## L-FEW-01 Rare tag\n- tags: rare\n- rule: Rarely triggered.',
  ].join('\n\n') + '\n');

  const now = new Date('2026-11-17T12:00:00Z');
  const at = '2026-11-15T10:00:00Z';

  function makeOrder(
    tag: string,
    kind: string,
    mounted: string[] | { promptFileIds: string[]; listedIds?: string[] },
    verdict: 'approve' | 'rework' | 'broken' | 'rework-then-approve' | 'open',
  ): OrderDoc {
    const promptPath = path.join(runsDir, `${tag}-r1.prompt.md`);
    let runLessons: NonNullable<OrderDoc['runs'][number]['lessons']> | undefined;
    if (Array.isArray(mounted)) {
      runLessons = { mounted, listed: [], bytes: 120 };
    } else {
      const lines = [
        `Read the UTF-8 file orders/${tag}.md in full and follow it exactly.`,
        '',
        '## Lessons from earlier work',
        '',
        'These rules come from mistakes made before. Follow them.',
        '',
        ...mounted.promptFileIds.map(id => `- ${id} Title: Follow ${id}.`),
        ...(mounted.listedIds?.length ? ['', 'Also on file; read the ones that touch your work:', ...mounted.listedIds.map(id => `- ${id} Listed (lessons/stats.md)`)] : []),
        '',
        '## How to finish: the report block',
      ];
      writeFileSync(promptPath, lines.join('\n') + '\n');
    }

    if (verdict === 'rework-then-approve') {
      return {
        version: 1,
        order: { tag, title: tag, kind, needs: [], created: at, updated: at },
        runs: [
          { id: 'r1', seq: 1, worker: 'w1', started: at, ended: at, outcome: 'completed', ...(runLessons ? { lessons: runLessons } : { prompt_file: promptPath }) },
          { id: 'r2', seq: 3, worker: 'w1', started: at, ended: at, outcome: 'completed', lessons: { mounted: Array.isArray(mounted) ? mounted : mounted.promptFileIds, listed: [], bytes: 120 } },
        ],
        reports: [],
        actions: [
          { seq: 2, at, kind: 'rework', note: 'fix it' },
          { seq: 4, at, kind: 'approve' },
        ],
      };
    }

    const broken = verdict === 'broken';
    const open = verdict === 'open';
    return {
      version: 1,
      order: { tag, title: tag, kind, needs: [], created: at, updated: at },
      runs: [{
        id: 'r1',
        seq: 1,
        worker: 'w1',
        started: at,
        ...(open ? {} : { ended: at }),
        ...(open ? {} : { outcome: broken ? 'failed' : 'completed' }),
        ...(broken ? { missing_report: true } : {}),
        ...(runLessons ? { lessons: runLessons } : { prompt_file: promptPath }),
      }],
      reports: [],
      actions: verdict === 'approve' || verdict === 'rework' ? [{ seq: 2, at, kind: verdict }] : [],
    };
  }

  const docs: OrderDoc[] = [];
  // 16 `ue` orders:
  // - 8 carry L-HI-01 (7/8 = 87.5% accepted first pass; 1 unjudged open order also carries it -> runs=9, judged=8)
  // - 8 do not carry L-HI-01 (1/8 = 12.5% accepted first pass; includes brokenRun and rework-then-approve) -> diff +75.0 pts >= 1/sqrt(8)=35.4 pts -> `higher with it`
  // - L-LO-01 has the inverse assignment on those 16 orders -> diff -75.0 pts -> `lower with it`
  // - L-NO-01 is split 4/8 (50%) with vs 4/8 (50%) without -> diff 0.0 pts < 35.4 pts -> `no effect visible`
  // - L-FEW-01 is carried in only 2 orders -> `too few runs`
  for (let i = 0; i < 8; i++) {
    const ids = ['L-HI-01', ...(i % 2 === 0 ? ['L-NO-01'] : []), ...(i < 2 ? ['L-FEW-01'] : [])];
    // Read first two from legacy prompt_file (with an `Also on file` L-LO-01 that must NOT count as mounted!)
    const source = i < 2 ? { promptFileIds: ids, listedIds: ['L-LO-01'] } : ids;
    docs.push(makeOrder(`U${i + 1}`, 'ue', source, i < 7 ? 'approve' : 'rework'));
  }
  docs.push(makeOrder('U9', 'ue', ['L-HI-01'], 'open'));
  for (let i = 0; i < 7; i++) {
    const ids = ['L-LO-01', ...(i < 3 ? ['L-NO-01'] : [])];
    const verdict = i === 0 ? 'approve' : i === 1 ? 'broken' : i === 2 ? 'rework-then-approve' : 'rework';
    docs.push(makeOrder(`U${10 + i}`, 'ue', ids, verdict));
  }

  // 6 `art` orders: all carry L-EV-01 -> `in every run of this kind` (must not mix with `ue` orders!)
  for (let i = 0; i < 6; i++) {
    docs.push(makeOrder(`A${i + 1}`, 'art', ['L-EV-01'], i < 4 ? 'approve' : 'rework'));
  }

  const cfg = makeProject(dir, { dir: lessonsDir });
  const report = lessonStats(cfg, docs, { since: '30d', now });
  assert.equal(report.runs_from_prompt_files, 2);
  // 8 + 1 + (6 single + 1 two-run rework-then-approve = 8) + 6 = 23 runs
  assert.equal(report.runs_in_window, 23);

  const byId = new Map(report.items.map(r => [r.id, r]));
  const hi = byId.get('L-HI-01')!;
  assert.equal(hi.label, 'higher with it');
  assert.deepEqual(hi.with, { runs: 9, judged: 8, accepted_first_pass: 7, first_pass_share: 7 / 8 });
  assert.deepEqual(hi.without, { runs: 8, judged: 8, accepted_first_pass: 1, first_pass_share: 1 / 8 });
  assert.equal(hi.diff_points, 75);

  const lo = byId.get('L-LO-01')!;
  assert.equal(lo.label, 'lower with it');
  assert.deepEqual(lo.with, { runs: 8, judged: 8, accepted_first_pass: 1, first_pass_share: 1 / 8 });
  assert.deepEqual(lo.without, { runs: 9, judged: 8, accepted_first_pass: 7, first_pass_share: 7 / 8 });
  assert.equal(lo.diff_points, -75);

  const no = byId.get('L-NO-01')!;
  assert.equal(no.label, 'no effect visible');
  assert.equal(no.with.judged, 8);
  assert.equal(no.without.judged, 8);

  const ev = byId.get('L-EV-01')!;
  assert.equal(ev.label, 'in every run of this kind');
  assert.deepEqual(ev.kinds, ['art']);
  assert.equal(ev.with.judged, 6);
  assert.equal(ev.without.runs, 0);

  const few = byId.get('L-FEW-01')!;
  assert.equal(few.label, 'too few runs');
  assert.equal(few.with.judged, 2);

  const formatted = formatLessonStats(report);
  assert.match(formatted, /2 from prompt files/);
  for (const expected of ['higher with it', 'lower with it', 'no effect visible', 'in every run of this kind', 'too few runs']) {
    assert.ok(formatted.includes(expected), `formatted table should contain "${expected}"`);
  }

  // CLI smoke check for `alba lessons stats --json` and `--kind`
  const cliFolder = path.join(dir, 'stats-cli');
  const cliFile = projectDir(cliFolder, `lessons:\n  dir: ${lessonsDir.replace(/\\/g, '/')}\n`);
  const cliOrders = new Orders(stateStore(validateProject({
    id: 'demo', name: 'Demo', root: cliFolder, work_orders: path.join(cliFolder, 'orders'), state_dir: path.join(cliFolder, 'state'),
    lessons: { dir: lessonsDir },
  }, cliFile)));
  cliOrders.add({ tag: 'S1', title: 'Sample', kind: 'art' });
  const cliOut = alba(cliFile, ['lessons', 'stats', '--kind', 'art', '--json']);
  assert.equal(cliOut.code, 0, cliOut.err);
  const parsedCli = JSON.parse(cliOut.out);
  assert.equal(parsedCli.kind, 'art');
  assert.ok(Array.isArray(parsedCli.items));
});
