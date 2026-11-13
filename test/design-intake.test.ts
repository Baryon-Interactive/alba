import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeStateStores, stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { loadProject, validateProject } from '../src/config.ts';
import { chunkMarkdown, checkIntake, getDesignDoc, importDesignDoc, intakeReview, listDesignDocs } from '../src/design/docs.ts';
import { reviewIntakeSystems } from '../src/design/intake-review.ts';
import { designHistory, readLibrary } from '../src/design/library.ts';
import { acceptDesignChanges } from '../src/design/worker.ts';
import { createIntake } from '../src/cli/intake.ts';
import { approve } from '../src/run/review.ts';
import { prepareRunWorktree } from '../src/run/launch.ts';
import { lintDelivery } from '../src/producer/delivery-lint.ts';
import { trialAcceptance } from '../src/review/acceptance.ts';
import { checkDesign } from '../src/design/read.ts';

after(() => closeStateStores());

function intakeFixture(prefix: string, configuredAccept = false) {
  const source = path.resolve('examples/intake-demo');
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  cpSync(source, root, { recursive: true });
  if (configuredAccept) writeFileSync(path.join(root, 'alba.yaml'), `${readFileSync(path.join(root, 'alba.yaml'), 'utf8')}\naccept:\n  steps:\n    - { name: smoke, command: ["node", "-e", "process.exit(0)"], timeout_minutes: 1 }\n`, 'utf8');
  const project = loadProject(path.join(root, 'alba.yaml'));
  const orders = new Orders(stateStore(project));
  mkdirSync(path.join(root, '.alba'), { recursive: true });
  cpSync(path.join(root, 'answers', 'alba'), path.join(root, '.alba'), { recursive: true });
  return { root, project, orders };
}

function git(root: string, ...args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }

function initGit(root: string) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '.');
  git(root, 'add', '-f', '.alba');
  git(root, 'commit', '-qm', 'base');
}

function ready(orders: Orders, tag: string) {
  orders.act(tag, 'queue');
  orders.runStart(tag, { worker: 'test-worker' });
  orders.runEnd(tag);
  orders.report(tag, { status: 'ready', summary: 'ready', evidence: [], commits: [] });
}

function createReadyGitIntake(prefix: string, configuredAccept = false) {
  const fixture = intakeFixture(prefix, configuredAccept);
  initGit(fixture.root);
  const tag = `${prefix.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)}-INTAKE`;
  createIntake(fixture.project, fixture.orders, { tag });
  fixture.orders.setGit(tag, { branch: 'main', worktree: fixture.root });
  ready(fixture.orders, tag);
  return { ...fixture, tag };
}

function fileList(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'state' || entry.name === 'worker-tree') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

test('intake outputs are read from the order worktree, not the project root', () => {
  const { root, project, orders } = intakeFixture('alba-tree-');
  const tag = 'INTAKE-TREE', worktree = path.join(root, 'worker-tree');
  mkdirSync(worktree);
  createIntake(project, orders, { tag });
  orders.setGit(tag, { worktree, branch: 'worker-tree' });
  rmSync(path.join(root, '.alba'), { recursive: true, force: true });
  cpSync(path.join(root, 'answers', 'alba'), path.join(worktree, '.alba'), { recursive: true });
  ready(orders, tag);
  assert.equal(existsSync(path.join(root, '.alba')), false);
  assert.deepEqual(intakeReview(project, orders, tag).systems.map(system => system.id).sort(), ['RUN', 'UI']);
  reviewIntakeSystems(project, orders, tag, { accept: ['RUN'] });
  assert.ok(readLibrary(project).system.some(system => system.code === 'RUN'));
  assert.equal(checkIntake(project, orders).ok, true);
  reviewIntakeSystems(project, orders, tag, { accept: ['UI'] });
  assert.throws(() => approve(project, orders, tag), error => !/still has intake systems awaiting review/.test(String(error)));
});

