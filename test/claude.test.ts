import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { tempOrders } from './helpers.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { expandEnv, startRun } from '../src/run/launch.ts';
import { systemProbes, type Probes } from '../src/tick/gather.ts';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { parseStreamLog } from '../src/workers/adapters/stream.ts';
import { parseActions, findLoops } from '../src/run/loops.ts';
import { LiveFold } from '../src/run/live.ts';
import { parseUsage } from '../src/usage/usage.ts';
import { stopTokenCappedRuns } from '../src/run/token-cap.ts';
import { executeTick } from '../src/tick/execute.ts';
import { workerViews } from '../src/api/views.ts';

const fixtureText = () => readFileSync(path.join(import.meta.dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });

function setup(cap?: number) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game'); mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'Test project.');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'initial');
  const workOrders = path.join(dir, 'orders'); mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-test.md'), '# T1\nTest the fake worker.');
  const skillDir = path.join(dir, 'skills', 'test-skill'); mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: Test skill\n---\nTest instructions.');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { base_ref: 'main', worktree_parent: path.join(dir, 'trees') }, skills: { sources: [{ id: 'test', dir: path.dirname(skillDir) }], always: ['test-skill'] } }, path.join(dir, 'project.yaml'));
  const proof = path.join(dir, 'proof.json');
  const workers = validateWorkers({ workers: [{ id: 'claude', engine: 'claude-cli', ...(cap ? { max_tokens_per_run: cap } : {}), launch: {
    program: process.execPath, model: 'test-model',
    args: [path.join(import.meta.dirname, 'fixtures', 'fake-claude.mjs'), '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions', '--model', '{model}', 'Read the UTF-8 file {prompt_file} in full and follow it exactly.'],
    env: { ANTHROPIC_AUTH_TOKEN: '${ALBA_TEST_AUTH}', CLAUDE_CODE_EFFORT_LEVEL: 'high', FAKE_CLAUDE_PROOF: proof },
  } }] }, path.join(dir, 'workers.yaml'));
  orders.add({ tag: 'T1', title: 'Test', kind: 'sim' }); orders.act('T1', 'queue');
  return { orders, project, workers, proof, dir };
}

