import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scheduledRound } from '../src/producer/round.ts';
import { producerBriefs } from '../src/producer/briefs.ts';
import { producerAct, producerActions, runProducerAction, syncRoundCases } from '../src/producer/producer.ts';
import { ProducerSessionManager, type SessionEngine } from '../src/producer/session.ts';
import { producerNotes, writeProducerNotes } from '../src/producer/notes.ts';
import { repeatedFailure, LOOP_REFUSAL } from '../src/producer/loop-guard.ts';
import { staleMonitor } from '../src/monitor/stale.ts';
import { runMonitors } from '../src/monitor/monitor.ts';
import { Orders } from '../src/orders/service.ts';
import { readStateFile, writeStateFile } from '../src/orders/state-files.ts';
import { planClean, applyClean, systemClean } from '../src/clean/clean.ts';
import { systemProbes, type Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { testStore, validateProject } from './state-helper.ts';
import { tempOrders } from './helpers.ts';
import { git } from './api-fixture.ts';
import { executeDispatch } from '../src/producer/dispatch.ts';
import { callProducerTool } from '../src/producer/mcp.ts';
import { acquireAcceptanceResources, releaseAcceptanceResources } from '../src/resources/leases.ts';

function fixture(extra: Record<string, unknown> = {}) {
  const { dir } = tempOrders();
  const root = path.join(dir, 'game'), bodies = path.join(dir, 'orders');
  mkdirSync(root); mkdirSync(bodies);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, '.gitignore'), 'Library/\nartifacts/\n');
  writeFileSync(path.join(root, 'a.txt'), 'base');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: bodies, state_dir: path.join(dir, 'state'),
    producer: { enabled: true, round: { every_minutes: 60, enabled: true }, session: { enabled: true } },
    dispatch: { min_free_ram_gb: 4, stall_minutes: 30, worktree_parent: dir, base_ref: 'refs/heads/main' }, ...extra }, path.join(dir, 'alba.yaml'));
  let now = new Date('2026-01-01T00:00:00Z'), processStart = '2025-12-31T23:00:00Z';
  let alive = false, ram: number | undefined = 32, output = 'building out/progress.log', fileAt: string | undefined;
  const spawned: string[] = [];
  const orders = new Orders(testStore(project.state_dir), () => now.toISOString(), 'fixture', () => processStart);
  const probes: Probes = { ...systemProbes, now: () => now, runCommand: () => '[]', worktrees: () => [],
    gitActivity: () => ({ lastCommitAt: '2026-01-01T00:10:00Z' }), isAlive: () => alive, processStartedAt: () => alive ? processStart : undefined,
    fileTime: file => file.endsWith('progress.log') ? fileAt : undefined, tail: () => '', readText: () => undefined,
    freeRamGb: () => ram, spawnDetached: program => { spawned.push(program); return 4242; },
    runCheck: () => ({ code: 0, output, timedOut: false }) };
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'fake', concurrency: 4,
    launch: { program: 'fixture-worker', args: ['{prompt_file}'] } }] }, 'workers.yaml');
  const clean = { ...systemClean(probes), processes: () => [], executableProcesses: () => [], freeDiskGb: () => 100 };
  const env = { probes, workers, clean };
  const add = (tag: string, options: Record<string, unknown> = {}) => {
    orders.add({ tag, title: tag, kind: 'sim', ...options });
    if (typeof options.priority === 'number') orders.update(tag, { priority: options.priority });
    writeFileSync(path.join(bodies, `${tag}-task.md`), `# ${tag}\n## Acceptance\nFinish the fixture task.\n`);
  };
  const advance = (minutes: number) => { now = new Date(now.getTime() + minutes * 60000); };
  const monitor = (tag = 'MON', pid?: number) => {
    add(tag); orders.act(tag, 'queue'); orders.runStart(tag, { worker: 'coder' }); orders.runEnd(tag);
    orders.report(tag, { status: 'monitoring', summary: 'Background job', evidence: [], commits: [], monitor: {
      check: ['fixture-status', 'out/progress.log'], done_when: { output_matches: '^done$' }, deadline_minutes: 300, ...(pid ? { pid } : {}) } });
  };
  return { dir, root, project, orders, env, probes, spawned, add, advance, monitor,
    alive: (value: boolean) => { alive = value; }, ram: (value?: number) => { ram = value; },
    processStart: (value: string) => { processStart = value; }, fileAt: (value: string) => { fileAt = value; }, output: (value: string) => { output = value; } };
}

