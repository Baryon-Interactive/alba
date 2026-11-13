import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject } from './state-helper.ts';
import { importTable } from '../src/table/import.ts';
import { findTables, formatRow } from '../src/table/markdown.ts';
import { renderTable } from '../src/table/render.ts';
import { writeBack } from '../src/table/write.ts';
import { tempOrders } from './helpers.ts';

const MARKDOWN = `# Plan

Done: AA1, AA2 (see notes D12, also AA1 again)

## Queue

| Status | Order | Worker | Needs |
|---|---|---|---|
| todo | AB1 Build the **bridge**: planks and ropes | Alice | AA1 merged |
| todo | AB2 Paint the bridge | Bob | AB1 and AB3 merged (D5) |
| doing | AB3:A cell with a full-width colon | Alice | — |
| later | AB4 Review pass | Bob | AA2 merged |
| ready | A row without a tag at all | Alice | — |
| todo | AB5 Needs a pipe \\| inside | Bob | |
| todo | AB6 Uses merged work | Bob | ZZ1, ZZ2 merged (D7) |
`;

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
  untagged: synthetic
  tag_exclude: '^D\\d+$'
  merged_marker: merged
  merged_list: { prefix: "Done: " }
  status_map: { todo: queued, later: draft, doing: running, ready: queued, review: awaiting-review }
