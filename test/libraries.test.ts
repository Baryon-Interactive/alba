import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { decisionList, ledgerDuplicates } from '../src/ledger/decisions.ts';
import { lessonsForOrder, lessonsSection, parseLessons, readLessons } from '../src/lessons/lessons.ts';
import { tempOrders } from './helpers.ts';

// ------------------------------------------------------------------------------------------------------------------ decisions: every table of the file

const MANY = `# Decision records

## TN1U:Arena

| ID | Date | Decision | Source |
|---|---|---|---|
| D910 | 2026-11-02 | Arenauses EX3 pipeline | TN1U report |
| D911 | 2026-11-02 | Restart the level every round | TN1U report |

Some words between the tables.

## RV1:Village

| ID | Date | Decision | Source |
|---|---|---|---|
| D1430 | 2026-11-01 | Raids call the damage model directly | RV1 |
| D911 | 2026-11-03 | Restart the level every round (revised) | RV1 revision |

## Other table

| Name | Value |
|---|---|
| a | b |
`;

function ledger(extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const file = path.join(dir, 'decisions.md');
  writeFileSync(file, MANY);
  const cfg = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state'), decisions: { file, section: '*', id_column: 1, date_column: 2, text_column: 3, source_column: 4, reviewer_range: [2030, 2099], ...extra } }, path.join(dir, 'alba.yaml'));
  return { cfg, orders, file };
}

test('decisions: section "*" reads every table whose rows hold numbers; each entry has the heading of its section; the later of a repeated number wins and the repeat is listed', () => {
  const { cfg, orders } = ledger();
  assert.equal(cfg.decisions!.all_tables, true);
  const list = decisionList(cfg, orders);
  assert.deepEqual(list.items.map(e => [e.id, e.topic]), [['D910', 'TN1U:Arena'], ['D911', 'RV1:Village'], ['D1430', 'RV1:Village']]);
  assert.equal(list.items.find(e => e.id === 'D911')!.text, 'Restart the level every round (revised)');
  assert.deepEqual(list.topics, ['TN1U:Arena', 'RV1:Village']);
  assert.deepEqual(list.duplicates, [{ id: 'D911', topics: ['TN1U:Arena', 'RV1:Village'] }]);
  assert.equal(list.next, 'D2030');
  // the old way is unchanged: one section only
  const one = ledger({ section: 'TN1U', all_tables: undefined });
  assert.equal(one.cfg.decisions!.all_tables, false);
  assert.deepEqual(decisionList(one.cfg, one.orders).items.map(e => e.id), ['D910', 'D911']);
});

test('decisions: the parsed file is kept until it changes', () => {
  const { cfg, orders, file } = ledger();
  const first = decisionList(cfg, orders).items;
  assert.equal(decisionList(cfg, orders).items[0], first[0], 'the same entries are served again');
  writeFileSync(file, MANY + '\n## New\n\n| ID | Date | Decision | Source |\n|---|---|---|---|\n| D1500 | 2026-11-04 | New item | x |\n');
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  assert.deepEqual(decisionList(cfg, orders).items.map(e => e.id), ['D910', 'D911', 'D1430', 'D1500']);
  assert.equal(ledgerDuplicates(cfg.decisions!).length, 1);
});

test('decisions: reading a file of 500 rows is quick and the second read costs nothing', () => {
  const { cfg, orders, file } = ledger();
  const rows = Array.from({ length: 500 }, (_, i) => `| D${3000 + i} | 2026-01-01 | decision ${i} | x |`).join('\n');
  writeFileSync(file, `## big\n\n| ID | Date | Decision | Source |\n|---|---|---|---|\n${rows}\n`);
  const later = new Date(Date.now() + 9000);
  utimesSync(file, later, later);
  assert.equal(decisionList(cfg, orders).count, 500);
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) decisionList(cfg, orders);
  assert.ok(performance.now() - t0 < 500, 'fifty requests in under half a second');
});

// Generic lessons support project scoping, fenced examples, multiline rules and tag selection.
const LESSONS = `
\`\`\`markdown
## L99 Example
- rule: ignored in a fence
\`\`\`
### L-ORD-01 Standard order
- tags: order, pm
- projects: *
- level: rule
- rule:
  - Keep one order per file.
  - Write the context.
  - State the outcome.
  - State acceptance.
  - Record evidence.
- why: Ambiguous orders cause rework.
### L-ENG-05 Other project
- tags: engine
- projects: other-game, another-game
- rule: Preserve the saved data.
### L-ENG-24 Build lock
- tags: unreal, ue
- projects: Demo
- rule: Run one build at a time.
### L-NO-01 Missing rule
- why: This is not a lesson.
`;
function library() {
  const { orders, dir } = tempOrders();
  mkdirSync(path.join(dir, 'lessons'), { recursive: true });
  writeFileSync(path.join(dir, 'lessons', 'orders.md'), LESSONS);
  const cfg = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state'),
    lessons: { dir: ['lessons'], max_rule_lines: 3, kind_tags: { ue: ['ue', 'engine'] } } }, path.join(dir, 'alba.yaml'));
  return { cfg, orders, dir };
}
test('generic lessons: English fields, scoped projects, multiline rules and fenced examples', () => {
  const found = parseLessons(LESSONS, 'orders.md');
  assert.deepEqual(found.map(l => l.id), ['L-ORD-01', 'L-ENG-05', 'L-ENG-24']);
  assert.equal(found[0].level, 'rule');
  assert.deepEqual(found[0].tags, ['order', 'pm']);
  assert.equal(found[0].projects, undefined);
  assert.equal(found[0].rule.split('\n').length, 5);
  assert.equal(found[0].why, 'Ambiguous orders cause rework.');
  assert.deepEqual(found[1].projects, ['other-game', 'another-game']);
});
test('generic lessons: scope filters prompts, kinds select tags, long rules are cut', () => {
  const { cfg, orders } = library();
  const all = readLessons(cfg.lessons, cfg);
  assert.deepEqual(all.map(l => [l.id, l.appliesToProject]), [['L-ORD-01', true], ['L-ENG-05', false], ['L-ENG-24', true]]);
  orders.add({ tag: 'U1', title: 'Build', kind: 'ue' });
  orders.add({ tag: 'O1', title: 'Order', kind: 'task', tags: ['order'] });
  assert.deepEqual(lessonsForOrder(cfg, orders.get('U1')).map(l => l.id), ['L-ENG-24']);
  const section = lessonsSection(lessonsForOrder(cfg, orders.get('O1')), 3).join('\n');
  assert.match(section, /Keep one order per file/);
  assert.match(section, /…/);
  assert.doesNotMatch(section, /Record evidence/);
});
test('generic lessons: project kind_tags add selections', () => {
  const { cfg, orders, dir } = library();
  writeFileSync(path.join(dir, 'lessons', 'more.md'), '### L-X-01 Engine rule\n- tags: engine\n- rule: Check build output.\n');
  orders.add({ tag: 'U2', title: 'Another', kind: 'ue' });
  assert.deepEqual(lessonsForOrder(cfg, orders.get('U2')).map(l => l.id), ['L-ENG-24', 'L-X-01']);
});