function testEnv() {
  const values = { ALBA_TEST_AUTH: randomUUID(), ANTHROPIC_API_KEY: randomUUID(), CLAUDE_CODE_PERSONAL: 'personal', CLAUDE_CONFIG_DIR: 'personal-config' };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  return () => { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
}

async function completed(ctx: ReturnType<typeof setup>) {
  // Exercise the actual detached launcher and capture wrapper, substituting only the executable.
  startRun({ ...ctx, probes: systemProbes }, 'T1', 'claude');
  const run = ctx.orders.get('T1').runs.at(-1)!;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (run.events_file && existsSync(run.events_file) && readFileSync(run.events_file, 'utf8').includes('Fake worker finished')) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(run.events_file && readFileSync(run.events_file, 'utf8').includes('Fake worker finished'), 'fake worker completed');
  // Output pipes close just after the last event. Only the known test pid is used here.
  for (let i = 0; i < 100 && systemProbes.isAlive(run.pid!); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(systemProbes.isAlive(run.pid!), false);
  return run;
}

test('Claude fixture: session, usage split, summary, tools and failing loops', () => {
  const text = fixtureText(), stream = parseStreamLog(text), parsed = parseActions(text);
  assert.equal(stream.sessionId, 'test-session');
  assert.equal(stream.finalText, 'The build is blocked.');
  assert.equal(parsed.format, 'claude-json'); assert.equal(parsed.started, 3);
  assert.deepEqual(parsed.actions.map(a => [a.command, a.failed]), Array.from({ length: 3 }, () => ['pnpm build', true]));
  assert.equal(findLoops(parsed.actions, { repeat: 3, alternate: 6, longCommands: [] })[0].kind, 'repeat');
  const usage = parseUsage(text);
  assert.equal(usage.source, 'claude-json');
  assert.equal(usage.input_tokens, 490); assert.equal(usage.output_tokens, 50);
  assert.equal(usage.cached_tokens, 260); assert.equal(usage.cache_write_tokens, 40);
  assert.equal(usage.total_tokens, 840); assert.equal(usage.cost_usd, 0.01);
  const fold = new LiveFold();
  for (const line of text.trim().split('\n')) fold.event(JSON.parse(line), '2026-01-01T00:00:00Z');
  const live = fold.view(new Date('2026-01-01T00:01:00Z'));
  assert.equal(live.messages.at(-1)?.text, 'The build is blocked.');
  assert.equal(live.commands, 3); assert.equal(live.failed_commands, 3);
  assert.equal(live.usage.input_tokens, 490); assert.equal(live.usage.output_tokens, 50);
  assert.equal(fold.accounting.signals('T1', 'r1', 'sim').filter(s => s.kind === 'failed-loop').length, 1);
});

test('detached Claude: launch, isolated settings and skills, inherited env removed, finish and resume', async () => {
  const restore = testEnv();
  try {
    const ctx = setup(), run = await completed(ctx);
    const proof = JSON.parse(readFileSync(ctx.proof, 'utf8'));
    assert.equal(path.resolve(proof.cwd), path.resolve(ctx.orders.get('T1').order.worktree!));
    assert.ok(proof.config.startsWith(path.join(ctx.project.state_dir, 'workers', 'claude')));
    assert.deepEqual(proof.settingsKeys, ['env']);
    assert.deepEqual(proof.envKeys, ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_EFFORT_LEVEL', 'FAKE_CLAUDE_PROOF']);
    assert.deepEqual(proof.configFiles, ['settings.json', 'skills']);
    assert.equal(proof.authFingerprint, createHash('sha256').update(process.env.ALBA_TEST_AUTH!).digest('hex'));
    assert.equal(proof.inheritedRemoved, true);
    assert.ok(proof.skillFiles.includes('test-skill'));
    assert.ok(existsSync(path.join(proof.config, 'skills', 'test-skill', 'SKILL.md')));
    assert.ok(proof.args.includes('-p')); assert.ok(proof.args.includes('--verbose'));
    for (const [flag, value] of [['--output-format', 'stream-json'], ['--model', 'test-model'], ['--permission-mode', 'bypassPermissions']]) assert.equal(proof.args[proof.args.indexOf(flag) + 1], value);
    assert.match(proof.args.at(-1), /^Read the UTF-8 file .*T1-r1.prompt.md in full and follow it exactly\.$/);
    const [finish] = findFinishes(ctx.project, ctx.orders, systemProbes, ctx.workers);
    assert.equal(finish.session, 'test-session'); assert.equal(finish.usage?.total_tokens, 840);
    assert.equal(finish.report?.status, 'waiting');
    applyFinish(ctx.orders, finish, ctx.project);
    const snapshot = { at: new Date().toISOString(), projects: [{ config: ctx.project, orders: ctx.orders, rows: [], workers: [{ config: ctx.workers.workers[0], available: true, reasons: [], running: 0, runsToday: 1 }] }] };
    assert.equal(workerViews(snapshot, { probes: systemProbes, workers: ctx.workers })[0].canResume, true);
    // The board draws a worker on the machine named by its `host`; a worker without one runs where alba runs.
    snapshot.projects[0].workers.push({ config: { ...ctx.workers.workers[0], id: 'remote', host: 'gpu-box' }, available: true, reasons: [], running: 0, runsToday: 0 });
    const views = workerViews(snapshot, { probes: systemProbes, workers: ctx.workers });
    assert.equal(views[0].host, undefined); assert.equal(views.find(v => v.id === 'remote')?.host, 'gpu-box');
    assert.match(readFileSync(run.last_file!, 'utf8'), /Fake worker finished/);
    const publicData = JSON.stringify(ctx.orders.get('T1')) + readFileSync(run.events_file!, 'utf8') + readFileSync(run.log!, 'utf8');
    assert.equal(publicData.includes(process.env.ALBA_TEST_AUTH!), false);
    ctx.orders.act('T1', 'answer', { note: 'Continue.' });
    await completed(ctx);
    const resumed = JSON.parse(readFileSync(ctx.proof, 'utf8'));
    assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], 'test-session');
    assert.equal(resumed.config, proof.config);
  } finally { restore(); }
});

test('token cap: dispatcher creates a failed report even when the fake has already exited', async () => {
  const restore = testEnv();
  try {
    const ctx = setup(800), run = await completed(ctx);
    const probes = { ...systemProbes, gitActivity: () => ({}), worktrees: () => [], freeRamGb: () => 32 };
    executeTick({ ...ctx, probes }, { maxDispatch: 0 });
    const doc = ctx.orders.get('T1');
    assert.equal(doc.runs[0].outcome, 'failed'); assert.equal(doc.runs[0].usage?.total_tokens, 840);
    assert.match(doc.reports.at(-1)!.summary, /max_tokens_per_run exceeded/);
    assert.equal(doc.runs[0].session, 'test-session');
    assert.ok(ctx.orders.store.events({ tag: 'T1' }).some(e => e.type === 'token-cap-stopped'));
    assert.deepEqual(stopTokenCappedRuns(ctx.project, ctx.orders, ctx.workers, probes), []);
    assert.ok(run.events_file);
  } finally { restore(); }
});

test('token cap: a live process must pass the guarded stop before the run can close', () => {
  const restore = testEnv();
  try {
    const ctx = setup(800);
    const probes: Probes = { ...systemProbes, spawnDetached: () => 4242, processStartedAt: () => '2026-01-01T00:00:00Z', isAlive: () => true };
    startRun({ ...ctx, probes }, 'T1', 'claude');
    const run = ctx.orders.get('T1').runs[0]; writeFileSync(run.events_file!, fixtureText());
    let checked = 0;
    probes.kill = (pid, at) => { assert.equal(pid, 4242); assert.equal(at, run.process_started_at); checked++; return []; };
    assert.match(stopTokenCappedRuns(ctx.project, ctx.orders, ctx.workers, probes)[0], /Refusing to stop/);
    assert.equal(ctx.orders.get('T1').runs[0].ended, undefined);
    probes.kill = () => [4242];
    stopTokenCappedRuns(ctx.project, ctx.orders, ctx.workers, probes);
    assert.equal(ctx.orders.get('T1').reports.at(-1)!.status, 'failed'); assert.equal(checked, 1);
  } finally { restore(); }
});

test('token caps validate as positive whole numbers', () => {
  for (const cap of [0, -1, 1.5, Infinity, '10']) assert.throws(() => validateWorkers({ workers: [{ id: 'c', engine: 'claude-cli', max_tokens_per_run: cap }] }, 'workers.yaml'), /max_tokens_per_run/);
});

test('explicit environment references resolve without expanding the referenced value again', () => {
  const name = `ALBA_TEST_${randomUUID().replaceAll('-', '')}`;
  process.env[name] = '{skill_names}';
  try {
    assert.deepEqual(expandEnv({ A: '${' + name + '}', B: '{skill_names}' }, { skill_names: 'test' }), { A: '{skill_names}', B: 'test' });
  } finally { delete process.env[name]; }
  assert.throws(() => expandEnv({ A: '${' + name + '}' }, {}), /not set/);
});

test('Claude usage updates one message once and reconciles cumulative result usage', () => {
  const assistant = (output: number) => ({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } });
  const text = [assistant(1), assistant(20), { type: 'result', usage: { input_tokens: 110, output_tokens: 25, cache_read_input_tokens: 12, cache_creation_input_tokens: 6 }, total_cost_usd: 0.02 }].map(e => JSON.stringify(e)).join('\n');
  const usage = parseUsage(text);
  assert.equal(usage.input_tokens, 110); assert.equal(usage.output_tokens, 25); assert.equal(usage.total_tokens, 153);
  assert.equal(usage.cached_tokens, 12); assert.equal(usage.cache_write_tokens, 6); assert.equal(usage.cost_usd, 0.02);
  assert.equal(usage.turns, 1);
  assert.equal(parseUsage(JSON.stringify({ type: 'result', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 } })).total_tokens, 14);
});

