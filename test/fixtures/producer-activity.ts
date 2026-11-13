import type { ProjectConfig } from '../../src/config.ts';
import type { Orders } from '../../src/orders/service.ts';
import type { ProducerAction, ProducerCase } from '../../src/producer/producer.ts';
import { producerPolicy } from '../../src/producer/producer.ts';
import { writeStateFile } from '../../src/orders/state-files.ts';

export const ACTIVITY_NOW = '2026-06-18T10:30:00.000Z';
/** Invented orders and notes only. Thirty-six actions across two UTC days, no model or executor. */
export function seedProducerActivity(project: ProjectConfig, orders: Orders) {
  const policy = producerPolicy(project);
  const kinds = ['accept', 'rework', 'nudge', 'queue', 'dispatch', 'hold', 'clean', 'answer', 'draft-order'] as const;
  const statuses = ['done', 'failed', 'refused', 'proposed', 'would-do', 'superseded'] as const;
  const cases: ProducerCase[] = [];
  const actions: ProducerAction[] = Array.from({ length: 36 }, (_, i) => {
    const tag = `DEMO${i + 1}`, at = new Date(Date.parse(ACTIVITY_NOW) - (i < 18 ? i * 1200000 : 86400000 + (i - 18) * 1200000)).toISOString();
    orders.add({ tag, title: `Synthetic delivery ${i + 1}`, kind: 'tooling' });
    const c: ProducerCase = { id: `case-${i}`, key: `delivery/${tag}`, order: tag, project: project.id, trigger: 'delivery', status: 'open', revision: 1, openedAt: at, updatedAt: at, facts: {}, card: { trigger: 'delivery', summary: `Review synthetic delivery ${tag}`, pointers: [], untrusted: ['summary'] } };
    cases.push(c);
    const kind = kinds[i % kinds.length], status = statuses[i % statuses.length];
    const note = i === 0 ? 'Spot check of the sample: zero errors claimed.\nChecked the stored evidence and the delivery notes.\nThis note records the producer’s claim for a person to inspect.' : kind === 'rework' ? 'Sampled the interface and found a missing label.\nPlease attach the revised screen.' : `Review synthetic ${kind} work.\nRecorded evidence is available for inspection.`;
    return { id: `action-${String(i).padStart(2, '0')}`, caseId: c.id, caseRevision: 1, target: tag, basis: { stage: orders.stage(orders.get(tag)).stage, actionSeq: Math.max(0, ...orders.get(tag).actions.map(a => a.seq)) }, idempotencyKey: `synthetic-${i}`, kind, status, mode: status === 'would-do' ? 'observe' : status === 'proposed' ? 'propose' : 'auto', at,
      ...(status === 'done' || status === 'failed' ? { ranAt: at, completedAt: new Date(Date.parse(at) + 1000).toISOString() } : {}),
      ruleId: 'review', policyHash: policy.hash, policyVersion: policy.version, note, evidence: ['docs/synthetic-check.md'],
      ...(status === 'done' ? { result: 'Recorded successfully' } : status === 'failed' || status === 'refused' ? { refusal: 'Synthetic prerequisite unavailable' } : {}),
    };
  });
  writeStateFile(project, '_producer-cases.json', JSON.stringify(cases));
  writeStateFile(project, '_producer-actions.json', JSON.stringify(actions));
  writeStateFile(project, '_producer-session.json', JSON.stringify({ state: 'running', active: true, currentTurn: 7, turns: 7, lastTurnAt: ACTIVITY_NOW, usage: { input_tokens: 14000, output_tokens: 4000, total_tokens: 18000 } }));
  writeStateFile(project, '_producer-session-turns.json', JSON.stringify([{ number: 7, at: ACTIVITY_NOW, sent: { kind: 'cards', cards: [{ key: cases[2].key, trigger: 'delivery', revision: 1 }] }, answer: '', tools: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }]));
  writeStateFile(project, '_producer-session-budget.json', JSON.stringify({ hour: ACTIVITY_NOW.slice(0, 13), hourTurns: 7, day: ACTIVITY_NOW.slice(0, 10), dayTurns: 16, dayUsage: 18000 }));
  writeStateFile(project, '_producer-drafting-budget.json', JSON.stringify({ day: ACTIVITY_NOW.slice(0, 10), keys: ['draft-a', 'draft-b'] }));
  writeStateFile(project, '_producer-round.json', JSON.stringify({ at: '2026-06-18T10:00:00.000Z' }));
  const audit = [
    { kind: 'session-start', at: '2026-06-17T08:00:00.000Z' },
    { kind: 'pause', at: '2026-06-17T09:00:00.000Z', reason: 'Director paused for a milestone review' },
    { kind: 'resume', at: '2026-06-17T09:10:00.000Z' },
    { kind: 'budget-exhausted', at: '2026-06-17T21:00:00.000Z', reason: 'Daily usage allowance reached' },
    { kind: 'session-stop', at: '2026-06-17T21:01:00.000Z' },
    { kind: 'action', id: actions[0].id, status: 'done', at: ACTIVITY_NOW },
  ];
  writeStateFile(project, 'producer-audit.jsonl', audit.map(e => JSON.stringify(e)).join('\n') + '\n');
  orders.store.appendEvent({ tag: 'DEMO1', type: 'accept-step', at: ACTIVITY_NOW, by: 'producer', data: { name: 'design-changesets', status: 'passed', files: ['design/changes/synthetic.json'] } });
  orders.store.appendEvent({ tag: 'DEMO1', type: 'accept-merged', at: ACTIVITY_NOW, by: 'producer', data: { merge: '0123456789abcdef0123456789abcdef01234567' } });
  return { actions, cases };
}