test('intake approval skips intake change sets in design-changesets', () => {
  const { project, orders, tag } = createReadyGitIntake('alba-skip-');
  orders.report(tag, { status: 'ready', summary: 'ready', evidence: [], commits: [], design_changes: ['.alba/design/changes/intake-RUN.json', '.alba/design/changes/intake-UI.json'] });
  reviewIntakeSystems(project, orders, tag, { accept: ['RUN'] });
  reviewIntakeSystems(project, orders, tag, { drop: ['UI'], note: 'UI is deferred.' });
  assert.equal(approve(project, orders, tag).accept, 'no accept command configured');
  const skipped = orders.store.events({ tag }).find(event => event.type === 'accept-step' && event.data?.name === 'design-changesets' && event.data?.status === 'skipped');
  assert.ok(skipped);
  assert.match(String(skipped?.data?.reason), /per-system intake review/);
  assert.equal(designHistory(project, 'RUN').length, 1);
  assert.equal(designHistory(project, 'UI').length, 0);
  assert.equal(readLibrary(project).system.some(system => system.code === 'UI'), false);
});

test('rejecting intake systems requires a note and records one rework', () => {
  const { project, orders } = intakeFixture('alba-rework-'), tag = 'INTAKE-REWORK';
  createIntake(project, orders, { tag });
  ready(orders, tag);
  assert.throws(() => reviewIntakeSystems(project, orders, tag, { reject: ['RUN'] }), /non-empty note/);
  const before = orders.store.events({ tag }).length;
  assert.throws(() => reviewIntakeSystems(project, orders, tag, { reject: ['MISSING'], note: 'Unknown system.' }), /404|No intake change set/);
  assert.equal(orders.store.events({ tag }).length, before);
  assert.throws(() => reviewIntakeSystems(project, orders, tag, { drop: ['MISSING'], note: 'Unknown system.' }), /404|No intake change set/);
  assert.equal(orders.store.events({ tag }).length, before);
  reviewIntakeSystems(project, orders, tag, { reject: ['RUN', 'UI'], note: 'Clarify both system contracts.' });
  const reworks = orders.store.events({ tag }).filter(event => event.type === 'action-rework');
  assert.equal(reworks.length, 1);
  assert.match(String(reworks[0].data?.note), /RUN/);
  assert.match(String(reworks[0].data?.note), /UI/);
});

test('approval waits for rejected systems until a new run delivers them', () => {
  const { project, orders, tag } = createReadyGitIntake('alba-wait-');
  reviewIntakeSystems(project, orders, tag, { reject: ['RUN'], note: 'Redo RUN.' });
  assert.throws(() => approve(project, orders, tag), /still has intake systems awaiting review: RUN/);
  orders.runStart(tag, { worker: 'test-worker' });
  orders.runEnd(tag);
  orders.report(tag, { status: 'ready', summary: 'redelivered', evidence: [], commits: [] });
  assert.equal(intakeReview(project, orders, tag).systems.find(system => system.id === 'RUN')?.status, 'pending');
  reviewIntakeSystems(project, orders, tag, { accept: ['RUN', 'UI'] });
  assert.equal(approve(project, orders, tag).accept, 'no accept command configured');
  assert.equal(orders.stage(orders.get(tag)).stage, 'merged');
});

test('dropping an intake system needs a note and lets approval proceed', () => {
  const { project, orders, tag } = createReadyGitIntake('alba-drop-');
  assert.throws(() => reviewIntakeSystems(project, orders, tag, { drop: ['UI'] }), /non-empty note/);
  reviewIntakeSystems(project, orders, tag, { accept: ['RUN'] });
  reviewIntakeSystems(project, orders, tag, { drop: ['UI'], note: 'Out of scope for this release.' });
  assert.equal(approve(project, orders, tag).accept, 'no accept command configured');
  assert.equal(orders.stage(orders.get(tag)).stage, 'merged');
  assert.equal(readLibrary(project).system.some(system => system.code === 'UI'), false);
});

