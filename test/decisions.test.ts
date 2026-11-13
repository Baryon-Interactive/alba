import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { addDecision, decisionList, parseRange, referencedDecisions } from '../src/ledger/decisions.ts';
import { fixture, shape } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';

const LEDGER = `# Decisions

| No. | Date | Decision | Said |
|---|---|---|---|
| D2001 | 2026-01-02 | Use a top-down view | "make it top-down" |
| D2002 | 2026-01-05 | Pixel art | default |
| D2010 | 2026-02-01 | Keep saves local | "no cloud saves" |
`;

function project(extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  writeFileSync(path.join(dir, 'decisions.md'), LEDGER);
  const cfg = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state'), decisions: { file: path.join(dir, 'decisions.md'), id_column: 1, date_column: 2, text_column: 3, source_column: 4, reviewer_range: [2030, 2039], ...extra } }, path.join(dir, 'alba.yaml'));
  return { cfg, orders, dir };
}

test('decisions: the project table is read in, own entries are added after it with the reviewer\'s numbers', () => {
  const { cfg, orders } = project();
  const list = decisionList(cfg, orders);
  assert.deepEqual(list.items.map(e => [e.id, e.date, e.sourceKind]), [['D2001', '2026-01-02', 'imported'], ['D2002', '2026-01-05', 'imported'], ['D2010', '2026-02-01', 'imported']]);
  assert.equal(list.next, 'D2030');
  assert.deepEqual(list.reviewerRange, [2030, 2039]);
  const a = addDecision(cfg, orders, { text: 'Two players', source: '"two players, local"' });
  assert.deepEqual([a.id, a.sourceKind, a.by], ['D2030', 'quote', 'cli']);
  const b = addDecision(cfg, orders, { text: 'Tile size 16', default: true });
  assert.deepEqual([b.id, b.sourceKind], ['D2031', 'default']);
  assert.match(b.source, /default/);
  const after = decisionList(cfg, orders);
  assert.equal(after.count, 5);
  assert.equal(after.next, 'D2032');
  assert.ok(orders.store.events().some(e => e.type === 'decision' && (e.data as { id: string }).id === 'D2030'));
});