test('Claude service errors clear interim assistant text so they can be retried', () => {
  const stream = parseStreamLog([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking.' }] } },
    { type: 'result', is_error: true, errors: ['HTTP 503 Service Unavailable'], result: 'Request failed' },
  ].map(e => JSON.stringify(e)).join('\n'));
  assert.equal(stream.finalText, ''); assert.deepEqual(stream.errors, ['HTTP 503 Service Unavailable']);
});

/** A Claude run whose events file is `events`, its process gone; the tick reads how it ended. */
function endedRun(events: unknown[]) {
  const ctx = setup();
  const probes: Probes = { ...systemProbes, spawnDetached: () => 4242, processStartedAt: () => '2026-01-01T00:00:00Z', isAlive: () => false, gitActivity: () => ({}), worktrees: () => [], freeRamGb: () => 32 };
  startRun({ ...ctx, probes }, 'T1', 'claude');
  const run = ctx.orders.get('T1').runs[0];
  writeFileSync(run.events_file!, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return { ...ctx, probes, run };
}
const said = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's-9', stop_reason: 'end_turn' });
const block = (summary: string) => `Done.\n\n--- alba-report ---\n${JSON.stringify({ status: 'ready', summary, evidence: [], commits: [] })}\n--- end ---`;

test('a run whose pid now belongs to another process (a reused pid) has ended; the same process still running has not', () => {
  const restore = testEnv();
  try {
    const ctx = endedRun([said(block('done')), result(block('done'))]);
    const alive = { ...ctx.probes, isAlive: () => true };
    assert.deepEqual(findFinishes(ctx.project, ctx.orders, { ...alive, processStartedAt: () => '2026-01-01T00:00:00Z' }, ctx.workers), []);
    assert.deepEqual(findFinishes(ctx.project, ctx.orders, { ...alive, processStartedAt: () => undefined }, ctx.workers), [], 'an unreadable start time counts as alive');
    const [f] = findFinishes(ctx.project, ctx.orders, { ...alive, processStartedAt: () => '2026-03-01T10:00:00Z' }, ctx.workers);
    assert.equal(f?.outcome, 'completed');
  } finally { restore(); }
});

