import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { validateWorkers } from '../src/workers/config.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tick } from '../src/tick/gather.ts';
import { currentIndependentCheck, independentChecks, needsIndependentCheck, parseIndependentVerdict, pollIndependentChecks, reviewRunsToday, startIndependentCheck, verifierArgs } from '../src/review/independent.ts';
import { intakeProducer, producerAct, runProducerAction, runProducerActions } from '../src/producer/producer.ts';
import { producerLog } from '../src/producer/activity.ts';
import { approve } from '../src/run/review.ts';
import { Orders } from '../src/orders/service.ts';
import { humanAction } from '../src/service/actions.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { alba, projectDir } from './cli-helper.ts';
import { loadProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pass = { checked: [{ item: 'The catalog sample is accurate', verdict: 'pass', evidence: 'Checked catalog.txt against the source: all three entries match.' }], pass: true, summary: 'The sample matches.' };
const failed = { checked: [{ item: 'The catalog sample is accurate', verdict: 'fail', evidence: 'catalog.txt line 3 disagrees with the source: 17 instead of 19.' }], pass: false, summary: 'One sample mismatch.' };
const block = (verdict: unknown) => `--- alba-independent-check ---\n${JSON.stringify(verdict)}\n--- end ---\n`;

function fixture(t: TestContext) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'repo'), workOrders = path.join(dir, 'orders'); mkdirSync(root); mkdirSync(workOrders);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(path.join(root, 'catalog.txt'), 'initial\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial');
  git(root, 'switch', '-qc', 'delivery'); writeFileSync(path.join(root, 'catalog.txt'), 'sample\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'catalog'); git(root, 'switch', '-q', 'main');
  const project = validateProject({ id: 'sample', name: 'Sample', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), accept: {},
    roles: { verifier: { workers: { prefer: ['author', 'checker'] } } }, producer: { enabled: true, budgets: { review_runs_per_day: 2 }, rules: [{ id: 'review', action: 'accept', instruction: 'Accept checked deliveries', mode: 'propose' }, { id: 'repair', action: 'rework', instruction: 'Return failed items', mode: 'propose' }] },
  }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({ workers: ['author', 'checker'].map(id => ({ id, engine: 'codex-cli', aliases: id === 'author' ? ['writer'] : [], launch: { program: id, args: ['--dangerously-bypass-approvals-and-sandbox'], template: 'synthetic' } })) }, path.join(dir, 'workers.yaml'));
  orders.add({ tag: 'CAT1', title: 'Catalog sample', kind: 'data', branch: 'delivery', check: 'independent' });
  writeFileSync(path.join(workOrders, 'CAT1.md'), '# Catalog\n\n## Acceptance\n- Independently sample three catalog entries against the source.\n\n## Other\nPrivate implementation instructions must not be copied.\n');
  orders.runStart('CAT1', { worker: 'writer' }); orders.runEnd('CAT1');
  orders.report('CAT1', { status: 'ready', summary: 'Catalog ready', evidence: ['catalog.txt'], commits: [git(root, 'rev-parse', 'delivery')], delivery_text: 'The delivering worker claims zero errors.' });
  let alive = true;
  const spawned: { program: string; args: string[] }[] = [];
  const probes: Probes = { now: () => new Date('2026-05-10T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => alive, tail: () => '', readText: file => existsSync(file) ? readFileSync(file, 'utf8') : undefined, processStartedAt: () => '2026-05-10T12:00:00Z', spawnDetached: (program, args) => { spawned.push({ program, args }); return 12345; } };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { project, orders, workers, probes };
  const finish = (text: string) => { const run = independentChecks(orders, 'CAT1').at(-1)!; writeFileSync(run.lastFile, text); alive = false; pollIndependentChecks(ctx); return independentChecks(orders, 'CAT1').at(-1)!; };
  return { ...ctx, dir, root, workOrders, spawned, finish };
}

test('strict verdict parser refuses absent, malformed, empty and contradictory verdicts', () => {
  for (const value of ['', 'Everything passed', '{"pass":true}', block({ ...pass, checked: [] }), block({ ...pass, pass: 'true' }), block({ ...failed, pass: true }), block({ ...pass, checked: [{ ...pass.checked[0], evidence: '' }] }), block({ ...pass, checked: [{ ...pass.checked[0], verdict: 'unknown' }] })]) assert.equal(parseIndependentVerdict(value), undefined, value);
  assert.deepEqual(parseIndependentVerdict(block(pass)), pass);
  assert.deepEqual(parseIndependentVerdict(JSON.stringify(failed)), failed);
  assert.deepEqual(parseIndependentVerdict('```json\n' + JSON.stringify(pass) + '\n```'), pass);
});

for (const [name, output, expected] of [['failed items', block(failed), 'failed'], ['no JSON block', 'Ready to merge!', 'failed'], ['passing items', block(pass), 'done']] as const) {
  test(`producer acceptance with ${name} uses a different read-only worker and ${expected === 'done' ? 'merges' : 'does not merge'}`, t => {
    const f = fixture(t), before = git(f.root, 'rev-parse', 'HEAD');
    const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
    const action = producerAct(f.project, f.orders, c.id, 'accept', { note: 'Independently verified catalog entries.' });
    const running = runProducerAction(f.project, f.orders, action.id, undefined, f);
    assert.equal(running.status, 'proposed'); assert.match(running.result!, /running/);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
    const check = independentChecks(f.orders)[0];
    assert.equal(check.worker, 'checker'); assert.equal(check.deliveringWorker, 'author');
    assert.equal(f.spawned.length, 1); assert.equal(f.spawned[0].program, 'checker');
    assert.ok(f.spawned[0].args.includes('read-only')); assert.ok(!f.spawned[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));
    const prompt = readFileSync(check.prompt, 'utf8');
    assert.match(prompt, /Independently sample three catalog entries/); assert.match(prompt, /zero errors/); assert.ok(prompt.includes(check.commit));
    assert.doesNotMatch(prompt, /Private implementation instructions/);
    assert.equal(tick(f.project, f.orders, f.workers, f.probes, { record: false }).workers.find(w => w.config.id === 'checker')!.running, 1);
    assert.equal(startIndependentCheck(f, 'CAT1').id, check.id); assert.equal(f.spawned.length, 1);
    const completed = f.finish(output); assert.equal(completed.status, expected === 'done' ? 'passed' : 'failed');
    const result = runProducerAction(f.project, f.orders, action.id, undefined, f); assert.equal(result.status, expected);
    const row = producerLog(f.project, f.orders).rows.find(r => r.id === action.id)!;
    assert.equal(row.claim, true); assert.equal(row.acceptance?.independent?.id, check.id);
    assert.equal(reviewRunsToday(f.orders, f.probes.now()), 1);
    if (expected === 'done') { assert.notEqual(git(f.root, 'rev-parse', 'HEAD'), before); assert.equal(f.orders.stage(f.orders.get('CAT1')).stage, 'merged'); }
    else {
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), before); assert.equal(f.orders.stage(f.orders.get('CAT1')).stage, 'awaiting-review');
      const failure = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'independent-check-failed')!;
      assert.ok(failure); assert.equal(failure.facts.check, check.id);
      if (name === 'failed items') {
        assert.deepEqual(failure.facts.checked, failed.checked);
        const rework = producerAct(f.project, f.orders, failure.id, 'rework', { note: failed.checked[0].evidence });
        assert.equal(runProducerAction(f.project, f.orders, rework.id).status, 'done');
        assert.match(f.orders.get('CAT1').actions.at(-1)!.note!, /17 instead of 19/);
      }
    }
  });
}

