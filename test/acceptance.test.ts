import assert from 'node:assert/strict';
import childProcess, { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { acceptanceCard, attemptAcceptance, latestAcceptanceTrial, mergeAcceptance, runAcceptanceTrials, trialAcceptance } from '../src/review/acceptance.ts';
import { approve } from '../src/run/review.ts';
import { lintDelivery } from '../src/producer/delivery-lint.ts';
import { intakeProducer, producerAct, reviewOf, runProducerAction, runProducerActions } from '../src/producer/producer.ts';
import { readProducerOrder } from '../src/producer/order-read.ts';
import { readLeases } from '../src/resources/leases.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { sessionCardKey } from '../src/producer/session.ts';
import { syncOrders } from '../src/sync/sync.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const command = (source: string) => [process.execPath, '-e', source];

/** Substitute selected Git calls while retaining real Git repositories and cleanup. */
function withGit(intercept: (args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding, real: typeof execFileSync) => string | void, run: () => void) {
  const real = childProcess.execFileSync;
  childProcess.execFileSync = ((file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
    if (file === 'git' && options?.timeout !== undefined) {
      const output = intercept(args, options, real);
      if (output !== undefined) return output;
    }
    return real(file, args, options);
  }) as typeof execFileSync;
  syncBuiltinESMExports();
  try { run(); }
  finally { childProcess.execFileSync = real; syncBuiltinESMExports(); }
}

function fixture(t: TestContext, extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'repo'), delivery = path.join(dir, 'delivery'), workOrders = path.join(dir, 'orders');
  mkdirSync(root); mkdirSync(workOrders);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'core.autocrlf', 'false');
  for (const file of ['build.txt', 'branch.txt', 'generated.md', 'unknown.txt']) writeFileSync(path.join(root, file), 'initial\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial');
  git(root, 'worktree', 'add', '-qb', 'delivery', delivery);
  for (const file of ['build.txt', 'branch.txt', 'generated.md']) writeFileSync(path.join(delivery, file), 'delivery\n');
  writeFileSync(path.join(delivery, 'feature.txt'), 'feature\n');
  git(delivery, 'add', '.'); git(delivery, 'commit', '-qm', 'feature');
  for (const file of ['build.txt', 'branch.txt']) writeFileSync(path.join(root, file), 'base\n');
  git(root, 'rm', '-q', 'generated.md'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base changes');
  const template = path.join(dir, 'accept-template.md');
  writeFileSync(template, '# {tag}: {title}\nCommit: {merge_commit}\nReviewer: {reviewer}\n{step_results}\nFindings: {findings}\n');
  const post = path.join(dir, 'post-ran.txt');
  const project = validateProject({ id: 'sample', name: 'Sample', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { base_ref: 'main' }, accept: {
    conflicts: { take_base: ['build.txt'], take_branch: ['branch.txt'], drop: ['generated.md'] },
    steps: [{ name: 'build', command: command("const fs=require('node:fs'); if(fs.readFileSync('build.txt','utf8').trim()!=='base'||fs.readFileSync('branch.txt','utf8').trim()!=='delivery'||fs.existsSync('generated.md'))process.exit(1);fs.writeFileSync('scratch-output.txt','built');console.log('fake build passed')"), timeout_minutes: 1 }, { name: 'library', command: command('process.exit(9)'), timeout_minutes: 1, when_changed: ['library/**'] }],
    note_template: template, post_merge: [command(`require('node:fs').writeFileSync(${JSON.stringify(post)},'archived')`)], ...extra,
  }, producer: { enabled: true, rules: [{ id: 'review', action: 'accept', instruction: 'Accept verified work', mode: 'propose' }] } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'DEMO', title: 'Sample feature', kind: 'code', worktree: delivery, branch: 'delivery' });
  writeFileSync(path.join(workOrders, 'DEMO.md'), '# Sample\n\n## Acceptance\n- The sample feature works.\n\n## Evidence\n- proof/*.png: screenshots\n');
  const deliver = () => {
    const run = orders.runStart('DEMO', { worker: 'fake' }).run;
    orders.runEnd('DEMO', 'completed');
    orders.report('DEMO', { status: 'ready', summary: 'Feature works', evidence: [], commits: [git(delivery, 'rev-parse', 'HEAD')] });
    return run;
  };
  deliver();
  t.after(() => { git(root, 'worktree', 'remove', '--force', delivery); rmSync(dir, { recursive: true, force: true }); });
  return { orders, dir, root, delivery, workOrders, project, post, deliver };
}

