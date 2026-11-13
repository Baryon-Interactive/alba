import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyChangeSet, applyChangeSets, designHistory, exportDesign, librarySnapshot, readLibrary } from '../src/design/library.ts';
import { checkDesign, readDesign, showDesign } from '../src/design/read.ts';
import { designFixture, initialDesign } from './fixtures/design.ts';
import { JsonDataCache, pointerValue, resolveParam } from '../src/design/files.ts';

test('design change sets validate the prospective graph, conflict atomically and never reuse retired ids', () => {
  const f = designFixture();
  const result = applyChangeSet(f.project, f.orders, initialDesign());
  assert.equal(result.applied, true); assert.ok(result.export); assert.equal(result.export_error, undefined);
  assert.equal(designHistory(f.project).length, 9);
  assert.throws(() => applyChangeSet(f.project, f.orders, { title: 'Conflict', changes: [
    { op: 'update', kind: 'system', id: 'ECON', base_version: 1, fields: { summary: 'Changed' } },
    { op: 'update', kind: 'rule', id: 'ECON-R01', base_version: 2, fields: { text: 'Stale' } },
  ] }), /ECON-R01.*base_version 2, current version 1/);
  assert.equal(readLibrary(f.project).system[0].summary, 'Gold flow');
  applyChangeSet(f.project, f.orders, { title: 'Retire old rule', changes: [
    { op: 'create', kind: 'rule', id: 'ECON-R02', fields: { system: 'ECON', text: 'Replacement', sources: [{ kind: 'doc', ref: 'rules.md' }] } },
    { op: 'retire', kind: 'rule', id: 'ECON-R01', base_version: 1, fields: { superseded_by: 'ECON-R02' } },
    { op: 'update', kind: 'param', id: 'ECON.income.base', base_version: 1, fields: { rules: ['ECON-R02'] } },
  ] });
  assert.equal(readLibrary(f.project).rule[0].version, 2);
  assert.throws(() => applyChangeSet(f.project, f.orders, { title: 'Reuse', changes: [initialDesign().changes[1]] }), /already exists/);
  const before = designHistory(f.project).length;
  assert.throws(() => applyChangeSet(f.project, f.orders, { title: 'Bad pointer', changes: [
    { op: 'update', kind: 'system', id: 'ECON', base_version: 1, fields: { summary: 'Must roll back' } },
    { op: 'update', kind: 'param', id: 'ECON.income.base', base_version: 2, fields: { location: { file: 'content/economy.json', pointer: '/missing' } } },
  ] }), /does not resolve/);
  assert.equal(designHistory(f.project).length, before); assert.equal(readLibrary(f.project).system[0].summary, 'Gold flow');
});

test('design live parameters, checks, named queries, dry run and byte-stable export', () => {
  const f = designFixture();
  applyChangeSet(f.project, f.orders, initialDesign(), { dryRun: true });
  assert.equal(designHistory(f.project).length, 0);
  applyChangeSet(f.project, f.orders, initialDesign());
  assert.equal((showDesign(f.project, 'ECON') as any).params[0].value, 7);
  assert.deepEqual(pointerValue({ 'a/b': { '~count': 2 } }, '/a~1b/~0count'), 2);
  assert.throws(() => pointerValue([1], '/01'), /does not resolve/);
  assert.throws(() => pointerValue({}, '/bad~2'), /Invalid RFC/);
  assert.equal((readDesign(f.project, f.orders, { query: 'open-gaps-without-order' }) as any[])[0].id, 'ECON-G01');
  assert.equal((readDesign(f.project, f.orders, { query: 'failing-targets' }) as any[])[0].id, 'ECON-T01');
  assert.equal((readDesign(f.project, f.orders, { query: 'unmeasured-targets' }) as any[])[0].id, 'ECON-T02');
  assert.deepEqual((readDesign(f.project, f.orders, { query: 'milestone' }) as any).criteria.map((c: any) => c.status), ['failing', 'unmeasured', 'manual']);
  const checks = checkDesign(f.project, f.orders);
  assert.equal(checks.ok, true); assert.equal(checks.issues.find(i => i.code === 'unregistered-numbers')?.count, 2);
  const out = path.join(f.root, 'export'); exportDesign(f.project, out);
  const bytes = readdirSync(out).map(name => readFileSync(path.join(out, name), 'utf8'));
  exportDesign(f.project, out); assert.deepEqual(readdirSync(out).map(name => readFileSync(path.join(out, name), 'utf8')), bytes);
  writeFileSync(path.join(f.root, 'content/economy.json'), '{"gold":20}');
  assert.equal((showDesign(f.project, 'ECON.income.base') as any).value, 20);
  assert.ok(checkDesign(f.project, f.orders).issues.some(i => i.code === 'param-range'));
  writeFileSync(path.join(f.root, 'content/economy.json'), '{}');
  assert.equal(checkDesign(f.project, f.orders).ok, true);
  assert.ok(!Object.hasOwn(readLibrary(f.project).param[0], 'value'));
});

