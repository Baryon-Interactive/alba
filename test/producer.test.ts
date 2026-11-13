import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { tempOrders } from './helpers.ts';
import { loadProject } from './state-helper.ts';
import { producerAct, producerActions, producerCases, currentProducerActions, producerHeartbeatAt, producerHeartbeatProblem, producerState, intakeProducer, runProducerAction, setProducerPaused } from '../src/producer/producer.ts';
import { producerNotes } from '../src/producer/session.ts';
import { readStateFile, writeStateFile } from '../src/orders/state-files.ts';

test('producer intake makes stable delivery cases and merges repeated facts', async () => {
  const f = await fixture({ project: () => ({ producer: { enabled: true, rules: [], budgets: {} } }) });
  const project = f.board.ctx.projects[0];
  const first = intakeProducer(project, f.orders, { verify: false, now: new Date('2026-01-01T00:00:00Z') });
  const delivery = first.find(c => c.trigger === 'delivery');
  assert.ok(delivery);
  assert.equal(delivery.card.untrusted.includes('report'), true);
  const revision = delivery.revision;
  const second = intakeProducer(project, f.orders, { verify: false, now: new Date('2026-01-01T00:01:00Z') });
  assert.equal(second.find(c => c.id === delivery.id)?.revision, revision);
  const page = await f.get('/legacy/producer?project=demo');
  assert.equal(page.status, 200);
  assert.match(String(page.body), /Producer/);
  const api = await f.get('/api/producer?project=demo');
  assert.equal(api.status, 200);
  assert.equal(api.body.cases.some((c: { trigger: string }) => c.trigger === 'delivery'), true);
});

test('unsupported producer aliases and configuration keys are refused', async () => {
  const f = await fixture({ project: () => ({ producer: { enabled: true } }) });
  assert.equal((await f.get('/api/unsupported-producer')).status, 404);
  const file = projectDir(f.dir, 'unsupported_producer:\n  enabled: true\n');
  assert.throws(() => loadProject(file), /unknown key/);
  assert.notEqual(alba(file, ['unsupported-producer', 'status']).code, 0);
});

test('targeted proposals require the captured order basis rather than obsolete timestamp inference', async () => {
  const f = await fixture({ project: () => ({ producer: { enabled: true, rules: [{ id: 'note', action: 'note', mode: 'propose', instruction: 'Record a note' }] } }) });
  const project = f.board.ctx.projects[0];
  const c = intakeProducer(project, f.orders, { verify: false }).find(c => c.order === 'Q1')!;
  const proposal = producerAct(project, f.orders, c.id, 'note', { note: 'Review the current order' });
  assert.ok(proposal.basis);
  const actions = producerActions(project).map(action => {
    if (action.id !== proposal.id) return action;
    const { basis: _basis, ...withoutBasis } = action;
    return withoutBasis;
  });
  writeStateFile(project, '_producer-actions.json', JSON.stringify(actions));
  const invalid = currentProducerActions(project, f.orders).find(action => action.id === proposal.id)!;
  assert.equal(invalid.status, 'superseded');
  assert.match(invalid.supersededReason!, /no captured order basis/);
});