test('round is opt-in; a quiet due round stores a brief and starts no fake engine', async () => {
  const f = fixture();
  delete f.project.producer.round;
  assert.equal(scheduledRound(f.project, f.orders, f.env), undefined);
  assert.equal(producerBriefs(f.project).length, 0);
  f.project.producer.round = { every_minutes: 60, enabled: true };
  let starts = 0, batches = 0;
  const engine: SessionEngine = { async start() { starts++; }, async sendBatch() { batches++; }, async *readEvents() {}, async stop() {}, usage: () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }) };
  const manager = new ProducerSessionManager(f.project, f.orders, () => engine);
  const round = scheduledRound(f.project, f.orders, f.env)!;
  assert.deepEqual(round.cases, []);
  await manager.onPass(round.cases);
  assert.deepEqual([starts, batches], [0, 0]);
  assert.match(producerBriefs(f.project)[0].skeleton, /stalls, monitors, dispatch, repeated failures and disk/);
  assert.equal(scheduledRound(f.project, f.orders, f.env), undefined);
  f.advance(60); assert.deepEqual(scheduledRound(f.project, f.orders, f.env)!.cases, []);
  await manager.stop();
});

test('fixture round opens stalled-run, stale monitor and dispatch cards with stable revisions', () => {
  const f = fixture();
  f.add('STALL', { worktree: f.root }); f.orders.act('STALL', 'queue'); f.orders.runStart('STALL', { worker: 'coder' });
  f.alive(true);
  f.monitor('MON', 88); assert.equal(f.orders.get('MON').monitor?.process_started_at, '2025-12-31T23:00:00Z');
  runMonitors(f.project, f.orders, f.probes);   // the first look at its output; it does not change afterwards
  for (const [tag, priority] of [['NEXT', 3], ['LATER', 2], ['LAST', 1]] as const) { f.add(tag, { priority }); f.orders.act(tag, 'queue'); }
  f.advance(120);
  const round = scheduledRound(f.project, f.orders, f.env)!;
  assert.deepEqual(round.cases.map(c => c.trigger).sort(), ['dispatch', 'monitor-stale', 'stalled-run']);
  const dispatch = round.cases.find(c => c.trigger === 'dispatch')!;
  assert.equal(dispatch.order, 'NEXT');
  assert.deepEqual((dispatch.facts.next as { tag: string }[]).map(n => n.tag), ['LATER', 'LAST']);
  assert.match(round.cases.find(c => c.trigger === 'monitor-stale')!.card.summary, /have not changed for 45 minutes/);
  const rework = producerActions(f.project).find(a => a.kind === 'rework')!;
  assert.equal(rework.status, 'proposed'); assert.match(rework.note!, /have not changed for 45 minutes/);
  assert.equal(f.spawned.length, 0);
  f.advance(60);
  const again = scheduledRound(f.project, f.orders, f.env)!;
  assert.ok(again.cases.every(c => c.revision === 1));
  assert.equal(producerActions(f.project).length, 2);
});

test('next planned order opens drafting instead of dispatch and needs are respected', () => {
  const f = fixture();
  f.orders.add({ tag: 'PLAN', title: 'Plan', kind: 'sim', planned: true });
  f.orders.update('PLAN', { priority: 10 });
  f.add('READY'); f.orders.act('READY', 'queue');
  const round = scheduledRound(f.project, f.orders, f.env)!;
  assert.deepEqual(round.cases.map(c => [c.trigger, c.order]), [['ready-to-draft', 'PLAN']]);
  assert.equal(producerActions(f.project).length, 0);
  f.orders.update('PLAN', { needs: ['READY'] }); f.advance(60);
  assert.equal(scheduledRound(f.project, f.orders, f.env)!.cases.find(c => c.trigger === 'dispatch')?.order, 'READY');
});

