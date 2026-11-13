import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAgreement, ruleTrust, type AgreementRecord } from '../src/producer/trust.ts';
import type { ProducerAction } from '../src/producer/producer.ts';
import type { OrderDoc, OrderEvent } from '../src/orders/model.ts';

const at = '2026-01-02T00:00:00.000Z', later = '2026-01-02T01:00:00.000Z';
const row = (patch: Partial<AgreementRecord> = {}): AgreementRecord => ({ actionId: 'proposal', ruleId: 'review', caseId: 'delivery/sample', caseRevision: 1, order: 'sample', run: 'initial', proposed: 'accept', note: 'ready', at, expiresAt: '2026-01-05T00:00:00.000Z', baselineSeq: 3, outcome: 'pending', ...patch });
const doc = (): OrderDoc => ({ version: 1, order: { tag: 'sample', title: 'Sample', kind: 'code', needs: [], created: at, updated: at }, actions: [], runs: [], reports: [] });
const event = (kind: string, note = 'ready'): OrderEvent => ({ tag: 'sample', type: `action-${kind}`, at: later, by: 'web', data: { note } });

test('agreement distinguishes exact, edited, rejected, different human action and nothing', () => {
  assert.equal(resolveAgreement(row(), undefined, doc(), [event('approve')], later).outcome, 'accepted');
  assert.equal(resolveAgreement(row(), undefined, doc(), [event('approve', 'after checking')], later).outcome, 'edited');
  const different = resolveAgreement(row(), undefined, doc(), [event('rework')], later);
  assert.equal(different.outcome, 'different'); assert.equal(different.humanAction, 'rework'); assert.match(different.evidence!, /event:/);
  const action = { decision: { at: later, outcome: 'rejected' }, id: 'proposal' } as ProducerAction;
  assert.equal(resolveAgreement(row(), action, doc(), [], later).outcome, 'rejected');
  assert.equal(resolveAgreement(row(), undefined, doc(), [], later).outcome, 'pending');
  assert.equal(resolveAgreement(row(), undefined, doc(), [], '2026-01-06T00:00:00Z').outcome, 'nothing');
});

test('agreement matches delivery, question, failure, stall and planning action kinds', () => {
  for (const [proposed, kind, caseId] of [['accept', 'approve', 'delivery/sample'], ['answer', 'answer', 'question/sample'], ['queue', 'queue', 'failed/sample'], ['nudge', 'message', 'stall/sample'], ['hold', 'hold', 'loop/sample']]) {
    assert.equal(resolveAgreement(row({ proposed, caseId }), undefined, doc(), [event(kind)], later).outcome, 'accepted', caseId);
  }
  const planning = row({ order: undefined, run: undefined, caseId: 'planning/free-slot', proposed: 'note' });
  assert.equal(resolveAgreement(planning, { id: 'proposal', kind: 'note', decision: { at: later, outcome: 'accepted' } } as ProducerAction, undefined, [], later).outcome, 'accepted');
  const asked: OrderEvent = { tag: 'sample', type: 'question-asked', at: later, by: 'web', data: { text: 'ready' } };
  assert.equal(resolveAgreement(row({ proposed: 'ask' }), undefined, doc(), [asked], later).outcome, 'accepted');
  assert.equal(resolveAgreement(row({ proposed: 'ask' }), undefined, doc(), [{ ...asked, data: { text: 'revised question' } }], later).outcome, 'edited');
  const added = { ...asked, type: 'order-added', data: {} }, draft = row({ proposed: 'add-order', createdOrder: { title: 'Sample', kind: 'code', needs: [] } });
  assert.equal(resolveAgreement(draft, undefined, doc(), [added], later).outcome, 'accepted');
  const renamed = doc(); renamed.order.title = 'Edited title';
  assert.equal(resolveAgreement(draft, undefined, renamed, [added], later).outcome, 'edited');
});

test('agreement isolates cases, orders, runs, time windows and producer automation', () => {
  for (const e of [{ ...event('approve'), tag: 'other' }, { ...event('approve'), by: 'producer' }, { ...event('approve'), at: '2026-01-01T23:59:00Z' }, { ...event('approve'), data: { run: 'another' } }, { ...event('approve'), data: { caseId: 'another' } }, { ...event('approve'), at: '2026-01-06T00:00:00Z' }]) assert.equal(resolveAgreement(row(), undefined, doc(), [e], later).outcome, 'pending');
  const d = doc(); d.runs.push({ id: 'next', seq: 4, worker: 'builder', started: '2026-01-02T00:30:00Z' });
  assert.equal(resolveAgreement(row(), undefined, d, [event('approve')], later).outcome, 'pending');
  const resolved = resolveAgreement(row(), undefined, doc(), [event('approve')], later);
  assert.deepEqual(resolveAgreement(resolved, undefined, doc(), [event('rework')], later), resolved);
});

export function trustFixture() {
  const records = { review: Array.from({ length: 12 }, (_, i) => row({ caseId: `delivery/sample-${i}`, actionId: `proposal-${i}`, outcome: i < 11 ? 'accepted' : 'rejected', decidedAt: later })), small: Array.from({ length: 3 }, (_, i) => row({ caseId: `question/sample-${i}`, ruleId: 'small', actionId: `small-${i}`, outcome: 'accepted', decidedAt: later })) };
  return ruleTrust([{ id: 'review', instruction: 'Review ready work', action: 'accept', mode: 'propose' }, { id: 'small', instruction: 'Observe questions', action: 'answer', mode: 'observe' }], records, {}, later);
}

test('trust fixture raises at eleven of twelve and refuses to judge three cases', () => {
  const [review, small] = trustFixture();
  assert.equal(review.rate, 11 / 12); assert.equal(review.suggestion?.to, 'auto'); assert.match(review.suggestion!.yaml, /mode: auto/);
  assert.equal(small.decided, 3); assert.equal(small.enough, false); assert.equal(small.suggestion, undefined);
});

test('trust boundary comparisons, configurable minimum, rolling window and lower suggestions', () => {
  const rule = { id: 'review', instruction: 'Review', action: 'accept', mode: 'auto' } as const;
  const records = (accepted: number) => ({ review: Array.from({ length: 10 }, (_, i) => row({ caseId: `delivery/sample-${i}`, outcome: i < accepted ? 'accepted' : 'different' })) });
  assert.equal(ruleTrust([rule], records(5), {}, later)[0].suggestion?.to, 'propose');
  assert.equal(ruleTrust([rule], records(6), {}, later)[0].suggestion, undefined);
  assert.equal(ruleTrust([{ ...rule, mode: 'propose' }], records(9), {}, later)[0].suggestion?.to, 'auto');
  assert.equal(ruleTrust([{ ...rule, mode: 'observe' }], records(9), {}, later)[0].suggestion?.to, 'propose');
  assert.equal(ruleTrust([rule], records(5), { min_cases: 11 }, later)[0].enough, false);
  assert.equal(ruleTrust([rule], records(5), {}, '2026-02-01T00:00:00Z')[0].decided, 0);
  assert.equal(ruleTrust([rule], { review: [row({ outcome: 'nothing' }), row()] }, { min_cases: 1 }, later)[0].rate, null);
  assert.equal(ruleTrust([rule], { review: Array.from({ length: 12 }, () => row({ outcome: 'accepted' })) }, {}, later)[0].decided, 1);
});
