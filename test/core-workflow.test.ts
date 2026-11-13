import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { parseReportBlock, validateReport } from '../src/orders/report.ts';
import { importTable } from '../src/table/import.ts';
import { fixture, shape } from './api-fixture.ts';
import { openStream, tempOrders } from './helpers.ts';
import { readKeyFile } from '../src/web/auth.ts';


const TABLE = `# Plan

| Status | Order |
|---|---|
| card waits | CA1 Needs a click |
| asks | CA2 Needs an answer |
| ready | CA3 Done |
`;

const projectWith = (extra: Record<string, unknown>) => {
  const { dir } = tempOrders();
  return validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state'), dispatch_table: { file: path.join(dir, 'plan.md'), status_column: 1, order_column: 2, status_map: { 'card waits': 'awaiting-user', asks: 'awaiting-user', ready: 'awaiting-review' }, ...extra } }, path.join(dir, 'alba.yaml'));
};

test('table import: a status word listed in card_words waits for a card, other awaiting-user words wait for an answer', () => {
  const cfg = projectWith({ card_words: ['card waits'] });
  const { orders } = tempOrders();
  importTable(orders, cfg.dispatch_table!, TABLE);
  assert.equal(orders.stage(orders.get('CA1')).waitingFor, 'card');
  assert.equal(orders.stage(orders.get('CA2')).waitingFor, 'answer');
  assert.equal(orders.stage(orders.get('CA3')).waitingFor, undefined);
  // the answer action is refused for the card, and allowed for the question
  assert.throws(() => orders.act('CA1', 'answer', { note: 'x' }), /waits for a card/);
  orders.act('CA2', 'answer', { note: 'yes' });
  assert.equal(orders.stage(orders.get('CA2')).stage, 'queued');
});

test('table import: card_words added later reach orders already imported, and a word that is not awaiting-user is refused', () => {
  const { orders } = tempOrders();
  importTable(orders, projectWith({}).dispatch_table!, TABLE);
  assert.equal(orders.stage(orders.get('CA1')).waitingFor, 'answer');
  importTable(orders, projectWith({ card_words: ['card waits'] }).dispatch_table!, TABLE);
  assert.equal(orders.stage(orders.get('CA1')).waitingFor, 'card');
  assert.equal(orders.stage(orders.get('CA2')).waitingFor, 'answer');
  assert.throws(() => projectWith({ card_words: ['ready'] }), /awaiting-user/);
});

test('report block: options need a question, 2 to 4 of them, recommended first; waiting_for is checked', () => {
  const ok = validateReport({ status: 'waiting', summary: 's', question: 'Which?', options: ['A', { label: 'B', note: 'why', images: ['b.png'] }], waiting_for: 'answer', evidence: [], commits: [] });
  assert.deepEqual(ok.options, [{ label: 'A' }, { label: 'B', note: 'why', images: ['b.png'] }]);
  assert.throws(() => validateReport({ status: 'waiting', summary: 's', question: 'Which?', options: ['only one'] }), /2 to 4 options/);
  assert.throws(() => validateReport({ status: 'waiting', summary: 's', question: 'Which?', options: ['a', 'b', 'c', 'd', 'e'] }), /2 to 4 options/);
  assert.throws(() => validateReport({ status: 'waiting', summary: 's', options: ['a', 'b'] }), /together with a "question"/);
  assert.throws(() => validateReport({ status: 'waiting', summary: 's', question: 'q', waiting_for: 'nobody' }), /"card" or "answer"/);
  assert.throws(() => validateReport({ status: 'ready', summary: 's', waiting_for: 'card' }), /status "waiting"/);
  const block = parseReportBlock(['text', '--- alba-report ---', JSON.stringify({ status: 'waiting', summary: 'x', question: 'Pick', options: ['One', 'Two'] }), '--- end ---'].join('\n'));
  assert.equal(block.options?.length, 2);
});

