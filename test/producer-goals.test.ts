import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designFixture, initialDesign } from './fixtures/design.ts';
import { applyChangeSet } from '../src/design/library.ts';
import { editDraftAction, intakeProducer, producerAct, producerCases, producerPolicy, runProducerAction } from '../src/producer/producer.ts';
import { createOrder } from '../src/service/new-order.ts';
import { draftBudgetRemaining } from '../src/producer/drafting-budget.ts';
import { freeGoalCapacity } from '../src/producer/goals.ts';
import { systemProbes } from '../src/tick/gather.ts';
import type { TickReport } from '../src/tick/plan.ts';

function fixture() {
  const f = designFixture(); applyChangeSet(f.project, f.orders, initialDesign());
  f.project.producer.enabled = true; f.project.dispatch.caps = { sim: 2 };
  return f;
}
const draft = { tag: 'DEMO', title: 'Improve gold flow', kind: 'sim', needs: [], body: '# Improve\nECON-T01\n## Acceptance\nGold stays in range.' };
test('all three goal triggers open and close on named orders, target pass, measure configuration and gap closure', () => {
  const f = fixture();
  let open = intakeProducer(f.project, f.orders, { verify: false });
  assert.deepEqual(open.map(c => c.trigger).sort(), ['gap-unowned', 'target-failing', 'target-unmeasured']);
  assert.equal(open.find(c => c.trigger === 'target-failing')?.facts.target && (open.find(c => c.trigger === 'target-failing')!.facts.target as any).last_value, 12);
  createOrder(f.project, f.orders, { ...draft, body: draft.body + '\nECON-T02\nECON-G01' });
  assert.equal(intakeProducer(f.project, f.orders, { verify: false }).length, 0);
  assert.deepEqual(producerCases(f.project).find(c => c.key === 'goal/ECON-T01')?.facts.orderMatches, [{ order: 'DEMO', id: 'ECON-T01', offset: draft.body.indexOf('ECON-T01') }]);
  f.orders.act('DEMO', 'cancel');
  assert.equal(intakeProducer(f.project, f.orders, { verify: false }).length, 3);
  applyChangeSet(f.project, f.orders, { title: 'Resolve goals', changes: [
    { op: 'update', kind: 'target', id: 'ECON-T01', base_version: 1, fields: { last_value: 8 } },
    { op: 'update', kind: 'target', id: 'ECON-T02', base_version: 1, fields: { measure: { argv: ['node', 'measure.mjs'], timeout_minutes: 1, value: { json_pointer: '' }, when: {} } } },
    { op: 'update', kind: 'gap', id: 'ECON-G01', base_version: 1, fields: { status: 'closed', closed_by: 'DEMO' } },
  ] });
  assert.equal(intakeProducer(f.project, f.orders, { verify: false }).length, 0);
});
test('draft-from-goal defaults to propose, carries facts, consumes allowance and creates an id-referencing order', () => {
  const f = fixture(); f.project.producer.budgets.draft_runs_per_day = 1;
  intakeProducer(f.project, f.orders, { verify: false });
  const action = producerAct(f.project, f.orders, 'goal/ECON-T01', 'draft-order', { order: draft });
  assert.equal(action.ruleId, 'draft-from-goal'); assert.equal(action.mode, 'propose'); assert.equal(action.status, 'proposed');
  assert.equal(producerPolicy(f.project).rules.find(r => r.id === 'draft-from-goal')?.mode, 'propose');
  assert.equal((action.goalFacts?.target as any).metric, 'Gold after one turn');
  assert.equal((action.goalFacts?.rules as any[])[0].id, 'ECON-R01'); assert.equal(draftBudgetRemaining(f.project), 0);
  assert.equal(producerAct(f.project, f.orders, 'goal/ECON-T01', 'draft-order', { order: draft }).id, action.id);
  assert.throws(() => editDraftAction(f.project, f.orders, action.id, '## Acceptance\nImprove gold flow.'), /reference/);
  assert.match(editDraftAction(f.project, f.orders, action.id, draft.body + '\nCheck the result twice.').order!.body, /twice/);
  assert.throws(() => producerAct(f.project, f.orders, 'goal/ECON-T02', 'add-order', { order: { ...draft, tag: 'SECOND', body: 'ECON-T02\n## Acceptance\nMeasure time.' } }), /allowance/);
  assert.equal(runProducerAction(f.project, f.orders, action.id).status, 'done');
  assert.ok(f.orders.resolveTag('DEMO')); assert.ok(!intakeProducer(f.project, f.orders).some(c => c.key === 'goal/ECON-T01'));
});
test('idle-capacity requires a real tick with no starts and free kind capacity and memory', () => {
  const f = fixture(); f.project.dispatch.min_free_ram_gb = 4;
  const tick = { dispatched: 0, problems: [], moves: [], heldBack: [] } as unknown as TickReport;
  const options = (ram: number) => ({ tick, env: { workers: { workers: [], quota_sources: {}, file: 'fixture.yaml' }, probes: { ...systemProbes, freeRamGb: () => ram } } });
  const open = intakeProducer(f.project, f.orders, options(8));
  assert.equal(open.filter(c => c.trigger === 'idle-capacity').length, 1);
  const idleGoals = open.find(c => c.trigger === 'idle-capacity')!.facts.goals as Record<string, unknown>[];
  assert.equal(idleGoals.length, 3);
  // The idle card lists goals by id; full system context stays on each goal case to keep the model payload small.
  assert.ok(idleGoals.every(g => typeof g.goal === 'string' && typeof g.summary === 'string' && !('rules' in g) && !('gaps' in g)));
  tick.dispatched = 1; assert.ok(!intakeProducer(f.project, f.orders, options(8)).some(c => c.trigger === 'idle-capacity'));
  tick.dispatched = 0; assert.ok(!intakeProducer(f.project, f.orders, options(1)).some(c => c.trigger === 'idle-capacity'));
  delete tick.dispatched; assert.ok(!intakeProducer(f.project, f.orders, options(8)).some(c => c.trigger === 'idle-capacity'));
  f.project.dispatch.caps.sim = 0; assert.deepEqual(freeGoalCapacity(f.project, f.orders, 8), []);
});
test('goal policy off refuses; a passing target makes a pending goal proposal stale', () => {
  const f = fixture(); intakeProducer(f.project, f.orders);
  f.project.producer.rules = [{ id: 'draft-from-goal', action: 'add-order', instruction: 'Draft goals', mode: 'off' }];
  assert.equal(producerAct(f.project, f.orders, 'goal/ECON-T01', 'add-order', { order: draft }).status, 'refused');
  f.project.producer.rules[0].mode = 'propose';
  const action = producerAct(f.project, f.orders, 'goal/ECON-T01', 'add-order', { order: { ...draft, tag: 'OTHER' } });
  applyChangeSet(f.project, f.orders, { title: 'Pass', changes: [{ op: 'update', kind: 'target', id: 'ECON-T01', base_version: 1, fields: { last_value: 8 } }] });
  assert.equal(runProducerAction(f.project, f.orders, action.id).status, 'failed');
  assert.equal(f.orders.resolveTag('OTHER'), undefined);
});
