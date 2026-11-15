import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { deliveryChecks, expandTag } from '../src/check/delivery.ts';
import { formatCheck, runCheck } from '../src/check/check.ts';
import { generalChecks } from '../src/check/general.ts';
import { parseReportBlock } from '../src/orders/report.ts';
import { lintBounceCount, lintDelivery } from '../src/producer/delivery-lint.ts';
import { intakeProducer, producerActions, producerCases, runProducerAction, setProducerPaused } from '../src/producer/producer.ts';
import { applyFinish } from '../src/run/finish.ts';
import { syncOrders } from '../src/sync/sync.ts';
import { summaries } from '../src/api/views.ts';
import { fixture as apiFixture } from './api-fixture.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

function fixture(checks: Record<string, unknown> = {}, mode?: string, backend?: 'files') {
  const { orders, dir } = tempOrders(backend);
  const root = path.join(dir, 'repo'), workOrders = path.join(dir, 'orders');
  mkdirSync(root); mkdirSync(workOrders);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'generated.txt'), 'original\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial');
  const initial = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-qc', 'delivery');
  writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'feature');
  const config = (extra: Record<string, unknown> = {}) => validateProject({ id: 'sample', name: 'Sample', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { base_ref: 'main' }, checks: { clean_worktree: false, ahead_of_base: false, encoding_scan: false, ...checks, ...extra }, ...(mode ? { producer: { enabled: true, rules: [{ id: 'lint', instruction: 'Send mechanical failures back', action: 'lint-bounce', mode }] } } : {}) }, path.join(dir, 'alba.yaml'));
  const project = config();
  orders.add({ tag: 'T1', title: 'Sample delivery', kind: 'code', worktree: root, branch: 'delivery' });
  writeFileSync(path.join(workOrders, 'T1.md'), '# Sample\n\n## Evidence\n- proof/*.txt: verification output\n');
  const lastFile = path.join(workOrders, 'T1.last.txt');
  const deliver = (revision: string | undefined = git(root, 'rev-parse', 'HEAD'), message = 'Output: artifacts/T1/package and artifacts/t1/log') => {
    const text = `${message}\n--- alba-report ---\n${JSON.stringify({ status: 'ready', summary: 'Sample delivery', ...(revision ? { revision } : {}), evidence: [], commits: [] })}\n--- end ---\n`;
    writeFileSync(lastFile, text);
    const run = orders.runStart('T1', { worker: 'fake', extra: { last_file: lastFile } }).run;
    orders.runEnd('T1', 'completed');
    orders.report('T1', { ...parseReportBlock(text), delivery_text: text }, path.basename(lastFile));
    return run;
  };
  return { orders, dir, root, workOrders, project, config, deliver, initial, lastFile };
}

test('delivery lint is entirely opt-in, preserving existing check output and events', () => {
  const f = fixture();
  f.deliver();
  const old = generalChecks(f.project.checks, f.root, 'refs/heads/main');
  const report = runCheck(f.project, f.orders, 'T1', []);
  assert.deepEqual(report.general, old);
  assert.equal('lint' in report, false);
  assert.deepEqual(deliveryChecks(f.project, f.orders.get('T1'), f.root), []);
  const before = f.orders.store.events().length;
  lintDelivery(f.project, f.orders, 'T1');
  assert.equal(f.orders.store.events().length, before);
  assert.doesNotMatch(formatCheck(report), /report_required|revision_is_head|delivery_lint/);
});

test('report_required passes valid final blocks and rejects missing, malformed and inferred reports', () => {
  const f = fixture({ report_required: true });
  f.deliver();
  const check = () => deliveryChecks(f.project, f.orders.get('T1'), f.root)[0];
  assert.equal(check().ok, true);
  for (const text of ['done', '--- alba-report ---\n{"status":"ready"}\n--- end ---', '--- alba-report ---\n{broken}\n--- end ---']) {
    f.orders.report('T1', { status: 'ready', summary: 'sample', evidence: [], commits: [], delivery_text: text }, 'T1.last.txt');
    assert.equal(check().ok, false);
  }
  f.orders.report('T1', { status: 'ready', summary: 'sample', source: 'inferred', evidence: [], commits: [], delivery_text: readFileSync(f.lastFile, 'utf8') }, 'T1.last.txt');
  assert.equal(check().ok, false);
});