test('asking a question with options and picking one records who, when and the note; the order is queued again', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'K1', title: 'Look', kind: 'task' });
  orders.act('K1', 'queue');
  orders.runStart('K1', { worker: 'w' }); orders.runEnd('K1');
  assert.throws(() => orders.ask('K1', { text: 'Which?', options: [{ label: 'only' }] }), /2 to 4/);
  const { question } = orders.ask('K1', { text: 'Which palette?', options: [{ label: 'Warm', note: 'recommended' }, { label: 'Cold', images: ['c.png'] }] }, 'cli');
  assert.equal(question.id, 'Q1');
  assert.equal(orders.stage(orders.get('K1')).stage, 'awaiting-user');
  assert.throws(() => orders.pick('K1', 'Q1', { choice: 3 }), /from 1 to 2/);
  const picked = orders.pick('K1', 'q1', { choice: 2, note: 'colder please', who: 'Sam' });
  assert.deepEqual([picked.question.answered?.choice, picked.question.answered?.note, picked.question.answered?.who, picked.question.answered?.by], [[2], 'colder please', 'Sam', 'cli']);
  const doc = orders.get('K1');
  assert.equal(orders.stage(doc).stage, 'queued');
  assert.match(doc.actions.at(-1)!.note!, /option 2, Cold/);
  assert.match(doc.actions.at(-1)!.note!, /colder please/);
  assert.equal(doc.actions.at(-1)!.choice, 2);
  assert.throws(() => orders.pick('K1', 'Q1', { choice: 1 }), /answered already/);
  const types = orders.store.events({ tag: 'K1' }).map(e => e.type);
  assert.ok(types.includes('question-asked') && types.includes('question-answered'));
});

