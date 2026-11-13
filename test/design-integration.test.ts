import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { designFixture, initialDesign } from './fixtures/design.ts';
import { alba } from './cli-helper.ts';
import { fixture as apiFixture } from './api-fixture.ts';
import { applyChangeSet, designHistory, readLibrary, requireDesign, stableJson } from '../src/design/library.ts';
import { acceptDesignChanges, writeDesignSnapshot } from '../src/design/worker.ts';
import { callProducerTool } from '../src/producer/mcp.ts';
import { approve } from '../src/run/review.ts';
import { trialAcceptance } from '../src/review/acceptance.ts';
import { syncOrders } from '../src/sync/sync.ts';
import { validateProject } from '../src/config.ts';
import { checkDesign, mergedPaths } from '../src/design/read.ts';
import { designTemplate } from '../src/design/template.ts';
import { humanAction } from '../src/service/actions.ts';
import { formatDecisions, readLedger } from '../src/ledger/decisions.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const proposal = (base_version = 1) => ({ title: 'Clarify income', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version, fields: { text: 'Credit income exactly once per turn.' } }] });

test('real CLI reads, conflict refusal, checks and producer named queries on a fixture', t => {
  const f = designFixture();
  applyChangeSet(f.project, f.orders, initialDesign());
  const show = alba(f.file, ['design', 'show', 'ECON']);
  assert.equal(show.code, 0, show.err);
  assert.equal(JSON.parse(show.out).params[0].value, 7);
  const file = path.join(f.root, 'proposal.json');
  writeFileSync(file, JSON.stringify(proposal(8)));
  const conflict = alba(f.file, ['design', 'apply', file]);
  assert.equal(conflict.code, 1); assert.match(conflict.err, /base_version 8, current version 1/);
  const check = alba(f.file, ['design', 'check', '--json']);
  assert.equal(check.code, 0, check.err);
  assert.equal(JSON.parse(check.out).issues.find((i: any) => i.code === 'unregistered-numbers').count, 2);
  const read = (query: string) => callProducerTool(f.project, f.orders, 'producer_read', { kind: 'design', query }) as any;
  assert.equal(read('open-gaps-without-order').value[0].id, 'ECON-G01');
  assert.equal(read('failing-targets').value[0].id, 'ECON-T01');
  assert.equal(read('unmeasured-targets').value[0].id, 'ECON-T02');
  assert.deepEqual(read('milestone').value.criteria.map((c: any) => c.status), ['failing', 'unmeasured', 'manual']);
  assert.deepEqual(read('stale-systems').value, []);
  assert.equal((callProducerTool(f.project, f.orders, 'producer_read', { kind: 'design', filters: { system: 'ECON', kind: 'param' } }) as any).value.length, 1);
  t.diagnostic(JSON.stringify({ show: JSON.parse(show.out), conflict: conflict.err.split('\n')[0], check: JSON.parse(check.out), producer: read('open-gaps-without-order') }));
  writeFileSync(path.join(f.root, 'content/economy.json'), '{"gold":"wrong type"}');
  assert.equal(alba(f.file, ['design', 'check', '--json']).code, 1);
  assert.equal((callProducerTool({ ...f.project, design: undefined }, f.orders, 'producer_read', { kind: 'design' }) as any).available, false);
});

