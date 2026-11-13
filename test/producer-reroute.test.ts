import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { createChatCase, intakeProducer, producerAct, producerPolicy, runProducerAction } from '../src/producer/producer.ts';
import { rerouteRefusal } from '../src/producer/reroute.ts';
import { compactSessionCard, mcpConfig, producerSystemPrompt } from '../src/producer/session.ts';
import { validateProducerToolCall } from '../src/producer/tool-schemas.ts';
import { attemptFacts, previousAttempts } from '../src/run/previous-attempts.ts';
import { startRun } from '../src/run/launch.ts';
import { answerOrder } from '../src/run/answer.ts';
import { sayToOrder } from '../src/run/say.ts';
import { tick, type Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { producerLog } from '../src/producer/activity.ts';
import { executeDispatch } from '../src/producer/dispatch.ts';
import { createBoard } from '../src/web/server.ts';
import type { AddressInfo } from 'node:net';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function fixture(mode: 'propose' | 'auto' = 'propose', repository = false) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game'), workOrders = path.join(dir, 'orders'), workersPath = path.join(dir, 'workers.yaml');
  mkdirSync(root); mkdirSync(workOrders);
  if (repository) { git(root, 'init', '-q', '-b', 'main'); writeFileSync(path.join(root, 'a.txt'), 'a'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first'); }
  writeFileSync(path.join(workOrders, 'T1-diagnose.md'), '# T1\nDiagnose the behaviour gate.\n');
  const raw = { workers: [
    { id: 'steady', aliases: ['primary'], engine: 'x', capabilities: ['shell', 'git', 'edit'], launch: { program: 'unused', args: ['{prompt_file}'] } },
    { id: 'expert', engine: 'x', capabilities: ['shell', 'git', 'edit'], concurrency: 1, daily_cap_usd: 10, launch: { program: 'unused', args: ['{prompt_file}'] } },
    { id: 'third', engine: 'x', capabilities: ['shell', 'git', 'edit'], launch: { program: 'unused', args: ['{prompt_file}'] } },
    { id: 'off', engine: 'x', enabled: false, capabilities: ['shell', 'git', 'edit'] },
    { id: 'reader', engine: 'x', capabilities: ['shell'] },
  ] };
  writeFileSync(workersPath, stringify(raw));
  const workers = validateWorkers(raw, workersPath);
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), workers: workersPath,
    roles: { default: { requires: ['shell', 'git', 'edit'], workers: { prefer: ['steady'] } } },
    producer: { enabled: true, escalate_to: ['expert', 'third', 'steady', 'off', 'reader'], rules: mode === 'auto' ? [{ id: 'escalate-hard', instruction: 'Change approach', action: 'reroute', mode }] : [], budgets: {} },
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
  }, path.join(dir, 'alba.yaml'));
  const now = new Date();
  const probes: Probes = { now: () => now, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined, spawnDetached: () => 4242 };
  orders.add({ tag: 'T1', title: 'Diagnose a behaviour gate', kind: 'diagnosis', worker: 'steady' });
  orders.act('T1', 'queue');
  for (let n = 0; n < 3; n++) { orders.runStart('T1', { worker: 'steady' }); orders.runEnd('T1', 'failed'); orders.report('T1', { status: 'failed', summary: 'Gate behaviour failed after a symptom patch.', evidence: [], commits: [] }); if (n < 2) orders.act('T1', 'queue'); }
  const c = createChatCase(project, 'synthetic-message');
  const act = (worker = 'expert', note = 'Reproduce the gate failure and redesign the state transition before patching symptoms.') => producerAct(project, orders, c.id, 'reroute', { target: 'T1', worker, note });
  return { project, orders, workers, probes, c, act, now };
}