`;

function project() {
  const { orders, dir } = tempOrders();
  writeFileSync(path.join(dir, 'plan.md'), MARKDOWN);
  writeFileSync(path.join(dir, 'alba.yaml'), YAML);
  return { orders, dir, cfg: loadProject(path.join(dir, 'alba.yaml')) };
}

test('markdown: finds the table under a heading, keeps escaped pipes', () => {
  const tables = findTables(MARKDOWN);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].heading, 'Queue');
  assert.equal(tables[0].rows.length, 7);
  assert.equal(tables[0].rows[5][1], 'AB5 Needs a pipe \\| inside');
});

test('import then render gives the same rows, tags, words and workers', () => {
  const { orders, cfg } = project();
  const result = importTable(orders, cfg.dispatch_table!, MARKDOWN);
  assert.equal(result.rows, 7);
  assert.deepEqual(result.mergedFromList.sort(), ['AA1', 'AA2', 'ZZ1', 'ZZ2']);   // D12 is excluded, AA1 is not duplicated, ZZ* come from the marker
  assert.equal(orders.all().length, 11);
  assert.deepEqual(orders.get('AB2').order.needs, ['AB1', 'AB3']);
  assert.equal(orders.stage(orders.get('AB3')).stage, 'running');
  assert.equal(orders.stage(orders.get('AB4')).stage, 'draft');
  assert.equal(orders.stage(orders.get('AB1')).stage, 'queued');     // AA1 is merged
  assert.equal(orders.stage(orders.get('AB2')).stage, 'waiting-needs');
  assert.deepEqual(orders.ready().map(d => d.order.tag), ['AB1', 'AB5', 'AB6', result.created.find(t => t.startsWith('X-'))].filter(Boolean).sort());
  const rendered = renderTable(orders, cfg.dispatch_table!);
  const original = findTables(MARKDOWN)[0];
  const lines = rendered.markdown.trimEnd().split('\n');
  assert.equal(lines[0], '| Status | Order | Worker | Needs |');
  assert.equal(lines[1], '|---|---|---|---|');
  // every original row comes back exactly, except the status word of a waiting-needs row, which maps back to its own word
  assert.equal(orders.stage(orders.get('AB6')).stage, 'queued');
  const expectedRows = original.rows.map(r => formatRow(r));
  assert.deepEqual(lines.slice(2), expectedRows);
  assert.deepEqual(rendered.warnings, []);
});

test('table refresh preserves a sticky reroute until its worker cell changes', () => {
  const { orders, cfg } = project();
  importTable(orders, cfg.dispatch_table!, MARKDOWN);
  orders.reroute('AB1', { id: 'handoff', at: new Date().toISOString(), from: 'Alice', to: 'expert', note: 'Change approach', brief: 'Stored facts' }, () => {});
  importTable(orders, cfg.dispatch_table!, MARKDOWN);
  assert.equal(orders.get('AB1').order.next_worker, 'expert');
  importTable(orders, cfg.dispatch_table!, MARKDOWN.replace('| Alice | AA1 merged |', '| Bob | AA1 merged |'));
  assert.equal(orders.get('AB1').order.next_worker, undefined);
  assert.equal(orders.get('AB1').order.worker, 'Bob');
  orders.reroute('AB1', { id: 'second-handoff', at: new Date().toISOString(), from: 'Bob', to: 'expert', note: 'Change approach', brief: 'Stored facts' }, () => {});
  importTable(orders, cfg.dispatch_table!, MARKDOWN.replace('| Alice | AA1 merged |', '|  | AA1 merged |'));
  assert.equal(orders.get('AB1').order.next_worker, undefined, 'emptying the worker cell clears the pin');
  assert.equal(orders.get('AB1').order.worker, undefined);
});

test('table refresh compares the worker cell with its last imported or written value after a person start', () => {
  for (const write of [false, true]) {
    const { orders, cfg, dir } = project();
    importTable(orders, cfg.dispatch_table!, MARKDOWN);
    const reroute = (id: string) => orders.reroute('AB1', { id, at: new Date().toISOString(), from: 'Alice', to: 'expert', note: 'Change approach', brief: 'Stored facts' }, () => {});
    reroute('first');
    // This is the same atomic hint update used by a person's explicit start.
    orders.clearWorkerPin('AB1', 'Person started a run on a different worker.', 'Bob');
    reroute('second');
    importTable(orders, cfg.dispatch_table!, MARKDOWN);
    assert.equal(orders.get('AB1').order.worker, 'Bob');
    assert.equal(orders.get('AB1').order.next_worker, 'expert', 'the unchanged table cannot undo a later producer pin');
    let table = MARKDOWN;
    if (write) {
      table = writeBack(orders, cfg.dispatch_table!, path.join(dir, 'plan.md'), cfg.state_dir, new Date()).text;
      assert.match(table, /Bob \| AA1 merged/);
      assert.equal(orders.get('AB1').order.next_worker, 'expert', 'readback of our own write is not a person edit');
      importTable(orders, cfg.dispatch_table!, table);
      assert.equal(orders.get('AB1').order.next_worker, 'expert');
    }
    importTable(orders, cfg.dispatch_table!, table.replace(write ? '| Bob | AA1 merged |' : '| Alice | AA1 merged |', write ? '|  | AA1 merged |' : '| Bob | AA1 merged |'));
    assert.equal(orders.get('AB1').order.next_worker, undefined, 'an actual cell edit clears the pin, even when it repeats the current hint');
    assert.equal(orders.get('AB1').order.worker, write ? undefined : 'Bob');
  }
});

test('importing again keeps real facts; a changed word applies; merged orders leave the table', () => {
  const { orders, cfg } = project();
  importTable(orders, cfg.dispatch_table!, MARKDOWN);
  orders.runEnd('AB3');
  orders.report('AB3', { status: 'ready', summary: 'done', evidence: [], commits: [] });
  const again = importTable(orders, cfg.dispatch_table!, MARKDOWN);
  assert.equal(again.created.length, 0);
  assert.equal(orders.stage(orders.get('AB3')).stage, 'awaiting-review');   // unchanged word: facts are kept
  assert.ok(renderTable(orders, cfg.dispatch_table!).markdown.includes('| review | AB3:A cell'));   // the stage moved on, so its word did too
  orders.act('AB3', 'approve');
  const rendered = renderTable(orders, cfg.dispatch_table!);
  assert.ok(!rendered.markdown.includes('| AB3'));
  assert.match(rendered.warnings.join('\n'), /AB3 is merged/);
  // the table now says "review" for AB1: the importer records a ready report
  importTable(orders, cfg.dispatch_table!, MARKDOWN.replace('| todo | AB1', '| review | AB1'));
  assert.equal(orders.stage(orders.get('AB1')).stage, 'awaiting-review');
});

test('import refuses unknown status words, missing tags and duplicates, and writes nothing', () => {
  const { orders, cfg } = project();
  const bad = MARKDOWN.replace('| later | AB4', '| soon | AB4').replace('| ready | A row without', '| ready | AB1 duplicate of the first');
  assert.throws(() => importTable(orders, cfg.dispatch_table!, bad), /status word "soon".*tag AB1 appears in two rows|tag AB1 appears in two rows.*status word "soon"/s);
  assert.equal(orders.all().length, 0);
  const strict = { ...cfg.dispatch_table!, untagged: 'error' as const };
  assert.throws(() => importTable(orders, strict, MARKDOWN), /does not start with a tag/);
  assert.equal(orders.all().length, 0);
});

test('config: clear errors for bad project files', () => {
  const { dir } = tempOrders();
  const write = (name: string, body: string) => { const f = path.join(dir, name); writeFileSync(f, body); return f; };
  mkdirSync(path.join(dir, 'x'), { recursive: true });
  assert.throws(() => loadProject(path.join(dir, 'missing.yaml')), /not found/);
  assert.throws(() => loadProject(write('a.yaml', 'id: demo\nname: D\nroot: nope\nwork_orders: .\nstate_dir: s\n')), /"root" points to .*not an existing directory/);
  assert.throws(() => loadProject(write('b.yaml', 'id: Demo\nname: D\nroot: .\nwork_orders: .\nstate_dir: s\n')), /"id" must be lower-case/);
  assert.throws(() => loadProject(write('c.yaml', 'id: d\nname: D\nroot: .\nwork_orders: .\nstate_dir: s\ndispatch: { caps: { ue: -1 } }\n')), /caps\.ue/);
  assert.throws(() => loadProject(write('d.yaml', YAML.replace('queued, later', 'queued, later').replace('todo: queued', 'todo: nonsense'))), /not a stage/);
  assert.throws(() => loadProject(write('e.yaml', YAML.replace('order_column: 2', 'order_column: 1'))), /must all be different/);
  assert.throws(() => loadProject(write('f.yaml', YAML + 'extra: 1\n')), /unknown key/);
  assert.throws(() => loadProject(write('g.yaml', 'id: d\nname: D\nroot: .\nwork_orders: .\n')), /"state_dir" must be a non-empty string/);
  const ok = loadProject(write('h.yaml', YAML + 'dispatch:\n  caps: { ue: 7 }\n  min_free_ram_gb: 8\n  stall_minutes: 60\n  worktree_parent: wt\n  base_ref: refs/heads/main\n'));
  assert.deepEqual(ok.dispatch, { caps: { ue: 7 }, long_command_minutes: 240, rework_reserve: 1, merge: 'manual', min_free_ram_gb: 8, stall_minutes: 60, worktree_parent: 'wt', base_ref: 'refs/heads/main', start_receipt_minutes: 15, on_loop: 'report', on_lingering: 'report', lingering_minutes: 10, loop_idle_minutes: 45, loop_repeat: 3, loop_alternate: 6, long_commands: [], monitor_dirs: [], monitor_timeout_seconds: 120, commit_nudge_minutes: 45 });
});

test('import: kind rules read kind and heavy class off the words of a row', () => {
  const { orders, cfg } = project();
  const table = { ...cfg.dispatch_table!, kind_rules: [{ match: 'bridge', kind: 'level', heavy: 'scenery' }, { match: '(?<![A-Za-z])Paint(?![A-Za-z])', kind: 'art' }] };
  importTable(orders, table, MARKDOWN);
  assert.deepEqual([orders.get('AB1').order.kind, orders.get('AB1').order.heavy], ['level', 'scenery']);
  assert.equal(orders.get('AB2').order.kind, 'level');   // "bridge" matches first
  assert.equal(orders.get('AB4').order.kind, '');         // no rule matches: left empty
});