test('design API uses write token, dry runs, conflicts, reads and disabled guidance', async () => {
  const f = await apiFixture({ populate: false, project: (_dir, root) => {
    mkdirSync(path.join(root, 'content')); writeFileSync(path.join(root, 'content/economy.json'), '{"gold":7}'); writeFileSync(path.join(root, 'rules.md'), '# Rules');
    return { state: { backend: 'sqlite' }, design: { enabled: true, data_roots: ['content/**/*.json'] } };
  } });
  assert.equal((await f.post('/api/design/changesets', { changeset: initialDesign() })).status, 401);
  assert.equal((await f.get('/api/projects')).body[0].design.enabled, true);
  const dry = await f.write('/api/design/changesets', { changeset: initialDesign(), dryRun: true });
  assert.equal(dry.status, 200); assert.equal(dry.body.applied, false);
  assert.deepEqual((await f.get('/api/design/systems')).body, []);
  const applied = await f.write('/api/design/changesets', { changeset: initialDesign() });
  assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.applied, true);
  assert.equal((await f.get('/api/design/show/ECON')).body.params[0].value, 7);
  assert.equal((await f.get('/api/design/history/ECON')).body[0].by, 'web');
  assert.equal((await f.get('/api/design/export')).body.param.length, 1);
  assert.equal((await f.write('/api/design/changesets', { changeset: proposal(9) })).status, 409);
  const bad = { title: 'Bad pointer', changes: [{ op: 'update', kind: 'param', id: 'ECON.income.base', base_version: 1, fields: { location: { file: 'content/economy.json', pointer: '/missing' } } }] };
  assert.equal((await f.write('/api/design/changesets', { changeset: bad })).status, 400);
  const off = await apiFixture({ populate: false });
  assert.equal((await off.get('/api/projects')).body[0].design.enabled, false);
  assert.match((await off.get('/api/design/systems')).body.note, /enabled/);
});

function delivery(pipeline: boolean, inherited = false) {
  const f = designFixture();
  if (inherited) {
    mkdirSync(path.join(f.root, '.alba/design/changes'), { recursive: true });
    writeFileSync(path.join(f.root, '.alba/design/changes/baseline.json'), JSON.stringify(initialDesign()));
  }
  // Operational state and order notes are outside Git's delivery scope.
  writeFileSync(path.join(f.root, '.gitignore'), 'state/\norders/\nalba.yaml\n');
  git(f.root, 'init', '-qb', 'main'); git(f.root, 'config', 'user.name', 'Test'); git(f.root, 'config', 'user.email', 'test@example.com');
  git(f.root, 'add', '.');
  if (inherited) git(f.root, 'add', '-f', '.alba/design/changes/baseline.json');
  git(f.root, 'commit', '-qm', 'Initial game');
  const worktree = path.join(f.root, 'worker');
  git(f.root, 'worktree', 'add', '-qb', 'delivery', worktree);
  // Ignore the nested fixture worktree in the base checkout.
  writeFileSync(path.join(f.root, '.git/info/exclude'), 'worker/\n');
  writeFileSync(path.join(worktree, 'content/economy.json'), '{"gold":9}');
  mkdirSync(path.join(worktree, 'src/economy'), { recursive: true }); writeFileSync(path.join(worktree, 'src/economy/income.ts'), 'export const income = 9;\n');
  git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'Income adjustment');
  applyChangeSet(f.project, f.orders, initialDesign());
  if (pipeline) f.project.accept = validateProject({ id: 'fixture', name: 'Fixture', root: f.root, work_orders: 'orders', state_dir: 'state', accept: { steps: [] } }, f.file).accept;
  f.orders.add({ tag: 'DEMO', title: 'Income delivery', kind: 'code', branch: 'delivery', worktree });
  writeDesignSnapshot(f.project, worktree);
  const snapshot = JSON.parse(readFileSync(path.join(worktree, '.alba/design/snapshot.json'), 'utf8'));
  assert.equal(snapshot.resolved_values[0].value, 9);
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  const file = path.join(worktree, '.alba/design/changes/income.json'); writeFileSync(file, JSON.stringify(proposal()));
  f.orders.runStart('DEMO', { worker: 'fake' }); f.orders.runEnd('DEMO');
  f.orders.report('DEMO', { status: 'ready', summary: 'Income works', evidence: [], commits: [git(worktree, 'rev-parse', 'HEAD')], design_changes: ['.alba/design/changes/income.json'] });
  return { ...f, worktree, proposalFile: file };
}

