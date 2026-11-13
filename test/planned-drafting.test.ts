import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { planOrder, editPlan } from '../src/orders/planned.ts';
import { draftPreview, draftingContext, namedPaths, planFingerprint, readyToDraft, acceptDraft } from '../src/producer/drafting.ts';
import { draftBudgetRemaining } from '../src/producer/drafting-budget.ts';
import { intakeProducer, producerAct, producerActions, runProducerAction } from '../src/producer/producer.ts';
import { ProducerSessionManager, type SessionEngine, type SessionEvent } from '../src/producer/session.ts';
import { planTick, type WorkerState } from '../src/tick/plan.ts';
import { routeFor } from '../src/routing/route.ts';
import { usesOf } from '../src/resources/leases.ts';
import { validateProject } from './state-helper.ts';
import { alba, projectDir } from './cli-helper.ts';
import { tempOrders } from './helpers.ts';
import { writeStateFile } from '../src/orders/state-files.ts';

const config = (mode = 'propose') => ({ producer: { enabled: true, rules: [{ id: 'draft', action: 'draft-order', mode, instruction: 'Draft the planned work from its context.' }], budgets: { draft_runs_per_day: 1 }, session: { enabled: true, engine: 'claude', max_turns: 50 } } });
const input = (tag = 'NEXT') => ({ tag, title: 'Document the result', kind: 'docs', needs: [] as string[], intent: 'Explain the result so the team can use it.' });
const body = '# Document the result\n\n## Files to read\n`a.txt` and `src/missing.ts`.\n\n## Task\nExplain why the simulator is irrelevant.\n\n## Acceptance\nThe guide describes the result.\n';
const draftOf = (tag = 'NEXT', needs: string[] = []) => ({ tag, title: input().title, kind: 'docs', needs, body, worker: 'coder' });
const workerStates = (f: Awaited<ReturnType<typeof fixture>>): WorkerState[] => f.board.ctx.workers!.workers.map(config => ({ config, available: true, reasons: [], running: 0, runsToday: 0 }));

test('planned orders cannot queue or start and the tick never dispatches them', async () => {
  const f = await fixture({ populate: false });
  const project = f.board.ctx.projects[0];
  const doc = planOrder(project, f.orders, input());
  assert.equal(f.orders.stage(doc).stage, 'planned');
  assert.throws(() => f.orders.act('NEXT', 'queue'));
  assert.throws(() => f.orders.runStart('NEXT', { worker: 'coder' }));
  assert.throws(() => f.orders.runStart('NEXT', { worker: 'coder' }, true));
  const tick = planTick({ now: new Date(), orders: [{ tag: 'NEXT', stage: 'planned', kind: 'docs', row: 0, rework: false, resume: false, endedWithoutReport: false }], workers: workerStates(f), caps: {}, reworkReserve: 0, activity: {}, alerts: [] });
  assert.deepEqual(tick.moves, []);
  assert.equal(existsSync(path.join(project.work_orders, 'NEXT-document-the-result.md')), false);
  f.orders.act('NEXT', 'cancel');
  assert.equal(f.orders.stage(f.orders.get('NEXT')).stage, 'cancelled');
});

test('a listed draft order without a body becomes a plan in place; later stages are refused', async () => {
  const f = await fixture({ populate: false });
  const project = f.board.ctx.projects[0];
  f.orders.add({ tag: 'LISTED', title: 'Listed only', kind: 'docs', needs: ['OLD'] });
  assert.equal(f.orders.stage(f.orders.get('LISTED')).stage, 'draft');
  const doc = planOrder(project, f.orders, { ...input('LISTED'), title: '', needs: ['BASE'] });
  assert.equal(f.orders.stage(doc).stage, 'planned');
  assert.equal(doc.order.title, 'Listed only');
  assert.deepEqual(doc.order.needs, ['BASE']);
  assert.equal(doc.order.intent, input().intent);
  assert.ok(f.orders.store.events({ tag: 'LISTED' }).some(e => e.type === 'planned-from-draft'));
  f.orders.add({ tag: 'QUEUED', title: 'Queued', kind: 'docs' }); f.orders.act('QUEUED', 'queue');
  assert.throws(() => planOrder(project, f.orders, input('QUEUED')), /past the draft stage/);
});