test('acceptance card trial resolves known conflicts, skips unchanged library, then merges and writes note/post result without pushing', t => {
  const f = fixture(t);
  const pushMarker = path.join(f.dir, 'push-attempted');
  const hook = path.join(f.root, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, `#!/bin/sh\ntouch '${pushMarker.replace(/\\/g, '/')}'\nexit 1\n`, { mode: 0o755 });
  git(f.root, 'remote', 'add', 'origin', path.join(f.dir, 'missing-remote'));
  const before = git(f.root, 'rev-parse', 'HEAD');
  lintDelivery(f.project, f.orders, 'DEMO');
  const trial = latestAcceptanceTrial(f.orders, 'DEMO')!;
  assert.equal(trial.status, 'passed');
  assert.deepEqual(trial.steps.map(s => s.status), ['passed', 'skipped']);
  assert.match(trial.steps[0].tail, /fake build passed/);
  assert.equal(readFileSync(trial.steps[0].log!, 'utf8').trim(), 'fake build passed');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  assert.equal(existsSync(path.join(f.root, 'scratch-output.txt')), false);
  assert.equal(git(f.root, 'worktree', 'list', '--porcelain').includes('trial-'), false);
  mkdirSync(path.join(f.delivery, 'proof')); writeFileSync(path.join(f.delivery, 'proof', 'screen.png'), 'fake image');
  const card = acceptanceCard(f.project, f.orders, 'DEMO')!;
  assert.equal(card.images.length, 1);
  assert.ok(path.isAbsolute(card.images[0]));
  assert.ok(card.changed.includes('feature.txt'));
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
  assert.equal(c.card.acceptance?.trial?.id, trial.id);
  assert.deepEqual(readProducerOrder(f.project, f.orders, 'DEMO').acceptance?.images, card.images);
  const action = producerAct(f.project, f.orders, c.id, 'accept', { note: 'Screenshots reviewed' });
  assert.equal(action.reviewCard, card.href);
  assert.equal(runProducerAction(f.project, f.orders, action.id).status, 'done');
  const merge = git(f.root, 'rev-parse', 'HEAD');
  assert.equal(git(f.root, 'show', '-s', '--format=%P', 'HEAD').split(' ').length, 2);
  assert.equal(git(f.root, 'show', '-s', '--format=%s', 'HEAD'), 'Merge DEMO: Sample feature');
  const note = readFileSync(path.join(f.workOrders, 'DEMO.accept.md'), 'utf8');
  assert.ok(note.includes(merge)); assert.match(note, /build: passed/); assert.match(note, /library: skipped/); assert.match(note, /Screenshots reviewed/); assert.match(note, /Reviewer: producer/);
  assert.equal(readFileSync(f.post, 'utf8'), 'archived');
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
  assert.equal(f.project.accept!.push, false);
  assert.equal(existsSync(pushMarker), false);
  assert.equal(readLeases(f.project).length, 0);
  t.diagnostic(JSON.stringify({ scenario: 'known-conflicts-and-accepted-card', trial: trial.status, steps: trial.steps.map(s => `${s.name}:${s.status}`), merge, parents: 2, note: 'DEMO.accept.md', post_merge: readFileSync(f.post, 'utf8'), push_attempted: existsSync(pushMarker) }));
});