for (const pipeline of [false, true]) test(`${pipeline ? 'pipeline' : 'manual'} approval applies worker proposal after merge with order history`, () => {
  const f = delivery(pipeline);
  if (!pipeline) git(f.root, 'merge', '--no-ff', '-m', 'Merge delivery', 'delivery');
  // Approval must resolve gameplay JSON in the merged root, despite a changed worker copy.
  writeFileSync(path.join(f.worktree, 'content/economy.json'), '{"gold":"worker-only edit"}');
  approve(f.project, f.orders, 'DEMO', 'Reviewed income');
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
  const h = designHistory(f.project, 'ECON-R01').at(-1)!;
  assert.equal(h.by, 'accept'); assert.equal(h.order, 'DEMO'); assert.equal(h.after.version, 2);
  assert.equal((callProducerTool(f.project, f.orders, 'producer_read', { kind: 'design', query: 'stale-systems' }) as any).value[0].orders[0], 'DEMO');
  const approvedAt = f.orders.get('DEMO').actions.at(-1)!.at;
  const verifiedAt = new Date(Date.parse(approvedAt) - 1000 + 14 * 3600000).toISOString().replace('Z', '+14:00');
  applyChangeSet(f.project, f.orders, { title: 'Prior verification with a timezone offset', changes: [{ op: 'update', kind: 'system', id: 'ECON', base_version: 1, fields: { verified_commit: 'abc1234', verified_at: verifiedAt } }] });
  assert.equal((callProducerTool(f.project, f.orders, 'producer_read', { kind: 'design', query: 'stale-systems' }) as any).value[0].orders[0], 'DEMO');
});

test('design refusal rolls the pipeline merge back, blocks note sync, supports fixed retry and explicit override', () => {
  const f = delivery(true), before = git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(f.proposalFile, JSON.stringify(proposal(9)));
  assert.throws(() => approve(f.project, f.orders, 'DEMO'), /Design change sets refused after merge/);
  // The library changes, the record and the approval are one transaction: refused together, so the merge is rolled back too.
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  assert.equal(existsSync(path.join(f.project.work_orders, 'DEMO.accept.md')), false);
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  assert.equal(readLibrary(f.project).rule[0].version, 1);
  assert.ok(f.orders.store.events().some(e => e.type === 'accept-step' && e.data?.status === 'failed' && String(e.data.reason).includes('current version 1')));
  writeFileSync(path.join(f.project.work_orders, 'DEMO.accept.md'), '# Handwritten note');
  syncOrders(f.project, f.orders); assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  rmSync(path.join(f.project.work_orders, 'DEMO.accept.md'));
  writeFileSync(f.proposalFile, JSON.stringify(proposal())); approve(f.project, f.orders, 'DEMO', 'Fixed design proposal');
  assert.notEqual(git(f.root, 'rev-parse', 'HEAD'), before); assert.equal(readLibrary(f.project).rule[0].version, 2);
  const skip = delivery(true); writeFileSync(skip.proposalFile, JSON.stringify(proposal(9)));
  assert.throws(() => approve(skip.project, skip.orders, 'DEMO'), /Design change sets refused/);
  assert.throws(() => approve(skip.project, skip.orders, 'DEMO', 'short', undefined, true), /override approval needs a note of at least 10 characters/);
  approve(skip.project, skip.orders, 'DEMO', 'Skip this obsolete proposal after review', undefined, true);
  assert.equal(skip.orders.stage(skip.orders.get('DEMO')).stage, 'merged');
  assert.ok(skip.orders.store.events().some(e => e.type === 'accept-step' && e.data?.status === 'skipped' && e.data.note));
  const first = delivery(true); writeFileSync(first.proposalFile, JSON.stringify(proposal(9)));
  approve(first.project, first.orders, 'DEMO', 'Skip obsolete design proposal after review', undefined, true);
  assert.equal(first.orders.stage(first.orders.get('DEMO')).stage, 'merged');
});