test('the last merged need opens a drafting case; kind and worker capacity gate free-slot drafting', async () => {
  const f = await fixture({ populate: false, project: () => ({ ...config(), drafting: { when: 'free-slot' }, dispatch: { caps: { docs: 1 } } }) });
  const p = f.board.ctx.projects[0]; const workers = workerStates(f);
  for (const tag of ['BASEA', 'BASEB']) f.orders.add({ tag, title: tag, kind: 'docs' });
  planOrder(p, f.orders, { ...input(), needs: ['BASEA', 'BASEB'] });
  const cases = () => intakeProducer(p, f.orders, { verify: false, workers }).filter(c => c.trigger === 'ready-to-draft');
  assert.equal(cases().length, 0);
  f.orders.act('BASEA', 'approve', { force: true }); assert.equal(cases().length, 0);
  f.orders.act('BASEB', 'approve', { force: true }); assert.equal(cases().length, 1);
  workers.forEach(w => { w.available = false; }); assert.equal(cases().length, 0);
  workers.forEach(w => { w.available = true; });
  f.orders.add({ tag: 'BUSY', title: 'Busy', kind: 'docs' }); f.orders.act('BUSY', 'queue'); f.orders.runStart('BUSY', { worker: 'coder' });
  assert.equal(cases().length, 0);
  f.orders.runEnd('BUSY'); assert.equal(cases().length, 1);
  const c = cases()[0];
  const action = producerAct(p, f.orders, c.id, 'draft-order', { order: draftOf('NEXT', ['BASEA', 'BASEB']) });
  f.orders.runStart('BUSY', { worker: 'coder' });
  assert.equal(cases()[0].revision, c.revision);
  assert.equal(runProducerAction(p, f.orders, action.id).status, 'done');
});

/** This fake invokes the same action boundary as the producer MCP; no model process starts. */
class DraftEngine implements SessionEngine {
  readonly batches: string[][] = [];
  private readonly propose: () => void;
  constructor(propose: () => void) { this.propose = propose; }
  async start(): Promise<void> {}
  async sendBatch(messages: string[]): Promise<void> { this.batches.push(messages); this.propose(); }
  async *readEvents(): AsyncIterable<SessionEvent> { await new Promise<void>(() => {}); }
  async stop(): Promise<void> {}
  usage() { return { input_tokens: 0, output_tokens: 0, total_tokens: 0 }; }
}

