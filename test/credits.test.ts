import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creditsOf, gate, quoteList } from '../src/credits/credits.ts';
import { fixture, shape } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { tempOrders } from './helpers.ts';

test('credits: a quote waits for a person, who approves it with a cap of their own; spending stops at the cap', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'A1', title: 'Art', kind: 'task' });
  assert.throws(() => orders.quote('A1', { service: '', cap_requested: 10 }), /service/);
  assert.throws(() => orders.quote('A1', { service: 'images', cap_requested: 0 }), /above 0/);
  const { quote } = orders.quote('A1', { service: 'image generation', unit: 'credits', unit_price: 2, quantity: 10, cap_requested: 30, note: 'sprites' }, 'cli');
  assert.deepEqual([quote.id, quote.status, quote.total, quote.unit], ['C1', 'pending', 20, 'credits']);
  assert.throws(() => orders.spend('A1', 'C1', { amount: 1, what: 'x' }), /pending: nothing can be spent/);
  assert.equal(gate(orders, 'A1', 'C1', 1).ok, false);
  assert.deepEqual(creditsOf(orders.get('A1')), { credits: { approved: 0, spent: 0, pending: 30 } });
  assert.throws(() => orders.decideQuote('A1', 'C1', { approve: true, cap: 0 }), /above 0/);
  const approved = orders.decideQuote('A1', 'C1', { approve: true, cap: 25, note: 'but not more' });
  assert.deepEqual([approved.quote.status, approved.quote.approval?.cap, approved.quote.approval?.note], ['approved', 25, 'but not more']);
  assert.throws(() => orders.decideQuote('A1', 'C1', { approve: false }), /decided already/);
  // Each gate that passes holds what it let through; a booking without a key takes the place of the oldest holds.
  const held = gate(orders, 'A1', 'C1', 10);
  assert.deepEqual([held.ok, held.remaining, held.hold?.amount], [true, 25, 10]);
  assert.equal(gate(orders, 'A1', 'C1', 10).remaining, 15);
  orders.spend('A1', 'C1', { amount: 20, what: '10 sprites' });
  const g = gate(orders, 'A1', 'C1', 10);
  assert.equal(g.ok, false);
  assert.equal(g.remaining, 5);
  assert.match(g.why, /5 credits left, 10 are needed/);
  assert.throws(() => orders.spend('A1', 'C1', { amount: 6, what: 'one more batch' }), /above the approved cap of 25 credits \(20 spent already\)/);
  orders.spend('A1', 'C1', { amount: 5, what: 'last' });
  assert.deepEqual(creditsOf(orders.get('A1')), { credits: { approved: 25, spent: 25, pending: 0 } });
  // another unit stays apart
  orders.quote('A1', { service: 'model calls', unit: 'usd', cap_requested: 3 });
  assert.deepEqual(creditsOf(orders.get('A1')), { credits: { approved: 25, spent: 25, pending: 0 }, usd: { approved: 0, spent: 0, pending: 3 } } as never);
  orders.decideQuote('A1', 'C2', { approve: false, note: 'no' });
  assert.equal(gate(orders, 'A1', 'C2', 1).ok, false);
  assert.match(gate(orders, 'A1', 'C2', 1).why, /rejected/);
  assert.equal(quoteList('p', orders, 'rejected').count, 1);
  assert.equal(gate(orders, 'A1', 'C9', 1).ok, false);
  const types = orders.store.events({ tag: 'A1' }).map(e => e.type).filter(t => t.startsWith('quote-'));
  assert.deepEqual(types, ['quote-made', 'quote-approved', 'quote-held', 'quote-held', 'quote-spent', 'quote-spent', 'quote-made', 'quote-rejected']);
});