test('revision_is_head accepts full/short HEAD and fails stale or absent revisions even with commits', () => {
  const f = fixture({ revision_is_head: true });
  const check = () => deliveryChecks(f.project, f.orders.get('T1'), f.root)[0];
  f.deliver(); assert.equal(check().ok, true);
  f.deliver(git(f.root, 'rev-parse', '--short', 'HEAD')); assert.equal(check().ok, true);
  f.deliver(f.initial); assert.equal(check().ok, false);
  f.orders.report('T1', { status: 'ready', summary: 'sample', evidence: [], commits: [] });
  assert.equal(check().ok, false);
  f.orders.report('T1', { status: 'ready', summary: 'sample', evidence: [], commits: [git(f.root, 'rev-parse', 'HEAD')] });
  assert.equal(check().ok, false);
});

test('base_merged counts base commits unreachable from the delivery, honoring max_behind', () => {
  const f = fixture({ base_merged: true });
  f.deliver();
  const check = (project = f.project) => deliveryChecks(project, f.orders.get('T1'), f.root)[0];
  assert.equal(check().ok, true);
  git(f.root, 'switch', '-q', 'main');
  writeFileSync(path.join(f.root, 'base.txt'), 'base'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'base change');
  git(f.root, 'switch', '-q', 'delivery');
  assert.equal(check().ok, false);
  assert.match(check().detail, /1 base commit.*Merge/);
  assert.equal(check(f.config({ base_merged: { max_behind: 1 } })).ok, true);
  git(f.root, 'merge', '-qm', 'merge base', 'main');
  assert.equal(check().ok, true);
});

function landOnMain(f: ReturnType<typeof fixture>) {
  git(f.root, 'switch', '-q', 'main');
  mkdirSync(path.join(f.root, 'shared'));
  writeFileSync(path.join(f.root, 'shared', 'ba1.txt'), 'merged order BA1\n');
  writeFileSync(path.join(f.root, 'generated.txt'), 'changed by merged order ST1\n');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'merged orders BA1 and ST1');
  git(f.root, 'switch', '-q', 'delivery');
}

test('base_intact passes a normal branch and a branch that merged the base and kept working', () => {
  const f = fixture({ base_intact: true });
  f.deliver();
  const check = () => deliveryChecks(f.project, f.orders.get('T1'), f.root).find(i => i.name === 'base_intact')!;
  assert.equal(check().ok, true);
  landOnMain(f);
  // Behind the base without merging it is base_merged's concern, not undone base work.
  assert.equal(check().ok, true);
  git(f.root, 'merge', '-qm', 'merge base', 'main');
  writeFileSync(path.join(f.root, 'feature.txt'), 'feature, continued\n');
  writeFileSync(path.join(f.root, 'shared', 'ba1.txt'), 'merged order BA1, extended by this order\n');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'continue after merge');
  assert.equal(check().ok, true, check().detail);
});

test('base_intact fails a branch that reverted its merge of the base and names the undone files', () => {
  const f = fixture({ base_merged: true }, 'auto');
  landOnMain(f);
  git(f.root, 'merge', '-qm', 'merge base', 'main');
  git(f.root, 'revert', '--no-edit', '-m', '1', 'HEAD');
  writeFileSync(path.join(f.root, 'feature.txt'), 'feature, continued\n');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'continue after revert');
  const items = () => deliveryChecks(f.project, f.orders.get('T1'), f.root);
  assert.deepEqual(items().map(i => i.name), ['base_merged', 'base_intact']);
  assert.equal(items()[0].ok, true, 'base commits stay reachable after the revert');
  const intact = items()[1];
  assert.equal(intact.ok, false);
  assert.match(intact.detail, /2 file\(s\).*generated\.txt, shared\/ba1\.txt\..*Revert commit\(s\): \w+ Revert "merge base"/);
  assert.doesNotMatch(intact.detail, /feature\.txt/);
  f.deliver(); lintDelivery(f.project, f.orders, 'T1');
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued');
  const note = f.orders.get('T1').actions.find(a => a.lint)!.note!;
  assert.match(note, /1\. base_intact: .*generated\.txt, shared\/ba1\.txt/);
  assert.equal(deliveryChecks(f.config({ base_intact: false }), f.orders.get('T1'), f.root).some(i => i.name === 'base_intact'), false);
  git(f.root, 'revert', '--no-edit', 'HEAD~1');
  assert.equal(items()[1].ok, true, items()[1].detail);
});