test('dispatch alternatives share tick priority, source row and rework ordering', () => {
  const f = fixture();
  for (const [tag, priority, row] of [['HIGH', 10, 50], ['AAA', 5, 20], ['ZZZ', 5, 2]] as const) {
    f.add(tag, { priority, source: { row } }); f.orders.act(tag, 'queue');
  }
  const first = scheduledRound(f.project, f.orders, f.env)!.cases.find(c => c.trigger === 'dispatch')!;
  assert.equal(first.order, 'HIGH');
  assert.deepEqual((first.facts.next as { tag: string }[]).map(n => n.tag), ['ZZZ', 'AAA']);
  f.add('REWORK'); f.orders.act('REWORK', 'queue'); f.orders.runStart('REWORK', { worker: 'coder' }); f.orders.runEnd('REWORK');
  f.orders.report('REWORK', { status: 'ready', summary: 'Fixture delivery', evidence: [], commits: [] });
  f.orders.act('REWORK', 'rework', { note: 'Repair the fixture' }); f.advance(60);
  const second = scheduledRound(f.project, f.orders, f.env)!.cases.find(c => c.trigger === 'dispatch')!;
  assert.equal(second.order, 'REWORK');
  assert.deepEqual((second.facts.next as { tag: string }[]).map(n => n.tag), ['HIGH', 'ZZZ']);
});

test('a monitored job whose process ended (or whose pid was reused) is checked once more and handed back: its condition decides, else it ended without success', () => {
  const f = fixture(); f.monitor('MON', 88);
  assert.match(staleMonitor(f.project, f.orders.get('MON'), f.probes)!.reason, /no longer exists/);
  // The job exited after it finished: its check says done (it stayed "monitoring" forever before).
  f.output('done');
  assert.deepEqual(runMonitors(f.project, f.orders, f.probes).resolved, ['MON']);
  assert.equal(f.orders.get('MON').monitor?.resolved?.result, 'done');
  assert.equal(f.orders.stage(f.orders.get('MON')).stage, 'queued');
  // The job exited and neither condition holds: it ended without success, and the worker is told so.
  f.output('building out/progress.log');
  f.monitor('GONE', 89);
  const gone = runMonitors(f.project, f.orders, f.probes);
  assert.deepEqual(gone.resolved, ['GONE']);
  assert.match(gone.done[0], /GONE: the monitored job \(pid 89\) has ended without meeting its condition; the order goes back to its worker/);
  assert.equal(f.orders.get('GONE').monitor?.resolved?.result, 'failed');
  assert.match(f.orders.get('GONE').actions.at(-1)!.note!, /its process \(pid 89\) is gone and neither condition you gave was met/);
  // A pid that now belongs to another process is the same: the job is gone.
  f.alive(true); f.processStart('2026-01-01T00:01:00Z'); f.advance(1); f.monitor('REUSED', 90); f.processStart('2026-01-01T00:02:00Z');
  assert.match(staleMonitor(f.project, f.orders.get('REUSED'), f.probes)!.reason, /reused/);
  assert.deepEqual(runMonitors(f.project, f.orders, f.probes).resolved, ['REUSED']);
  assert.equal(f.orders.get('REUSED').monitor?.resolved?.result, 'failed');
});

