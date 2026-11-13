import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { validateProject } from './state-helper.ts';
import { tempOrders } from './helpers.ts';
import { planOrder } from '../src/orders/planned.ts';
import { readStateJson, writeStateFile } from '../src/orders/state-files.ts';
import { intakeProducer, producerAct, producerActions, rejectProducerAction, runProducerAction } from '../src/producer/producer.ts';
import { ProducerSessionManager, producerAct as sessionAct, type SessionEngine, type SessionEvent } from '../src/producer/session.ts';
import { emptyUsage } from '../src/producer/session-usage.ts';
import { agreementRecords, refreshAgreement } from '../src/producer/trust.ts';
import { AUTO_DRAFT_TRIES, draftRetryDue, markWorksShown, pollProducerWorks, producerWorks, startProducerWork, type ProducerWork } from '../src/producer/work-sessions.ts';
import { answerOrder } from '../src/run/answer.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';

class RouterEngine implements SessionEngine {
  batches: string[][] = [];
  async start() {}
  async sendBatch(messages: string[]) { this.batches.push(messages); }
  async *readEvents(): AsyncIterable<SessionEvent> { await new Promise(() => {}); }
  async stop() {}
  usage() { return emptyUsage(); }
}
const settings = () => ({ producer: { enabled: true, rules: [{ id: 'draft', instruction: 'Draft', action: 'draft-order', mode: 'propose' }], budgets: {}, session: { enabled: true, engine: 'claude', max_turns: 100 } } });
const HOUR = 3600_000;

test('a failed planned draft is tried again on a later pass (failures under an older limit do not count), at most twice an hour apart; "draft again" starts another', async () => {
  const f = await fixture({ populate: false, project: settings });
  const p = f.board.ctx.projects[0];
  let clock = Date.parse('2026-11-12T08:40:00Z');
  const probes = { ...f.board.ctx.probes, now: () => new Date(clock), readText: (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } }, processStartedAt: () => '2026-01-01T00:00:00Z' } as Probes;
  planOrder(p, f.orders, { tag: 'AUD1', title: 'Audio', kind: 'docs', needs: [], intent: 'Make the sounds.' });
  const c = intakeProducer(p, f.orders, { verify: false }).find(c => c.order === 'AUD1')!;
  const fail = (run: ProducerWork, at: number) => { writeFileSync(run.log, ''); pollProducerWorks(p, { ...probes, now: () => new Date(at) }); };
  // the trial: a try and a retry under the old 120-second limit
  const old = startProducerWork(p, f.orders, c.key, 'draft', '', probes);
  const works = readStateJson<ProducerWork[]>(p, '_producer-work-sessions.json', []);
  writeStateFile(p, '_producer-work-sessions.json', JSON.stringify(works.map(w => ({ ...w, timeoutMs: 120_000 }))));
  fail(old, clock + 121_000);
  const oldRetry = startProducerWork(p, f.orders, c.key, 'draft', '', probes);
  writeStateFile(p, '_producer-work-sessions.json', JSON.stringify(readStateJson<ProducerWork[]>(p, '_producer-work-sessions.json', []).map(w => ({ ...w, timeoutMs: 120_000 }))));
  fail(oldRetry, clock + 242_000);
  assert.equal(producerWorks(p).filter(w => w.status === 'failed').length, 2);
  // within the hour of that retry nothing comes back; after it, the case is due again under the new limit
  assert.equal(draftRetryDue(p, c, new Date(clock + 30 * 60_000)), false);
  clock += 3 * HOUR;
  assert.equal(draftRetryDue(p, c, new Date(clock)), true);
  const engine = new RouterEngine(), manager = new ProducerSessionManager(p, f.orders, () => engine, probes);
  // the router has seen this card with its failed work before (as in the trial)
  writeStateFile(p, '_producer-session-seen.json', JSON.stringify({ [c.key]: 'seen-before' }));
  await manager.onPass([c], new Date(clock));
  assert.match(engine.batches.at(-1)![0], /draft\/AUD1/);
  const retry = producerWorks(p).at(-1)!;
  assert.equal(retry.status, 'running'); assert.equal(retry.retryOf, oldRetry.id); assert.equal(retry.timeoutMs, 10 * 60_000);
  assert.match(readFileSync(retry.prompt, 'utf8'), /previous_attempt/);
  fail(retry, clock + 11 * 60_000);
  assert.equal(draftRetryDue(p, c, new Date(clock + 20 * 60_000)), false, 'one retry an hour');
  clock += 2 * HOUR;
  assert.equal(draftRetryDue(p, c, new Date(clock)), true);
  fail(startProducerWork(p, f.orders, c.key, 'draft', '', probes), clock + 11 * 60_000);
  clock += 2 * HOUR;
  assert.equal(AUTO_DRAFT_TRIES, 2);
  assert.equal(draftRetryDue(p, c, new Date(clock)), false, 'two tries under the current limit, then only a person');
  await manager.stop();

  // the console: the draft view says why, "draft again" starts a session and refuses a second while it runs
  const view = await f.get('/api/orders/AUD1/draft');
  assert.equal(view.body.work.status, 'failed'); assert.equal(view.body.canDraftAgain, true);
  const again = await f.write('/api/orders/AUD1/draft-again', { brief: 'Only the battle music.' });
  assert.equal(again.status, 200, JSON.stringify(again.body)); assert.equal(again.body.work.status, 'running');
  assert.equal(producerWorks(p).at(-1)!.brief, 'Only the battle music.');
  const busy = await f.write('/api/orders/AUD1/draft-again', {});
  assert.equal(busy.status, 409); assert.match(busy.body.error.message, /running/);
  assert.match((await f.write('/api/orders/NOPE/draft-again', {})).body.error.message, /NOPE/);
});