test('Claude: a background command that ends after the final message does not lose the report; the newest earlier block is taken and marked', () => {
  const restore = testEnv();
  try {
    // as in REN1B-r3: a report, a second report, then the notification turn with a short remark
    const ctx = endedRun([
      said('Working.'), { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'build', run_in_background: true } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'started' }] } },
      said(block('first try')), result(block('first try')),
      said(block('final report')), result(block('final report')),
      { type: 'system', subtype: 'task_notification' }, { type: 'system', subtype: 'init' },
      said('The background build finished; nothing changes.'), result('The background build finished; nothing changes.'),
    ]);
    const [f] = findFinishes(ctx.project, ctx.orders, ctx.probes, ctx.workers);
    assert.equal(f.outcome, 'completed'); assert.equal(f.report?.summary, 'final report');
    assert.deepEqual(f.report_from, { where: 'earlier-message' }); assert.match(f.why, /earlier message/);
    applyFinish(ctx.orders, f, ctx.project);
    const doc = ctx.orders.get('T1');
    assert.equal(doc.runs[0].report_from, 'earlier-message'); assert.equal(doc.runs[0].missing_report, undefined);
    assert.equal(doc.reports.at(-1)!.summary, 'final report');
    assert.ok(ctx.orders.store.events({ tag: 'T1' }).some(e => e.type === 'report-from-earlier' && e.data?.where === 'earlier-message'));
    assert.match(readFileSync(ctx.run.last_file!, 'utf8'), /final report/);
    assert.equal(ctx.orders.store.events({ tag: 'T1' }).some(e => e.type === 'report-bounced'), false);
  } finally { restore(); }
});