test('acceptance runs intake-check for intake orders', () => {
  const { root, project, orders, tag } = createReadyGitIntake('alba-check-', true);
  lintDelivery(project, orders, tag);
  const delivered = orders.store.events({ tag }).find(event => event.type === 'accept-step' && event.data?.name === 'intake-check');
  assert.equal(delivered?.data?.status, 'passed');
  const trial = trialAcceptance(project, orders, tag, true);
  assert.equal(trial.steps.find(step => step.name === 'intake-check')?.status, 'passed');
  reviewIntakeSystems(project, orders, tag, { accept: ['RUN', 'UI'] });
  const coverage = path.join(root, '.alba', 'intake', 'coverage.json');
  const report = JSON.parse(readFileSync(coverage, 'utf8'));
  report.blocks.pop();
  writeFileSync(coverage, JSON.stringify(report));
  git(root, 'add', '-f', '.alba/intake/coverage.json');
  git(root, 'commit', '-qm', 'remove coverage block');
  const failed = trialAcceptance(project, orders, tag, true);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.steps.find(step => step.name === 'intake-check')?.issues?.some(issue => /content@1/.test(issue)));
  assert.throws(() => approve(project, orders, tag), /Acceptance failed/);
});

test('intake-check runs for projects without an accept pipeline', () => {
  const { root, project, orders, tag } = createReadyGitIntake('alba-nopipe-');
  assert.equal(project.accept, undefined);
  lintDelivery(project, orders, tag);
  const passed = trialAcceptance(project, orders, tag, true);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.steps.find(step => step.name === 'intake-check')?.status, 'passed');
  reviewIntakeSystems(project, orders, tag, { accept: ['RUN', 'UI'] });
  const coverage = path.join(root, '.alba', 'intake', 'coverage.json');
  const report = JSON.parse(readFileSync(coverage, 'utf8'));
  report.blocks.pop();
  writeFileSync(coverage, JSON.stringify(report));
  git(root, 'add', '-f', '.alba/intake/coverage.json');
  git(root, 'commit', '-qm', 'remove coverage block');
  const failed = trialAcceptance(project, orders, tag, true);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.steps.find(step => step.name === 'intake-check')?.issues?.some(issue => /Block .* has no coverage/.test(issue)));
  assert.throws(() => approve(project, orders, tag), /Acceptance failed/);
});

test('intake-check does not rewrite stored document paths or versions', () => {
  const { root, project, orders, tag } = createReadyGitIntake('alba-readonly-');
  const beforeDocs = listDesignDocs(project);
  const db = (stateStore(project) as import('../src/orders/sqlite-store.ts').SqliteStore).db;
  const beforeRows = db.prepare('SELECT id, path, doc_order, status FROM design_docs ORDER BY id').all();
  const beforeVersions = db.prepare('SELECT doc_id, version, body, blocks, hash, created, author FROM design_doc_versions ORDER BY doc_id, version').all();
  const baseFile = path.join(root, 'docs', 'base.md'), baseBody = readFileSync(baseFile, 'utf8');
  git(root, 'switch', '-qc', 'delivery');
  writeFileSync(baseFile, `${baseBody}\nChanged on the delivery branch.\n`);
  git(root, 'add', 'docs/base.md');
  git(root, 'commit', '-qm', 'change source document');
  git(root, 'switch', '-q', 'main');
  assert.equal(readFileSync(baseFile, 'utf8'), baseBody);
  orders.setGit(tag, { branch: 'delivery', worktree: root });
  const trial = trialAcceptance(project, orders, tag, true);
  assert.equal(trial.status, 'passed', JSON.stringify(trial));
  assert.deepEqual(db.prepare('SELECT id, path, doc_order, status FROM design_docs ORDER BY id').all(), beforeRows);
  assert.deepEqual(db.prepare('SELECT doc_id, version, body, blocks, hash, created, author FROM design_doc_versions ORDER BY doc_id, version').all(), beforeVersions);
  assert.deepEqual(listDesignDocs(project).map(doc => [doc.id, doc.version, doc.path]), beforeDocs.map(doc => [doc.id, doc.version, doc.path]));
});