test('api: approve is offered only for an order awaiting review; answer is not offered for a card', async () => {
  const f = await fixture();
  f.orders.add({ tag: 'C1', title: 'A card', kind: 'task' });
  f.orders.report('C1', { status: 'waiting', summary: 's', question: 'Click the card', waiting_for: 'card', evidence: [], commits: [] });
  const card = (await f.get('/api/orders/C1')).body;
  assert.equal(card.waitingFor, 'card');
  assert.ok(!card.actions.includes('answer'));
  assert.match(card.unavailable.answer, /card/);
  assert.equal((await f.get('/api/orders?stage=awaiting-user')).body.items.find((i: { tag: string }) => i.tag === 'C1').waitingFor, 'card');
  assert.equal((await f.write('/api/orders/C1/actions', { action: 'answer', text: 'hi' })).status, 409);
  const q1 = (await f.get('/api/orders/Q1')).body;
  assert.equal(q1.waitingFor, 'answer');
  assert.ok(q1.actions.includes('answer'));
  // a running order is not offered approve, and the call is refused
  const w1 = (await f.get('/api/orders/W1')).body;
  assert.ok(!w1.actions.includes('approve'));
  assert.match(w1.unavailable.approve, /awaiting review/);
  const refused = await f.write('/api/orders/W1/actions', { action: 'approve' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /awaiting review/);
  assert.ok((await f.get('/api/orders/R1')).body.actions.includes('approve'));
});

test('api: a question with options is asked and picked over the interface; the pick records who and when', async () => {
  const f = await fixture();
  f.orders.add({ tag: 'P1', title: 'Pick', kind: 'task' });
  f.orders.act('P1', 'queue'); f.orders.runStart('P1', { worker: 'coder' }); f.orders.runEnd('P1');
  assert.equal((await f.post('/api/orders/P1/questions', { text: 'q', options: ['a', 'b'] })).status, 401);   // a write needs the token
  assert.equal((await f.write('/api/orders/P1/questions', { text: 'q', options: ['a'] })).status, 400);
  const asked = await f.write('/api/orders/P1/questions', { text: 'Which tileset?', options: [{ label: 'Forest', note: 'my pick' }, { label: 'Desert' }, 'Snow'] });
  assert.equal(asked.status, 201);
  shape(asked.body, { id: 'string', text: 'string', options: [{ key: 'string', label: 'string', images: 'array', recommended: 'boolean' }], askedBy: 'string', at: 'string' });
  assert.deepEqual(asked.body.options.map((o: { key: string; recommended: boolean }) => [o.key, o.recommended]), [['1', true], ['2', false], ['3', false]]);
  const waiting = (await f.get('/api/orders/P1')).body;
  assert.equal(waiting.stage, 'awaiting-user');
  assert.equal(waiting.questions.length, 1);
  assert.equal(waiting.reports.at(-1).options.length, 3);
  assert.equal((await f.write('/api/orders/P1/questions/Q1/answer', { choice: 7 })).status, 400);
  const picked = await f.write('/api/orders/P1/questions/Q1/answer', { choice: 2, note: 'desert is nicer', who: 'Sam' });
  assert.equal(picked.status, 200);
  assert.deepEqual([picked.body.answered.choice, picked.body.answered.note, picked.body.answered.who, picked.body.answered.by], [['2'], 'desert is nicer', 'Sam', 'web']);
  const after = (await f.get('/api/orders/P1')).body;
  assert.equal(after.questions[0].answered.choice[0], '2');
  assert.ok(['queued', 'running'].includes(after.stage));
  assert.equal(after.decisions.at(-1).choice, 2);
  assert.equal((await f.write('/api/orders/P1/questions/Q1/answer', { choice: 1 })).status, 400);
});

test('api: an answer to a report with options can name the option (choice), with a note', async () => {
  const f = await fixture();
  f.orders.add({ tag: 'O1', title: 'Options', kind: 'task' });
  f.orders.act('O1', 'queue'); f.orders.runStart('O1', { worker: 'coder' }); f.orders.runEnd('O1');
  f.orders.report('O1', { status: 'waiting', summary: 's', question: 'Which?', options: [{ label: 'Red' }, { label: 'Blue' }], evidence: [], commits: [] });
  const detail = (await f.get('/api/orders/O1')).body;
  assert.deepEqual(detail.reports.at(-1).options.map((o: { label: string }) => o.label), ['Red', 'Blue']);
  assert.equal((await f.write('/api/orders/O1/actions', { action: 'answer' })).status, 400);              // neither text nor choice
  assert.equal((await f.write('/api/orders/O1/actions', { action: 'answer', choice: 9 })).status, 400);
  const r = await f.write('/api/orders/O1/actions', { action: 'answer', choice: 2, text: 'the lighter one' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await f.get('/api/orders/O1')).body;
  assert.match(after.decisions.at(-1).note, /option 2, Blue/);
  assert.equal(after.decisions.at(-1).choice, 2);
});

test('api: runs of all orders, newest first, filtered by since and worker, in pages', async () => {
  const f = await fixture();
  f.orders.add({ tag: 'X1', title: 'More runs', kind: 'task' });
  for (let i = 0; i < 3; i++) { f.orders.act('X1', 'queue', { force: true }); f.orders.runStart('X1', { worker: i === 1 ? 'editor' : 'coder' }); f.orders.runEnd('X1'); }
  const all = (await f.get('/api/runs')).body;
  shape(all, { project: 'string', count: 'number', items: [{ id: 'string', key: 'string', worker: 'string', started: 'string', project: 'string', tag: 'string', title: 'string', stage: 'string', hasLog: 'boolean' }] });
  assert.equal(all.count, 6);                                  // Q1, R1, W1 and three of X1
  const starts = all.items.map((r: { started: string }) => r.started);
  assert.deepEqual(starts, [...starts].sort().reverse());
  assert.equal(all.next, undefined);
  const onlyEditor = (await f.get('/api/runs?worker=editor')).body;
  assert.deepEqual(onlyEditor.items.map((r: { key: string }) => r.key), ['X1:r2']);
  const since = (await f.get(`/api/runs?since=${encodeURIComponent(all.items[1].started)}`)).body;
  assert.equal(since.count, 2);
  assert.equal((await f.get('/api/runs?since=yesterday')).status, 400);
  const page1 = (await f.get('/api/runs?limit=4')).body;
  assert.equal(page1.count, 4);
  assert.ok(page1.next);
  const page2 = (await f.get(`/api/runs?limit=4&cursor=${encodeURIComponent(page1.next)}`)).body;
  assert.equal(page2.count, 2);
  assert.equal(page2.next, undefined);
  assert.deepEqual([...page1.items, ...page2.items].map((r: { key: string }) => r.key), all.items.map((r: { key: string }) => r.key));
});

test('api: a new order takes base_ref and tags', async () => {
  const f = await fixture();
  const made = await f.write('/api/orders', { tag: 'N1', title: 'From a branch', kind: 'task', base_ref: 'feature/base', tags: ['Art', 'ui'] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const detail = (await f.get('/api/orders/N1')).body;
  assert.equal(detail.order.base_ref, 'feature/base');
  assert.deepEqual(detail.order.tags, ['art', 'ui']);
  assert.deepEqual((await f.get('/api/orders')).body.items.find((i: { tag: string }) => i.tag === 'N1').tags, ['art', 'ui']);
  assert.equal((await f.write('/api/orders', { tag: 'N2', title: 'Bad', kind: 'task', base_ref: '--upload-pack=x' })).status, 400);
  assert.equal((await f.write('/api/orders', { tag: 'N3', title: 'Bad', kind: 'task', tags: 'art' })).status, 400);
});

test('api: reads do not wait for the slow probes, and a write is visible in the order detail at once', async () => {
  const f = await fixture();
  const t0 = Date.now();
  await f.write('/api/orders/D1/actions', { action: 'queue' });
  const d = (await f.get('/api/orders/D1')).body;
  assert.equal(d.stage, 'queued');
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('stream: decisions, questions, quotes and a clean arrive as events of their own', async () => {
  const f = await fixture({ project: () => ({ decisions: { id_column: 1, text_column: 2 } }) });
  const s = await openStream(f.base, 'project=demo', { 'x-alba-token': f.token });
  const wait = async (name: string) => {
    for (let i = 0; i < 20; i++) { const frame = await s.next(); if (frame.event === name) return frame; }
    throw new Error(`no ${name} event`);
  };
  try {
    await f.write('/api/decisions', { text: 'Two players', source: '"two"' });
    assert.equal((await wait('decision.added')).data.data.id, 'D1');
    f.orders.add({ tag: 'S1', title: 'Stream', kind: 'task' });
    f.orders.act('S1', 'queue'); f.orders.runStart('S1', { worker: 'coder' }); f.orders.runEnd('S1');
    await f.write('/api/orders/S1/questions', { text: 'Which?', options: ['a', 'b'] });
    assert.equal((await wait('question.asked')).data.tag, 'S1');
    await f.write('/api/orders/S1/questions/Q1/answer', { choice: 1 });
    assert.equal((await wait('question.answered')).data.data.choice, 1);
    await f.write('/api/orders/S1/quotes', { service: 'images', capRequested: 5 });
    assert.equal((await wait('credits.changed')).data.type, 'quote-made');
    f.orders.record('S1', 'clean', { action: 'remove', result: 'removed' });
    assert.equal((await wait('clean.done')).data.tag, 'S1');
  } finally { s.close(); }
});

test('alba web --allow-origin lets a front end on another origin call the interface', async () => {
  const { freePort } = await import('../src/web/port.ts');
  const { spawn } = await import('node:child_process');
  const { projectDir } = await import('./cli-helper.ts');
  const dir = tempOrders().dir;
  const project = projectDir(dir);
  const port = await freePort('127.0.0.1');
  const main = path.resolve(import.meta.dirname, '../src/cli/main.ts');
  // The key file goes to a folder of this test, not the person's own.
  const env = { ...process.env, ALBA_RUNTIME_DIR: path.join(dir, 'run') };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', main, 'web', '--port', String(port), '--allow-origin', 'http://localhost:5173', '--sign-in', '--project', project], { stdio: 'ignore', env });
  try {
    let record: ReturnType<typeof readKeyFile>;
    for (let i = 0; i < 100 && !record; i++) { record = readKeyFile(port, env); if (!record) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(record, 'the board did not start (no key file)');
    const key = { 'x-alba-token': record.key };
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`)).status, 401);                                 // the key file is the way in
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { ...key, origin: 'http://localhost:5173' } })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { ...key, origin: 'http://evil.example' } })).status, 403);
  } finally { child.kill(); }
});