test('stale unchanged locations and code lines warn without blocking unrelated edits', () => {
  const f = designFixture(), set = initialDesign();
  Object.assign(set.changes[2].fields, { code_refs: ['rules.md:3'] });
  applyChangeSet(f.project, f.orders, set);
  writeFileSync(path.join(f.root, 'content/economy.json'), '{}');
  writeFileSync(path.join(f.root, 'rules.md'), '# Shorter');
  const edit = { title: 'Clarify rule', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version: 1, fields: { text: 'Income once per turn' } }] };
  const result = applyChangeSet(f.project, f.orders, edit);
  assert.ok(result.applied);
  assert.ok(result.warnings.some(w => w.code === 'param-unresolved'));
  const checks = checkDesign(f.project, f.orders);
  assert.equal(checks.ok, true);
  assert.deepEqual(checks.issues.filter(i => ['param-unresolved', 'code-ref-stale'].includes(i.code)).map(i => [i.code, i.severity]), [['param-unresolved', 'warning'], ['code-ref-stale', 'warning']]);
  assert.throws(() => applyChangeSet(f.project, f.orders, { title: 'Edit stale param', changes: [{ op: 'update', kind: 'param', id: 'ECON.income.base', base_version: 1, fields: { meaning: 'Income' } }] }), /does not resolve/);
  assert.throws(() => applyChangeSet(f.project, f.orders, { title: 'Edit stale formula', changes: [{ op: 'update', kind: 'formula', id: 'ECON-F01', base_version: 1, fields: { notes: 'Clarification' } }] }), /code line does not exist/);
  // A stale source file on an unchanged rule also cannot freeze the library.
  unlinkSync(path.join(f.root, 'rules.md'));
  assert.ok(applyChangeSet(f.project, f.orders, { title: 'Rename term', changes: [{ op: 'update', kind: 'term', id: 'gold', base_version: 1, fields: { meaning: 'Currency' } }] }).applied);
  assert.ok(checkDesign(f.project, f.orders).issues.some(i => i.code === 'code-ref-stale'));
});

test('retirement checks affected unchanged references while unrelated stale files remain warnings', () => {
  const f = designFixture(); applyChangeSet(f.project, f.orders, initialDesign());
  writeFileSync(path.join(f.root, 'content/economy.json'), '{}');
  const retire = { title: 'Retire rule', changes: [
    { op: 'create', kind: 'rule', id: 'ECON-R02', fields: { system: 'ECON', text: 'Replacement', sources: [{ kind: 'doc', ref: 'rules.md' }] } },
    { op: 'retire', kind: 'rule', id: 'ECON-R01', base_version: 1, fields: { superseded_by: 'ECON-R02' } },
  ] };
  assert.throws(() => applyChangeSet(f.project, f.orders, retire), /Reference to retired rule: ECON-R01/);
  assert.equal(designHistory(f.project).length, 9);
  assert.ok(applyChangeSet(f.project, f.orders, { title: 'System summary', changes: [{ op: 'update', kind: 'system', id: 'ECON', base_version: 1, fields: { summary: 'Currency flow' } }] }).applied);
});

test('multiple sets validate forward references against the combined library and roll back failures', () => {
  const f = designFixture(), initial = initialDesign();
  const rule = initial.changes.splice(1, 1)[0];
  const sets = [initial, { title: 'Forward rule', changes: [rule] }];
  assert.ok(applyChangeSets(f.project, f.orders, sets).every(r => r.applied));
  const before = designHistory(f.project).length, exports = readdirSync(f.project.design!.export_dir);
  assert.throws(() => applyChangeSets(f.project, f.orders, [
    { title: 'Valid first', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version: 1, fields: { text: 'New text' } }] },
    { title: 'Invalid second', changes: [{ op: 'update', kind: 'param', id: 'ECON.income.base', base_version: 1, fields: { location: { file: 'content/economy.json', pointer: '/missing' } } }] },
  ]), /does not resolve/);
  assert.equal(designHistory(f.project).length, before);
  assert.equal(readLibrary(f.project).rule[0].version, 1);
  assert.deepEqual(readdirSync(f.project.design!.export_dir), exports);
});