test('reroute proposal waits for a person, queues failure, starts with host facts, and stays pinned', () => {
  const f = fixture('propose', true);
  f.orders.update('T1', { worker: 'primary' });
  assert.equal(producerPolicy(f.project).rules.find(r => r.id === 'escalate-hard')?.mode, 'propose');
  const proposal = f.act();
  assert.equal(proposal.status, 'proposed');
  assert.equal(f.orders.get('T1').order.next_worker, undefined);
  const done = runProducerAction(f.project, f.orders, proposal.id, undefined, f);
  assert.equal(done.status, 'done', done.refusal);
  assert.equal(f.orders.get('T1').reroutes?.[0].from, 'steady', 'history stores the worker id rather than its alias');
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued');
  assert.equal(producerLog(f.project, f.orders).rows[0].reroute?.to, 'expert');
  assert.deepEqual(producerLog(f.project, f.orders).now.budgets.find(b => b.key === 'escalations_per_day'), { key: 'escalations_per_day', used: 1, limit: 4, resetsAt: new Date(Date.UTC(f.now.getUTCFullYear(), f.now.getUTCMonth(), f.now.getUTCDate() + 1)).toISOString() });
  const plan = tick(f.project, f.orders, f.workers, f.probes, { record: false });
  assert.equal(plan.report.moves[0]?.worker, 'expert');
  startRun(f, 'T1', plan.report.moves[0].worker);
  const run = f.orders.get('T1').runs.at(-1)!;
  const prompt = readFileSync(run.prompt_file!, 'utf8');
  assert.match(prompt, /redesign the state transition/);
  assert.match(prompt, /## Previous attempts/);
  assert.match(prompt, /Runs: 3; workers: 1 \(steady\)/);
  assert.match(prompt, /Branch head: [a-f0-9]{40}/);
  assert.equal(run.previous_attempts?.includes('failed: Gate behaviour failed'), true);
  f.orders.runEnd('T1', 'failed'); f.orders.report('T1', { status: 'failed', summary: 'Needs another pass', evidence: [], commits: [] }); f.orders.act('T1', 'queue');
  assert.equal(tick(f.project, f.orders, f.workers, f.probes, { record: false }).report.moves[0]?.worker, 'expert');
  startRun(f, 'T1', 'expert');
  assert.doesNotMatch(readFileSync(f.orders.get('T1').runs.at(-1)!.prompt_file!, 'utf8'), /## Previous attempts/);
  f.orders.update('T1', { worker: 'steady' });
  assert.equal(f.orders.get('T1').order.next_worker, undefined, 'a person may reset even the original worker hint');
});

test('auto reroute preserves an active run and applies to the next dispatch; a full worker waits', () => {
  const f = fixture('auto');
  f.orders.act('T1', 'queue');
  const active = f.orders.runStart('T1', { worker: 'steady', extra: { pid: 4242 } }).run;
  delete f.project.workers;
  const done = producerAct(f.project, f.orders, f.c.id, 'reroute', { target: 'T1', worker: 'expert', note: 'Use the supplied workers context to diagnose the transition.' }, f);
  assert.equal(done.status, 'done', done.refusal);
  assert.deepEqual(f.orders.get('T1').runs.at(-1), active);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'running');
  f.orders.runEnd('T1', 'failed'); f.orders.report('T1', { status: 'failed', summary: 'Still failed', evidence: [], commits: [] }); f.orders.act('T1', 'queue');
  f.orders.add({ tag: 'T2', title: 'Other work', kind: 'diagnosis' }); f.orders.act('T2', 'queue'); f.orders.runStart('T2', { worker: 'expert', extra: { pid: 4243 } });
  const full = tick(f.project, f.orders, f.workers, f.probes, { record: false }).report;
  assert.equal(full.moves.some(m => m.tag === 'T1'), false);
  assert.ok(full.heldBack.some(h => h.tag === 'T1'));
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'queued');
  f.orders.runEnd('T2');
  assert.equal(tick(f.project, f.orders, f.workers, f.probes, { record: false }).report.moves.find(m => m.tag === 'T1')?.worker, 'expert');
});