test('unknown conflict stops with file list, retains logs and never sends rework', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.delivery, 'unknown.txt'), 'delivery\n'); git(f.delivery, 'add', '.'); git(f.delivery, 'commit', '-qm', 'unknown delivery');
  writeFileSync(path.join(f.root, 'unknown.txt'), 'base\n'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'unknown base');
  const trial = trialAcceptance(f.project, f.orders, 'DEMO');
  assert.equal(trial.status, 'failed'); assert.deepEqual(trial.conflicts, ['unknown.txt']);
  assert.equal(trialAcceptance(f.project, f.orders, 'DEMO').id, trial.id);
  assert.equal(existsSync(path.join(trial.log_dir!, 'trial.json')), true);
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
  assert.match(c.card.summary, /unknown.txt/);
  assert.equal(f.orders.get('DEMO').actions.some(a => a.kind === 'rework'), false);
  assert.throws(() => approve(f.project, f.orders, 'DEMO'), /Unknown conflicts: unknown.txt/);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  t.diagnostic(JSON.stringify({ scenario: 'unknown-conflict', trial: trial.status, conflicts: trial.conflicts, steps: trial.steps.length, base_clean: true, rework: false }));
});

test('a failing step stops ordered execution and preserves the output tail', t => {
  const f = fixture(t, { steps: [{ name: 'tests', command: command("console.error('fake tests failed');process.exit(7)"), timeout_minutes: 1 }, { name: 'later', command: command('process.exit(0)'), timeout_minutes: 1 }] });
  const trial = trialAcceptance(f.project, f.orders, 'DEMO');
  assert.equal(trial.status, 'failed'); assert.equal(trial.steps.length, 1); assert.equal(trial.steps[0].code, 7); assert.match(trial.reason!, /fake tests failed/);
  assert.equal(f.orders.store.events().filter(e => e.type === 'accept-step').length, 1);
  assert.equal(git(f.root, 'worktree', 'list', '--porcelain').includes('trial-'), false);
  assert.equal(trialAcceptance(f.project, f.orders, 'DEMO').id, trial.id);
});

test('approval refuses dirty or wrong-branch base checkout without changing user files', t => {
  const f = fixture(t);
  trialAcceptance(f.project, f.orders, 'DEMO');
  const head = git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.root, 'build.txt'), 'user work\n');
  assert.throws(() => mergeAcceptance(f.project, f.orders, 'DEMO'), /dirty base checkout/);
  assert.equal(readFileSync(path.join(f.root, 'build.txt'), 'utf8'), 'user work\n');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  git(f.root, 'restore', 'build.txt'); git(f.root, 'switch', '-qc', 'other');
  assert.throws(() => mergeAcceptance(f.project, f.orders, 'DEMO'), /base branch/);
});

test('approval reruns trials when base or delivery branch changes', t => {
  const f = fixture(t);
  const first = trialAcceptance(f.project, f.orders, 'DEMO');
  writeFileSync(path.join(f.root, 'new-base.txt'), 'base'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'advance base');
  writeFileSync(path.join(f.delivery, 'new-branch.txt'), 'branch'); git(f.delivery, 'add', '.'); git(f.delivery, 'commit', '-qm', 'advance branch');
  const result = approve(f.project, f.orders, 'DEMO', 'Reviewed');
  const second = latestAcceptanceTrial(f.orders, 'DEMO')!;
  assert.notEqual(second.id, first.id); assert.notEqual(second.base, first.base); assert.notEqual(second.branch, first.branch);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), result.merge);
  assert.ok(second.changed.includes('new-branch.txt'));
});

