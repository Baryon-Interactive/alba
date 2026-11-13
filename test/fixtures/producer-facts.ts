import type { OrderDoc, OrderEvent } from '../../src/orders/model.ts';
import { computeFacts } from '../../src/producer/facts/engine.ts';

export const NOW = '2026-11-08T00:00:00.000Z';
export const hour = (h: number) => new Date(Date.parse('2026-11-07T00:00:00.000Z') + h * 3_600_000).toISOString();
export function producerFactsFixture() {
  const order = (tag: string): OrderDoc => ({ version: 1, order: { tag, title: 'Fixture order', kind: 'engine', needs: [], created: hour(0), updated: hour(23) }, actions: [{ seq: 1, kind: 'queue', at: hour(0) }], runs: [], reports: [] });
  const a = order('A1');
  a.runs = [{ id: 'r1', seq: 2, worker: 'builder', started: hour(0), ended: hour(6), outcome: 'completed', usage: { source: 'codex-json', total_tokens: 40 } }, { id: 'r2', seq: 5, worker: 'builder', started: hour(18), ended: hour(20), outcome: 'completed', usage: { source: 'codex-json', total_tokens: 60 } }];
  a.reports = [{ seq: 3, at: hour(6), run: 'r1', status: 'monitoring', summary: 'Build running', evidence: [], commits: [] }, { seq: 6, at: hour(20), run: 'r2', status: 'ready', summary: 'Delivered', evidence: [], commits: [] }];
  a.actions.push({ seq: 4, kind: 'monitor', at: hour(18) }, { seq: 7, kind: 'approve', at: hour(22) });
  const b = order('B1');
  b.runs = [{ id: 'r1', seq: 2, worker: 'builder', started: hour(0), ended: hour(12), outcome: 'completed', usage: { source: 'codex-json', total_tokens: 80 } }, { id: 'r2', seq: 5, worker: 'builder', started: hour(14), ended: hour(20), outcome: 'completed', usage: { source: 'codex-json', total_tokens: 120 } }];
  b.reports = [{ seq: 3, at: hour(12), run: 'r1', status: 'ready', summary: 'Delivered', evidence: [], commits: [] }, { seq: 6, at: hour(20), run: 'r2', status: 'ready', summary: 'Revised', evidence: [], commits: [] }];
  b.actions.push({ seq: 4, kind: 'rework', at: hour(14) }, { seq: 7, kind: 'approve', at: hour(23) });
  const c = order('C1');
  c.runs = [{ id: 'r1', seq: 2, worker: 'builder', started: hour(0), usage: { source: 'codex-json', total_tokens: 30 } }];
  const errors = ['Build failed on disk', 'Tool crash', 'Quota exhausted', 'Need clarification of specification', 'Acceptance criteria not met', 'Unexpected purple outcome'].map((summary, i) => {
    const d = order(`E${i + 1}`);
    d.reports.push({ seq: 2, at: hour(3), status: 'blocked', summary, evidence: [], commits: [] });
    return d;
  });
  const docs = [a, b, c, ...errors];
  const events: OrderEvent[] = docs.flatMap(d => [
    { at: d.order.created, tag: d.order.tag, type: 'order-added', data: { kind: d.order.kind } },
    ...d.actions.map(a => ({ at: a.at, tag: d.order.tag, type: `action-${a.kind}` })),
    ...d.reports.map(r => ({ at: r.at, tag: d.order.tag, type: 'report', data: { status: r.status, summary: r.summary } })),
    ...d.runs.flatMap(r => [{ at: r.started, tag: d.order.tag, type: 'run-start', data: { run: r.id, worker: r.worker } }, ...(r.ended ? [{ at: r.ended, tag: d.order.tag, type: 'run-end', data: { run: r.id, outcome: r.outcome } }] : [])]),
  ]).sort((a, b) => a.at.localeCompare(b.at));
  const input = { orders: docs, events, usage: [], caps: { engine: 3 }, now: NOW };
  return { ...input, snapshot: computeFacts(input) };
}