test('rules without sources or with unresolvable sources fail intake check', () => {
  const { root, project, orders } = intakeFixture('alba-sources-');
  const file = path.join(root, '.alba', 'design', 'changes', 'intake-RUN.json');
  const set = JSON.parse(readFileSync(file, 'utf8'));
  const rule = set.changes.find((change: { kind: string }) => change.kind === 'rule');
  rule.fields.sources = [];
  writeFileSync(file, JSON.stringify(set));
  assert.ok(checkIntake(project, orders).issues.some(issue => issue.code === 'rule-sources'));
  rule.fields.sources = [{ kind: 'doc', ref: 'missing@1#block' }];
  writeFileSync(file, JSON.stringify(set));
  assert.ok(checkIntake(project, orders).issues.some(issue => issue.code === 'source-unresolved'));
  rule.fields.sources = [{ kind: 'decision', ref: 'D-NOT-FOUND' }];
  writeFileSync(file, JSON.stringify(set));
  assert.ok(checkIntake(project, orders).issues.some(issue => issue.code === 'source-unresolved' && /decision/.test(issue.message)));
});

test('supersession within the same document fails intake check', () => {
  const { root, project, orders } = intakeFixture('alba-same-doc-');
  const file = path.join(root, '.alba', 'intake', 'coverage.json');
  const report = JSON.parse(readFileSync(file, 'utf8'));
  report.blocks[2] = { ref: report.blocks[2].ref, superseded: report.blocks[2].ref };
  writeFileSync(file, JSON.stringify(report));
  assert.ok(checkIntake(project, orders).issues.some(issue => issue.code === 'coverage-order'));
});

test('question lines must name an existing gap id', () => {
  const cases = [
    { text: '- This question has no identifier.\n', code: 'question-gap', match: /no gap id/ },
    { text: '- UI-G99 is unknown.\n', code: 'question-gap', match: /unknown gap UI-G99/ },
    { text: 'No open questions.\n', code: 'question-gap', match: /UI-G01/ },
  ];
  for (const [index, current] of cases.entries()) {
    const { root, project, orders } = intakeFixture(`alba-questions-${index}-`);
    writeFileSync(path.join(root, '.alba', 'intake', 'questions.md'), current.text);
    const result = checkIntake(project, orders);
    assert.ok(result.issues.some(issue => issue.code === current.code && current.match.test(issue.message)), current.text);
  }
  const { root, project, orders } = intakeFixture('alba-questions-valid-');
  writeFileSync(path.join(root, '.alba', 'intake', 'questions.md'), '- UI-G01: This gap needs a product decision.\n');
  assert.equal(checkIntake(project, orders).ok, true);
});

test('chunking keeps block ids when an earlier paragraph changes and handles Chinese headings', () => {
  const before = chunkMarkdown('# \u6838\u5fc3\u5faa\u73af\n\n\u524d\u9762\u7684\u6bb5\u843d\u3002\n\n## \u89c4\u5219\n\n\u540e\u9762\u7684\u6bb5\u843d\u3002\n\n### \u8be6\u7ec6\n\n\u66f4\u591a\u5185\u5bb9\u3002');
  const after = chunkMarkdown('# \u6838\u5fc3\u5faa\u73af\n\n\u6539\u8fc7\u7684\u524d\u9762\u6bb5\u843d\u3002\n\n## \u89c4\u5219\n\n\u540e\u9762\u7684\u6bb5\u843d\u3002\n\n### \u8be6\u7ec6\n\n\u66f4\u591a\u5185\u5bb9\u3002');
  assert.notEqual(after[0].id, before[0].id);
  assert.deepEqual(after.slice(1).map(block => block.id), before.slice(1).map(block => block.id));
  assert.deepEqual(after.map(block => block.heading_path), [['\u6838\u5fc3\u5faa\u73af'], ['\u6838\u5fc3\u5faa\u73af', '\u89c4\u5219'], ['\u6838\u5fc3\u5faa\u73af', '\u89c4\u5219', '\u8be6\u7ec6']]);
});

