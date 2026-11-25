import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { readStateFile } from '../src/orders/state-files.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject, validateProject } from './state-helper.ts';
import { syncOrders } from '../src/sync/sync.ts';
import { importTable } from '../src/table/import.ts';
import { writeBack } from '../src/table/write.ts';
import { tempOrders } from './helpers.ts';
import { tmpDir } from './tmp.ts';

function shadow() {
  const { orders, dir } = tempOrders();
  const work = path.join(dir, 'orders');
  mkdirSync(work);
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: work, state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
  const put = (name: string, text: string, when: string) => { const file = path.join(work, name); writeFileSync(file, text); utimesSync(file, new Date(when), new Date(when)); };
  return { orders, dir, work, project, put };
}

const BLOCK = '--- alba-report ---\n{"status":"ready","summary":"Built and checked","question":"","evidence":["out.txt"],"commits":["abc1234"]}\n--- end ---\n';

test('sync: a delivery becomes a finished run and a report; the block wins, a file without one is inferred; nothing is recorded twice', () => {
  const { orders, project, put } = shadow();
  for (const tag of ['A1', 'A2']) { orders.add({ tag, title: tag, kind: 'k', worker: 'Claude session' }); orders.act(tag, 'queue'); orders.runStart(tag, { worker: 'Claude session' }, true); }
  put('A1-thing.md', '# A1', '2026-01-01T08:00:00Z');
  put('A1.last.txt', `Done.\n\n${BLOCK}`, '2026-01-01T10:00:00Z');
  put('A2-thing.md', '# A2', '2026-01-01T08:00:00Z');
  put('A2.last.txt', '**A2 is finished**, tests pass.\n\nMore text.', '2026-01-01T11:00:00Z');
  put('ZZ9.last.txt', 'no such order', '2026-01-01T11:00:00Z');

  const dry = syncOrders(project, orders, { dryRun: true });
  assert.equal(dry.changes.length, 2);
  assert.equal(orders.stage(orders.get('A1')).stage, 'running');   // a dry run records nothing

  const first = syncOrders(project, orders);
  assert.deepEqual(first.changes.map(c => c.tag), ['A1', 'A2']);
  assert.deepEqual(first.unknown, ['zz9']);
  const a1 = orders.get('A1'), a2 = orders.get('A2');
  assert.equal(orders.stage(a1).stage, 'awaiting-review');
  assert.equal(a1.runs.length, 1);                                  // the imported open run was closed, not duplicated
  assert.equal(a1.runs[0].outcome, 'completed');
  assert.equal(a1.runs[0].ended, '2026-01-01T10:00:00.000Z');
  assert.equal(a1.reports[0].summary, 'Built and checked');
  assert.equal(a1.reports[0].source, undefined);
  assert.equal(a2.reports[0].source, 'inferred');
  assert.equal(a2.reports[0].summary, 'A2 is finished, tests pass.');
  assert.equal(a2.reports[0].at, '2026-01-01T11:00:00.000Z');

  const again = syncOrders(project, orders);
  assert.deepEqual(again.changes, []);                              // idempotent
  assert.equal(orders.get('A1').runs.length, 1);
  assert.equal(orders.get('A1').reports.length, 1);
});

test('sync leaves a newer imported run open when the file names an earlier run', () => {
  const { orders, project, put } = shadow();
  orders.add({ tag: 'T1', title: 'Demo', kind: 'task' });
  orders.runStart('T1', { worker: 'demo' }, true);
  orders.runEnd('T1');
  orders.runStart('T1', { worker: 'demo' }, true);
  put('T1.last.txt', BLOCK.replace('"status"', '"run":"r1","status"'), '2026-01-02T00:00:00Z');
  for (let pass = 0; pass < 2; pass++) assert.equal(syncOrders(project, orders).changes.length, 0);
  assert.equal(orders.get('T1').runs.at(-1)?.ended, undefined);
  assert.equal(orders.store.events({ tag: 'T1' }).filter(e => e.type === 'stale-report').length, 1);
});

test('sync: an acceptance file merges the order, but only when it is not older than the delivery; stale files and tool runs are left alone', () => {
  const { orders, project, put } = shadow();
  for (const tag of ['B1', 'B2', 'B3', 'B4']) { orders.add({ tag, title: tag, kind: 'k' }); orders.act(tag, 'queue'); orders.runStart(tag, { worker: 'w' }, true); }
  put('B1.last.txt', BLOCK, '2026-01-01T10:00:00Z');
  put('B1.accept.md', 'Result: merge', '2026-01-01T12:00:00Z');
  put('B2.last.txt', BLOCK, '2026-01-01T10:00:00Z');
  put('B2.accept.md', 'Result: merge', '2026-01-01T09:00:00Z');   // an acceptance of an earlier round
  put('B3-thing.md', '# B3', '2026-01-02T00:00:00Z');             // sent out again after the delivery
  put('B3.last.txt', BLOCK, '2026-01-01T10:00:00Z');
  orders.runEnd('B4');
  orders.runStart('B4', { worker: 'w', extra: { pid: 1 } });      // a run this tool started and has not recorded the end of
  put('B4.last.txt', BLOCK, '2026-01-01T10:00:00Z');

  const r = syncOrders(project, orders);
  assert.equal(orders.stage(orders.get('B1')).stage, 'merged');
  assert.equal(orders.stage(orders.get('B2')).stage, 'awaiting-review');
  assert.equal(orders.stage(orders.get('B3')).stage, 'running');
  assert.equal(orders.stage(orders.get('B4')).stage, 'running');
  assert.deepEqual(r.skipped.map(s => s.tag).sort(), ['B2', 'B3', 'B4']);
  assert.equal(orders.get('B1').actions.at(-1)?.imported, true);
  assert.deepEqual(syncOrders(project, orders).changes, []);
});