test('generated_paths checks committed diffs against the merge base and instructs restoration', () => {
  const f = fixture({ generated_paths: ['**/generated.*'] });
  f.deliver();
  const check = () => deliveryChecks(f.project, f.orders.get('T1'), f.root)[0];
  assert.equal(check().ok, true);
  writeFileSync(path.join(f.root, 'generated.txt'), 'build output'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'generated data');
  assert.equal(check().ok, false); assert.match(check().detail, /Restore.*do not commit/);
  git(f.root, 'restore', '--source=main', '--', 'generated.txt'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'restore generated data');
  assert.equal(check().ok, true);
});

test('evidence_required accepts worktree globs or branch files and rejects each missing path', () => {
  const f = fixture({ evidence_required: true });
  f.deliver();
  const check = () => deliveryChecks(f.project, f.orders.get('T1'), f.root)[0];
  assert.equal(check().ok, false);
  mkdirSync(path.join(f.root, 'proof')); writeFileSync(path.join(f.root, 'proof', 'result.txt'), 'proof');
  assert.equal(check().ok, true);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'proof');
  git(f.root, 'update-index', '--skip-worktree', 'proof/result.txt');
  // A sparse worktree may omit a file that is present in the delivered branch.
  unlinkSync(path.join(f.root, 'proof', 'result.txt'));
  assert.equal(check().ok, true);
  writeFileSync(path.join(f.workOrders, 'T1.md'), '## Evidence\n- proof/result.txt: tracked proof\n- missing.txt: second required proof\n');
  assert.equal(check().ok, false); assert.match(check().detail, /missing.txt/);
});

test('report patterns inspect structured reports and final messages, expanding tag placeholders literally', () => {
  const f = fixture({ report_must_match: [{ pattern: 'artifacts/{tag}/', message: 'Use {tag} output' }, { pattern: 'artifacts/{tag_lower}/', message: 'Use {tag_lower} log' }], report_must_not_match: [{ pattern: 'foreign-output', message: 'Restore output to {tag}' }] });
  f.deliver();
  const check = () => deliveryChecks(f.project, f.orders.get('T1'), f.root);
  assert.ok(check().every(i => i.ok));
  f.deliver(f.initial, 'foreign-output');
  assert.ok(check().every(i => !i.ok));
  assert.match(check()[0].detail, /Use T1 output/);
  assert.equal(expandTag('^{tag}/{tag_lower}$', 'A.1', true), '^A\\.1/a\\.1$');
  f.orders.report('T1', { status: 'ready', summary: 'artifacts/T1/ and artifacts/t1/', evidence: [], commits: [], delivery_text: 'Structured delivery'  });
  assert.ok(check().every(i => i.ok));
});

for (const mode of ['off', 'observe', 'propose', 'auto']) test(`lint-bounce ${mode}: deterministic proposal and correct order stage`, () => {
  const f = fixture({ evidence_required: true }, mode);
  f.deliver(); lintDelivery(f.project, f.orders, 'T1');
  const item = producerActions(f.project)[0];
  assert.equal(item.mode, mode);
  assert.equal(item.status, ({ off: 'refused', observe: 'would-do', propose: 'proposed', auto: 'done' } as Record<string, string>)[mode]);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, mode === 'auto' ? 'queued' : 'awaiting-review');
  const before = producerActions(f.project).length;
  lintDelivery(f.project, f.orders, 'T1');
  assert.equal(producerActions(f.project).length, before);
  if (mode === 'propose') {
    intakeProducer(f.project, f.orders, { verify: false });
    assert.equal(runProducerAction(f.project, f.orders, item.id).status, 'done');
    assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued');
  }
});

test('missing lint rule defaults to observe; producer pause prevents automatic rework', () => {
  const f = fixture({ evidence_required: true }, 'auto');
  f.project.producer.rules = [];
  f.deliver(); lintDelivery(f.project, f.orders, 'T1');
  assert.equal(producerActions(f.project)[0].status, 'would-do');
  f.project.producer.rules = f.config().producer.rules;
  setProducerPaused(f.project, true);
  f.deliver(); lintDelivery(f.project, f.orders, 'T1');
  assert.ok(producerActions(f.project).some(a => a.refusal === 'producer is paused'));
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'awaiting-review');
});

test('two consecutive automatic send-backs stop at review with findings; a pass resets the streak', () => {
  const f = fixture({ evidence_required: true }, 'auto');
  for (let i = 0; i < 3; i++) { f.deliver(); lintDelivery(f.project, f.orders, 'T1'); }
  assert.equal(lintBounceCount(f.orders, 'T1'), 2);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'awaiting-review');
  assert.equal(producerActions(f.project).filter(a => a.status === 'done').length, 2);
  assert.ok(producerCases(f.project).some(c => c.facts.limited === true && Array.isArray(c.facts.lint)));
  mkdirSync(path.join(f.root, 'proof')); writeFileSync(path.join(f.root, 'proof', 'pass.txt'), 'proof');
  f.deliver(); lintDelivery(f.project, f.orders, 'T1');
  assert.equal(lintBounceCount(f.orders, 'T1'), 0);
});