test('A-7: committed change sets are applied from the merge, and a worktree edit after the trial cannot reach the library', () => {
  const f = delivery(true);
  // Committed on the branch: the merge has it; the worker's later, uncommitted edit of the same file is ignored.
  git(f.worktree, 'add', '-f', '.alba/design/changes/income.json'); git(f.worktree, 'commit', '-qm', 'Design proposal');
  f.orders.runStart('DEMO', { worker: 'fake' }); f.orders.runEnd('DEMO');
  f.orders.report('DEMO', { status: 'ready', summary: 'Income works', evidence: [], commits: [git(f.worktree, 'rev-parse', 'HEAD')], design_changes: ['.alba/design/changes/income.json'] });
  writeFileSync(f.proposalFile, JSON.stringify({ title: 'Edited after review', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version: 1, fields: { text: 'Edited in the worktree after the review.' } }] }));
  approve(f.project, f.orders, 'DEMO', 'Reviewed income');
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
  assert.equal(readLibrary(f.project).rule[0].text, 'Credit income exactly once per turn.');

  // Not committed: the text the trial took is what is applied; an edit after the trial makes the inputs stale.
  const g = delivery(true);
  const trial = trialAcceptance(g.project, g.orders, 'DEMO');
  assert.equal(trial.status, 'passed');
  writeFileSync(g.proposalFile, JSON.stringify({ title: 'Edited after the trial', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version: 1, fields: { text: 'Edited after the trial.' } }] }));
  approve(g.project, g.orders, 'DEMO', 'Reviewed income');
  const trials = g.orders.store.events({ tag: 'DEMO' }).filter(e => e.type === 'accept-trial');
  assert.ok(trials.length >= 2 && trials.at(-1)!.data!.fingerprint !== trial.fingerprint, 'the edit made a new trial, not the old one');
  assert.equal(readLibrary(g.project).rule[0].text, 'Edited after the trial.');
});

test('A-9: a failure after the push restores the remote branch as well as the local one', () => {
  const f = delivery(true);
  const remote = path.join(f.root, '..', `${path.basename(f.root)}-remote.git`);
  git(f.root, 'init', '-q', '--bare', remote);
  git(f.root, 'remote', 'add', 'origin', remote);
  git(f.root, 'push', '-q', '-u', 'origin', 'main');
  const before = git(f.root, 'rev-parse', 'HEAD');
  f.project.accept = { ...f.project.accept!, push: true };
  // Refused by the design step, which runs after the push.
  writeFileSync(f.proposalFile, JSON.stringify(proposal(9)));
  assert.throws(() => approve(f.project, f.orders, 'DEMO'), /Design change sets refused/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), before);
  assert.ok(f.orders.store.events({ tag: 'DEMO' }).some(e => e.type === 'accept-push-reverted'));
  assert.equal(existsSync(path.join(f.project.state_dir, 'acceptance', 'merge-journal.json')), false);
  // Fixed: merged, pushed and approved.
  writeFileSync(f.proposalFile, JSON.stringify(proposal()));
  approve(f.project, f.orders, 'DEMO', 'Fixed design proposal');
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), git(f.root, 'rev-parse', 'HEAD'));
  rmSync(remote, { recursive: true, force: true });
});

test('automatic backups retain the newest thirty complete exports', () => {
  const f = designFixture(); applyChangeSet(f.project, f.orders, initialDesign());
  for (let version = 1; version <= 31; version++) applyChangeSet(f.project, f.orders, { title: 'Update summary', changes: [{ op: 'update', kind: 'system', id: 'ECON', base_version: version, fields: { summary: `Economy revision ${version}` } }] });
  const dirs = readdirSync(f.project.design!.export_dir);
  assert.equal(dirs.length, 30);
  assert.ok(dirs.every(d => JSON.parse(readFileSync(path.join(f.project.design!.export_dir, d, 'system.json'), 'utf8'))[0].version >= 3));
});

test('manual fast-forward approval retains all delivery paths across multiple commits', () => {
  const f = delivery(false);
  writeFileSync(path.join(f.worktree, 'extra.md'), '# Later change');
  git(f.worktree, 'add', '.'); git(f.worktree, 'commit', '-qm', 'Second delivery commit');
  git(f.root, 'merge', '--ff-only', 'delivery');
  assert.ok(mergedPaths(f.project, 'delivery').includes('src/economy/income.ts'));
  assert.ok(mergedPaths(f.project, 'delivery').includes('extra.md'));
  approve(f.project, f.orders, 'DEMO');
  assert.equal((callProducerTool(f.project, f.orders, 'producer_read', { kind: 'design', query: 'stale-systems' }) as any).value[0].orders[0], 'DEMO');
});