test('monitor stale evidence covers unchanged output and named file changes', () => {
  const f = fixture(); f.alive(true); f.monitor('MON', 88);
  f.output('building out/progress.log');
  runMonitors(f.project, f.orders, f.probes); f.advance(44);
  assert.equal(staleMonitor(f.project, f.orders.get('MON'), f.probes), undefined);
  f.advance(2); runMonitors(f.project, f.orders, f.probes);
  assert.match(staleMonitor(f.project, f.orders.get('MON'), f.probes)!.reason, /45 minutes/);
  f.fileAt('2026-01-01T00:46:00Z'); runMonitors(f.project, f.orders, f.probes);
  assert.equal(staleMonitor(f.project, f.orders.get('MON'), f.probes), undefined);
  f.advance(46); f.output('building out/progress.log 80%'); runMonitors(f.project, f.orders, f.probes);
  assert.equal(staleMonitor(f.project, f.orders.get('MON'), f.probes), undefined);
});

test('dispatch acceptance launches once with fake probes and refuses memory, caps, quota, resources and needs changes', () => {
  const proposal = () => { const f = fixture(); f.add('NEXT'); f.orders.act('NEXT', 'queue'); scheduledRound(f.project, f.orders, f.env); return f; };
  for (const memory of [0, undefined]) {
    const f = proposal(); f.ram(memory);
    const action = runProducerAction(f.project, f.orders, producerActions(f.project)[0].id, undefined, f.env);
    assert.equal(action.status, 'refused'); assert.match(action.refusal!, /memory/); assert.equal(f.spawned.length, 0);
  }
  for (const gate of ['caps', 'quota', 'resources', 'needs'] as const) {
    const f = proposal();
    if (gate === 'caps') { f.project.dispatch.caps.sim = 0; }
    if (gate === 'quota') f.env.workers.workers[0].enabled = false;
    if (gate === 'resources') { f.project.resources = { disk: { slots: 0, exclusive: false, blocks: [], lease_minutes: 60 } }; f.orders.update('NEXT', { uses: ['disk'] }); }
    if (gate === 'needs') { f.add('DEPENDENCY'); f.orders.update('NEXT', { needs: ['DEPENDENCY'] }); }
    const a = runProducerAction(f.project, f.orders, producerActions(f.project)[0].id, undefined, f.env);
    assert.ok(['refused', 'superseded'].includes(a.status), `${gate}: ${a.status}`); assert.equal(f.spawned.length, 0);
  }
  const f = proposal(); const id = producerActions(f.project)[0].id;
  assert.equal(runProducerAction(f.project, f.orders, id, undefined, f.env).status, 'done');
  assert.equal(runProducerAction(f.project, f.orders, id, undefined, f.env).status, 'done');
  assert.equal(f.spawned.length, 1); assert.ok(f.orders.store.events().some(e => e.type === 'producer-dispatch'));
});

test('dispatch rechecks acceptance cap and resource reservations after a proposal', () => {
  for (const reservation of ['cap', 'resource'] as const) {
    const f = fixture({ dispatch: { min_free_ram_gb: 4, caps: { sim: 1 } },
      ...(reservation === 'resource' ? { resources: { disk: { slots: 1 } } } : {}) });
    f.add('NEXT', reservation === 'resource' ? { uses: ['disk'] } : {});
    f.orders.act('NEXT', 'queue');
    scheduledRound(f.project, f.orders, f.env);
    const proposal = producerActions(f.project).find(a => a.kind === 'dispatch')!;
    assert.ok(proposal);
    f.add('REVIEW');
    assert.equal(acquireAcceptanceResources(f.project, f.orders, 'REVIEW', [reservation === 'cap' ? 'sim' : 'disk']), undefined);
    try {
      const result = runProducerAction(f.project, f.orders, proposal.id, undefined, f.env);
      assert.equal(result.status, 'refused');
      assert.match(result.refusal!, reservation === 'cap' ? /cap.*full/ : /resource disk is full/);
      assert.equal(f.spawned.length, 0);
      f.advance(60);
      assert.ok(!scheduledRound(f.project, f.orders, f.env)!.cases.some(c => c.trigger === 'dispatch'));
    } finally { releaseAcceptanceResources(f.project, f.orders, 'REVIEW'); }
    f.advance(60);
    assert.equal(scheduledRound(f.project, f.orders, f.env)!.cases.find(c => c.trigger === 'dispatch')?.order, 'NEXT');
  }
});