const PLAN = [
  '# Plan',
  '',
  'Some text before the table, with a | pipe.',
  '',
  '## Queue',
  '',
  '| Status | Order | Worker | Needs | Notes |',
  '|---|---|---|---|---|',
  '| doing | C1 First thing | Claude | - | keep me   as   is |',
  '| todo | C2 Second thing | Codex | C1 merged | |',
  '| later | C3 Third thing | Codex | | wide  cell |',
  '',
  'Text after the table.',
  '',
].join('\r\n');

const YAML = `id: demo
name: Demo
root: .
work_orders: .
state_dir: state
dispatch_table:
  file: plan.md
  section: Queue
  status_column: 1
  order_column: 2
  worker_column: 3
  needs_column: 4
  status_map: { todo: queued, later: draft, doing: running, review: awaiting-review }
`;

function planFixture() {
  const { orders, dir } = tempOrders();
  writeFileSync(path.join(dir, 'plan.md'), PLAN);
  writeFileSync(path.join(dir, 'alba.yaml'), YAML);
  const cfg = loadProject(path.join(dir, 'alba.yaml'));
  importTable(orders, cfg.dispatch_table!, PLAN);
  return { orders, dir, cfg, file: path.join(dir, 'plan.md') };
}

test('table write-back: only the table changes, only rows that differ are rewritten, a backup is made first', () => {
  const { orders, dir, cfg, file } = planFixture();
  orders.runEnd('C1');
  orders.report('C1', { status: 'ready', summary: 'ok', evidence: [], commits: [] });
  orders.act('C2', 'approve', { force: true });                      // merged has no status word in this table: its row stays as written
  orders.add({ tag: 'C4', title: 'Fourth thing', kind: '', worker: 'Codex' });
  orders.act('C4', 'queue');

  const result = writeBack(orders, cfg.dispatch_table!, file, cfg.state_dir, new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(result.changed, ['C1']);
  assert.deepEqual(result.added, ['C4']);
  assert.ok(result.kept.includes('C2'));
  const written = readFileSync(file, 'utf8');
  const lines = written.split('\r\n');
  assert.equal(lines[8], '| review | C1 First thing | Claude | - | keep me   as   is |');   // the notes column is not the tool's to change
  assert.equal(lines[9], '| todo | C2 Second thing | Codex | C1 merged | |');             // an unchanged row keeps its exact text
  assert.equal(lines[10], '| later | C3 Third thing | Codex | | wide  cell |');
  assert.equal(lines[11], '| todo | C4 Fourth thing | Codex | | |');                       // an order without a row is added after the last row
  assert.equal(lines.slice(0, 8).join('\r\n'), PLAN.split('\r\n').slice(0, 8).join('\r\n'));     // everything before the table
  assert.ok(written.endsWith('\r\n\r\nText after the table.\r\n'));
  assert.ok(!written.replace(/\r\n/g, '').includes('\n'));                                   // line endings stay as they were
  const backups = orders.store instanceof SqliteStore ? orders.store.db.prepare("SELECT name FROM meta WHERE name LIKE 'file:backups/%'").all().map(row => String(row.name).slice('file:backups/'.length)) : readdirSync(path.join(cfg.state_dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(readStateFile(cfg, `backups/${backups[0]}`), PLAN);
  // a second write has nothing left to change
  const second = writeBack(orders, cfg.dispatch_table!, file, cfg.state_dir, new Date('2026-01-01T00:00:01Z'));
  assert.deepEqual([second.changed, second.added], [[], []]);
  assert.equal(readFileSync(file, 'utf8'), written);
});

test('table write-back refuses a table that a person edited after the last import', () => {
  const { orders, cfg, file } = planFixture();
  writeFileSync(file, PLAN.replace('| todo | C2', '| later | C2'));
  assert.throws(() => writeBack(orders, cfg.dispatch_table!, file, cfg.state_dir, new Date()), /changed since the last import/);
  assert.ok(!existsSync(path.join(cfg.state_dir, 'backups')));
});

test('sync: a report block that is there but cannot be read is a failed delivery, never a guessed ready', async () => {
  const { readDelivery } = await import('../src/sync/sync.ts');
  const broken = readDelivery('Could not finish.\n\n--- alba-report ---\n{"status":"failed","summary":"x","evidence":[],"commits":[],}\n--- end ---\n');
  assert.equal(broken.report.status, 'failed');
  assert.match(broken.report.summary, /the report block could not be read/);
  assert.ok(broken.why);
  const none = readDelivery('Done, see the branch.\n');
  assert.deepEqual([none.report.status, none.report.summary, none.why], ['ready', 'Done, see the branch.', undefined]);
});

test('events: a line cut short by a crash is skipped on reading, and the next event starts on a line of its own', async () => {
  const { FileStore } = await import('../src/orders/store.ts');
  const { appendFileSync } = await import('node:fs');
  const dir = tmpDir('alba-events-');
  const store = new FileStore(dir);
  store.appendEvent({ at: '2026-01-01T00:00:00Z', tag: 'T1', type: 'a' } as never);
  appendFileSync(path.join(dir, 'events.jsonl'), '{"at":"2026-01-01T00:00:01Z","tag":"T1","ty');
  store.appendEvent({ at: '2026-01-01T00:00:02Z', tag: 'T1', type: 'b' } as never);
  assert.deepEqual(store.events({ tag: 'T1' }).map(e => e.type), ['a', 'b']);
});