test('the complete template validates with invented ledger data and rejects unresolved references atomically', () => {
  const f = designFixture();
  mkdirSync(path.join(f.root, 'docs')); writeFileSync(path.join(f.root, 'docs/design.md'), '# Economy');
  writeFileSync(path.join(f.root, 'content/economy.json'), '{"income":{"base":7}}');
  writeFileSync(path.join(f.root, 'decisions.md'), '| Id | Decision |\n| --- | --- |\n| D9001 | Income is credited once per turn. |\n');
  const project = validateProject({ id: 'fixture', name: 'Fixture', root: f.root, work_orders: 'orders', state_dir: 'state', state: { backend: 'sqlite' }, design: { enabled: true }, decisions: { file: 'decisions.md', id_column: 1, text_column: 2 } }, f.file);
  applyChangeSet(project, f.orders, designTemplate());
  assert.equal(readLibrary(project).decision_link[0].decision, 'D9001');
  assert.equal((callProducerTool(project, f.orders, 'producer_read', { kind: 'design', design_kind: 'decision_link' }) as any).value[0].entity, 'ECON-R01');
  assert.equal((callProducerTool(project, f.orders, 'producer_read', { kind: 'design', filters: { system: 'ECON', kind: 'decision_link' } }) as any).value[0].entity, 'ECON-R01');
  const history = designHistory(project).length;
  for (const fields of [{ sources: [] }, { sources: [{ kind: 'decision', ref: 'D9999' }] }, { implementation: 'done' }, { evidence: [{ kind: 'order', ref: 'MISSING' }] }, { evidence: [{ kind: 'file', ref: '../outside.md' }] }]) {
    assert.throws(() => applyChangeSet(project, f.orders, { title: 'Invalid rule', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version: 1, fields }] }));
  }
  assert.throws(() => applyChangeSet(project, f.orders, { title: 'Stored value forbidden', changes: [{ op: 'update', kind: 'param', id: 'ECON.income.base', base_version: 1, fields: { value: 8 } }] }), /unknown or read-only/);
  assert.equal(designHistory(project).length, history);
});

test('approval applies multiple files atomically and corrected retries remain idempotent', () => {
  const f = delivery(false);
  git(f.root, 'merge', '--no-ff', '-m', 'Merge delivery', 'delivery');
  const second = path.join(f.worktree, '.alba/design/changes/gap.json');
  const gap = (base_version: number) => ({ title: 'Assign gap', changes: [{ op: 'update', kind: 'gap', id: 'ECON-G01', base_version, fields: { order: 'DEMO' } }] });
  writeFileSync(second, JSON.stringify(gap(9)));
  f.orders.report('DEMO', { status: 'ready', summary: 'Design proposals', evidence: [], commits: [], design_changes: ['.alba/design/changes/income.json', '.alba/design/changes/gap.json'] });
  const before = designHistory(f.project).length, exports = readdirSync(f.project.design!.export_dir);
  assert.throws(() => approve(f.project, f.orders, 'DEMO'), /base_version 9/);
  assert.equal(readLibrary(f.project).rule[0].version, 1);
  assert.equal(designHistory(f.project).length, before);
  assert.deepEqual(readdirSync(f.project.design!.export_dir), exports);
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  // A malformed later file is also read before any earlier file is written.
  writeFileSync(second, '{');
  assert.throws(() => approve(f.project, f.orders, 'DEMO'), /Design change sets refused/);
  assert.equal(designHistory(f.project).length, before);
  writeFileSync(second, JSON.stringify(gap(1))); approve(f.project, f.orders, 'DEMO');
  assert.equal(readLibrary(f.project).rule[0].version, 2);
  assert.equal(designHistory(f.project).filter(h => h.by === 'accept').length, 2);
  acceptDesignChanges(f.project, f.orders, 'DEMO');
  assert.equal(designHistory(f.project).filter(h => h.by === 'accept').length, 2);
});

test('an export failure refuses the approval with its library change, and the retry applies it once', () => {
  const f = delivery(false);
  git(f.root, 'merge', '--no-ff', '-m', 'Merge delivery', 'delivery');
  const exportDir = f.project.design!.export_dir;
  const blocked = path.join(f.root, 'export-file'); writeFileSync(blocked, 'This is a file');
  f.project.design!.export_dir = blocked;
  assert.throws(() => approve(f.project, f.orders, 'DEMO'), /export failed/);
  // The library change is part of the approval's transaction: refused with it, applied again by the retry.
  assert.equal(readLibrary(f.project).rule[0].version, 1);
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  f.project.design!.export_dir = exportDir;
  approve(f.project, f.orders, 'DEMO');
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
  assert.equal(designHistory(f.project).filter(h => h.by === 'accept').length, 1);
});