test('automatic pending accept resumes after the verifier exits', t => {
  const f = fixture(t), c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
  const action = producerAct(f.project, f.orders, c.id, 'accept');
  writeStateFile(f.project, '_producer-actions.json', JSON.stringify([{ ...action, mode: 'auto' }]));
  assert.equal(runProducerActions(f.project, f.orders, f)[0].status, 'proposed'); f.finish(block(pass));
  assert.equal(runProducerActions(f.project, f.orders, f)[0].status, 'done');
});

test('verifier routing refuses the author, missing role and unavailable alternative', t => {
  const f = fixture(t); f.project.roles!.verifier.workers = { only: ['author'] };
  assert.throws(() => startIndependentCheck(f, 'CAT1'), /different available verifier/);
  assert.equal(f.spawned.length, 0);
  f.project.roles = {}; assert.throws(() => startIndependentCheck(f, 'CAT1'), /Unknown role/);
  f.project.roles = { verifier: { sources: {}, workers: { only: ['checker'] } } }; f.workers.workers[1].enabled = false;
  assert.throws(() => startIndependentCheck(f, 'CAT1'), /different available verifier/);
});

test('review budget is durable, counts reruns once and resets at UTC midnight', t => {
  const f = fixture(t); f.project.producer.budgets.review_runs_per_day = 1;
  startIndependentCheck(f, 'CAT1'); f.finish(block(failed));
  assert.equal(reviewRunsToday(f.orders, f.probes.now()), 1);
  assert.throws(() => startIndependentCheck(f, 'CAT1', true), /budget exhausted/);
  assert.equal(reviewRunsToday(f.orders, new Date('2026-05-11T00:00:00Z')), 0);
  assert.equal(producerLog(f.project, f.orders, {}, f.probes.now()).now.budgets.find(b => b.key === 'review_runs_per_day')!.used, 1);
});