test('decisions: a decision needs the user\'s words or "default", a valid date, and a free id', () => {
  const { cfg, orders } = project();
  assert.throws(() => addDecision(cfg, orders, { text: 'x' }), /own words/);
  assert.throws(() => addDecision(cfg, orders, { text: 'x', source: 's', default: true }), /not both/);
  assert.throws(() => addDecision(cfg, orders, { text: 'x', source: 's', date: '3 May' }), /YYYY-MM-DD/);
  assert.throws(() => addDecision(cfg, orders, { text: 'x', source: 's', id: 'D2010' }), /taken already/);   // from the table
  assert.throws(() => addDecision(cfg, orders, { text: 'x', source: 's', id: 'D2050' }), /outside the reviewer's range/);
  assert.throws(() => addDecision(cfg, orders, { text: 'x', source: 's', id: 'nonsense' }), /not a decision id/);
  assert.equal(addDecision(cfg, orders, { text: 'y', source: 's', id: '2035' }).id, 'D2035');
  assert.throws(() => addDecision(validateProject({ id: 'x', name: 'x', root: cfg.root, work_orders: cfg.work_orders, state_dir: cfg.state_dir }, cfg.file), orders, { text: 'x', source: 's' }), /no "decisions" section/);
});

test('decisions: a range reserved on an open order cannot be given to anyone else; the order takes its own numbers', () => {
  const { cfg, orders } = project({ reviewer_range: undefined });
  orders.add({ tag: 'W1', title: 'Worker', kind: 'task', mandate: { decisions: 'D2100-D2102' } });
  orders.act('W1', 'queue'); orders.runStart('W1', { worker: 'w' });
  assert.deepEqual(decisionList(cfg, orders).reserved, [{ tag: 'W1', range: [2100, 2102] }]);
  assert.throws(() => addDecision(cfg, orders, { text: 'x', source: 's', id: 'D2101' }), /reserved on W1, which is still open/);
  assert.throws(() => addDecision(cfg, orders, { text: 'x', source: 's', order: 'W1', id: 'D2200' }), /outside the range D2100-D2102/);
  const first = addDecision(cfg, orders, { text: 'The worker decided', source: '"as you see fit"', order: 'W1' });
  assert.equal(first.id, 'D2100');
  assert.equal(addDecision(cfg, orders, { text: 'again', source: 's', order: 'W1' }).id, 'D2101');
  addDecision(cfg, orders, { text: 'c', source: 's', order: 'W1' });
  assert.throws(() => addDecision(cfg, orders, { text: 'd', source: 's', order: 'W1' }), /No free number/);
  // without a reviewer range the next number skips the reserved block
  assert.equal(addDecision(cfg, orders, { text: 'e', source: 's', id: 'D2099' }).id, 'D2099');
  orders.add({ tag: 'N1', title: 'No range', kind: 'task' });
  assert.throws(() => addDecision(cfg, orders, { text: 'x', source: 's', order: 'N1' }), /no number range reserved/);
  // once the order is merged the range is free again
  orders.act('W1', 'approve', { force: true });
  assert.equal(addDecision(cfg, orders, { text: 'free now', source: 's', id: 'D2103' }).id, 'D2103');
  assert.deepEqual(decisionList(cfg, orders).reserved, []);
});

test('decisions: ranges are read from free text; orders reference decisions by id', () => {
  assert.deepEqual(parseRange('D2040-D2050'), [2040, 2050]);
  assert.deepEqual(parseRange('numbers 2040 ~ 2050 are yours'), [2040, 2050]);
  assert.deepEqual(parseRange('D2040 to D2050'), [2040, 2050]);
  assert.equal(parseRange('D2040'), undefined);
  assert.equal(parseRange('D2050-D2040'), undefined);
  const { cfg, orders } = project();
  orders.add({ tag: 'R1', title: 'Follow D2001', kind: 'task', mandate: { quote: 'see D2010 and D9999' } });
  const doc = orders.get('R1');
  assert.deepEqual(referencedDecisions(cfg, doc, 'The file mentions D2002.').map(e => e.id), ['D2001', 'D2002', 'D2010']);
  assert.deepEqual(referencedDecisions(cfg, doc).map(e => e.id), ['D2001', 'D2010']);
});

test('api: the decisions ledger is listed and extended; order detail shows the decisions it names', async () => {
  const f = await fixture({ project: (dir) => { writeFileSync(path.join(dir, 'decisions.md'), LEDGER); return { decisions: { file: path.join(dir, 'decisions.md'), id_column: 1, date_column: 2, text_column: 3, source_column: 4, reviewer_range: [2030, 2039] } }; } });
  const list = (await f.get('/api/decisions')).body;
  shape(list, { project: 'string', count: 'number', items: [{ id: 'string', number: 'number', date: 'string', text: 'string', source: 'string', sourceKind: 'string' }], 'reviewerRange?': 'array', next: 'string', reserved: 'array' });
  assert.equal(list.count, 3);
  assert.equal((await f.post('/api/decisions', { text: 'x', source: 's' })).status, 401);
  assert.equal((await f.write('/api/decisions', { text: 'x' })).status, 400);
  const made = await f.write('/api/decisions', { text: 'Ship in spring', source: '"spring is fine"' });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.id, made.body.by], ['D2030', 'web']);
  assert.equal((await f.write('/api/decisions', { text: 'dup', source: 's', id: 'D2030' })).status, 409);
  assert.equal((await f.write('/api/decisions', { text: 'x', default: true })).body.id, 'D2031');
  f.orders.add({ tag: 'Z1', title: 'Obeys D2001', kind: 'task', mandate: { decisions: 'D2060-D2070' } });
  assert.equal((await f.write('/api/decisions', { text: 'x', source: 's', id: 'D2065' })).status, 409);
  const detail = (await f.get('/api/orders/Z1')).body;
  assert.deepEqual(detail.referencedDecisions.map((e: { id: string }) => e.id), ['D2001']);
  assert.equal((await f.get('/api/decisions')).body.count, 5);
  // without a ledger section the list is empty rather than an error
  const plain = await fixture();
  assert.equal((await plain.get('/api/decisions')).body.count, 0);
  assert.equal((await plain.write('/api/decisions', { text: 'x', source: 's' })).status, 400);
});