for (const pipeline of [false, true]) test(`${pipeline ? 'pipeline' : 'manual'} rework approval discovers two diff proposals and excludes the inherited applied file`, () => {
  const f = delivery(pipeline, true);
  const gapPath = '.alba/design/changes/gap.json';
  writeFileSync(path.join(f.worktree, gapPath), JSON.stringify({ title: 'Assign measurement', changes: [{ op: 'update', kind: 'gap', id: 'ECON-G01', base_version: 1, fields: { order: 'DEMO' } }] }));
  git(f.worktree, 'add', '-f', '.alba/design/changes/income.json', gapPath);
  git(f.worktree, 'commit', '-qm', 'Design proposals');
  f.orders.act('DEMO', 'rework', { note: 'Check the measurements independently' });
  f.orders.runStart('DEMO', { worker: 'fake' }); f.orders.runEnd('DEMO');
  f.orders.report('DEMO', { status: 'ready', summary: 'No further design changes', evidence: [], commits: [] });
  if (!pipeline) git(f.root, 'merge', '--no-ff', '-m', 'Merge reworked delivery', 'delivery');
  // Acceptance must read committed proposals from the merged checkout.
  writeFileSync(f.proposalFile, JSON.stringify(proposal(99)));
  approve(f.project, f.orders, 'DEMO');
  assert.equal(readLibrary(f.project).rule[0].version, 2);
  assert.equal(readLibrary(f.project).gap[0].order, 'DEMO');
  const events = f.orders.store.events({ tag: 'DEMO' });
  const step = events.filter(e => e.type === 'accept-step' && e.data?.name === 'design-changesets' && e.data.status === 'passed').at(-1)!;
  assert.deepEqual(step.data?.sources, { report: [], diff: [gapPath, '.alba/design/changes/income.json'] });
  assert.ok(events.some(e => e.type === 'accept-warning'));
  assert.equal(designHistory(f.project).filter(h => h.by === 'accept').length, 2);
  assert.equal(checkDesign(f.project, f.orders).issues.filter(i => i.code === 'unapplied-changeset').length, 0);
  acceptDesignChanges(f.project, f.orders, 'DEMO');
  assert.equal(designHistory(f.project).filter(h => h.by === 'accept').length, 2);
});