test('post-merge failure restores original checkout and preserves command changes in stash', t => {
  const f = fixture(t, { post_merge: [command("require('node:fs').writeFileSync('build.txt','command output');require('node:fs').writeFileSync('untracked.txt','keep');process.exit(4)")] });
  const head = git(f.root, 'rev-parse', 'HEAD');
  assert.throws(() => approve(f.project, f.orders, 'DEMO'), /post_merge 1 failed/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  assert.equal(readFileSync(path.join(f.root, 'build.txt'), 'utf8'), 'base\n');
  assert.equal(existsSync(path.join(f.workOrders, 'DEMO.accept.md')), false);
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  assert.match(git(f.root, 'show', 'stash:build.txt'), /command output/);
  assert.match(git(f.root, 'show', 'stash^3:untracked.txt'), /keep/);
});

test('resource and project slot waits are retried and do not run commands early', t => {
  const f = fixture(t, { steps: [{ name: 'build', command: command("console.log('leased')"), resource: 'builder', timeout_minutes: 1 }] });
  f.project.resources = { builder: { slots: 1, exclusive: false, blocks: [], lease_minutes: 60 } };
  writeStateFile(f.project, '_leases.json', JSON.stringify({ leases: [{ resource: 'builder', tag: 'OTHER', since: new Date().toISOString(), expires: new Date(Date.now() + 60000).toISOString() }] }));
  assert.equal(trialAcceptance(f.project, f.orders, 'DEMO').status, 'waiting');
  assert.equal(f.orders.store.events().some(e => e.type === 'accept-step'), false);
  writeStateFile(f.project, '_leases.json', JSON.stringify({ leases: [] }));
  const lock = path.join(f.project.state_dir, 'acceptance', 'trial-0.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.match(trialAcceptance(f.project, f.orders, 'DEMO').reason!, /project slot/);
  rmSync(lock);
  assert.equal(trialAcceptance(f.project, f.orders, 'DEMO').status, 'passed');
  assert.equal(readLeases(f.project).length, 0);
  const events = f.orders.store.events();
  assert.ok(events.find(e => e.type === 'lease-acquired' && e.data?.acceptance));
  assert.ok(events.find(e => e.type === 'lease-released' && e.data?.acceptance));
  assert.equal(readdirSync(path.join(f.project.state_dir, 'acceptance')).some(p => p.endsWith('.lock')), false);
});

test('lint failure prevents trials; trial status changes are new session facts', t => {
  const f = fixture(t);
  f.project.checks.revision_is_head = true;
  lintDelivery(f.project, f.orders, 'DEMO');
  assert.equal(latestAcceptanceTrial(f.orders, 'DEMO'), undefined);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  f.project.checks.revision_is_head = false;
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
  const key = sessionCardKey(c);
  c.card.acceptance!.trial!.status = 'failed';
  assert.notEqual(sessionCardKey(c), key);
});

test('accept configuration validates commands, timeouts, booleans and unknown keys', t => {
  const f = fixture(t);
  assert.equal(f.project.accept!.git_timeout_minutes, 2);
  const raw = { id: 'sample', name: 'Sample', root: f.root, work_orders: f.workOrders, state_dir: f.project.state_dir };
  for (const accept of [{ push: 'false' }, { parallel: 0 }, { conflicts: { mystery: [] } }, { steps: [{ name: 'x', command: 'build', timeout_minutes: 1 }] }, { steps: [{ name: 'x', command: ['build'], timeout_minutes: -1 }] }, { post_merge: [['']] }]) assert.throws(() => validateProject({ ...raw, accept }, path.join(f.dir, 'alba.yaml')), /Invalid accept/);
  for (const git_timeout_minutes of [0, -1, NaN, Infinity, '10', null, true]) assert.throws(() => validateProject({ ...raw, accept: { git_timeout_minutes } }, path.join(f.dir, 'alba.yaml')), /Invalid accept.git_timeout_minutes/);
  for (const git_timeout_minutes of [0.02, 10]) assert.equal(validateProject({ ...raw, accept: { git_timeout_minutes } }, path.join(f.dir, 'alba.yaml')).accept!.git_timeout_minutes, git_timeout_minutes);
});

test('an auto accept rule uses the same guarded merge and note path', t => {
  const f = fixture(t, { merge_message: 'Accepted {tag}: {title}' });
  f.project.producer.rules[0].mode = 'auto';
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
  const action = producerAct(f.project, f.orders, c.id, 'accept', { note: 'Evidence reviewed' });
  assert.equal(action.status, 'done');
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
  assert.equal(git(f.root, 'show', '-s', '--format=%s', 'HEAD'), 'Accepted DEMO: Sample feature');
  assert.match(readFileSync(path.join(f.workOrders, 'DEMO.accept.md'), 'utf8'), /Evidence reviewed/);
});

test('ambiguous rules and drop on content conflicts stop with the conflicting paths', t => {
  for (const conflicts of [
    { take_base: ['build.txt'], take_branch: ['build.txt', 'branch.txt'], drop: ['generated.md'] },
    { take_base: [], take_branch: ['branch.txt'], drop: ['build.txt', 'generated.md'] },
  ]) {
    const f = fixture(t, { conflicts });
    const trial = trialAcceptance(f.project, f.orders, 'DEMO');
    assert.equal(trial.status, 'failed');
    assert.deepEqual(trial.conflicts, ['build.txt']);
    assert.equal(trial.steps.length, 0);
  }
});

test('a cap waits for a running worker and releases after the trial', t => {
  const f = fixture(t, { steps: [{ name: 'build', command: command("console.log('cap acquired')"), resource: 'heavy', timeout_minutes: 1 }] });
  f.project.dispatch.caps.heavy = 1;
  f.orders.add({ tag: 'OTHER', title: 'Other work', kind: 'heavy' });
  f.orders.runStart('OTHER', { worker: 'fake' });
  assert.match(trialAcceptance(f.project, f.orders, 'DEMO').reason!, /cap for heavy is full/);
  f.orders.runEnd('OTHER', 'completed');
  assert.equal(trialAcceptance(f.project, f.orders, 'DEMO').status, 'passed');
  assert.equal(readLeases(f.project).length, 0);
});

test('non-ready reports do not create trials; missing templates leave the base untouched', t => {
  const f = fixture(t);
  f.orders.act('DEMO', 'rework', { note: 'Try again' });
  f.orders.runStart('DEMO', { worker: 'fake' }); f.orders.runEnd('DEMO', 'failed');
  f.orders.report('DEMO', { status: 'failed', summary: 'Failed', evidence: [], commits: [] });
  lintDelivery(f.project, f.orders, 'DEMO');
  assert.equal(latestAcceptanceTrial(f.orders, 'DEMO'), undefined);
  f.orders.act('DEMO', 'queue'); f.deliver();
  f.project.accept!.note_template = path.join(f.dir, 'missing.md');
  const head = git(f.root, 'rev-parse', 'HEAD');
  assert.throws(() => approve(f.project, f.orders, 'DEMO'), /ENOENT/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
});

test('sync cannot approve a pipeline delivery from a note before post-merge succeeds', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.workOrders, 'DEMO.accept.md'), 'Pending post-merge commands');
  const sync = syncOrders(f.project, f.orders);
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  assert.ok(sync.skipped.some(s => /pipeline owns approval/.test(s.why)));
  assert.equal(f.orders.get('DEMO').actions.some(a => a.kind === 'approve'), false);
});