test('run start writes design snapshot and blocks.json into an intake worktree', () => {
  const { root, project, orders } = intakeFixture('alba-snapshot-');
  const tag = 'INTAKE-SNAPSHOT', worktree = path.join(root, 'worker-tree');
  mkdirSync(worktree);
  createIntake(project, orders, { tag });
  orders.setGit(tag, { worktree, branch: 'worker-tree' });
  const beforeRoot = fileList(root);
  const docs = listDesignDocs(project).filter(doc => doc.status !== 'retired');
  prepareRunWorktree(project, orders, tag, worktree);
  const snapshot = JSON.parse(readFileSync(path.join(worktree, '.alba', 'intake', 'blocks.json'), 'utf8'));
  assert.deepEqual(snapshot.documents.map((doc: { id: string; version: number; order: number; status: string }) => [doc.id, doc.version, doc.order, doc.status]), docs.map(doc => [doc.id, doc.version, doc.order, doc.status]));
  assert.equal(snapshot.blocks.length, docs.reduce((sum, doc) => sum + doc.blocks.length, 0));
  for (const doc of docs) for (const block of doc.blocks) {
    const found = snapshot.blocks.find((entry: { ref: string }) => entry.ref === `${doc.id}@${doc.version}#${block.id}`);
    assert.deepEqual([found.heading_path, found.text], [block.heading_path, block.text]);
    assert.deepEqual([found.heading_path, found.text], [getDesignDoc(project, doc.id, doc.version).blocks.find(item => item.id === block.id)?.heading_path, getDesignDoc(project, doc.id, doc.version).blocks.find(item => item.id === block.id)?.text]);
  }
  assert.equal(existsSync(path.join(worktree, '.alba', 'design', 'snapshot.json')), true);
  assert.deepEqual(fileList(root), beforeRoot);
  assert.equal(existsSync(path.join(root, '.alba', 'intake', 'blocks.json')), false);
});

test('intake end to end', () => {
  const { root, project, orders } = intakeFixture('alba-e2e-');
  initGit(root);
  const tag = 'INTAKE-E2E', worktree = path.join(root, 'worker-tree');
  git(root, 'worktree', 'add', '-q', '-b', 'intake-worker', worktree, 'main');
  const before = existsSync(path.join(root, '.alba'));
  createIntake(project, orders, { tag });
  assert.equal(existsSync(path.join(root, '.alba')), before);
  orders.setGit(tag, { worktree, branch: 'intake-worker' });
  prepareRunWorktree(project, orders, tag, worktree);
  cpSync(path.join(root, 'answers', 'alba'), path.join(worktree, '.alba'), { recursive: true });
  git(worktree, 'add', '-f', '.alba');
  git(worktree, 'commit', '-qm', 'deliver intake outputs');
  orders.runStart(tag, { worker: 'test-worker' });
  orders.runEnd(tag);
  orders.report(tag, { status: 'ready', summary: 'ready', evidence: [], commits: [git(worktree, 'rev-parse', 'HEAD')] });
  lintDelivery(project, orders, tag);
  assert.ok(orders.store.events({ tag }).some(event => event.type === 'accept-step' && event.data?.name === 'intake-check' && event.data?.status === 'passed'));
  reviewIntakeSystems(project, orders, tag, { accept: ['RUN'] });
  reviewIntakeSystems(project, orders, tag, { reject: ['UI'], note: 'Revise the interface mapping.' });
  assert.equal(orders.store.events({ tag }).filter(event => event.type === 'action-rework').length, 1);
  assert.throws(() => approve(project, orders, tag), /still has intake systems awaiting review: UI/);
  orders.runStart(tag, { worker: 'test-worker' });
  orders.runEnd(tag);
  orders.report(tag, { status: 'ready', summary: 'redelivered', evidence: [], commits: [git(worktree, 'rev-parse', 'HEAD')] });
  lintDelivery(project, orders, tag);
  assert.equal(intakeReview(project, orders, tag).systems.find(system => system.id === 'UI')?.status, 'pending');
  reviewIntakeSystems(project, orders, tag, { accept: ['UI'] });
  git(root, 'merge', '--no-ff', '--no-edit', 'intake-worker');
  orders.setGit(tag, { worktree: root, branch: 'main' });
  assert.equal(approve(project, orders, tag).accept, 'no accept command configured');
  assert.equal(orders.stage(orders.get(tag)).stage, 'merged');
  assert.equal(checkDesign(project, orders).ok, true);
  const library = readLibrary(project);
  assert.ok(library.system.some(system => system.code === 'RUN'));
  assert.ok(library.system.some(system => system.code === 'UI'));
  assert.equal(designHistory(project, 'RUN').length, 1);
  assert.equal(designHistory(project, 'UI').length, 1);
});

