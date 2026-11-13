import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { continueToolJobs, createToolJob, runToolJob, toolJob, toolJobs } from '../src/plugins/jobs.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { Orders } from '../src/orders/service.ts';

/**
 * A project with a paid stand-in tool `meter`: its quote tool answers `price` (and `unpriced` when asked), and its operation behaves
 * as `mode` says: ok, spent (answers `spent`), error, error-spent, hang (never answers).
 */
function fixture(autoApprove?: unknown) {
  const { dir, orders } = tempOrders();
  const tool = path.join(dir, 'tools', 'meter');
  mkdirSync(tool, { recursive: true });
  writeFileSync(path.join(tool, 'server.mjs'), `
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const answer = (id, structuredContent, isError) => send({ id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent ?? {}) }], ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError: true } : {}) } });
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meter', version: '0' } } });
  if (method === 'tools/list') return send({ id, result: { tools: [] } });
  const a = params.arguments ?? {};
  if (params.name === 'meter_price') return answer(id, { amount: a.price ?? 2, ...(a.unpriced ? { unpriced: true } : {}) });
  switch (a.mode) {
    case 'spent': return answer(id, { spent: a.spent });
    case 'error': return answer(id, undefined, true);
    case 'error-spent': return answer(id, { spent: a.spent }, true);
    case 'hang': return;
    default: return answer(id, { done: true });
  }
});
`);
  writeFileSync(path.join(tool, 'alba-plugin.yaml'), [
    'id: meter', 'version: 0.1.0', 'apiVersion: 1', 'kinds: [tool]', 'description: A paid stand-in.',
    'agent:', '  mcp:', '    meter: { command: node, args: ["${plugin}/server.mjs"], workers: false }',
    'operations:', '  work:', '    description: Works for a price.',
    '    input: { type: object, properties: { mode: { type: string }, price: { type: number }, unpriced: { type: boolean }, spent: { type: number } } }',
    '    run: { mcp: meter, tool: meter_work }', '    quote: { unit: credits, tool: meter_price }', '    output: { text: out.txt }',
  ].join('\n') + '\n');
  mkdirSync(path.join(dir, 'orders'));
  const project = validateProject({
    id: 'demo', name: 'Demo', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'),
    plugins: { enable: ['meter'], sources: [{ path: 'tools' }], ...(autoApprove !== undefined ? { auto_approve: autoApprove } : {}) },
  }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'ART1', title: 'Concepts', kind: 'art' });
  return { dir, orders, project };
}
type Fixture = ReturnType<typeof fixture>;
const work = (f: Fixture, input: Record<string, unknown>, orders: Orders = f.orders, timeoutMs?: number) =>
  runToolJob(f.project, orders, createToolJob(f.project, orders, { tool: 'meter', operation: 'work', input, order: 'ART1' }).id, timeoutMs ? { timeoutMs } : {});
const ledger = (f: Fixture) => f.orders.get('ART1').quotes!.flatMap(q => q.ledger.map(e => ({ quote: q.id, amount: e.amount, unknown: e.unknown ?? false })));

test('plugins.auto_approve: a number is one job\'s cap and ten of them a day; the long form names per_job, per_day and per_project', () => {
  assert.deepEqual(fixture({ credits: 5 }).project.plugins!.auto_approve, { credits: { per_job: 5, per_day: 50 } });
  assert.deepEqual(fixture({ credits: { per_job: 2, per_day: 3, per_project: 5 }, images: 0 }).project.plugins!.auto_approve, { credits: { per_job: 2, per_day: 3, per_project: 5 }, images: { per_job: 0, per_day: 0 } });
  assert.throws(() => fixture({ credits: { per_day: 3 } }), /"plugins\.auto_approve\.credits\.per_job" is needed/);
  assert.throws(() => fixture({ credits: { per_job: 1, per_week: 3 } }), /unknown key\(s\) under "plugins\.auto_approve\.credits": per_week/);
  assert.throws(() => fixture({ credits: { per_job: 1, per_day: -1 } }), /"plugins\.auto_approve\.credits\.per_day" must be an amount of at least 0/);
});