test('fake delivery fails three checks, emits automatic rework and passes after repair', () => {
  const f = fixture({ revision_is_head: true, generated_paths: ['generated.txt'], evidence_required: true }, 'auto');
  writeFileSync(path.join(f.root, 'generated.txt'), 'build rewrote this'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'bad delivery');
  f.deliver(f.initial); lintDelivery(f.project, f.orders, 'T1');
  const before = f.orders.store.events().filter(e => e.type === 'check').at(-1)!.data!;
  assert.equal((before.lint as { ok: boolean }[]).filter(i => !i.ok).length, 3);
  const note = f.orders.get('T1').actions.find(a => a.lint)!.note!;
  assert.match(note, /1\. revision_is_head[\s\S]*2\. generated_paths[\s\S]*3\. evidence_required/);
  git(f.root, 'restore', '--source=main', '--', 'generated.txt');
  mkdirSync(path.join(f.root, 'proof')); writeFileSync(path.join(f.root, 'proof', 'result.txt'), 'proof');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'repair delivery');
  f.deliver(); lintDelivery(f.project, f.orders, 'T1');
  const after = f.orders.store.events().filter(e => e.type === 'check').at(-1)!.data!;
  assert.equal(after.ok, true);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'awaiting-review');
  if (process.env.ALBA_LINT_EVIDENCE) writeFileSync(process.env.ALBA_LINT_EVIDENCE, JSON.stringify({ failed: before.lint, rework: note, passed: after.lint }, null, 2));
});

test('run completion and imported deliveries automatically record lint and bounce before review', () => {
  const f = fixture({ evidence_required: true }, 'auto');
  const text = '--- alba-report ---\n{"status":"ready","summary":"done","commits":[],"evidence":[]}\n--- end ---';
  writeFileSync(f.lastFile, text);
  const run = f.orders.runStart('T1', { worker: 'fake', extra: { last_file: f.lastFile } }).run;
  applyFinish(f.orders, { tag: 'T1', run: run.id, outcome: 'completed', report: parseReportBlock(text), why: 'test' }, f.project);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued');
  const imported = fixture({ evidence_required: true }, 'auto');
  imported.orders.runStart('T1', { worker: 'fake' }, true);
  writeFileSync(imported.lastFile, text);
  syncOrders(imported.project, imported.orders);
  assert.equal(imported.orders.stage(imported.orders.get('T1')).stage, 'queued');
});

test('delivery check configuration rejects invalid values without adding dependencies', () => {
  const f = fixture();
  for (const bad of [{ report_required: 'yes' }, { base_merged: { max_behind: -1 } }, { base_merged: {} }, { base_intact: 'yes' }, { generated_paths: 'cache/**' }, { report_must_match: [{ pattern: '[', message: 'bad' }] }, { report_must_not_match: [{ pattern: 'x' }] }]) assert.throws(() => f.config(bad));
});

test('console API retains delivery findings after rework and marks both board summary paths', async () => {
  const f = await apiFixture({ project: () => ({ checks: { evidence_required: true }, producer: { enabled: true, rules: [{ id: 'lint', action: 'lint-bounce', mode: 'auto', instruction: 'Repair mechanical failures' }] } }) });
  const project = f.board.ctx.projects[0];
  writeFileSync(path.join(project.work_orders, 'R1-review.md'), '## Evidence\n- missing.txt: proof\n');
  lintDelivery(project, f.orders, 'R1');
  const response = await f.get('/api/orders/R1?project=demo');
  assert.equal(response.status, 200);
  assert.equal(response.body.stage, 'queued');
  assert.equal(response.body.deliveryLint.delivery, true);
  assert.ok(response.body.deliveryLint.lint.some((i: { ok: boolean }) => !i.ok));
  const list = await f.get('/api/orders?project=demo');
  assert.equal(list.status, 200);
  assert.equal(list.body.items.find((o: { tag: string }) => o.tag === 'R1').lintBounced, true);
  assert.equal(summaries({ config: project, orders: f.orders }, { probes: f.board.ctx.probes }).find(o => o.tag === 'R1')?.lintBounced, true);
  assert.equal(f.spawned.length, 0);
});