test('a third identical producer requeue is refused with an event; naming a different fix passes', () => {
  const f = fixture({ producer: { enabled: true, round: { every_minutes: 60, enabled: true }, rules: [{ id: 'queue', action: 'queue', mode: 'propose', instruction: 'Queue after checking failures' }] } });
  f.add('LOOP');
  const c = () => syncRoundCases(f.project, [{ key: 'round/repeated-failure/LOOP', trigger: 'repeated-failure', order: 'LOOP', facts: { roundFingerprint: f.probes.now().toISOString() }, card: { trigger: 'repeated-failure', summary: 'Empty report', pointers: [], untrusted: [] } }], f.probes.now().toISOString())[0];
  for (let i = 0; i < 2; i++) {
    f.advance(1);
    const action = producerAct(f.project, f.orders, c().id, 'queue', { note: 'Try again', now: f.probes.now() });
    assert.equal(runProducerAction(f.project, f.orders, action.id, undefined, f.env).status, 'done');
    f.orders.runStart('LOOP', { worker: 'coder' }); f.orders.runEnd('LOOP');
    f.orders.report('LOOP', { status: 'failed', summary: 'empty report block', evidence: [], commits: [] });
  }
  assert.ok(repeatedFailure(f.orders.get('LOOP')));
  f.advance(1); const third = producerAct(f.project, f.orders, c().id, 'queue', { note: 'Try again', now: f.probes.now() });
  assert.equal(third.status, 'refused'); assert.equal(third.refusal, LOOP_REFUSAL);
  assert.ok(f.orders.store.events().some(e => e.type === 'producer-refused' && (e.data as { reason: string }).reason === LOOP_REFUSAL));
  const repair = producerAct(f.project, f.orders, c().id, 'queue', { note: 'Empty report block: fix: validate the report before exiting and print every required field.', now: f.probes.now() });
  assert.equal(runProducerAction(f.project, f.orders, repair.id, undefined, f.env).status, 'done');
  f.advance(60); assert.ok(scheduledRound(f.project, f.orders, f.env)!.cases.some(c => c.trigger === 'repeated-failure'));
});

test('project notes roll into dated archives and order notes remain separate', () => {
  const f = fixture(); f.project.producer.session.notes_chars = 20;
  writeProducerNotes(f.project, 'old project facts');
  const result = writeProducerNotes(f.project, 'new project facts');
  assert.equal(result.text.length, 20); assert.match(result.archive!, /^producer-notes-archive-\d{4}-\d{2}-\d{2}\.md$/);
  assert.match(readStateFile(f.project, result.archive!)!, /old project/);
  writeProducerNotes(f.project, 'order one facts', false, 'ONE');
  writeProducerNotes(f.project, 'order two facts', false, 'TWO');
  assert.match(producerNotes(f.project, 'one'), /order one/); assert.match(producerNotes(f.project, 'TWO'), /order two/);
  const replaced = writeProducerNotes(f.project, 'replacement', true);
  assert.match(readStateFile(f.project, replaced.archive!)!, /new project facts/);
  f.add('ONE');
  assert.deepEqual(callProducerTool(f.project, f.orders, 'producer_notes', { tag: 'one' }), { text: producerNotes(f.project, 'ONE') });
  callProducerTool(f.project, f.orders, 'producer_notes', { tag: 'ONE', text: 'updated', replace: true });
  assert.match(producerNotes(f.project, 'ONE'), /updated/);
  assert.throws(() => callProducerTool(f.project, f.orders, 'producer_notes', { tag: 'MISSING' }), /No order/);
});