test('credits: alba credits gate exits 1 unless the approved quote has enough left', () => {
  const { dir } = tempOrders();
  const project = projectDir(dir);
  assert.equal(alba(project, ['orders', 'add', 'A1', '--title', 'Art', '--kind', 'task']).code, 0);
  const quote = alba(project, ['credits', 'quote', 'A1', '--service', 'images', '--cap', '10']);
  assert.equal(quote.code, 0, quote.err);
  assert.match(quote.out, /quote C1 for images made, asking 10 credits/);
  const waiting = alba(project, ['credits', 'gate', 'A1', 'C1', '--need', '2']);
  assert.equal(waiting.code, 1);
  assert.match(waiting.out, /waits for approval; do not spend/);
  assert.equal(alba(project, ['credits', 'approve', 'A1', 'C1', '--cap', '5']).code, 0);
  const ok = alba(project, ['credits', 'gate', 'A1', 'C1', '--need', '2']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /2 of 5 credits left may be spent/);
  assert.equal(alba(project, ['credits', 'spend', 'A1', 'C1', '--amount', '4', '--what', 'four']).code, 0);
  const low = alba(project, ['credits', 'gate', 'A1', 'C1', '--need', '2']);
  assert.equal(low.code, 1);
  assert.match(low.out, /1 credits left, 2 are needed/);
  const over = alba(project, ['credits', 'spend', 'A1', 'C1', '--amount', '2', '--what', 'too much']);
  assert.equal(over.code, 1);
  assert.match(over.err, /above the approved cap/);
  const list = alba(project, ['credits', 'list']);
  assert.match(list.out, /A1\/C1\s+approved\s+images\s+4\/5 credits/);
  assert.equal(alba(project, ['credits', 'gate', 'A1', 'C1']).code, 1);      // --need is required
});

test('api: quotes are made, approved with a cap, spent against and listed; pending ones show on the overview', async () => {
  const f = await fixture();
  assert.equal((await f.post('/api/orders/W1/quotes', { service: 's', capRequested: 5 })).status, 401);
  assert.equal((await f.write('/api/orders/W1/quotes', { service: 's' })).status, 400);
  assert.equal((await f.write('/api/orders/W1/quotes', { service: 's', capRequested: 'many' })).status, 400);
  const made = await f.write('/api/orders/W1/quotes', { service: 'image generation', unit: 'credits', unitPrice: 2, quantity: 5, capRequested: 12, note: 'ten sprites' });
  assert.equal(made.status, 201);
  shape(made.body, { id: 'string', project: 'string', tag: 'string', service: 'string', unit: 'string', capRequested: 'number', created: 'string', by: 'string', status: 'string', spent: 'number', ledger: 'array', 'total?': 'number', 'remaining?': 'number' });
  assert.deepEqual([made.body.id, made.body.status, made.body.total, made.body.by], ['C1', 'pending', 10, 'web']);
  const overview = (await f.get('/api/overview')).body;
  assert.equal(overview.pendingQuotes.count, 1);
  assert.equal(overview.pendingQuotes.items.length, 1);
  assert.equal((await f.write('/api/orders/W1/quotes/C1/spend', { amount: 1, what: 'x' })).status, 409);       // not approved yet
  assert.equal((await f.write('/api/orders/W1/quotes/C1/approve', {})).status, 400);                           // the cap is the person's to give
  const approved = await f.write('/api/orders/W1/quotes/C1/approve', { cap: 8, note: 'eight at most' });
  assert.equal(approved.status, 200);
  assert.deepEqual([approved.body.status, approved.body.approval.cap, approved.body.remaining], ['approved', 8, 8]);
  assert.equal((await f.write('/api/orders/W1/quotes/C1/approve', { cap: 9 })).status, 409);
  assert.equal((await f.get('/api/overview')).body.pendingQuotes.count, 0);
  const spent = await f.write('/api/orders/W1/quotes/C1/spend', { amount: 5, what: 'five sprites' });
  assert.deepEqual([spent.body.spent, spent.body.remaining, spent.body.ledger.length], [5, 3, 1]);
  assert.equal((await f.write('/api/orders/W1/quotes/C1/spend', { amount: 4, what: 'more' })).status, 409);
  const detail = (await f.get('/api/orders/W1')).body;
  assert.equal(detail.quotes.length, 1);
  assert.deepEqual(detail.spend.credits, { credits: { approved: 8, spent: 5, pending: 0 } });
  assert.equal((await f.get('/api/orders')).body.items.find((i: { tag: string }) => i.tag === 'W1').spend, undefined); // list rows omit detailed spend; detail above retains it
  const second = await f.write('/api/orders/W1/quotes', { service: 'sounds', capRequested: 3 });
  assert.equal((await f.write(`/api/orders/W1/quotes/${second.body.id}/reject`, { note: 'not needed' })).body.status, 'rejected');
  assert.equal((await f.get('/api/credits')).body.count, 2);
  assert.deepEqual((await f.get('/api/credits?status=rejected')).body.items.map((x: { id: string }) => x.id), ['C2']);
  assert.equal((await f.get('/api/credits?status=nonsense')).status, 400);
  assert.equal((await f.write('/api/orders/W1/quotes/C9/approve', { cap: 1 })).status, 400);
});