test('Claude: a block before the last instruction, the footer example and a broken last block are not taken', () => {
  const restore = testEnv();
  try {
    // a block answered an earlier instruction of the same session: the new instruction has none, so the repair path runs
    const old = endedRun([said(block('old answer')), { type: 'user', message: { role: 'user', content: 'Also fix the docs.' } }, said('Fixed the docs.'), result('Fixed the docs.')]);
    const [a] = findFinishes(old.project, old.orders, old.probes, old.workers);
    assert.ok(a.bounce, a.why); assert.equal(a.report_from, undefined);
    // the prompt's example block printed back
    const example = endedRun([said(`--- alba-report ---\n${JSON.stringify({ status: 'ready', summary: 'one sentence', evidence: [], commits: [] })}\n--- end ---`), result('Stopping.')]);
    assert.ok(findFinishes(example.project, example.orders, example.probes, example.workers)[0].bounce);
    // the last message has a block that does not parse: it is sent back for repair, an older good block does not hide that
    const broken = endedRun([said(block('older')), result('--- alba-report ---\n{"status":\n--- end ---')]);
    assert.ok(findFinishes(broken.project, broken.orders, broken.probes, broken.workers)[0].bounce?.error);
  } finally { restore(); }
});

test('Claude: a report the worker saved with the Write tool to a *.last.txt file of its own counts, and spacing inside the markers is forgiven', () => {
  const restore = testEnv();
  try {
    // as in MAP1-r7: the report went to a file the worker named itself, with "---  alba-report ---"
    const text = `MAP1-r7 Final Report\n\n---  alba-report ---\n${JSON.stringify({ status: 'progress', summary: 'autoplay blocked', evidence: [], commits: ['409ed46'] })}\n--- end ---\n`;
    const ctx = endedRun([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/x/.local/alba/runs/MAP1-r7.last.txt', content: text } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'File created successfully' }] } },
      said('The final report is complete. Summary: ...'), result('The final report is complete. Summary: ...'),
    ]);
    const [f] = findFinishes(ctx.project, ctx.orders, ctx.probes, ctx.workers);
    assert.equal(f.report?.status, 'progress'); assert.deepEqual(f.report?.commits, ['409ed46']);
    assert.deepEqual(f.report_from, { where: 'written-file', file: '/x/.local/alba/runs/MAP1-r7.last.txt' });
    // another file written with a block (a doc that shows the format) is not a report
    const doc = endedRun([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: 'docs/format.md', content: block('format example') } }] } }, result('Stopping.')]);
    assert.equal(findFinishes(doc.project, doc.orders, doc.probes, doc.workers)[0].report, undefined);
  } finally { restore(); }
});

test('Claude prompts tell the worker to wait for or stop its background commands before the final message', () => {
  const restore = testEnv();
  try {
    const ctx = endedRun([]);
    assert.match(readFileSync(ctx.run.prompt_file!, 'utf8'), /wait for or stop every background command you started/);
  } finally { restore(); }
});

test('a remote host that refused to start the worker fails the run with its reason, not as a missing report', () => {
  const restore = testEnv();
  try {
    const ctx = endedRun([]);
    writeFileSync(ctx.run.log!, '[remote] dispatch failed: 1 Git LFS file(s) are still pointer files after checkout, their objects are missing on this machine: Content/Hero.uasset\nRemote dispatch failed: 1 Git LFS file(s) are still pointer files after checkout, their objects are missing on this machine: Content/Hero.uasset\n');
    const [f] = findFinishes(ctx.project, ctx.orders, ctx.probes, ctx.workers);
    assert.equal(f.outcome, 'failed'); assert.equal(f.why, 'remote dispatch failed');
    assert.match(f.report!.summary, /before the worker started: 1 Git LFS file\(s\) are still pointer files .*Content\/Hero\.uasset/);
  } finally { restore(); }
});