for (const status of ['failed', 'waiting'] as const) test(`override approval of a ${status} delivery trials, merges, archives and applies design`, () => {
  const f = delivery(true);
  git(f.worktree, 'add', '-f', '.alba/design/changes/income.json'); git(f.worktree, 'commit', '-qm', 'Design proposal');
  const marker = path.join(f.project.state_dir, 'archived.txt');
  f.project.accept!.post_merge = [[process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'archived')`]];
  f.orders.report('DEMO', { status, summary: 'Packaging needs attention', ...(status === 'waiting' ? { question: 'Accept the verified source?' } : {}), evidence: [], commits: [] });
  const before = git(f.root, 'rev-parse', 'HEAD');
  assert.throws(() => humanAction(f.project, f.orders, 'DEMO', 'approve'), /override/);
  assert.throws(() => humanAction(f.project, f.orders, 'DEMO', 'approve', 'short', undefined, true), /at least 10/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  assert.equal(humanAction(f.project, f.orders, 'DEMO', 'approve', 'Source and design checked independently', undefined, true), 'merged');
  assert.notEqual(git(f.root, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(marker, 'utf8'), 'archived');
  assert.equal(readLibrary(f.project).rule[0].version, 2);
  assert.equal(designHistory(f.project).at(-1)?.order, 'DEMO');
  assert.match(readFileSync(path.join(f.project.work_orders, 'DEMO.accept.md'), 'utf8'), /checked independently/);
  const events = f.orders.store.events({ tag: 'DEMO' });
  for (const type of ['accept-trial', 'accept-post-merge', 'accept-merged', 'action-approve']) assert.ok(events.some(e => e.type === type));
  assert.equal(f.orders.get('DEMO').actions.at(-1)?.override, true);
});

test('multi-file CLI apply validates all files atomically, attributes the order and clears unapplied warnings', () => {
  const f = designFixture();
  f.orders.add({ tag: 'SAMPLE', title: 'Economy registration', kind: 'design' });
  const dir = path.join(f.root, '.alba/design/changes'); mkdirSync(dir, { recursive: true });
  const first = path.join(dir, 'system.json'), second = path.join(dir, 'rule.json');
  writeFileSync(first, JSON.stringify({ title: 'Economy system', changes: [initialDesign().changes[0]] }));
  writeFileSync(second, '{');
  const cli = (...args: string[]) => alba(f.file, ['design', 'apply', second, first, '--order', 'SAMPLE', ...args]);
  assert.equal(cli().code, 1); assert.equal(designHistory(f.project).length, 0);
  const rule = initialDesign().changes[1];
  writeFileSync(second, JSON.stringify({ title: 'Economy rule', changes: [{ ...rule, fields: { ...rule.fields, system: 'MISSING' } }] }));
  assert.equal(cli().code, 1); assert.equal(designHistory(f.project).length, 0);
  writeFileSync(second, JSON.stringify({ title: 'Economy rule', changes: [rule] }));
  assert.equal(checkDesign(f.project, f.orders).issues.filter(i => i.code === 'unapplied-changeset').length, 2);
  const dry = cli('--dry-run'); assert.equal(dry.code, 0, dry.err);
  assert.equal(designHistory(f.project).length, 0); assert.equal(existsSync(f.project.design!.export_dir), false);
  const applied = cli(); assert.equal(applied.code, 0, applied.err);
  assert.equal(JSON.parse(applied.out).length, 2);
  assert.deepEqual(designHistory(f.project).map(h => h.order), ['SAMPLE', 'SAMPLE']);
  assert.equal(checkDesign(f.project, f.orders).issues.filter(i => i.code === 'unapplied-changeset').length, 0);
  assert.equal(cli().code, 0); assert.equal(designHistory(f.project).length, 2);
});

for (const [ledgerId, alias] of [['D7', 'D007'], ['D007', 'D7']]) test(`decision alias ${alias} resolves to ledger spelling ${ledgerId} with canonical storage`, () => {
  const f = designFixture();
  writeFileSync(path.join(f.root, 'decisions.md'), `| Id | Decision |\n| --- | --- |\n| ${ledgerId} | Income is credited once per turn. |\n`);
  f.project.decisions = validateProject({ id: 'fixture', name: 'Fixture', root: f.root, work_orders: 'orders', state_dir: 'state', decisions: { file: 'decisions.md', id_column: 1, text_column: 2 } }, f.file).decisions;
  const set = initialDesign(); set.decision = alias;
  set.changes[1].fields.sources = [{ kind: 'decision', ref: alias }];
  set.changes[3].fields.source = 'decision'; set.changes[3].fields.source_ref = alias;
  set.changes[6].fields.status = 'closed'; set.changes[6].fields.closed_by = alias;
  set.changes.push({ op: 'create', kind: 'decision_link', id: `${alias}:rule:ECON-R01`, fields: { decision: alias, kind: 'rule', entity: 'ECON-R01' } });
  applyChangeSet(f.project, f.orders, set);
  const library = readLibrary(f.project);
  assert.equal(library.rule[0].sources[0].ref, 'D7');
  assert.equal(library.param[0].source_ref, 'D7');
  assert.equal(library.gap[0].closed_by, 'D7');
  assert.equal(library.decision_link[0].decision, 'D7');
  assert.ok(designHistory(f.project).every(h => h.decision === 'D7'));
  const ledger = readLedger(f.project.decisions!);
  assert.equal(ledger[0].id, 'D7'); assert.equal(ledger[0].displayId ?? ledger[0].id, ledgerId);
  assert.ok(formatDecisions(ledger).startsWith(ledgerId));
  applyChangeSet(f.project, f.orders, { title: 'Update source only', changes: [{ op: 'update', kind: 'param', id: 'ECON.income.base', base_version: 1, fields: { source_ref: alias } }] });
  assert.equal(readLibrary(f.project).param[0].source_ref, 'D7');
  f.orders.add({ tag: 'D007', title: 'Close the measurement gap', kind: 'design' });
  applyChangeSet(f.project, f.orders, { title: 'Close by an exact order reference', changes: [{ op: 'update', kind: 'gap', id: 'ECON-G01', base_version: 1, fields: { status: 'closed', closed_by: 'D007' } }] });
  assert.equal(readLibrary(f.project).gap[0].closed_by, 'D007');
  assert.throws(() => applyChangeSet(f.project, f.orders, { title: 'Missing decision', decision: 'D999', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version: 1, fields: { text: 'Unresolved attribution' } }] }), /Unresolved decision/);
});


test('manual review CLI persists add and action flags and exposes them in order listings', () => {
  const f = designFixture();
  const add = alba(f.file, ['orders', 'add', 'SAMPLE', '--title', 'Independent review', '--kind', 'design', '--review', 'manual']);
  assert.equal(add.code, 0, add.err); assert.equal(f.orders.get('SAMPLE').order.review, 'manual');
  const list = alba(f.file, ['orders', 'list']);
  assert.match(list.out, /REVIEW/); assert.match(list.out, /manual/);
  const json = alba(f.file, ['orders', 'list', '--json']);
  assert.equal(JSON.parse(json.out)[0].review, 'manual');
  for (const [action, review] of [['review-auto', 'auto'], ['review-manual', 'manual']]) {
    const result = alba(f.file, ['orders', 'act', 'SAMPLE', action]);
    assert.equal(result.code, 0, result.err); assert.equal(f.orders.get('SAMPLE').order.review, review);
  }
  assert.equal(alba(f.file, ['orders', 'add', 'INVALID', '--title', 'Bad review', '--review', 'unknown']).code, 1);
  assert.equal(f.orders.resolveTag('INVALID'), undefined);
});

test('acceptance discovers modified proposal files as well as added ones', () => {
  const f = delivery(false, true), file = '.alba/design/changes/baseline.json';
  writeFileSync(path.join(f.worktree, file), JSON.stringify(proposal()));
  git(f.worktree, 'add', '-f', file);
  assert.match(git(f.worktree, 'diff', '--cached', '--name-status'), /^M\s+\.alba\/design\/changes\/baseline\.json$/m);
  git(f.worktree, 'commit', '-qm', 'Replace inherited proposal with a new update');
  f.orders.report('DEMO', { status: 'ready', summary: 'Update complete', evidence: [], commits: [] });
  git(f.root, 'merge', '--no-ff', '-m', 'Merge updated proposal', 'delivery');
  approve(f.project, f.orders, 'DEMO');
  assert.equal(readLibrary(f.project).rule[0].version, 2);
  const step = f.orders.store.events().filter(e => e.type === 'accept-step' && e.data?.name === 'design-changesets').at(-1)!;
  assert.deepEqual(step.data?.sources, { report: [], diff: [file] });
});

test('a project without a design library approves a fast-forward delivery without diff discovery', () => {
  const f = delivery(false);
  f.orders.report('DEMO', { status: 'ready', summary: 'Plain delivery', evidence: [], commits: [] });
  git(f.root, 'merge', '--ff-only', 'delivery');
  // Without a base reflog the changed paths of a fast forward are unknowable; that must not matter here.
  git(f.root, 'reflog', 'expire', '--expire=now', '--all');
  approve({ ...f.project, design: undefined }, f.orders, 'DEMO');
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
  assert.equal(f.orders.store.events().filter(e => e.type === 'accept-step' && e.data?.name === 'design-changesets').length, 0);
});

test('obsolete order-attributed hashes do not count as canonical change set hashes', () => {
  const f = delivery(false, true), set = initialDesign();
  const oldHash = createHash('sha256').update(stableJson({ ...set, order: 'EARLIER' })).digest('hex');
  requireDesign(f.project).db.prepare("UPDATE design_history SET changeset = ?, order_tag = ?, by_actor = 'accept'").run(oldHash, 'EARLIER');
  assert.ok(checkDesign(f.project, f.orders).issues.some(i => i.code === 'unapplied-changeset'));
});