test('a branch a person already merged is approved on the manual path and keeps their note', t => {
  const f = fixture(t);
  // Resolve the fixture's conflicts by hand: the person's own choices, not the configured rules.
  try { git(f.root, 'merge', '-q', '-X', 'theirs', '--no-ff', '-m', 'Manual merge', 'delivery'); } catch { /* modify/delete conflict on generated.md */ }
  git(f.root, 'rm', '-q', '--ignore-unmatch', 'generated.md');
  git(f.root, 'add', '-A');
  if (git(f.root, 'status', '--porcelain')) git(f.root, 'commit', '-qm', 'Manual merge');
  const head = git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.workOrders, 'DEMO.accept.md'), 'Reviewed and merged by hand\n');
  approve(f.project, f.orders, 'DEMO', 'merged by hand after review');
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(path.join(f.workOrders, 'DEMO.accept.md'), 'utf8'), 'Reviewed and merged by hand\n');
  assert.equal(existsSync(f.post), false);
  assert.equal(latestAcceptanceTrial(f.orders, 'DEMO'), undefined);
});

test('a timed-out command fails and removes the scratch worktree', t => {
  const f = fixture(t, { steps: [{ name: 'timeout', command: command('while(true){}'), timeout_minutes: 0.001 }] });
  const trial = trialAcceptance(f.project, f.orders, 'DEMO');
  assert.equal(trial.status, 'failed');
  assert.match(trial.steps[0].tail, /ETIMEDOUT/);
  assert.equal(trial.retryable, undefined);
  assert.equal(trialAcceptance(f.project, f.orders, 'DEMO').id, trial.id);
  assert.equal(git(f.root, 'worktree', 'list', '--porcelain').includes('trial-'), false);
  assert.equal(readdirSync(path.join(f.project.state_dir, 'acceptance')).some(p => p.endsWith('.lock')), false);
});