test('a rejected draft does not come back; a pending one blocks "draft again"', async () => {
  const f = await fixture({ populate: false, project: settings });
  const p = f.board.ctx.projects[0];
  const probes = { ...f.board.ctx.probes, readText: (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } }, processStartedAt: () => '2026-01-01T00:00:00Z' } as Probes;
  planOrder(p, f.orders, { tag: 'DOC1', title: 'Docs', kind: 'docs', needs: [], intent: 'Write it.' });
  const c = intakeProducer(p, f.orders, { verify: false }).find(c => c.order === 'DOC1')!;
  const run = startProducerWork(p, f.orders, c.key, 'draft', '', probes);
  writeFileSync(run.log, JSON.stringify({ type: 'result', result: `--- alba-producer-work ---\n{"summary":"x","action":{"kind":"draft-order","order":{"tag":"DOC1","title":"Docs","kind":"docs","needs":[]}}}\n--- end ---\n--- alba-producer-body ---\n# DOC1\n\n## 4. Acceptance\n- done\n--- end body ---` }) + '\n');
  pollProducerWorks(p, probes); markWorksShown(p, [run.id]);
  const proposal = sessionAct(p, f.orders, c.key, 'draft-order', { work: run.id });
  assert.equal(proposal.status, 'proposed');
  const pending = await f.write('/api/orders/DOC1/draft-again', {});
  assert.equal(pending.status, 409); assert.match(pending.body.error.message, /waits for a decision/);
  rejectProducerAction(p, proposal.id, 'not like this');
  const cases = intakeProducer(p, f.orders, { verify: false });
  assert.equal(cases.some(x => x.key === c.key && x.status === 'open'), false);
  assert.equal(draftRetryDue(p, c, new Date()), false);
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** An order whose run on a resumable worker ended with a question; the producer has an answer rule in propose. */
function asked() {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game'); mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main'); writeFileSync(path.join(root, 'a.txt'), 'a'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders'); mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-table.md'), '# T1\nBuild the table.\n');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
    producer: { enabled: true, rules: [{ id: 'answer-workers', action: 'answer', mode: 'propose', instruction: 'Answer technical questions.' }], budgets: {} } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Table', kind: 'k' }); orders.act('T1', 'queue');
  orders.runStart('T1', { worker: 'resumable', session: 's-1', extra: { template: 'resumable', session: 's-1' } }); orders.runEnd('T1');
  orders.report('T1', { status: 'waiting', summary: 'need a decision', question: 'Should the table use 12 or 16 columns?', evidence: [], commits: [] });
  const spawned: string[][] = [];
  const probes = { now: () => new Date('2026-01-01T12:00:00Z'), spawnDetached: (_p: string, args: string[]) => { spawned.push(args); return 4242; },
    fileTime: () => undefined, readText: () => undefined, tail: () => '', isAlive: () => false, worktrees: () => [], gitActivity: () => ({}), runCommand: () => '[]', freeRamGb: () => 32 } as unknown as Probes;
  const workers = validateWorkers({ workers: [{ id: 'resumable', engine: 'codex-cli', launch: { program: 'coder', args: ['exec', '{session_args}', '-o', '{last_file}', 'Read {prompt_file}'], session: { new: ['-C', '{cwd}'], resume: ['resume', '{session_id}'] } } }, { id: 'other', engine: 'codex-cli', launch: { program: 'coder', args: ['exec', 'Read {prompt_file}'] } }] }, 'w.yaml');
  const c = intakeProducer(project, orders, { verify: false }).find(c => c.order === 'T1' && c.status === 'open')!;
  return { orders, project, probes, workers, spawned, c };
}