test('fake-engine acceptance: two needs, complete context, flagged preview, saved edit and queued file', async () => {
  const f = await fixture({ populate: false, project: () => ({ ...config(), drafting: { template: 'template.md', examples: 1 }, resources: { simulator: { match: 'simulator', slots: 1 } }, kinds: { docs: { description: 'Documentation and guides.', match: 'guide' } } }) });
  const p = f.board.ctx.projects[0];
  writeStateFile(p, '_producer-direction.json', JSON.stringify([{ version: 1, at: new Date().toISOString(), priorities: 'Explain the limitations first.', stop: '', constraints: 'Keep examples reproducible.', notes: '' }]));
  writeFileSync(p.drafting!.template!, '## Background\n\n## Task\n\n## Acceptance\n\n## Evidence\n\n## Hard rules\nUse fake engines only.\n');
  for (const tag of ['BASEA', 'BASEB']) {
    f.orders.add({ tag, title: tag, kind: 'docs' });
    f.orders.report(tag, { status: 'ready', summary: `Findings from ${tag}`, evidence: ['docs/evidence.md'], commits: [] });
    writeFileSync(path.join(p.work_orders, `${tag}-example.md`), `# Example ${tag}\n\n## Acceptance\nChecked.\n`);
    writeFileSync(path.join(p.work_orders, `${tag}.accept.md`), `Acceptance notes for ${tag}`);
  }
  const planned = await f.write('/api/orders/plan', { project: p.id, ...input(), role: 'writer', needs: ['BASEA', 'BASEB'] });
  assert.equal(planned.status, 201);
  const detail = await f.get('/api/orders/NEXT?project=demo');
  assert.equal(detail.body.order.planned, true);
  assert.equal(detail.body.order.intent, input().intent);
  assert.equal(detail.body.order.role, 'writer');
  assert.deepEqual(detail.body.needsStatus.map((n: { tag: string }) => n.tag), ['BASEA', 'BASEB']);
  const ready = () => intakeProducer(p, f.orders, { verify: false }).filter(c => c.trigger === 'ready-to-draft');
  assert.equal(ready().length, 0);
  f.orders.act('BASEA', 'approve', { force: true, note: 'Accepted the first result' }); assert.equal(ready().length, 0);
  f.orders.act('BASEB', 'approve', { force: true, note: 'Accepted the second result' }); assert.equal(ready().length, 1);
  const context = draftingContext(p, f.orders, 'NEXT');
  assert.match(context.template, /Use fake engines only/);
  assert.equal(context.needs.length, 2); assert.match(context.needs[1].reports[0].summary, /BASEB/);
  assert.match(context.needs[0].acceptanceNotes, /Acceptance notes/); assert.equal(context.examples.length, 1);
  assert.match(context.examples[0].body, /Example/); assert.equal(context.direction.priorities, 'Explain the limitations first.');
  const planEdit = await f.write('/api/orders/NEXT/plan', { project: p.id, intent: input().intent, role: '' });
  assert.equal(planEdit.status, 200);
  const cases = intakeProducer(p, f.orders, { verify: false });
  const c = cases.find(c => c.trigger === 'ready-to-draft')!;
  const engine = new DraftEngine(() => { producerAct(p, f.orders, c.id, 'draft-order', { order: draftOf('NEXT', ['BASEA', 'BASEB']) }); });
  const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await manager.onPass([c]);
  assert.equal(engine.batches.length, 1); assert.doesNotMatch(engine.batches[0][0], /Findings from BASEB/);
  assert.match(engine.batches[0][0], /"work":/);
  assert.equal(draftBudgetRemaining(p), 0);
  const action = producerActions(p).find(a => a.kind === 'draft-order')!;
  assert.equal(action.status, 'proposed');
  const view = await f.get('/api/orders/NEXT/draft?project=demo'); assert.equal(view.status, 200);
  assert.equal(view.body.preview.classifier.kind, 'docs');
  assert.equal(view.body.preview.route.chosen, 'coder');
  assert.deepEqual(view.body.preview.missingPaths, ['src/missing.ts']);
  assert.equal(view.body.preview.resources.resources[0].matches[0].text, 'simulator');
  const edited = body.replace('irrelevant', 'unneeded');
  const save = await f.write('/api/orders/NEXT/draft', { project: p.id, actionId: action.id, decision: 'save', body: edited });
  assert.equal(save.status, 200); assert.equal(save.body.order.body, edited);
  const accepted = await f.write('/api/orders/NEXT/draft', { project: p.id, actionId: action.id, decision: 'accept' });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.status, 'done');
  const file = path.join(p.work_orders, 'NEXT-document-the-result.md');
  assert.equal(readFileSync(file, 'utf8'), edited);
  assert.equal(f.orders.stage(f.orders.get('NEXT')).stage, 'queued');
  assert.deepEqual(usesOf(p, f.orders.get('NEXT')), ['simulator']);
  assert.equal(f.orders.store.events({ tag: 'NEXT' }).some(e => e.type === 'draft-accepted'), true);
  assert.equal(runProducerAction(p, f.orders, action.id).status, 'done');
  await manager.stop();
});