test('Git checkout timeout preserves its cause, removes an initializing locked worktree, and retries unchanged inputs', t => {
  const f = fixture(t, { git_timeout_minutes: 0.02 });
  const calls: string[][] = [];
  let creations = 0, scratch = '';
  withGit((args, options, real) => {
    const command = args.slice(2);
    if (command[0] === 'worktree' || args[1].includes('trial-')) {
      calls.push([...command]);
      assert.equal(options.timeout, 1200);
    }
    if (command[0] !== 'worktree' || command[1] !== 'add' || ++creations !== 1) return;
    scratch = command[3];
    real('git', ['-C', f.root, 'worktree', 'add', '--detach', '--no-checkout', scratch, command[4]], options);
    real('git', ['-C', f.root, 'worktree', 'lock', '--reason', 'initializing', scratch], options);
    // A slow fake checkout uses the actual configured process timeout and emits stderr first.
    return real(process.execPath, ['-e', "process.stderr.write('checkout still initializing\\n');while(true){}"], options);
  }, () => {
    const first = trialAcceptance(f.project, f.orders, 'DEMO');
    assert.equal(first.status, 'failed');
    assert.equal(first.retryable, true);
    assert.match(first.reason!, /timed out.*ETIMEDOUT/);
    assert.match(first.reason!, /checkout still initializing/);
    assert.doesNotMatch(first.reason!, /Scratch cleanup failed/);
    assert.deepEqual(calls.slice(-2), [['worktree', 'remove', '-f', '-f', scratch], ['worktree', 'prune']]);
    assert.equal(path.dirname(scratch), path.resolve(f.project.state_dir, 'acceptance'));
    assert.equal(existsSync(scratch), false);
    assert.equal(git(f.root, 'worktree', 'list', '--porcelain').includes('trial-'), false);
    assert.equal(readdirSync(path.join(f.project.state_dir, 'acceptance')).some(p => p.endsWith('.lock')), false);
    assert.equal(JSON.parse(readFileSync(path.join(first.log_dir!, 'trial.json'), 'utf8')).retryable, true);
    const second = trialAcceptance(f.project, f.orders, 'DEMO');
    assert.notEqual(second.id, first.id);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(second.status, 'passed', second.reason);
    assert.equal(creations, 2);
    assert.equal(second.steps[0].status, 'passed');
  });
});

test('automatic interrupted trials wait 30 minutes without new events or logs across ticks and producer intake', t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-09T12:00:00Z') });
  let creations = 0;
  withGit(args => {
    if (args[2] === 'worktree' && args[3] === 'add') {
      creations++;
      throw Object.assign(new Error('checkout timed out'), { code: 'ETIMEDOUT' });
    }
  }, () => {
    const first = attemptAcceptance(f.project, f.orders, 'DEMO')!;
    assert.equal(first.retryable, true);
    const events = f.orders.store.events({ tag: 'DEMO' }).filter(e => e.type === 'accept-trial').length;
    const logs = () => readdirSync(path.join(f.project.state_dir, 'acceptance')).filter(p => p.startsWith('logs-'));
    const firstLogs = logs();
    // Both tick and producer intake use this automatic runner.
    runAcceptanceTrials(f.project, f.orders);
    intakeProducer(f.project, f.orders, { verify: false });
    t.mock.timers.tick(30 * 60 * 1000 - 1);
    assert.equal(attemptAcceptance(f.project, f.orders, 'DEMO')!.id, first.id);
    assert.equal(creations, 1);
    assert.equal(f.orders.store.events({ tag: 'DEMO' }).filter(e => e.type === 'accept-trial').length, events);
    assert.deepEqual(logs(), firstLogs);
    t.mock.timers.tick(1);
    runAcceptanceTrials(f.project, f.orders);
    const second = latestAcceptanceTrial(f.orders, 'DEMO')!;
    assert.notEqual(second.id, first.id);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(creations, 2);
    assert.equal(logs().length, firstLogs.length + 1);
    runAcceptanceTrials(f.project, f.orders);
    assert.equal(creations, 2);
  });
});