test('answer starts on the pinned worker with the handoff brief', () => {
  const f = fixture('auto', true);
  assert.equal(f.act().status, 'done');
  f.orders.runStart('T1', { worker: 'steady' });
  f.orders.runEnd('T1', 'completed');
  f.orders.report('T1', { status: 'waiting', summary: 'Need direction', question: 'Which gate?', evidence: [], commits: [] });
  const answer = answerOrder(f, 'T1', 'Check the behaviour gate.');
  assert.equal(answer.started?.worker, 'expert', answer.message);
  assert.match(readFileSync(f.orders.get('T1').runs.at(-1)!.prompt_file!, 'utf8'), /## Previous attempts/);
  assert.equal(f.orders.get('T1').order.next_worker, 'expert');
});

test('restarting a running order uses the pin and its pending handoff', () => {
  const f = fixture('auto', true);
  f.orders.act('T1', 'queue');
  f.orders.runStart('T1', { worker: 'steady', extra: { pid: 4242 } });
  assert.equal(f.act().status, 'done');
  f.probes.isAlive = () => false;
  const result = sayToOrder(f, 'T1', 'Continue with a new approach.', { restart: true });
  assert.equal(result.started?.worker, 'expert', result.message);
  assert.match(readFileSync(f.orders.get('T1').runs.at(-1)!.prompt_file!, 'utf8'), /## Previous attempts/);
});

test('a person can start on a worker previously left, clearing the pin without ping-pong refusal', () => {
  const f = fixture('auto', true);
  assert.equal(f.act().status, 'done');
  startRun(f, 'T1', 'third', { dryRun: true, explicitWorker: true });
  assert.equal(f.orders.get('T1').order.next_worker, 'expert', 'previews do not change the pin');
  assert.equal(startRun(f, 'T1', 'steady', { explicitWorker: true }).worker, 'steady');
  const doc = f.orders.get('T1');
  assert.equal(doc.order.next_worker, undefined);
  assert.equal(doc.order.worker, 'steady');
  assert.equal(doc.reroutes?.length, 1, 'a person change is not a producer escalation');
  assert.ok(f.orders.store.events().some(e => e.type === 'worker-pin-cleared' && e.data?.person === true));
  f.orders.runEnd('T1', 'failed');
  f.orders.report('T1', { status: 'failed', summary: 'Try again', evidence: [], commits: [] }); f.orders.act('T1', 'queue');
  assert.equal(tick(f.project, f.orders, f.workers, f.probes, { record: false }).report.moves[0]?.worker, 'steady');
});

test('manual starts still allow a disabled worker while an effective pin enforces eligibility', () => {
  const f = fixture('auto', true);
  assert.equal(f.act().status, 'done');
  const worker = f.workers.workers.find(w => w.id === 'steady')!;
  worker.enabled = false;
  assert.equal(startRun(f, 'T1', worker.id, { explicitWorker: true }).worker, worker.id);
  assert.equal(f.orders.get('T1').order.next_worker, undefined);
});

test('unknown, disabled and newly unfit pins raise a problem and are dropped only on a recording tick', () => {
  for (const problem of ['removed', 'disabled', 'capabilities']) {
    const f = fixture('auto');
    assert.equal(f.act().status, 'done');
    if (problem === 'removed') f.workers.workers = f.workers.workers.filter(w => w.id !== 'expert');
    else if (problem === 'disabled') f.workers.workers.find(w => w.id === 'expert')!.enabled = false;
    else f.project.roles!.default.requires = ['vision'];
    const preview = tick(f.project, f.orders, f.workers, f.probes, { record: false });
    assert.ok(preview.report.problems.some(p => p.tag === 'T1' && /pin expert dropped/.test(p.text)));
    assert.equal(f.orders.get('T1').order.next_worker, 'expert');
    const result = tick(f.project, f.orders, f.workers, f.probes, { record: true });
    assert.ok(result.report.problems.some(p => /unknown worker|disabled worker|missing capabilities/.test(p.text)));
    assert.equal(f.orders.get('T1').order.next_worker, undefined);
    assert.equal(f.orders.get('T1').order.worker, 'steady');
    assert.ok(f.orders.store.events().some(e => e.type === 'worker-pin-cleared' && /unknown worker|disabled worker|missing capabilities/.test(String(e.data?.reason))));
    if (problem === 'disabled') {
      assert.equal(result.report.moves.find(m => m.tag === 'T1')?.worker, 'steady');
      assert.ok(!result.report.heldBack.some(h => h.tag === 'T1'), 'a disabled pin must not strand the order');
    }
  }
});

test('API run without an explicit worker uses the live reroute pin despite a stale board tick', async () => {
  for (const explicit of [false, true]) {
    const f = fixture('auto', true);
    f.orders.act('T1', 'queue');
    const board = createBoard({ projects: [f.project], workers: f.workers, probes: f.probes, port: 0, hubCheckMs: 100000 });
    try {
      await new Promise<void>(resolve => board.server.once('listening', resolve));
      const stale = board.ctx.snapshot();
      assert.equal(stale.projects[0].tick?.moves.find(m => m.tag === 'T1')?.worker, 'steady');
      board.ctx.snapshot = () => stale;
      assert.equal(f.act().status, 'done');
      const res = await fetch(`http://127.0.0.1:${(board.server.address() as AddressInfo).port}/api/orders/T1/actions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-alba-token': board.ctx.token, connection: 'close' },
        body: JSON.stringify({ action: 'run', ...(explicit ? { worker: 'third' } : {}) }),
      });
      assert.equal(res.status, 200, await res.text());
      const doc = f.orders.get('T1'), run = doc.runs.at(-1)!;
      assert.equal(run.worker, explicit ? 'third' : 'expert');
      assert.equal(doc.order.next_worker, explicit ? undefined : 'expert');
      assert.equal(doc.order.worker, explicit ? 'third' : 'steady');
      assert.equal(!!run.previous_attempts, !explicit);
      assert.match(readFileSync(run.prompt_file!, 'utf8'), /redesign the state transition/);
      const cleared = f.orders.store.events().filter(e => e.type === 'worker-pin-cleared');
      assert.equal(cleared.length, explicit ? 1 : 0);
      if (explicit) assert.equal(cleared[0].data?.person, true);
    } finally {
      board.hub.stop(); board.server.closeAllConnections();
      await new Promise<void>(resolve => board.server.close(() => resolve()));
    }
  }
});

test('producer dispatch drops an unfit pin with its actual reason and keeps the person worker hint', () => {
  for (const problem of ['disabled', 'capabilities']) {
    const f = fixture('auto', true);
    f.orders.update('T1', { worker: 'primary' });
    assert.equal(f.act().status, 'done');
    const expert = f.workers.workers.find(w => w.id === 'expert')!;
    if (problem === 'disabled') expert.enabled = false;
    else expert.capabilities = ['shell'];
    const preview = tick(f.project, f.orders, f.workers, f.probes, { record: false });
    assert.equal(preview.report.moves[0]?.worker, 'steady');
    assert.equal(f.orders.get('T1').order.next_worker, 'expert');
    assert.match(executeDispatch(f, 'T1'), /Started T1 with steady/);
    const doc = f.orders.get('T1');
    assert.equal(doc.order.next_worker, undefined);
    assert.equal(doc.order.worker, 'primary');
    const events = f.orders.store.events().filter(e => e.type === 'worker-pin-cleared');
    assert.equal(events.length, 1);
    assert.match(String(events[0].data?.reason), problem === 'disabled' ? /disabled worker/ : /missing capabilities/);
    assert.equal(events[0].data?.person, undefined);
    assert.equal(events[0].data?.to, undefined);
  }
});

test('an inferred worker cannot override a healthy pin, while an explicit answer worker can', () => {
  const f = fixture('auto', true);
  assert.equal(f.act().status, 'done');
  assert.throws(() => startRun(f, 'T1', 'third'), /pinned to worker expert/);
  assert.equal(f.orders.get('T1').order.next_worker, 'expert');
  f.orders.report('T1', { status: 'waiting', summary: 'Need direction', question: 'Which gate?', evidence: [], commits: [] });
  const result = answerOrder(f, 'T1', 'Check the recovery gate.', { worker: 'third' });
  assert.equal(result.started?.worker, 'third', result.message);
  assert.equal(f.orders.get('T1').order.next_worker, undefined);
  assert.equal(f.orders.get('T1').order.worker, 'third');
});

test('loop facts and a pending reroute proposal survive the next intake unchanged', () => {
  const f = fixture();
  const log = path.join(f.project.root, 'attempt.log');
  writeFileSync(log, [1, 2, 3].flatMap(id => [
    JSON.stringify({ type: 'tool_call', toolCallId: String(id), title: 'run_terminal_command', toolName: 'run_terminal_command', rawInput: { command: 'node check.js' }, status: 'pending' }),
    JSON.stringify({ type: 'tool_call_update', toolCallId: String(id), status: 'in_progress', rawOutput: { type: 'Bash', output_for_prompt: 'Error: invalid transition', exit_code: 2, command: 'node check.js' } }),
  ]).join('\n'));
  f.orders.patchRun('T1', f.orders.get('T1').runs.at(-1)!.id, { log });
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.trigger === 'repeated-failure')!;
  assert.equal((c.facts.loops as string[]).length, 1);
  const proposal = producerAct(f.project, f.orders, c.id, 'reroute', { target: 'T1', worker: 'expert', note: 'Redesign the state transition.' });
  assert.equal(proposal.status, 'proposed');
  const next = intakeProducer(f.project, f.orders, { verify: false }).find(next => next.id === c.id)!;
  assert.equal(next.revision, c.revision);
  assert.deepEqual(next.facts, c.facts);
  assert.equal(runProducerAction(f.project, f.orders, proposal.id, undefined, f).status, 'done');
});

test('capacity and cancelled runs do not count as consecutive failures', () => {
  for (const outcome of ['capacity', 'cancelled'] as const) {
    const f = fixture();
    f.orders.act('T1', 'queue');
    f.orders.runStart('T1', { worker: 'steady' });
    f.orders.runEnd('T1', outcome);
    assert.equal(attemptFacts(f.orders.get('T1')).consecutive_failures, 0);
    if (f.orders.stage(f.orders.get('T1')).stage !== 'queued') f.orders.act('T1', 'queue');
    f.orders.runStart('T1', { worker: 'steady' });
    f.orders.runEnd('T1', 'completed');
    assert.equal(attemptFacts(f.orders.get('T1')).consecutive_failures, 1, 'a real no-report ending still counts');
  }
});

test('rework evidence expires and active or ready orders have no repeated-failure case', () => {
  const f = fixture();
  const doc = f.orders.get('T1');
  doc.actions.push(...[1, 2, 3].map(seq => ({ kind: 'rework' as const, seq: -seq, at: doc.order.created, note: 'Old review' })));
  f.orders.store.write(doc);
  assert.equal(attemptFacts(doc).reworks, 0, 'reworks before the recent attempt window are historical');
  f.orders.act('T1', 'queue');
  f.orders.runStart('T1', { worker: 'steady', extra: { pid: 4242 } });
  assert.ok(!intakeProducer(f.project, f.orders, { verify: false }).some(c => c.trigger === 'repeated-failure'));
  f.orders.runEnd('T1', 'completed');
  f.orders.report('T1', { status: 'ready', summary: 'Gate behaviour passed', evidence: [], commits: [] });
  assert.ok(!intakeProducer(f.project, f.orders, { verify: false }).some(c => c.trigger === 'repeated-failure'));
});

test('implicit escalation and allowlist edits preserve pending policy hashes; MCP gets the resolved workers file', () => {
  const f = fixture();
  const p = f.project, b = p.producer;
  const beforeUpgrade = { enabled: b.enabled, rules: b.rules, budgets: b.budgets, session: b.session, drafting: p.drafting, round: b.round, monitor: p.monitor, clean: p.clean, dispatch: p.dispatch };
  const oldHash = createHash('sha256').update(JSON.stringify(beforeUpgrade)).digest('hex');
  assert.equal(producerPolicy(p).hash, oldHash);
  const proposal = f.act();
  p.producer.escalate_to = ['expert'];
  assert.equal(producerPolicy(p).hash, oldHash);
  assert.equal(runProducerAction(p, f.orders, proposal.id, undefined, f).status, 'done');
  delete p.workers;
  const file = mcpConfig(p, false, f.workers.file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers['alba-producer'].env.ALBA_WORKERS, path.resolve(f.workers.file));
});

test('reroute refusals preserve the order and explain worker, role, stage, spend and empty-list failures', () => {
  const f = fixture();
  for (const [worker, reason] of [['missing', /unknown worker/], ['off', /disabled/], ['reader', /capabilities/], ['steady', /same as/]] as const) {
    const before = f.orders.get('T1'); const action = f.act(worker);
    assert.equal(action.status, 'refused'); assert.match(action.refusal!, reason); assert.deepEqual(f.orders.get('T1'), before);
  }
  f.project.producer.escalate_to = [];
  assert.match(f.act('expert', 'Empty list test').refusal!, /default list is empty/);
  f.project.producer.escalate_to = ['expert', 'third'];
  f.orders.act('T1', 'hold'); assert.match(f.act('expert', 'Held order test').refusal!, /held/); f.orders.act('T1', 'release');
  f.orders.add({ tag: 'SPEND', title: 'Cap evidence', kind: 'diagnosis' }); f.orders.act('SPEND', 'queue');
  const spent = f.orders.runStart('SPEND', { worker: 'expert' }).run;
  f.orders.patchRun('SPEND', spent.id, { started: f.now.toISOString(), usage: { source: 'unknown', cost_usd: 10 } });
  assert.match(f.act('expert', 'Spend cap test').refusal!, /spend cap reached/);
  assert.match(f.act('third', 'x'.repeat(2001)).refusal!, /2000 characters/);
  assert.match(f.act('third', ' ').refusal!, /non-empty note/);
});

test('execution rechecks spend, per-order 24 hours, no return, and daily allowance atomically', () => {
  const f = fixture();
  const proposed = f.act();
  f.workers.workers.find(w => w.id === 'expert')!.daily_cap_usd = 0;
  assert.match(runProducerAction(f.project, f.orders, proposed.id, undefined, f).refusal!, /spend cap/);
  assert.equal(f.orders.get('T1').reroutes, undefined);
  f.workers.workers.find(w => w.id === 'expert')!.daily_cap_usd = 10;
  const done = runProducerAction(f.project, f.orders, f.act('expert', 'Try structural analysis').id, undefined, f);
  assert.equal(done.status, 'done');
  assert.match(f.act('third').refusal!, /one reroute per order/);
  const doc = f.orders.get('T1');
  doc.reroutes![0].by = 'cli'; f.orders.store.write(doc);
  assert.match(rerouteRefusal(f.project, f.orders, f.orders.get('T1'), 'steady', 'Return', f, f.now)!, /cannot return/);
  const later = new Date(f.now.getTime() + 86400_001);
  assert.equal(rerouteRefusal(f.project, f.orders, f.orders.get('T1'), 'steady', 'Return later', f, later), undefined);
  const current = f.orders.get('T1'); current.reroutes![0].by = 'producer'; f.orders.store.write(current);
  f.project.producer.budgets.escalations_per_day = 1;
  f.orders.add({ tag: 'T3', title: 'Another diagnosis', kind: 'diagnosis', worker: 'steady' });
  assert.match(rerouteRefusal(f.project, f.orders, f.orders.get('T3'), 'expert', 'A new approach', f, f.now)!, /daily escalation allowance/);
});

test('router cards and bounded handoff expose attempt facts; tool requires reroute fields', () => {
  const f = fixture();
  const facts = attemptFacts(f.orders.get('T1'), ['Repeated diagnosis']);
  assert.equal(facts.consecutive_failures, 3); assert.deepEqual(facts.same_gate_failing, ['behaviour']);
  const c = intakeProducer(f.project, f.orders, { verify: false }).find(c => c.order === 'T1')!;
  const card = compactSessionCard(c, f.project);
  assert.equal(card.runs, 3); assert.equal(card.consecutive_failures, 3); assert.equal(card.reworks, 0);
  const missing = compactSessionCard({ ...f.c, order: 'T1' }, f.project);
  for (const key of ['runs', 'consecutive_failures', 'reworks']) assert.ok(!Object.hasOwn(missing, key), `${key} is absent rather than invented`);
  assert.match(producerSystemPrompt(f.project), /escalate-hard/);
  assert.ok(previousAttempts(f.orders.get('T1'), ['x'.repeat(10000)]).length <= 6000);
  validateProducerToolCall('producer_act', { actions: [{ case: c.id, kind: 'reroute', target: 'T1', worker: 'expert', note: 'Change the approach' }] });
  for (const fields of [{ target: 'T1', worker: 'expert' }, { target: 'T1', note: 'Change' }, { worker: 'expert', note: 'Change' }, { target: 'T1', worker: 'expert', note: 'x'.repeat(2001) }]) {
    assert.throws(() => validateProducerToolCall('producer_act', { actions: [{ case: c.id, kind: 'reroute', ...fields }] }), /Invalid producer_act/);
  }
});