test('auto-approval keeps a running total: within one job, a UTC day and the project; past any of them a person decides', async () => {
  const f = fixture({ credits: { per_job: 2, per_day: 3, per_project: 5 } });
  const first = await work(f, { price: 2 });
  const second = await work(f, { price: 1 });
  assert.deepEqual([first.status, first.quote!.auto, second.status, second.quote!.auto], ['done', true, 'done', true]);
  const overDay = await work(f, { price: 1 });
  assert.equal(overDay.status, 'waiting-quote');
  assert.equal(overDay.quote!.auto, undefined);
  assert.equal(overDay.quote!.manual, 'Alba approved 3 credits of tool jobs today; 1 more is over plugins.auto_approve.credits per_day 3');
  assert.match(overDay.waiting!, /waits for approval: alba credits approve ART1 C3 --cap 1 \(Alba approved 3 credits of tool jobs today/);
  const overJob = await work(f, { price: 3 });
  assert.equal(overJob.status, 'waiting-quote');
  assert.match(overJob.quote!.manual!, /3 credits is over what Alba approves for one job \(plugins\.auto_approve\.credits per_job 2\)/);
  // A person's approvals do not count: only what Alba approved by itself.
  f.orders.decideQuote('ART1', overDay.quote!.id!, { approve: true, cap: 1 });
  assert.equal((await runToolJob(f.project, f.orders, overDay.id)).status, 'done');
  // The next UTC day starts again, up to what the project allows in all.
  const tomorrow = new Orders(f.orders.store, () => '2026-01-02T08:00:00.000Z');
  const next = await work(f, { price: 2 }, tomorrow);
  assert.equal(next.status, 'done', next.error);
  assert.equal(next.quote!.autoAt, '2026-01-02T08:00:00.000Z');
  const overProject = await work(f, { price: 1 }, tomorrow);
  assert.equal(overProject.status, 'waiting-quote');
  assert.equal(overProject.quote!.manual, 'Alba approved 5 credits of tool jobs in this project; 1 more is over plugins.auto_approve.credits per_project 5');
  assert.deepEqual(toolJobs(f.project).filter(j => j.quote?.auto).map(j => [j.id, j.quote!.amount]), [['J1', 2], ['J2', 1], ['J5', 2]]);
});

test('a price of 0, or a quote tool that says unpriced, still makes a quote a person approves, and the call is booked', async () => {
  const f = fixture({ credits: 100 });
  const zero = await work(f, { price: 0 });
  assert.equal(zero.status, 'waiting-quote', 'a paid call is never free, and Alba never approves it itself');
  assert.deepEqual([zero.quote!.amount, zero.quote!.unpriced, zero.quote!.auto], [0, true, undefined]);
  assert.match(zero.waiting!, /quote C1 of ART1 \(unpriced, asks 0 credits\) waits for approval: alba credits approve ART1 C1 --cap <amount> \(Alba never approves a quote the tool could not price\)/);
  const quote = f.orders.get('ART1').quotes![0]!;
  assert.deepEqual([quote.cap_requested, quote.status], [0, 'pending']);
  assert.match(quote.note!, /tool job J1: the tool could not price it; approve a cap of your own/);
  f.orders.decideQuote('ART1', 'C1', { approve: true, cap: 4 });
  const ran = await runToolJob(f.project, f.orders, zero.id);
  assert.equal(ran.status, 'done', ran.error);
  assert.deepEqual([ran.spent, ran.spentUnknown], [4, true], 'no price and no word from the tool: the approved cap is booked as the most it cost');
  assert.match(f.orders.get('ART1').quotes![0]!.ledger[0]!.what, /tool job J1 \(meter\/work\): unknown, at most the quote \(the tool could not price it and did not say what it spent\)/);
  // The tool says unpriced with a ceiling: a person approves it, and what the tool reports is booked.
  const ceiling = await work(f, { price: 3, unpriced: true, mode: 'spent', spent: 2 });
  assert.equal(ceiling.status, 'waiting-quote');
  f.orders.decideQuote('ART1', ceiling.quote!.id!, { approve: true, cap: 3 });
  const reported = await runToolJob(f.project, f.orders, ceiling.id);
  assert.deepEqual([reported.status, reported.spent, reported.spentUnknown], ['done', 2, undefined]);
  assert.deepEqual(ledger(f), [{ quote: 'C1', amount: 4, unknown: true }, { quote: 'C2', amount: 2, unknown: false }]);
});

test('a paid call that fails without a word, times out or whose result cannot be written is booked, never as nothing', async () => {
  const f = fixture({ credits: { per_job: 5, per_day: 100 } });
  const error = await work(f, { price: 2, mode: 'error' });
  assert.equal(error.status, 'failed');
  assert.deepEqual([error.spent, error.spentUnknown], [2, true]);
  const said = await work(f, { price: 2, mode: 'error-spent', spent: 1 });
  assert.deepEqual([said.status, said.spent, said.spentUnknown], ['failed', 1, undefined], 'a failure that says what it spent books that');
  const hung = await work(f, { price: 3, mode: 'hang' }, f.orders, 3000);
  assert.equal(hung.status, 'failed');
  assert.deepEqual([hung.spent, hung.spentUnknown], [3, true], 'a timeout may have cost: at most the quote is booked');
  assert.match(f.orders.get('ART1').quotes!.find(q => q.id === hung.quote!.id)!.ledger[0]!.what, /unknown, at most the quote \(the call may have gone through: /);
  // The answer came and is booked at its price before the result is written; the write then fails.
  const blocked = createToolJob(f.project, f.orders, { tool: 'meter', operation: 'work', input: { price: 1 }, order: 'ART1' });
  mkdirSync(path.join(blocked.out, 'out.txt'), { recursive: true });
  const unwritten = await runToolJob(f.project, f.orders, blocked.id);
  assert.equal(unwritten.status, 'failed');
  assert.deepEqual([unwritten.spent, unwritten.spentUnknown], [1, undefined]);
  assert.deepEqual(ledger(f), [{ quote: 'C1', amount: 2, unknown: true }, { quote: 'C2', amount: 1, unknown: false }, { quote: 'C3', amount: 3, unknown: true }, { quote: 'C4', amount: 1, unknown: false }]);
});

test('the tick books a job whose process died while it ran as at most the quote, once, and books a spend that could not be written', () => {
  const f = fixture();
  f.orders.quote('ART1', { id: 'Q1', service: 'meter', unit: 'credits', cap_requested: 5 });
  f.orders.decideQuote('ART1', 'Q1', { approve: true, cap: 5 });
  const a = createToolJob(f.project, f.orders, { tool: 'meter', operation: 'work', input: {}, order: 'ART1' });
  const b = createToolJob(f.project, f.orders, { tool: 'meter', operation: 'work', input: {}, order: 'ART1' });
  writeStateFile(f.project, '_tool-jobs.json', JSON.stringify(toolJobs(f.project).map(j =>
    j.id === a.id ? { ...j, status: 'running', pid: 999999, quote: { unit: 'credits', amount: 2, id: 'Q1' } }
      : { ...j, status: 'failed', quote: { unit: 'credits', amount: 1, id: 'Q1' }, unbooked: { amount: 1, what: `tool job ${b.id} (meter/work)` }, warning: 'could not be booked' })));
  const spawn = (() => 1) as never;
  assert.deepEqual(continueToolJobs(f.project, f.orders, spawn), [
    `tool job ${a.id}: its process is gone; marked failed, 2 credits booked as the most it may have cost`,
    `tool job ${b.id}: booked 1 credits on quote Q1`,
  ]);
  assert.deepEqual(continueToolJobs(f.project, f.orders, spawn), [], 'nothing is booked twice');
  assert.deepEqual(ledger(f), [{ quote: 'Q1', amount: 2, unknown: true }, { quote: 'Q1', amount: 1, unknown: false }]);
  assert.match(toolJob(f.project, a.id).error!, /the call may have gone through, so the most it may have cost is booked as unknown/);
  const booked = toolJob(f.project, b.id);
  assert.deepEqual([booked.spent, booked.unbooked, booked.warning], [1, undefined, undefined]);
});
