import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { tempOrders } from './helpers.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { startRun } from '../src/run/launch.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { parseStreamLog } from '../src/workers/adapters/stream.ts';
import { LiveFold } from '../src/run/live.ts';
import { parseUsage } from '../src/usage/usage.ts';
import { isTransientError } from '../src/run/transient.ts';
import { agy } from '../src/workers/adapters/agy.ts';
import { agyFailureKind } from '../src/workers/adapters/agy-protocol.ts';

const fake = path.join(import.meta.dirname, 'fixtures', 'fake-agy.mjs');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });

function setup(mode: string, extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game'); mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'Test project.');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'initial');
  const workOrders = path.join(dir, 'orders'); mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-test.md'), '# T1\nTest the fake agy worker.');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { base_ref: 'main', worktree_parent: path.join(dir, 'trees') } }, path.join(dir, 'project.yaml'));
  const proof = path.join(dir, 'proof.json');
  // Only the executable is replaced: node runs the fake, the template is the one a real agy worker would have.
  const workers = validateWorkers({ workers: [{ id: 'agy-direct', engine: 'agy-cli', ...extra, launch: {
    program: process.execPath, model: 'gemini-test',
    args: [fake, '-p', 'Read the UTF-8 file {prompt_file} in full and follow it exactly.'],
    env: { FAKE_AGY_MODE: mode, FAKE_AGY_PROOF: proof },
  } }] }, path.join(dir, 'workers.yaml'));
  orders.add({ tag: 'T1', title: 'Test', kind: 'docs' }); orders.act('T1', 'queue');
  return { orders, project, workers, proof, dir };
}

async function ran(ctx: ReturnType<typeof setup>) {
  startRun({ ...ctx, probes: systemProbes }, 'T1', 'agy-direct');
  const run = ctx.orders.get('T1').runs.at(-1)!;
  const deadline = Date.now() + 15000;
  const done = () => !!run.events_file && existsSync(run.events_file) && readFileSync(run.events_file, 'utf8').includes('"event":"result"');
  while (Date.now() < deadline && !done()) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(done(), 'the fake agy printed its result line');
  for (let i = 0; i < 100 && systemProbes.isAlive(run.pid!); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(systemProbes.isAlive(run.pid!), false);
  return run;
}

const finishOf = (ctx: ReturnType<typeof setup>) => { const [f] = findFinishes(ctx.project, ctx.orders, systemProbes, ctx.workers); assert.ok(f, 'the run ended'); return f; };

test('agy stream-json: conversation id, final message after the last tool, usage, live view', () => {
  const text = execFileSync(process.execPath, [fake, '-p', 'Read the UTF-8 file p.md in full and follow it exactly.', '--output-format', 'stream-json'], { encoding: 'utf8', env: { ...process.env, FAKE_AGY_MODE: 'ok', FAKE_AGY_PROOF: '' } });
  const log = parseStreamLog(text);
  assert.equal(log.sessionId, 'conv-fake-1');
  assert.equal(log.ended, true);
  assert.match(log.finalText, /^Fake agy worker finished\.\n\n--- alba-report ---/);
  assert.equal(log.tokens, 690); assert.equal(log.turns, 3);
  assert.deepEqual(log.errors, []);
  // The text before the last tool call is not the final message, even without a result line (a process killed mid-run).
  const cut = parseStreamLog(text.split('\n').filter(l => !l.includes('"event":"result"')).join('\n'));
  assert.ok(cut.finalText.startsWith('Fake agy worker finished.')); assert.equal(cut.ended, false);
  const usage = parseUsage(text);
  assert.equal(usage.source, 'agy-json'); assert.equal(usage.total_tokens, 690); assert.equal(usage.input_tokens, 600); assert.equal(usage.cached_tokens, 30);
  const fold = new LiveFold();
  for (const line of text.trim().split('\n')) fold.event(JSON.parse(line), '2026-01-01T00:00:00Z');
  const live = fold.view(new Date('2026-01-01T00:01:00Z'));
  assert.equal(live.commands, 1); assert.equal(live.failed_commands, 0);
  assert.equal(live.phase, 'idle');
  assert.match(live.messages.at(-1)!.text, /Fake agy worker finished/);
  assert.ok(live.recent.some(a => a.summary === 'git status --short'));
  assert.equal(live.usage.input_tokens, 600); assert.equal(live.usage.turns, 3);
  assert.equal(fold.accounting.turns.length, 3); assert.equal(fold.accounting.turns.at(-1)!.usage.source, 'agy-json');
});

test('agy failures: region, sign-in, model and quota are told apart; a quota line is not read as a transient 429', () => {
  assert.equal(agyFailureKind('FAILED_PRECONDITION (code 400): User location is not supported for the API use.'), 'region');
  assert.equal(agyFailureKind('UNAUTHENTICATED (code 401): not signed in'), 'auth');
  assert.equal(agyFailureKind('error: invalid model selection (--model "gemini-4-argon" --effort ""): model gemini-4-argon is not recognized as a known model or custom model in settings'), 'model');
  assert.equal(agyFailureKind('RESOURCE_EXHAUSTED (code 429): You have exhausted your capacity on this model. Your quota will reset after 3h.'), 'quota');
  assert.equal(agyFailureKind('503 model is overloaded'), undefined);
  // The error of a result line counts as an error event for the transient classifier.
  assert.ok(isTransientError(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'UNAVAILABLE (code 503): The model is overloaded.' } })));
  assert.ok(!isTransientError(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_info: { output: 'HTTP 429 in the test output' } } })));
});