test('producer state preserves current cases, actions, notes, pause and heartbeat across reads', async () => {
  const f = await fixture({ populate: false, project: () => ({ producer: { enabled: true, rules: [], budgets: {} } }) });
  const project = f.board.ctx.projects[0];
  const legacyCase = { id: 'case-1', key: 'question/Q1', project: project.id, trigger: 'question', status: 'open', revision: 2, openedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', order: 'Q1', facts: { answer: 'old' }, card: { trigger: 'question', summary: 'old', pointers: [], untrusted: [] } };
  const oldState = (name: string) => name;
  const legacyAction = { id: 'action-1', idempotencyKey: 'question/Q1:note:2', caseId: 'case-1', caseRevision: 2, kind: 'note', status: 'proposed', ruleId: 'note', mode: 'propose', policyVersion: 'old-policy', policyHash: 'hash', at: '2026-01-01T00:01:00.000Z' };
  writeStateFile(project, oldState('_producer-cases.json'), JSON.stringify([legacyCase]));
  writeStateFile(project, oldState('_producer-actions.json'), JSON.stringify([legacyAction]));
  writeStateFile(project, oldState('_producer-paused.json'), 'true\n');
  writeStateFile(project, oldState('_producer-heartbeat.json'), JSON.stringify({ at: '2026-01-01T00:02:00.000Z', project: project.id }));
  writeStateFile(project, oldState('producer-notes.md'), 'legacy note\n');
  assert.equal(producerCases(project)[0].id, 'case-1');
  assert.equal(producerActions(project)[0].id, 'action-1');
  assert.equal(producerState(project).paused, true);
  assert.equal(producerNotes(project), 'legacy note\n');
  assert.equal(producerHeartbeatAt(project), '2026-01-01T00:02:00.000Z');
  assert.equal(readStateFile(project, '_producer-cases.json') !== undefined, true);
  assert.equal(producerCases(project)[0].facts.answer, 'old');
});

test('producer closes a stall after the dirty-tree finding clears and merges repeated errors', async () => {
  const f = await fixture({ project: () => ({ producer: { enabled: true, rules: [], budgets: {} } }) });
  const project = f.board.ctx.projects[0];
  const run = f.orders.get('W1').runs.find(r => !r.ended)!;
  writeStateFile(project, '_nudges.json', JSON.stringify({ [`W1:${run.id}`]: { at: '2026-01-01T00:00:00.000Z', count: 2, files: 2, minutes: 120 } }));
  const tick = { problems: [{ kind: 'commit-nudge', tag: 'W1', text: 'twice' }], moves: [], heldBack: [] } as never;
  intakeProducer(project, f.orders, { tick, verify: false, now: new Date('2026-01-01T02:00:00Z') });
  assert.equal(producerCases(project, true).some(c => c.key === 'stall/W1'), true);
  intakeProducer(project, f.orders, { tick: { problems: [], moves: [], heldBack: [] } as never, verify: false, now: new Date('2026-01-01T02:01:00Z') });
  assert.equal(producerCases(project).find(c => c.key === 'stall/W1')?.status, 'closed');

  f.orders.report('Q1', { status: 'failed', summary: 'Error 404 at workspace/temp\\one', evidence: [], commits: [] });
  f.orders.report('R1', { status: 'failed', summary: 'Error 404 at workspace/temp\\two', evidence: [], commits: [] });
  intakeProducer(project, f.orders, { verify: false });
  assert.equal(producerCases(project, true).filter(c => c.trigger === 'error-pattern').length, 1);
});

test('producer closes failure and loop cases once the order runs or is settled, and ignores harmless log lines', async () => {
  const f = await fixture({ project: () => ({ producer: { enabled: true, rules: [], budgets: {} } }) });
  const project = f.board.ctx.projects[0];
  f.orders.report('Q1', { status: 'failed', summary: 'it broke', evidence: [], commits: [] });
  intakeProducer(project, f.orders, { verify: false });
  assert.equal(producerCases(project, true).some(c => c.key === 'failed/Q1'), true);
  f.orders.act('Q1', 'queue', { force: true });
  intakeProducer(project, f.orders, { verify: false });
  assert.equal(producerCases(project).find(c => c.key === 'failed/Q1')?.status, 'closed');
  f.orders.runStart('Q1', { worker: 'coder' });
  intakeProducer(project, f.orders, { verify: false });
  assert.equal(producerCases(project, true).some(c => c.key === 'failed/Q1'), false);
  // A first log line every run prints is not an error signature shared between orders.
  assert.equal(producerCases(project, true).some(c => c.trigger === 'error-pattern'), false);
});

test('producer action modes store would-do, run proposals once, and pause', async () => {
  const f = await fixture({ project: () => ({ producer: { enabled: true, rules: [{ id: 'n', instruction: 'nudge', action: 'nudge', mode: 'observe' }, { id: 'q', instruction: 'note', action: 'note', mode: 'propose' }], budgets: {} } }) });
  const project = f.board.ctx.projects[0];
  intakeProducer(project, f.orders, { verify: false });
  const c = producerCases(project, true).find(x => x.order === 'R1')!;
  const observed = producerAct(project, f.orders, c.id, 'nudge', { note: 'check' });
  assert.equal(observed.status, 'would-do');
  const proposed = producerAct(project, f.orders, c.id, 'note', { note: 'check 2' });
  assert.equal(proposed.status, 'proposed');
  assert.equal(runProducerAction(project, f.orders, proposed.id).status, 'done');
  setProducerPaused(project, true);
  assert.equal(producerAct(project, f.orders, c.id, 'broadcast').status, 'refused');
});

test('producer heartbeat watchdog reports only stale enabled producers', async () => {
  const f = await fixture({ populate: false, project: () => ({ producer: { enabled: true, rules: [], budgets: {} } }) });
  const project = f.board.ctx.projects[0];
  assert.match(producerHeartbeatProblem(project, new Date('2026-01-01T00:20:00Z')) ?? '', /stale/);
  project.producer.enabled = false;
  assert.equal(producerHeartbeatProblem(project, new Date('2026-01-01T00:20:00Z')), undefined);
});

test('producer auto actions run once and stale proposals are refused', async () => {
  const f = await fixture({ project: () => ({ producer: { enabled: true, rules: [{ id: 'auto-note', instruction: 'record', action: 'note', mode: 'auto' }, { id: 'proposal-note', instruction: 'record later', action: 'broadcast', mode: 'propose' }], budgets: {} } }) });
  const project = f.board.ctx.projects[0];
  intakeProducer(project, f.orders, { verify: false });
  const c = producerCases(project, true).find(x => x.order === 'R1')!;
  const auto = producerAct(project, f.orders, c.id, 'note', { note: 'automatic' });
  assert.equal(auto.status, 'done');
  const before = producerCases(project).length;
  const actionsAgain = runProducerAction(project, f.orders, auto.id);
  assert.equal(actionsAgain.status, 'done');
  assert.equal(producerCases(project).length, before);
  const proposed = producerAct(project, f.orders, c.id, 'broadcast', { note: 'later' });
  writeStateFile(project, '_producer-cases.json', JSON.stringify(producerCases(project).map(x => x.id === c.id ? { ...x, status: 'closed' } : x)));
  assert.equal(runProducerAction(project, f.orders, proposed.id).status, 'refused');
});