test('design document blocks keep content-based ids and database imports deduplicate versions', () => {
  const first = chunkMarkdown('# Core\n\nA stable paragraph.\n\n## Rules\n\nA rule.');
  const second = chunkMarkdown('# Core\n\nA stable paragraph.\n\n## Rules\n\nA rule.\n\n');
  assert.deepEqual(second.map(b => b.id), first.map(b => b.id));
  const root = mkdtempSync(path.join(tmpdir(), 'alba-docs-')), docs = path.join(root, 'docs'); mkdirSync(docs); mkdirSync(path.join(root, 'orders'));
  const md = path.join(docs, 'draft.md'); writeFileSync(md, '# Draft\n\nOne paragraph.\n');
  const projectFile = path.join(root, 'alba.yaml'); writeFileSync(projectFile, 'id: docs\nname: Docs\nroot: .\nwork_orders: orders\nstate_dir: state\nstate: { backend: sqlite }\n');
  const project = validateProject({ id: 'docs', name: 'Docs', root: '.', work_orders: 'orders', state_dir: 'state', state: { backend: 'sqlite' } }, projectFile);
  const firstVersion = importDesignDoc(project, md, 'draft');
  const same = importDesignDoc(project, md, 'draft');
  assert.equal(firstVersion.version, 1); assert.equal(same.version, 1);
  writeFileSync(md, '# Draft\n\nChanged paragraph.\n');
  assert.equal(importDesignDoc(project, md, 'draft').version, 2);
  assert.equal(getDesignDoc(project, 'draft', 1).blocks[0].text, 'One paragraph.');
  assert.equal(listDesignDocs(project).length, 1);
});

test('intake check accepts the standard example and catches an unclassified block', () => {
  const source = path.resolve('examples/intake-demo'), root = mkdtempSync(path.join(tmpdir(), 'alba-intake-'));
  cpSync(source, root, { recursive: true });
  const project = loadProject(path.join(root, 'alba.yaml'));
  const orders = new Orders(stateStore(project));
  const answer = path.join(root, 'answers', 'alba'); mkdirSync(path.join(root, '.alba'), { recursive: true }); cpSync(answer, path.join(root, '.alba'), { recursive: true });
  const good = checkIntake(project, orders); assert.equal(good.ok, true, JSON.stringify(good.issues));
  const coverage = path.join(root, '.alba', 'intake', 'coverage.json'); const parsed = JSON.parse(readFileSync(coverage, 'utf8')); parsed.blocks.pop(); writeFileSync(coverage, JSON.stringify(parsed));
  const bad = checkIntake(project, orders); assert.equal(bad.ok, false); assert.ok(bad.issues.some(i => i.code === 'unclassified-block'));
});