test('changed inputs bypass the automatic interrupted-trial retry interval', t => {
  const f = fixture(t);
  withGit(args => {
    if (args[2] === 'worktree' && args[3] === 'add') throw Object.assign(new Error('checkout timed out'), { code: 'ETIMEDOUT' });
  }, () => {
    const first = attemptAcceptance(f.project, f.orders, 'DEMO')!;
    f.project.accept!.git_timeout_minutes = 10;
    const second = attemptAcceptance(f.project, f.orders, 'DEMO')!;
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.fingerprint, first.fingerprint);
    assert.equal(second.retryable, true);
  });
});

test('manual approval always retries interrupted trials immediately and can merge after recovery', t => {
  const f = fixture(t);
  let creations = 0;
  withGit(args => {
    if (args[2] === 'worktree' && args[3] === 'add' && ++creations <= 3) throw Object.assign(new Error('checkout timed out'), { code: 'ETIMEDOUT' });
  }, () => {
    const first = attemptAcceptance(f.project, f.orders, 'DEMO')!;
    let previous = first;
    for (let retry = 0; retry < 2; retry++) {
      assert.throws(() => mergeAcceptance(f.project, f.orders, 'DEMO'), /ETIMEDOUT/);
      const current = latestAcceptanceTrial(f.orders, 'DEMO')!;
      assert.notEqual(current.id, previous.id);
      assert.equal(current.fingerprint, first.fingerprint);
      previous = current;
    }
    mergeAcceptance(f.project, f.orders, 'DEMO');
    assert.equal(creations, 4);
    assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
  });
});

test('cleanup retains the primary failure before removal and prune errors', t => {
  const f = fixture(t);
  const cleanup: string[][] = [];
  withGit((args, options) => {
    if (args[2] !== 'worktree') return;
    assert.equal(options.timeout, 120000);
    if (args[3] === 'add') {
      mkdirSync(args[5]);
      throw Object.assign(new Error('checkout timed out'), { code: 'ETIMEDOUT', stderr: 'checkout incomplete' });
    }
    cleanup.push(args.slice(2));
    throw new Error(args[3] === 'remove' ? 'removal refused' : 'prune refused');
  }, () => {
    const trial = trialAcceptance(f.project, f.orders, 'DEMO');
    assert.equal(trial.status, 'failed');
    assert.equal(trial.retryable, true);
    assert.match(trial.reason!, /^Command timed out \(ETIMEDOUT\): checkout incomplete\nScratch cleanup failed: removal refused\nScratch cleanup failed: prune refused$/);
    assert.equal(cleanup[0][1], 'remove');
    assert.deepEqual(cleanup[0].slice(2, 4), ['-f', '-f']);
    assert.deepEqual(cleanup[1], ['worktree', 'prune']);
    assert.equal(existsSync(cleanup[0][4]), true);
  });
});

test('failed worktree creation without a directory skips removal but still prunes', t => {
  const f = fixture(t);
  const cleanup: string[][] = [];
  withGit(args => {
    if (args[2] !== 'worktree') return;
    if (args[3] === 'add') throw Object.assign(new Error('checkout timed out'), { code: 'ETIMEDOUT', stderr: 'checkout incomplete' });
    cleanup.push(args.slice(2));
    if (args[3] === 'remove') throw new Error('scratch directory does not exist');
  }, () => {
    const trial = trialAcceptance(f.project, f.orders, 'DEMO');
    assert.equal(trial.retryable, true);
    assert.match(trial.reason!, /^Command timed out \(ETIMEDOUT\): checkout incomplete$/);
    assert.deepEqual(cleanup, [['worktree', 'prune']]);
  });
});

