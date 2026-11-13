import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { startRun } from '../src/run/launch.ts';
import { pendingNotes, promptFor } from '../src/run/prompt.ts';
import { producerCases } from '../src/producer/producer.ts';
import { runMonitors } from '../src/monitor/monitor.ts';
import { tick, type Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

function fixture(resumable = false) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-work.md'), '# Work\nBuild the package and check the result.\n');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees') } }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({ workers: [{ id: 'fake', engine: 'fake', launch: { program: 'fake-engine', args: [...(resumable ? ['{session_args}'] : []), '{prompt_file}'], ...(resumable ? { session: { new: ['new', '{session_id}'], resume: ['resume', '{session_id}'] } } : {}) } }] }, 'workers.yaml');
  const prompts: string[] = [];
  let output = '';
  const probes: Probes = {
    now: () => new Date('2026-01-02T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => false, tail: () => output, readText: () => undefined,
    spawnDetached(program, args) {
      assert.equal(program, 'fake-engine');
      prompts.push(readFileSync(args.at(-1)!, 'utf8'));
      return 4242;
    },
    runCheck: () => ({ code: 0, output: 'package complete', timedOut: false }),
  };
  orders.add({ tag: 'T1', title: 'Build the package', kind: 'build' });
  orders.act('T1', 'queue');
  const ctx = { project, orders, workers, probes };
  return {
    ...ctx, prompts,
    start: () => startRun(ctx, 'T1', 'fake'),
    finish(text: string) {
      output = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
      const finishes = findFinishes(project, orders, probes, workers);
      assert.equal(finishes.length, 1);
      applyFinish(orders, finishes[0], project);
      output = '';
    },
  };
}

const block = (status: string, extra = {}) => `--- alba-report ---\n${JSON.stringify({ status, summary: 'package status', evidence: [], commits: [], ...extra })}\n--- end ---`;

/** Full prompts are reviewable fixtures; only temporary paths and send times are normalized. */
function checkPrompt(name: string, prompt: string) {
  const normalized = prompt.replaceAll('\\', '/').replace(/Read the UTF-8 file .*\/orders\/T1-work.md/, 'Read the UTF-8 file <work-orders>/T1-work.md').replace(/Sent [^\n]+/g, 'Sent <time>.').replace(/### [^\n]+ — /g, '### <time> — ')
    .replace(/Your working folder is \S+ \(branch/, 'Your working folder is <worktree> (branch').replace(/Never change, build in or commit to \S+ or another worktree/, 'Never change, build in or commit to <root> or another worktree');
  const file = new URL(`./fixtures/continuation-${name}.prompt.md`, import.meta.url);
  // UPDATE_PROMPT_FIXTURES=1 rewrites the fixture from the prompt (review the diff).
  if (process.env.UPDATE_PROMPT_FIXTURES === '1') writeFileSync(file, normalized, 'utf8');
  assert.equal(normalized, readFileSync(file, 'utf8'));
}

test('a missing report followed by a queue note gets a work prompt, including across a capacity retry', () => {
  const f = fixture();
  f.start();
  f.finish('The previous work is done.');
  f.orders.act('T1', 'queue', { force: true, note: 'Rework the package, build it, and take screenshots.' });
  f.start();
  const prompt = f.prompts.at(-1)!;
  assert.match(prompt, /Rework the package, build it, and take screenshots/);
  assert.match(prompt, /The previous run ended without a report block; end this run with one\./);
  assert.doesNotMatch(prompt, /Do not redo the work|print only the report block/);
  assert.doesNotMatch(promptFor(f.project.work_orders, f.orders.get('T1')), /Do not redo the work|print only the report block/);
  checkPrompt('work', prompt);
  f.orders.runEnd('T1', 'capacity');
  f.start();
  assert.match(f.prompts.at(-1)!, /Rework the package/);
  assert.doesNotMatch(f.prompts.at(-1)!, /Do not redo the work|print only the report block/);
});

test('a missing report without a newer note gets the report-only repair prompt', () => {
  const f = fixture(true);
  f.start();
  f.finish('The previous work is done.');
  f.start();
  const prompt = f.prompts.at(-1)!;
  assert.match(prompt, /Do not redo the work: check `git log` and print only the report block/);
  checkPrompt('repair', prompt);
  f.finish(block('ready'));
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'awaiting-review');
});

for (const kind of ['queue', 'rework', 'answer', 'message'] as const) {
  for (const timing of ['during-run', 'after-repair'] as const) {
    test(`${kind} note ${timing} takes precedence over missing or invalid report repair`, () => {
      const f = fixture(true);
      f.start();
      if (timing === 'during-run') f.orders.act('T1', kind, { force: true, note: 'Continue with the requested package changes.' });
      f.finish(block('invalid-status'));
      if (timing === 'after-repair') f.orders.act('T1', kind, { force: true, note: 'Continue with the requested package changes.' });
      f.start();
      assert.match(f.prompts.at(-1)!, /Continue with the requested package changes/);
      assert.match(f.prompts.at(-1)!, /The previous run ended without a report block/);
      assert.doesNotMatch(f.prompts.at(-1)!, /Do not redo the work|print only the report block/);
      f.finish(block('ready'));
      assert.deepEqual(pendingNotes(f.orders.get('T1')), []);
    });
  }
}

test('an older pending note does not suppress report-only repair', () => {
  const f = fixture();
  f.orders.act('T1', 'message', { note: 'Build the original package.' });
  f.start();
  f.finish('The previous work is done.');
  f.start();
  assert.match(f.prompts.at(-1)!, /Do not redo the work/);
});

test('a hard failure with no final message then a queue note includes the one-line report reminder', () => {
  const f = fixture(true);
  f.start();
  f.finish('');
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'failed');
  f.orders.act('T1', 'queue', { note: 'Build the revised package.' });
  f.start();
  assert.match(f.prompts.at(-1)!, /Build the revised package/);
  assert.match(f.prompts.at(-1)!, /The previous run ended without a report block; end this run with one\./);
  assert.doesNotMatch(f.prompts.at(-1)!, /Do not redo the work|print only the report block/);
});

for (const [resumable, repair] of [[false, false], [false, true], [true, false], [true, true]]) {
  test(`monitor progress gets one automatic continuation then a producer case (resumable=${resumable}, repair=${repair})`, () => {
    const f = fixture(resumable);
    f.start();
    f.finish(block('monitoring', { monitor: { check: ['fake-status'], done_when: { exit_code: 0 }, deadline_minutes: 5, note: 'Read out/summary.txt, verify the package, and take screenshots.' } }));
    assert.deepEqual(runMonitors(f.project, f.orders, f.probes).resolved, ['T1']);
    f.start();
    const prompt = f.prompts.at(-1)!;
    assert.match(prompt, /Use the monitor result to continue the order's remaining work/);
    assert.match(prompt, /package complete/);
    assert.match(prompt, /Read out\/summary.txt/);
    assert.doesNotMatch(prompt, /Do not redo the work|print only the report block/);
    if (resumable) checkPrompt('monitor', prompt);
    // Even a report-repair restart of this follow-up must continue work with the monitor result.
    if (repair) {
      f.finish('The monitor says the package is complete.');
      f.start();
      assert.equal(f.orders.get('T1').runs.at(-1)?.monitor, true);
      assert.match(f.prompts.at(-1)!, /continue the order's remaining work/);
      assert.doesNotMatch(f.prompts.at(-1)!, /Do not redo the work|print only the report block/);
    }
    f.finish(block('progress'));
    assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued');
    const moves = tick(f.project, f.orders, f.workers, f.probes, { record: false }).report.moves;
    assert.deepEqual(moves.map(m => [m.tag, m.mode, m.worker]), [['T1', 'resume', 'fake']]);
    f.start();
    assert.match(f.prompts.at(-1)!, /one automatic continuation/);
    assert.match(f.prompts.at(-1)!, /Read out\/summary.txt/);
    assert.doesNotMatch(f.prompts.at(-1)!, /Do not redo the work|print only the report block/);
    f.finish(block('progress'));
    assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'failed');
    assert.deepEqual(tick(f.project, f.orders, f.workers, f.probes, { record: false }).report.moves, []);
    const cases = producerCases(f.project, true).filter(c => c.order === 'T1');
    assert.ok(cases.some(c => c.trigger === 'failed' && /one automatic continuation/.test(c.card.summary)));
    assert.equal(f.orders.store.events().filter(e => e.type === 'monitor-progress-retry').length, 1);
    assert.equal(f.orders.store.events().filter(e => e.type === 'monitor-progress-exhausted').length, 1);
  });
}