test('intake check rejects invalid proposals, too few targets, bad supersession, unknown mappings and question gaps', () => {
  const source = path.resolve('examples/intake-demo'), root = mkdtempSync(path.join(tmpdir(), 'alba-intake-failures-')); cpSync(source, root, { recursive: true });
  const project = loadProject(path.join(root, 'alba.yaml')), orders = new Orders(stateStore(project)), answer = path.join(root, 'answers', 'alba'); mkdirSync(path.join(root, '.alba'), { recursive: true }); cpSync(answer, path.join(root, '.alba'), { recursive: true });
  const changes = path.join(root, '.alba', 'design', 'changes', 'intake-RUN.json'), set = JSON.parse(readFileSync(changes, 'utf8'));
  set.changes = set.changes.filter((change: { kind: string; id: string }) => change.kind !== 'target' || change.id === 'RUN-T01'); writeFileSync(changes, JSON.stringify(set));
  let result = checkIntake(project, orders); assert.ok(result.issues.some(i => i.code === 'few-targets'));
  set.changes = JSON.parse(readFileSync(path.join(source, 'answers', 'alba', 'design', 'changes', 'intake-RUN.json'), 'utf8')).changes; set.changes.find((change: { kind: string }) => change.kind === 'rule').fields.sources[0].ref = 'base@1#missing'; writeFileSync(changes, JSON.stringify(set));
  result = checkIntake(project, orders); assert.ok(result.issues.some(i => i.code === 'changeset-invalid'));
  set.changes.find((change: { kind: string }) => change.kind === 'rule').fields.sources[0].ref = 'base@1#b2c8ddc41fde8'; writeFileSync(changes, JSON.stringify(set));
  const coverage = path.join(root, '.alba', 'intake', 'coverage.json'), report = JSON.parse(readFileSync(coverage, 'utf8')); report.blocks[0] = { ref: report.blocks[0].ref, superseded: 'base@1#b2c8ddc41fde8' }; report.blocks[1].mapped = ['UNKNOWN']; report.blocks[2] = { ref: report.blocks[2].ref, unclear: 'RUN-G99' }; writeFileSync(coverage, JSON.stringify(report)); writeFileSync(path.join(root, '.alba', 'intake', 'questions.md'), '# Questions\n\nGAP-NOPE needs an answer.\n');
  result = checkIntake(project, orders); assert.ok(result.issues.some(i => i.code === 'coverage-order')); assert.ok(result.issues.some(i => i.code === 'coverage-entity')); assert.ok(result.issues.some(i => i.code === 'coverage-gap')); assert.ok(result.issues.some(i => i.code === 'question-gap'));
});

test('the intake order carries absolute paths to the formats and the example, the command to run and the commit step', () => {
  const { root, project, orders } = intakeFixture('alba-intake-prompt-');
  const tag = createIntake(project, orders, { tag: 'PROMPT-INTAKE' }) as string;
  const file = readdirSync(project.work_orders).find(f => f.startsWith(`${tag}-`))!;
  const body = readFileSync(path.join(project.work_orders, file), 'utf8');
  const alba = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
  for (const rel of ['docs/libraries/027-design-library.md', 'docs/libraries/030-design-intake.md', 'schema/intake-coverage.schema.json', 'examples/intake-demo/answers/alba/']) {
    assert.ok(body.includes(`${alba}/${rel}`), `${rel} is named with its absolute path`);
    assert.ok(existsSync(path.join(alba, rel)), `${rel} exists`);
  }
  assert.ok(body.includes(`intake check --dir .alba`));
  const quoted = (p: string) => /[\s"]/.test(p) ? `"${p}"` : p;
  const command = `node ${quoted(`${alba}/bin/alba.mjs`)} --project ${quoted(path.resolve(root, 'alba.yaml').split(path.sep).join('/'))} intake check --dir .alba`;
  assert.ok(body.includes(command), command);
  assert.match(body, /git add -f \.alba\/intake\/coverage\.json \.alba\/intake\/questions\.md \.alba\/design\/changes\/intake-\*\.json/);
  assert.ok(!/\{(alba_root|alba_command|min_targets|tag)\}/.test(body), 'every placeholder is filled');
});

test('intake check --dir is read from the current folder, as the worker runs it in its worktree', () => {
  const { root, project } = intakeFixture('alba-intake-dir-');
  const worktree = path.join(root, 'worker-tree');
  mkdirSync(path.join(worktree, '.alba'), { recursive: true });
  cpSync(path.join(root, 'answers', 'alba'), path.join(worktree, '.alba'), { recursive: true });
  rmSync(path.join(root, '.alba'), { recursive: true, force: true });
  const main = path.resolve(import.meta.dirname, '../src/cli/main.ts');
  const run = (cwd: string) => {
    try { return { code: 0, out: execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', main, '--project', project.file, 'intake', 'check', '--dir', '.alba', '--json'], { cwd, encoding: 'utf8', env: { ...process.env, ALBA_LANG: 'en' } }) }; }
    catch (e) { return { code: (e as { status: number }).status, out: String((e as { stdout: string }).stdout) }; }
  };
  const inTree = run(worktree);
  assert.equal(inTree.code, 0, inTree.out);
  assert.equal(JSON.parse(inTree.out).ok, true);
  assert.notEqual(run(root).code, 0, 'from the project root the same --dir finds no outputs');
});