test('a killed merge retries without treating its partial conflicts as a normal merge result', t => {
  const f = fixture(t, { git_timeout_minutes: 10 });
  let merges = 0, conflictReads = 0;
  withGit((args, options, real) => {
    if (!args[1].includes('trial-')) return;
    assert.equal(options.timeout, 600000);
    if (args.includes('--diff-filter=U')) conflictReads++;
    if (args[2] !== 'merge' || ++merges !== 1) return;
    try { real('git', args, options); } catch { /* Leave actual partial merge conflicts behind. */ }
    throw Object.assign(new Error('merge interrupted'), { signal: 'SIGTERM', stderr: 'merge was interrupted' });
  }, () => {
    const first = trialAcceptance(f.project, f.orders, 'DEMO');
    assert.equal(first.status, 'failed');
    assert.equal(first.retryable, true);
    assert.match(first.reason!, /SIGTERM.*merge was interrupted/);
    assert.equal(conflictReads, 0);
    assert.equal(first.steps.length, 0);
    assert.equal(git(f.root, 'worktree', 'list', '--porcelain').includes('trial-'), false);
    const second = trialAcceptance(f.project, f.orders, 'DEMO');
    assert.equal(second.status, 'passed', second.reason);
    assert.notEqual(second.id, first.id);
    assert.equal(second.fingerprint, first.fingerprint);
  });
});

test('ready deliveries without a recorded worker run still produce acceptance cases', t => {
  const f = fixture(t);
  f.orders.add({ tag: 'IMPORTED', title: 'Imported feature', kind: 'code', branch: 'delivery', worktree: f.delivery });
  f.orders.report('IMPORTED', { status: 'ready', summary: 'Imported delivery', evidence: [], commits: [] });
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.order === 'IMPORTED')!;
  assert.equal(c.trigger, 'delivery');
  assert.equal(c.card.acceptance?.trial?.status, 'passed');
});


for (const mode of ['auto', 'propose', 'observe', 'off'] as const) test(`manual review keeps accept and rework as proposals under ${mode} policy`, t => {
  const f = fixture(t);
  f.orders.update('DEMO', { review: 'manual' });
  f.project.producer.rules[0].mode = mode;
  f.project.producer.rules.push({ id: 'rework', action: 'rework', instruction: 'Review rework', mode });
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
  let acceptId = '';
  for (const kind of ['accept', 'rework']) {
    const action = producerAct(f.project, f.orders, c.id, kind, { note: 'Evidence checked independently' });
    if (kind === 'accept') acceptId = action.id;
    assert.equal(action.mode, 'propose'); assert.equal(action.status, 'proposed');
    assert.match(action.reason!, /person reviews/);
  }
  runProducerActions(f.project, f.orders);
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  assert.equal(existsSync(f.post), false);
  const accepted = runProducerAction(f.project, f.orders, acceptId);
  assert.equal(accepted.status, 'done', accepted.refusal);
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'merged');
});

test('the project review default makes orders that say nothing manual; an order that says auto stays auto', t => {
  const f = fixture(t);
  f.project.review = 'manual';
  f.project.producer.rules[0].mode = 'auto';
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
  const held = producerAct(f.project, f.orders, c.id, 'accept', { note: 'Evidence checked independently' });
  assert.equal(held.mode, 'propose');
  assert.match(held.reason!, /person reviews/);
  assert.equal(reviewOf(f.project, f.orders.get('DEMO').order), 'manual');
  f.orders.update('DEMO', { review: 'auto' });
  assert.equal(reviewOf(f.project, f.orders.get('DEMO').order), 'auto');
  assert.equal(reviewOf({ ...f.project, review: undefined }, { }), 'auto', 'without a project default, auto as before');
});

test('setting manual review also stops an auto action already in the queue', t => {
  const f = fixture(t); f.project.producer.rules[0].mode = 'auto';
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'delivery')!;
  f.project.producer.rules[0].mode = 'propose';
  const action = producerAct(f.project, f.orders, c.id, 'accept', { note: 'Evidence checked' });
  f.project.producer.rules[0].mode = 'auto';
  // Recreate the persisted pending state from before the executor's first pass.
  action.status = 'proposed'; action.mode = 'auto'; delete action.ranAt;
  f.orders.update('DEMO', { review: 'manual' });
  writeStateFile(f.project, '_producer-actions.json', JSON.stringify([action]));
  const results = runProducerActions(f.project, f.orders);
  assert.equal(results[0].mode, 'propose'); assert.equal(results[0].status, 'proposed');
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  assert.equal(existsSync(f.post), false);
});