test('an accepted producer answer resumes the worker exactly like `alba answer`: same worker, same session, only the answer in the prompt', () => {
  const viaProducer = asked();
  const proposal = producerAct(viaProducer.project, viaProducer.orders, viaProducer.c.key, 'answer', { note: '16 columns, the map needs it' });
  assert.equal(proposal.status, 'proposed');
  const done = runProducerAction(viaProducer.project, viaProducer.orders, proposal.id, undefined, { probes: viaProducer.probes, workers: viaProducer.workers });
  assert.equal(done.status, 'done', done.refusal);
  assert.match(done.result ?? '', /session of run r1 continues as run r2 on resumable/);
  const viaCli = asked();
  answerOrder({ project: viaCli.project, orders: viaCli.orders, workers: viaCli.workers, probes: viaCli.probes }, 'T1', '16 columns, the map needs it');
  assert.deepEqual([viaProducer.spawned.length, viaCli.spawned.length], [1, 1], 'one start each');
  const [p, q] = [viaProducer.orders.get('T1').runs[1], viaCli.orders.get('T1').runs[1]];
  assert.deepEqual([p.worker, p.note, p.continuation], [q.worker, q.note, q.continuation]);
  assert.deepEqual(viaProducer.spawned[0].slice(0, 4), viaCli.spawned[0].slice(0, 4));
  assert.deepEqual(viaProducer.spawned[0].slice(0, 4), ['exec', '--json', 'resume', 's-1']);
  assert.equal(readFileSync(p.prompt_file!, 'utf8').replace(/[\s\S]*?(16 columns)/, '$1').split('\n')[0], readFileSync(q.prompt_file!, 'utf8').replace(/[\s\S]*?(16 columns)/, '$1').split('\n')[0]);
});

test('trust: your own `alba answer` decides the pending answer proposal of the same question: the same text agrees, other text is "edited", another action is "different"', () => {
  for (const [label, act, outcome] of [
    ['same answer', (o: ReturnType<typeof asked>) => answerOrder({ project: o.project, orders: o.orders, workers: o.workers, probes: o.probes }, 'T1', '16 columns, the map needs it'), 'accepted'],
    ['own wording', (o: ReturnType<typeof asked>) => answerOrder({ project: o.project, orders: o.orders, workers: o.workers, probes: o.probes }, 'T1', 'Use 16.'), 'edited'],
    ['put on hold', (o: ReturnType<typeof asked>) => o.orders.act('T1', 'hold'), 'different'],
  ] as const) {
    const o = asked();
    const proposal = producerAct(o.project, o.orders, o.c.key, 'answer', { note: '16 columns, the map needs it', now: new Date(o.orders.now()) });
    assert.equal(proposal.status, 'proposed', label);
    act(o);
    refreshAgreement(o.project, producerActions(o.project), o.orders.all(), o.orders.store.events(), o.orders.now());
    const row = agreementRecords(o.project)['answer-workers'].find(r => r.actionId === proposal.id)!;
    assert.equal(row.outcome, outcome, label);
  }
});