test('dispatch reads live cap, resource, needs and quota gates rather than reserving a proposal slot', () => {
  const f = fixture(); f.project.dispatch.caps.sim = 1;
  f.project.resources = { disk: { slots: 1, exclusive: false, blocks: [], lease_minutes: 60 } };
  f.add('NEXT', { uses: ['disk'] }); f.orders.act('NEXT', 'queue');
  f.add('BUSY'); f.orders.runStart('BUSY', { worker: 'coder' });
  assert.throws(() => executeDispatch({ ...f.env, project: f.project, orders: f.orders }, 'NEXT'), /cap.*full/);
  f.orders.runEnd('BUSY'); f.project.dispatch.caps.sim = 2;
  f.monitor('HOLDER');
  writeStateFile(f.project, '_leases.json', JSON.stringify({ leases: [{ tag: 'HOLDER', resource: 'disk', since: f.probes.now().toISOString(), expires: '2026-01-02T00:00:00Z' }] }));
  assert.throws(() => executeDispatch({ ...f.env, project: f.project, orders: f.orders }, 'NEXT'), /resource disk is full/);
  f.orders.act('HOLDER', 'cancel');
  f.orders.update('NEXT', { needs: ['BUSY'] });
  assert.throws(() => executeDispatch({ ...f.env, project: f.project, orders: f.orders }, 'NEXT'), /needs/);
  f.orders.update('NEXT', { needs: [] });
  const workers = validateWorkers({ quota_sources: { q: { type: 'command-json', command: ['fixture-quota'], windows: 'windows', window_fields: { name: 'name', used: 'used' } } },
    workers: [{ id: 'coder', engine: 'fake', quota: 'q', disabled_when: [{ window_full: '*' }], launch: { program: 'fixture-worker', args: ['{prompt_file}'] } }] }, 'workers.yaml');
  const probes = { ...f.probes, runCommand: () => JSON.stringify({ windows: [{ name: 'day', used: 100 }] }) };
  assert.throws(() => executeDispatch({ project: f.project, orders: f.orders, workers, probes }, 'NEXT'), /quota|window|nobody|available|full/i);
  assert.equal(f.spawned.length, 0);
});

test('clean round card keeps packages under review, applies exact accepted plan in a temporary folder, and records last clean', () => {
  const f = fixture({ clean: { idle_hours: 0, packages: [{ dir: 'artifacts/packages', keep: 1 }], logs_days: 1, drives: [{ path: '.', min_free_gb: 10 }], min_gain_gb: 0 } });
  f.env.clean.freeDiskGb = () => 2;
  for (const tag of ['MERGED', 'REVIEW', 'UNMERGED']) { f.add(tag); if (tag === 'MERGED') f.orders.act(tag, 'approve', { force: true }); }
  f.orders.act('REVIEW', 'queue'); f.orders.runStart('REVIEW', { worker: 'coder' }); f.orders.runEnd('REVIEW'); f.orders.report('REVIEW', { status: 'ready', summary: 'Review package', evidence: [], commits: [] });
  const packages = path.join(f.root, 'artifacts/packages');
  for (const [index, name] of ['MERGED-old', 'REVIEW-old', 'UNMERGED-old', 'MERGED-new'].entries()) {
    const dir = path.join(packages, name); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'package.bin'), 'fixture bytes'); utimesSync(dir, index + 1, index + 1);
  }
  const logs = path.join(f.project.state_dir, 'runs'); mkdirSync(logs, { recursive: true });
  const log = path.join(logs, 'old.log'); writeFileSync(log, 'old log'); utimesSync(log, 1, 1);
  const round = scheduledRound(f.project, f.orders, f.env)!;
  const card = round.cases.find(c => c.trigger === 'clean')!; assert.ok(card); assert.equal(round.plan.drives![0].low, true);
  const deletions = round.plan.items.filter(i => i.action === 'delete');
  assert.deepEqual(deletions.map(i => i.pathClass).sort(), ['logs', 'packages']);
  assert.ok(deletions.every(i => i.signature && i.bytes! > 0));
  const action = producerActions(f.project).find(a => a.kind === 'clean')!;
  assert.equal(action.mode, 'propose'); assert.ok(existsSync(log));
  const accepted = runProducerAction(f.project, f.orders, action.id, undefined, f.env);
  assert.equal(accepted.status, 'done'); assert.ok(!existsSync(log)); assert.ok(!existsSync(path.join(packages, 'MERGED-old')));
  for (const name of ['MERGED-new', 'REVIEW-old', 'UNMERGED-old']) assert.ok(existsSync(path.join(packages, name)));
  assert.match(readStateFile(f.project, '_producer-last-clean.json')!, /deleted/);
});

