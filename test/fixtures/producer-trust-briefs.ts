import type { OrderDoc, OrderEvent } from '../../src/orders/model.ts';
import { computeFacts } from '../../src/producer/facts/engine.ts';
import { buildBrief, type BriefInput, type BriefReadings } from '../../src/producer/briefs.ts';
import { ruleTrust, type AgreementRecord } from '../../src/producer/trust.ts';

export const fixtureNow = '2026-01-03T00:00:00.000Z';
export function trustBriefFixture(language = 'en'): BriefInput {
  const make = (tag: string): OrderDoc => ({ version: 1, order: { tag, title: 'Fixture work', kind: 'code', needs: [], created: '2025-12-28T00:00:00Z', updated: fixtureNow }, actions: [], reports: [], runs: [] });
  const delivery = make('delivery');
  delivery.actions = [{ seq: 1, at: '2026-01-02T01:00:00Z', kind: 'queue' }, { seq: 4, at: '2026-01-02T04:00:00Z', kind: 'rework' }, { seq: 7, at: '2026-01-02T08:00:00Z', kind: 'approve' }];
  delivery.runs = [{ id: 'first', seq: 2, worker: 'builder', started: '2026-01-02T02:00:00Z', ended: '2026-01-02T03:00:00Z', outcome: 'completed' }, { id: 'revised', seq: 5, worker: 'builder', started: '2026-01-02T05:00:00Z', ended: '2026-01-02T06:00:00Z', outcome: 'completed' }];
  delivery.reports = [{ seq: 3, at: '2026-01-02T03:00:00Z', status: 'ready', summary: 'Ready', run: 'first', evidence: [], commits: [] }, { seq: 6, at: '2026-01-02T06:00:00Z', status: 'ready', summary: 'Revised', run: 'revised', evidence: [], commits: [] }];
  const running = make('running'); running.actions = [{ seq: 1, at: '2026-01-02T10:00:00Z', kind: 'queue' }]; running.runs = [{ id: 'active', seq: 2, worker: 'builder', started: '2026-01-02T11:00:00Z' }];
  const held = make('held'); held.actions = [{ seq: 1, at: '2025-12-29T00:00:00Z', kind: 'hold' }];
  const question = make('question'); question.reports = [{ seq: 1, at: '2026-01-02T09:00:00Z', status: 'waiting', summary: 'Needs input', question: 'Choose a direction?', evidence: [], commits: [] }];
  const failed = make('failed'); failed.reports = [{ seq: 1, at: '2026-01-02T12:00:00Z', status: 'failed', summary: 'Build failed', evidence: [], commits: [] }];
  const orders = [delivery, running, held, question, failed];
  const events: OrderEvent[] = orders.flatMap(d => [
    ...d.actions.map(a => ({ tag: d.order.tag, at: a.at, type: `action-${a.kind}`, by: 'web' })),
    ...d.reports.map(r => ({ tag: d.order.tag, at: r.at, type: 'report', data: { status: r.status, run: r.run } })),
    ...d.runs.map(r => ({ tag: d.order.tag, at: r.started, type: 'run-start', data: { run: r.id } })),
  ]).sort((a, b) => a.at.localeCompare(b.at));
  const snapshot = computeFacts({ now: fixtureNow, orders, events, caps: { code: 3 }, usage: [] });
  const readings: BriefReadings = { report: { at: fixtureNow, problems: [{ kind: 'stalled', tag: 'running', text: 'No recent progress' }], heldBack: [{ tag: 'question', why: 'Waiting for an answer' }], moves: [], needsUser: [], unavailable: [], notChecked: [], waiting: [], monitoring: [], finishes: [], done: [], exitCode: 2 }, activity: { running: { lastCommitAt: '2026-01-02T22:00:00Z' } } };
  return { now: fixtureNow, language, orders, events, snapshot, readings, direction: { version: 0, at: '', priorities: 'Finish ready work', stop: '', constraints: '', notes: '' } };
}
export function trustSuggestionFixture() {
  const record = (ruleId: string, i: number, accepted: boolean): AgreementRecord => ({ actionId: `${ruleId}-${i}`, ruleId, caseId: `delivery/sample-${i}`, caseRevision: 1, order: 'sample', proposed: 'accept', at: fixtureNow, expiresAt: fixtureNow, baselineSeq: 0, outcome: accepted ? 'accepted' : 'rejected', decidedAt: fixtureNow });
  return ruleTrust([{ id: 'review', instruction: 'Review ready work', action: 'accept', mode: 'propose' }, { id: 'small', instruction: 'Observe questions', action: 'answer', mode: 'observe' }], { review: Array.from({ length: 12 }, (_, i) => record('review', i, i < 11)), small: Array.from({ length: 3 }, (_, i) => record('small', i, true)) }, {}, fixtureNow);
}
export const fixtureBrief = (language = 'en') => buildBrief(trustBriefFixture(language));