test('changed branch or acceptance invalidates a passing check, but a person can approve', t => {
  const f = fixture(t); startIndependentCheck(f, 'CAT1'); f.finish(block(pass));
  assert.equal(currentIndependentCheck(f.project, f.orders, 'CAT1')?.status, 'passed');
  git(f.root, 'switch', 'delivery'); writeFileSync(path.join(f.root, 'catalog.txt'), 'changed sample\n');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'Revise sample'); git(f.root, 'switch', 'main');
  assert.equal(currentIndependentCheck(f.project, f.orders, 'CAT1'), undefined);
  startIndependentCheck(f, 'CAT1'); f.finish(block(pass));
  writeFileSync(path.join(f.workOrders, 'CAT1.md'), '# Catalog\n\n## Acceptance\n- Check five entries.\n');
  assert.equal(currentIndependentCheck(f.project, f.orders, 'CAT1'), undefined);
  const producer = new Orders(f.orders.store, undefined, 'producer');
  assert.throws(() => approve(f.project, producer, 'CAT1'), /Independent check has not passed/);
  assert.equal(approve(f.project, f.orders, 'CAT1').accept, 'Acceptance pipeline passed');
});

test('a human approval ignores an explicitly failed verdict', t => {
  const f = fixture(t); startIndependentCheck(f, 'CAT1'); f.finish(block(failed));
  assert.ok(approve(f.project, f.orders, 'CAT1').merge);
  assert.equal(f.orders.stage(f.orders.get('CAT1')).stage, 'merged');
});

test('verifier checkout changes fail closed even with a passing JSON block', t => {
  const f = fixture(t), check = startIndependentCheck(f, 'CAT1'); writeFileSync(path.join(check.cwd, 'catalog.txt'), 'tampered\n');
  assert.equal(f.finish(block(pass)).status, 'failed');
  assert.match(independentChecks(f.orders)[0].reason!, /checkout changed/);
});

test('Codex disables every configured MCP server and refuses unreadable configuration', t => {
  const f = fixture(t);
  f.probes.runCommand = () => JSON.stringify([{ name: 'sample.tools' }, { name: 'other' }]);
  assert.equal(startIndependentCheck(f, 'CAT1').status, 'running');
  assert.ok(f.spawned[0].args.includes('mcp_servers={"sample.tools"={enabled=false},"other"={enabled=false}}'));
  assert.ok(!f.spawned[0].args.some(a => /^mcp_servers\."/.test(a)), 'no quoted -c key paths: codex-cli keeps the quotes');
  f.finish(block(failed));
  f.probes.runCommand = () => 'unreadable';
  assert.equal(startIndependentCheck(f, 'CAT1', true).status, 'failed');
  assert.equal(f.spawned.length, 1);
});

test('a reused verifier PID fails without touching the unrelated process', t => {
  const f = fixture(t); startIndependentCheck(f, 'CAT1');
  f.probes.processStartedAt = () => '2026-05-10T13:00:00Z';
  pollIndependentChecks(f);
  assert.equal(independentChecks(f.orders)[0].status, 'failed');
  assert.match(independentChecks(f.orders)[0].reason!, /PID was reused/);
});

test('per-kind config and per-order CLI overrides remain backward compatible', t => {
  const f = fixture(t); f.orders.update('CAT1', { check: undefined });
  f.project.accept!.independent_check = { data: true, code: false }; assert.equal(needsIndependentCheck(f.project, f.orders.get('CAT1')), true);
  humanAction(f.project, f.orders, 'CAT1', 'check-none'); assert.equal(needsIndependentCheck(f.project, f.orders.get('CAT1')), false);
  humanAction(f.project, f.orders, 'CAT1', 'check-independent'); assert.equal(needsIndependentCheck(f.project, f.orders.get('CAT1')), true);
  const file = projectDir(path.join(f.dir, 'cli'));
  const added = alba(file, ['orders', 'add', 'DEMO7', '--title', 'Synthetic catalog', '--kind', 'data', '--check', 'independent']); assert.equal(added.code, 0, added.err);
  const cliOrders = new Orders(stateStore(loadProject(file))); assert.equal(cliOrders.get('DEMO7').order.check, 'independent');
  assert.equal(alba(file, ['orders', 'act', 'DEMO7', 'check-none']).code, 0);
  assert.notEqual(alba(file, ['orders', 'add', 'DEMO8', '--title', 'Invalid check', '--check', 'maybe']).code, 0);
});

test('Claude verifier disables mutation tools and uses only its empty MCP configuration', t => {
  const f = fixture(t), worker = { ...f.workers.workers[1], engine: 'claude-cli' };
  const args = verifierArgs(worker, f.root, 'Inspect the sample', 'last.txt');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep'); assert.ok(args.includes('--strict-mcp-config'));
  assert.match(args[args.indexOf('--disallowedTools') + 1], /Bash.*Edit.*Write/);
});