test('clean auto classes require explicit allowlisting and destructive opt-in', () => {
  const f = fixture({ producer: { enabled: true, round: { every_minutes: 60, enabled: true }, rules: [{ id: 'clean', action: 'clean', mode: 'auto', instruction: 'Clean eligible artifacts' }] }, clean: { logs_days: 0, min_gain_gb: 0, auto_classes: ['logs'], packages: [{ dir: 'artifacts/packages', keep: 0 }] } });
  const logs = path.join(f.project.state_dir, 'runs'); mkdirSync(logs, { recursive: true }); const log = path.join(logs, 'old.log'); writeFileSync(log, 'old'); utimesSync(log, 1, 1);
  scheduledRound(f.project, f.orders, f.env); assert.ok(!existsSync(log)); assert.equal(producerActions(f.project)[0].mode, 'auto');
  f.add('MERGED'); f.orders.act('MERGED', 'approve', { force: true });
  const pkg = path.join(f.root, 'artifacts/packages/MERGED-old'); mkdirSync(pkg, { recursive: true }); writeFileSync(path.join(pkg, 'x'), 'bytes');
  f.advance(60); scheduledRound(f.project, f.orders, f.env);
  const pending = producerActions(f.project).find(a => a.status === 'proposed')!;
  assert.equal(pending.mode, 'propose'); assert.ok(existsSync(pkg));
  assert.throws(() => validateProject({ id: 'x', name: 'x', root: f.root, work_orders: f.root, state_dir: f.project.state_dir, clean: { auto_classes: ['worktrees'] } }, f.project.file), /auto_classes/);
  assert.throws(() => validateProject({ id: 'x', name: 'x', root: f.root, work_orders: f.root, state_dir: f.project.state_dir, clean: { auto_destructive: 'true' } }, f.project.file), /auto_destructive/);
  const optedIn = validateProject({ id: 'x', name: 'x', root: f.root, work_orders: f.root, state_dir: f.project.state_dir, clean: { auto_destructive: true, auto_classes: ['worktrees', 'packages'] } }, f.project.file);
  assert.deepEqual(optedIn.clean!.auto_classes, ['worktrees', 'packages']);
  const automatic = fixture({ producer: { enabled: true, round: { every_minutes: 60, enabled: true }, rules: [{ id: 'clean', action: 'clean', mode: 'auto', instruction: 'Clean eligible artifacts' }] }, clean: { auto_destructive: true, auto_classes: ['packages'], min_gain_gb: 0, packages: [{ dir: 'artifacts/packages', keep: 0 }] } });
  automatic.add('MERGED'); automatic.orders.act('MERGED', 'approve', { force: true });
  const autoPackage = path.join(automatic.root, 'artifacts/packages/MERGED-old'); mkdirSync(autoPackage, { recursive: true }); writeFileSync(path.join(autoPackage, 'x'), 'bytes');
  scheduledRound(automatic.project, automatic.orders, automatic.env);
  assert.ok(!existsSync(autoPackage));
  assert.ok(producerActions(automatic.project).some(a => a.kind === 'clean' && a.mode === 'auto' && a.status === 'done'));
});