test('auto drafting requires both an auto rule and an allowed kind; rejection persists', async () => {
  for (const allow of [false, true]) {
    const f = await fixture({ populate: false, project: () => ({ ...config('auto'), drafting: { auto_kinds: allow ? ['docs'] : [] } }) });
    const p = f.board.ctx.projects[0]; planOrder(p, f.orders, input());
    const c = intakeProducer(p, f.orders, { verify: false }).find(c => c.trigger === 'ready-to-draft')!;
    const action = producerAct(p, f.orders, c.id, 'draft-order', { order: draftOf() });
    assert.equal(action.status, allow ? 'done' : 'proposed');
    assert.equal(f.orders.stage(f.orders.get('NEXT')).stage, allow ? 'queued' : 'planned');
    if (!allow) {
      assert.equal((await f.write('/api/orders/NEXT/draft', { project: p.id, actionId: action.id, decision: 'reject' })).body.status, 'rejected');
      assert.equal(intakeProducer(p, f.orders, { verify: false }).filter(c => c.trigger === 'ready-to-draft').length, 0);
      editPlan(f.orders, 'NEXT', { intent: 'An updated intent.' });
      assert.equal(intakeProducer(p, f.orders, { verify: false }).filter(c => c.trigger === 'ready-to-draft').length, 1);
    }
  }
});

test('stale drafts and existing files cannot be accepted', async () => {
  const f = await fixture({ populate: false, project: () => config() }); const p = f.board.ctx.projects[0];
  const doc = planOrder(p, f.orders, input()); const fingerprint = planFingerprint(doc);
  editPlan(f.orders, 'NEXT', { intent: 'Changed intent' });
  assert.throws(() => acceptDraft(p, f.orders, draftOf(), fingerprint), /changed/);
  writeFileSync(path.join(p.work_orders, 'NEXT-existing.md'), 'Existing body');
  assert.throws(() => acceptDraft(p, f.orders, draftOf(), planFingerprint(f.orders.get('NEXT'))), /already exists/);
  assert.equal(f.orders.stage(f.orders.get('NEXT')).stage, 'planned');
});

test('preview follows rule routing and concrete paths ignore links and globs', async () => {
  const f = await fixture({ populate: false }); const p = f.board.ctx.projects[0];
  planOrder(p, f.orders, input());
  const preview = draftPreview(p, f.orders, draftOf(), workerStates(f));
  assert.equal(preview.route.chosen, routeFor(p, { ...f.orders.get('NEXT'), order: { ...f.orders.get('NEXT').order, worker: 'coder' } }, workerStates(f)).chosen);
  assert.deepEqual(namedPaths('Read `src/a.ts`, [doc](docs/readme.md), https://example.com/a.ts and src/**/*.ts; a.txt.'), ['src/a.ts', 'docs/readme.md', 'a.txt']);
  assert.deepEqual(readyToDraft(p, f.orders).map(d => d.order.tag), ['NEXT']);
});

test('draft budget blocks a new plan without losing eligibility; configuration and CLI plan/edit/cancel work', async () => {
  const f = await fixture({ populate: false, project: () => config() }); const p = f.board.ctx.projects[0];
  p.producer.budgets.draft_runs_per_day = 0; planOrder(p, f.orders, input());
  const c = intakeProducer(p, f.orders, { verify: false }).find(c => c.trigger === 'ready-to-draft')!;
  const engine = new DraftEngine(() => {}); const manager = new ProducerSessionManager(p, f.orders, () => engine, f.board.ctx.probes);
  await manager.onPass([c]); assert.equal(engine.batches.length, 0);
  p.producer.budgets.draft_runs_per_day = 1; await manager.onPass([c]); assert.equal(engine.batches.length, 1);
  assert.equal(draftBudgetRemaining(p, new Date(Date.now() + 86400000)), 1); await manager.stop();
  assert.throws(() => validateProject({ id: 'demo', name: 'Demo', root: f.root, work_orders: p.work_orders, state_dir: p.state_dir, drafting: { when: 'never' } }, p.file), /drafting.when/);
  const { dir } = tempOrders(); const file = projectDir(dir);
  assert.equal(alba(file, ['orders', 'plan', 'NEXT', '--title', 'Next task', '--kind', 'docs', '--needs', '', '--intent', 'Explain the result']).code, 0);
  assert.equal(alba(file, ['orders', 'edit-plan', 'NEXT', '--intent', 'Explain more']).code, 0);
  assert.equal(alba(file, ['orders', 'cancel', 'NEXT']).code, 0);
});