test('agy prepare: flags go after the template, the prompt folder is added, a resume names the conversation', () => {
  const worker = validateWorkers({ workers: [{ id: 'a', engine: 'agy-cli', launch: { program: 'agy', model: 'gemini-x', args: [] } }] }, 'w.yaml').workers[0];
  const base = { worker, stateDir: 's', skills: [], env: {}, envUnset: [], promptFile: 'state/runs/T1-r1.prompt.md', lastFile: 'orders/T1.last.txt' };
  const fresh = agy.prepare([], base).args;
  assert.deepEqual(fresh, ['-p', 'Read the UTF-8 file state/runs/T1-r1.prompt.md in full and follow it exactly.', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--print-timeout', '8h', '--model', 'gemini-x', '--add-dir', 'state/runs']);
  const resumed = agy.prepare(['-p', 'go', '--output-format', 'text', '--print-timeout', '2h'], { ...base, resume: 'conv-9' }).args;
  assert.deepEqual(resumed, ['-p', 'go', '--output-format', 'stream-json', '--print-timeout', '2h', '--dangerously-skip-permissions', '--model', 'gemini-x', '--conversation', 'conv-9', '--add-dir', 'state/runs']);
});

test('detached agy: launch in the worktree with the headless flags, report read from the result, resume with --conversation', async () => {
  const ctx = setup('ok');
  const run = await ran(ctx);
  const proof = JSON.parse(readFileSync(ctx.proof, 'utf8'));
  assert.equal(path.resolve(proof.cwd), path.resolve(ctx.orders.get('T1').order.worktree!));
  for (const [flag, value] of [['--output-format', 'stream-json'], ['--model', 'gemini-test'], ['--print-timeout', '8h']]) assert.equal(proof.args[proof.args.indexOf(flag) + 1], value);
  assert.ok(proof.args.includes('--dangerously-skip-permissions'));
  assert.equal(path.resolve(proof.args[proof.args.indexOf('--add-dir') + 1]), path.resolve(path.dirname(run.prompt_file!)));
  assert.ok(!proof.args.includes('--conversation'));
  const f = finishOf(ctx);
  assert.equal(f.outcome, 'completed');
  assert.equal(f.report?.status, 'waiting'); assert.equal(f.report?.summary, 'Fake agy worker finished');
  assert.equal(f.session, 'conv-fake-1');
  assert.equal(f.usage?.source, 'agy-json'); assert.equal(f.usage?.total_tokens, 690);
  applyFinish(ctx.orders, f, ctx.project);
  assert.match(readFileSync(run.last_file!, 'utf8'), /^Fake agy worker finished\./);
  ctx.orders.act('T1', 'answer', { note: 'Continue.' });
  await ran(ctx);
  const resumed = JSON.parse(readFileSync(ctx.proof, 'utf8'));
  assert.equal(resumed.args[resumed.args.indexOf('--conversation') + 1], 'conv-fake-1');
});

test('detached agy: each way agy refuses to work ends the run with its own reason', async () => {
  const region = setup('region');
  await ran(region);
  const r = finishOf(region);
  assert.equal(r.outcome, 'capacity'); assert.match(r.why, /region block.*resume 1 of 3/);
  for (const [mode, summary, question] of [
    ['auth', /not signed in/, /Sign agy in/],
    ['model', /does not know the model gemini-test/, /agy models/],
    ['quota', /quota is used up/, /quota to reset/],
  ] as const) {
    const ctx = setup(mode);
    await ran(ctx);
    const f = finishOf(ctx);
    assert.equal(f.outcome, 'failed', mode);
    assert.equal(f.report?.status, 'blocked', mode);
    assert.match(f.report!.summary, summary); assert.match(f.report!.question!, question);
    applyFinish(ctx.orders, f, ctx.project);
    assert.equal(ctx.orders.stage(ctx.orders.get('T1')).stage, 'blocked');
  }
  const rotate = setup('quota', { on_limit: 'rotate' });
  await ran(rotate);
  const q = finishOf(rotate);
  assert.equal(q.outcome, 'capacity'); assert.equal(q.limit, 'quota');
});