test('clean refuses all of a stale plan before deleting anything, and protects live runs and tracked artifacts', () => {
  const f = fixture({ clean: { builds: [{ dir: 'artifacts/builds', keep: 0 }] } });
  const dirs = ['a', 'b'].map(name => path.join(f.root, 'artifacts/builds', name));
  for (const dir of dirs) { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'x'), 'before'); }
  const plan = planClean(f.project, f.orders, f.env.clean);
  writeFileSync(path.join(dirs[1], 'x'), 'changed');
  assert.throws(() => applyClean(f.project, f.orders, plan, f.env.clean), /stale plan/);
  assert.ok(dirs.every(dir => existsSync(dir)));
  git(f.root, 'add', '-f', path.relative(f.root, dirs[0])); git(f.root, 'commit', '-qm', 'tracked artifact');
  assert.equal(planClean(f.project, f.orders, f.env.clean).items.find(i => path.basename(i.path) === 'a')!.action, 'skip');
  f.add('LIVE'); f.orders.runStart('LIVE', { worker: 'coder', extra: { pid: 99 } }); f.alive(true);
  assert.deepEqual(planClean(f.project, f.orders, f.env.clean).items.map(i => [path.basename(i.path), i.action]).sort(), [['a', 'skip'], ['b', 'delete']], 'unrelated live run does not protect builds');
});

test('cancelled worktrees need a clean merged branch; junction targets survive accepted clean', () => {
  const f = fixture({ clean: { idle_hours: 0, caches: ['Library'] } });
  f.env.clean.probes = { ...f.probes, worktrees: systemProbes.worktrees };
  const outside = path.join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'precious.txt'), 'keep');
  const wt = path.join(f.dir, 'cancelled'); git(f.root, 'worktree', 'add', '-qb', 'cancelled', wt, 'main');
  f.add('CANCEL', { worktree: wt, branch: 'cancelled' }); f.orders.act('CANCEL', 'cancel');
  mkdirSync(path.join(wt, 'Library')); symlinkSync(outside, path.join(wt, 'Library', 'link'), 'junction');
  f.advance(525600);
  const plan = planClean(f.project, f.orders, f.env.clean); assert.equal(plan.items[0].action, 'remove'); assert.equal(plan.items[0].pathClass, 'worktrees');
  applyClean(f.project, f.orders, plan, f.env.clean);
  assert.ok(!existsSync(wt)); assert.equal(readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep');
});

test('a removable worktree raises the clean card even when its size was not counted in time', () => {
  const f = fixture({ clean: { idle_hours: 0, min_gain_gb: 5, drives: [{ path: '.', min_free_gb: 1 }] } });
  f.env.clean.probes = { ...f.probes, worktrees: systemProbes.worktrees }; f.env.clean.sizeBudgetMs = 0;
  const wt = path.join(f.dir, 'done'); git(f.root, 'worktree', 'add', '-qb', 'done', wt, 'main');
  f.add('DONE', { worktree: wt, branch: 'done' }); f.orders.act('DONE', 'cancel');
  f.advance(525600);
  const round = scheduledRound(f.project, f.orders, f.env)!;
  const removal = round.plan.items.find(i => i.action === 'remove' && i.pathClass === 'worktrees')!;
  assert.ok(removal); assert.equal(removal.bytes, undefined); assert.equal(round.plan.drives![0].low, false);
  const card = round.cases.find(c => c.trigger === 'clean')!; assert.ok(card);
  assert.match(card.card.summary, /unmeasured size/);
});

test('auto destructive worktrees still require allowlisting and fresh safety checks', () => {
  const f = fixture({ producer: { enabled: true, round: { enabled: true, every_minutes: 60 }, rules: [{ id: 'clean', action: 'clean', mode: 'auto', instruction: 'Remove eligible worktrees' }] },
    clean: { idle_hours: 0, min_gain_gb: 0, auto_destructive: true, auto_classes: ['worktrees'] } });
  f.env.clean.probes = { ...f.probes, worktrees: systemProbes.worktrees };
  const wt = path.join(f.dir, 'finished'); git(f.root, 'worktree', 'add', '-qb', 'finished', wt, 'main');
  f.add('FINISHED', { worktree: wt, branch: 'finished' }); f.orders.act('FINISHED', 'cancel');
  f.advance(525600);
  scheduledRound(f.project, f.orders, f.env);
  assert.ok(!existsSync(wt));
  assert.ok(producerActions(f.project).some(a => a.kind === 'clean' && a.mode === 'auto' && a.status === 'done'));
});
