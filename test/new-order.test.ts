import { SqliteStore } from '../src/orders/sqlite-store.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject, validateProject } from './state-helper.ts';
import { createOrder, slugOf } from '../src/service/new-order.ts';
import { importTable } from '../src/table/import.ts';
import { tempOrders } from './helpers.ts';

const PLAN = ['# Plan', '', '## Queue', '', '| Status | Order | Worker | Needs |', '|---|---|---|---|', '| todo | C1 First thing | Codex | |', '', 'After.', ''].join('\n');

function fixture(writeBack: boolean) {
  const { orders, dir } = tempOrders();
  mkdirSync(path.join(dir, 'orders'));
  writeFileSync(path.join(dir, 'plan.md'), PLAN);
  writeFileSync(path.join(dir, 'alba.yaml'), `id: demo
name: Demo
root: .
work_orders: orders
state_dir: state
dispatch_table:
  file: plan.md
  section: Queue
  status_column: 1
  order_column: 2
  worker_column: 3
  needs_column: 4
  write_back: ${writeBack}
  status_map: { todo: queued, later: draft }
`);
  const project = loadProject(path.join(dir, 'alba.yaml'));
  importTable(orders, project.dispatch_table!, PLAN);
  return { orders, dir, project };
}

test('slug: lower-case ASCII words, or "order" when the title has none', () => {
  assert.equal(slugOf('Add a Map  Editor, v2!'), 'add-a-map-editor-v2');
  assert.equal(slugOf('!!!'), 'order');
  assert.equal(slugOf('x'.repeat(80)).length, 40);
});

test('new order: the file, the state and the table row are made together, and the order can be queued', () => {
  const { orders, dir, project } = fixture(true);
  const made = createOrder(project, orders, { tag: 'C2', title: 'Second thing', kind: 'sim', body: '# C2\nDo it.', queue: true }, new Date('2026-01-01T00:00:00Z'));
  assert.equal(made.file, path.join(dir, 'orders', 'C2-second-thing.md').replace(/\\/g, '/'));
  assert.equal(readFileSync(made.file!, 'utf8'), '# C2\nDo it.\n');
  assert.equal(orders.stage(orders.get('C2')).stage, 'queued');
  assert.deepEqual(createOrder(project, orders, { tag: 'C7', title: 'Seventh', needs: ['C1'], body: '# C7', queue: true }).doc.order.needs, ['C1']);
  assert.equal(made.tableRow, true);
  assert.match(readFileSync(path.join(dir, 'plan.md'), 'utf8'), /\| todo \| C2 Second thing \|/);
  assert.ok(orders.store instanceof SqliteStore ? orders.store.db.prepare("SELECT name FROM meta WHERE name LIKE 'file:backups/%'").all().length > 0 : existsSync(path.join(project.state_dir, 'backups')));
  assert.deepEqual(orders.store.events({ tag: 'C2' }).map(e => e.type), ['order-added', 'action-queue', 'order-updated']);   // the last one: the table was read back, the order now has its row
});

test('new order: nothing is created when the tag or the file exists, a file is never replaced, and without a body only the state is touched', () => {
  const { orders, dir, project } = fixture(false);
  writeFileSync(path.join(dir, 'orders', 'C3-old.md'), 'mine\n');
  const events = () => orders.store.events().length;
  const before = events();
  assert.throws(() => createOrder(project, orders, { tag: 'C3', title: 'Third', body: 'new text' }), /exists already: .*C3-old\.md/);
  assert.throws(() => createOrder(project, orders, { tag: 'C1', title: 'Again', body: 'x' }), /"C1" already exists/);
  assert.throws(() => createOrder(project, orders, { tag: 'C4', title: '  ', body: 'x' }), /needs a title/);
  assert.throws(() => createOrder(project, orders, { tag: 'C4', title: 'Four', body: '   ' }), /text is empty/);
  assert.throws(() => createOrder(project, orders, { tag: 'C4', title: 'Four', body: 'x', slug: '../evil' }), /file name part/);
  assert.equal(readFileSync(path.join(dir, 'orders', 'C3-old.md'), 'utf8'), 'mine\n');
  assert.ok(!existsSync(path.join(dir, 'orders', 'C4-four.md')) && !existsSync(path.join(dir, 'orders', 'C4-order.md')));   // a refused order leaves no file
  assert.equal(events(), before);
  // no body: state only; the table is untouched because write_back is off
  const made = createOrder(project, orders, { tag: 'C5', title: 'Five' });
  assert.deepEqual([made.file, made.tableRow, made.tableWarning, orders.get('C5').order.kind], [undefined, false, undefined, 'task']);
  assert.equal(readFileSync(path.join(dir, 'plan.md'), 'utf8'), PLAN);
});

test('new order: a table that changed since the import is not written; the order exists and the answer says why', () => {
  const { orders, dir, project } = fixture(true);
  writeFileSync(path.join(dir, 'plan.md'), PLAN.replace('First thing', 'First thing, edited by hand'));
  const made = createOrder(project, orders, { tag: 'C6', title: 'Six' });
  assert.equal(made.tableRow, false);
  assert.match(made.tableWarning!, /changed since the last import/);
  assert.ok(orders.resolveTag('C6'));
  assert.ok(readFileSync(path.join(dir, 'plan.md'), 'utf8').includes('edited by hand'));
});

test('new order: queueing one without a work-order file is refused at once (a run could never start it)', () => {
  const { dir, orders } = tempOrders();
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
  assert.throws(() => createOrder(project, orders, { tag: 'Q1', title: 'No text', queue: true }), /Q1 has no work-order file in .*: give its text \(--body-file\) or write Q1-<name>\.md there, then queue it\./);
  assert.equal(orders.resolveTag('Q1'), undefined);
  assert.equal(createOrder(project, orders, { tag: 'Q2', title: 'Later' }).doc.order.tag, 'Q2', 'without --queue it is a draft, as before');
});