test('each operation parses twenty JSON files once for two thousand params', t => {
  const f = designFixture(), initial = initialDesign(), param = initial.changes.splice(3, 1)[0];
  unlinkSync(path.join(f.root, 'content/economy.json'));
  // Keep only the system and rule; the formula and gap in the baseline reference its original param.
  initial.changes = initial.changes.slice(0, 2);
  const alpha = (n: number) => String.fromCharCode(97 + Math.floor(n / 26), 97 + n % 26);
  for (let file = 0; file < 20; file++) {
    writeFileSync(path.join(f.root, `content/data-${file}.json`), JSON.stringify({ cache_fixture_marker: true, values: Array.from({ length: 100 }, (_, i) => i) }));
    for (let i = 0; i < 100; i++) initial.changes.push({ ...param, id: `ECON.${alpha(file)}.${alpha(i)}`, fields: { ...param.fields, formulas: [], range_max: 100, location: { file: `content/data-${file}.json`, pointer: `/values/${i}` } } });
  }
  // Count actual gameplay JSON parses, excluding SQLite entity documents and proposal hashing.
  const parse = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', (text: string, ...args: any[]) => {
    if (text.startsWith('{"cache_fixture_marker":')) parses++;
    return parse(text, ...args);
  });
  const measure = (name: string, operation: () => unknown) => {
    parses = 0; const start = performance.now(); operation(); const elapsed = performance.now() - start;
    assert.equal(parses, 20, name); t.diagnostic(`${name}: 2000 params, 20 files, ${parses} parses, ${elapsed.toFixed(2)} ms`);
  };
  measure('apply including automatic export', () => applyChangeSet(f.project, f.orders, initial));
  measure('snapshot', () => librarySnapshot(f.project));
  measure('check', () => checkDesign(f.project, f.orders));
  measure('read', () => readDesign(f.project, f.orders, { kind: 'param' }));
  measure('export', () => exportDesign(f.project, path.join(f.root, 'export')));
  // Canonical aliases share an entry; a new operation sees updated live values.
  const p = readLibrary(f.project).param[0], cache = new JsonDataCache();
  resolveParam(f.root, p, cache); resolveParam(f.root, p, cache);
  symlinkSync(path.join(f.root, 'content'), path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  resolveParam(f.root, { ...p, location: { ...p.location, file: p.location.file.replace('content/', 'alias/') } }, cache);
  assert.equal(cache.parses, 1);
  writeFileSync(path.join(f.root, p.location.file), '{"values":[123]}');
  assert.equal(resolveParam(f.root, p), 123);
  const broken = new JsonDataCache();
  writeFileSync(path.join(f.root, p.location.file), '{');
  assert.throws(() => resolveParam(f.root, p, broken), SyntaxError);
  assert.throws(() => resolveParam(f.root, p, broken), SyntaxError);
  assert.equal(broken.parses, 1);
});

test('a rule that superseded another can itself be retired later (supersession chains)', () => {
  const f = designFixture(); applyChangeSet(f.project, f.orders, initialDesign());
  applyChangeSet(f.project, f.orders, { title: 'First replacement', changes: [
    { op: 'create', kind: 'rule', id: 'ECON-R02', fields: { system: 'ECON', text: 'Replacement', sources: [{ kind: 'doc', ref: 'rules.md' }] } },
    { op: 'retire', kind: 'rule', id: 'ECON-R01', base_version: 1, fields: { superseded_by: 'ECON-R02' } },
    { op: 'update', kind: 'param', id: 'ECON.income.base', base_version: 1, fields: { rules: ['ECON-R02'] } },
  ] });
  const second = applyChangeSet(f.project, f.orders, { title: 'Second replacement', changes: [
    { op: 'create', kind: 'rule', id: 'ECON-R03', fields: { system: 'ECON', text: 'Second replacement', sources: [{ kind: 'doc', ref: 'rules.md' }] } },
    { op: 'retire', kind: 'rule', id: 'ECON-R02', base_version: 1, fields: { superseded_by: 'ECON-R03' } },
    { op: 'update', kind: 'param', id: 'ECON.income.base', base_version: 2, fields: { rules: ['ECON-R03'] } },
  ] });
  assert.equal(second.applied, true);
  assert.equal(readLibrary(f.project).rule.find(r => r.id === 'ECON-R01')?.superseded_by, 'ECON-R02');
});
