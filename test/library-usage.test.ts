import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { validateUsageLedgers } from '../src/library/config.ts';
import { localDay, orderExternalCalls, parseTime, readLedger, under, usageView } from '../src/library/usage.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { libraryProject } from './library-helpers.ts';

const FIELDS = { time: 'time', model: 'model', status: 'status', cwd: 'cwd', out: 'out' };

function ledgerFor(dir: string, lines: unknown[], name = 'calls.jsonl') {
  const file = path.join(dir, name);
  writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return validateUsageLedgers([{ id: 'gen', file: name, fields: FIELDS, project_match: 'path' }], path.join(dir, 'alba.yaml'), dir)[0];
}

/** A local time as the ledger writes it, for a local date built from parts (the test does not depend on the time zone of the machine). */
const local = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0): string => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

test('a time without a zone is the machine\'s local time; with a zone it is exact; a number is seconds or milliseconds', () => {
  const d = parseTime('2026-10-30 18:53:53')!;
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], [2026, 9, 30, 18, 53, 53]);
  assert.equal(parseTime('2026-10-30T18:53:53.250')!.getMilliseconds(), 250);
  assert.equal(parseTime('2026-10-30 18:53:53', 'utc')!.toISOString(), '2026-10-30T18:53:53.000Z');
  assert.equal(parseTime('2026-10-30T18:53:53+08:00')!.toISOString(), '2026-10-30T10:53:53.000Z');
  assert.equal(parseTime('2026-10-30T18:53:53Z')!.toISOString(), '2026-10-30T18:53:53.000Z');
  assert.equal(parseTime(1788000000)!.getTime(), 1788000000000);
  assert.equal(parseTime(1788000000000)!.getTime(), 1788000000000);
  assert.equal(parseTime('yesterday'), undefined);
  assert.equal(parseTime(undefined), undefined);
  assert.equal(localDay(new Date(2026, 9, 3, 23, 59)), '2026-10-03');
});

test('a call belongs to the project root across Windows separators and case', () => {
  const root = path.win32.resolve('workspace', 'Work', 'game');
  assert.ok(under(root, path.win32.join(root.toLowerCase(), 'client')));
  assert.ok(under(root.replace(/\\/g, '/'), path.win32.join(root, 'out', 'a.png')));
  assert.ok(under(root, root));
  assert.ok(!under(root, path.win32.join(root + '-other', 'a.png')));
  assert.ok(!under(root, undefined));
});

test('attribution by cwd or out, success words, unreadable lines counted; the prompt text of a line is never carried', () => {
  const s = libraryProject({});
  const inside = path.join(s.root, 'client');
  const ledger = ledgerFor(s.dir, [
    { time: local(2026, 11, 1, 10), model: 'img-a', status: 'ok', cwd: inside, out: 'x', prompt_head: 'SECRET WORDS' },
    { time: local(2026, 11, 1, 11), model: 'img-a', status: 'error', cwd: path.join(s.dir, 'elsewhere'), out: path.join(s.root, 'out', 'a.png') },
    { time: local(2026, 11, 1, 12), model: 'img-b', status: 'succeeded', cwd: path.join(s.dir, 'elsewhere'), out: path.join(s.dir, 'elsewhere', 'b.png') },
    { time: 'garbage', model: 'img-a', status: 'ok', cwd: inside },
    'not json',
  ]);
  const read = readLedger(ledger, [s.root]);
  assert.deepEqual([read.view.calls, read.view.lines, read.view.unreadable], [2, 5, 2]);
  assert.deepEqual(read.calls.map(c => [c.model, c.ok]), [['img-a', true], ['img-a', false]]);
  assert.ok(!JSON.stringify(read).includes('SECRET'));
  assert.equal(readLedger({ ...ledger, file: path.join(s.dir, 'missing.jsonl') }, [s.root]).view.ok, false);
});

test('the usage view: project, day and model for the last 7 local days; older days and other projects are left out; worktrees of orders count', () => {
  const s = libraryProject({});
  const wt = path.join(s.dir, 'worktrees', 'T1');
  mkdirSync(wt, { recursive: true });
  s.orders.add({ tag: 'T1', title: 'Art', kind: 'sim', worktree: wt });
  const now = new Date(2026, 10, 4, 15, 0, 0);
  const ledger = ledgerFor(s.dir, [
    { time: local(2026, 11, 4, 9), model: 'img-a', status: 'ok', cwd: s.root },
    { time: local(2026, 11, 4, 23, 59, 59), model: 'img-a', status: 'ok', cwd: s.root },                // a little after now (clock skew): still today
    { time: local(2026, 11, 3, 23, 59, 59), model: 'img-a', status: 'error', cwd: s.root },
    { time: local(2026, 11, 3, 0, 0, 1), model: 'img-b', status: 'ok', out: path.join(wt, 'a.png') },
    { time: local(2026, 10, 29, 12), model: 'img-a', status: 'ok', cwd: s.root },                          // 6 days before today: inside the 7
    { time: local(2026, 10, 28, 12), model: 'img-a', status: 'ok', cwd: s.root },                          // 7 days before: outside
    { time: local(2026, 11, 3, 12), model: 'img-a', status: 'ok', cwd: path.join(s.dir, 'other-project') },
  ]);
  const view = usageView(s.project, s.orders, [ledger], now, 7);
  assert.equal(view.enabled, true);
  assert.deepEqual(view.byDay.map(r => [r.day, r.model, r.ok, r.failed]), [
    ['2026-11-04', 'img-a', 2, 0], ['2026-11-03', 'img-a', 0, 1], ['2026-11-03', 'img-b', 1, 0], ['2026-10-29', 'img-a', 1, 0],
  ]);
  assert.deepEqual(view.byModel.map(r => [r.model, r.ok, r.failed]), [['img-a', 3, 1], ['img-b', 1, 0]]);
  assert.deepEqual(view.total, { ok: 4, failed: 1 });
  assert.equal(view.ledgers[0].calls, 6);
  assert.deepEqual(usageView(s.project, s.orders, [ledger], now, 1).total, { ok: 2, failed: 0 });
  assert.equal(usageView(s.project, s.orders, [], now).enabled, false);
});

test('an order\'s calls are the ones made under its worktree', () => {
  const s = libraryProject({});
  const wt = path.join(s.dir, 'worktrees', 'T1');
  const ledger = ledgerFor(s.dir, [
    { time: local(2026, 11, 1), model: 'img-a', status: 'ok', cwd: wt },
    { time: local(2026, 11, 2), model: 'img-a', status: 'error', out: path.join(wt, 'x.png') },
    { time: local(2026, 11, 2), model: 'img-a', status: 'ok', cwd: s.root },
  ]);
  assert.deepEqual(orderExternalCalls([ledger], wt), [{ ledger: 'gen', ok: 1, failed: 1 }]);
  assert.deepEqual(orderExternalCalls([ledger], undefined), []);
  assert.deepEqual(orderExternalCalls([ledger], path.join(s.dir, 'worktrees', 'none')), []);
});

test('usage_ledgers are checked in the project file and the workers file', () => {
  const s = libraryProject({});
  const f = path.join(s.dir, 'alba.yaml');
  assert.throws(() => validateUsageLedgers([{ id: 'g', file: 'x.jsonl', fields: { time: 't', model: 'm', status: 's' } }], f, s.dir), /needs "cwd" or "out"/);
  assert.throws(() => validateUsageLedgers([{ id: 'g', file: 'x.jsonl', fields: { ...FIELDS, extra: 'e' } }], f, s.dir), /unknown key/);
  assert.throws(() => validateUsageLedgers([{ id: 'g', file: 'x.jsonl', format: 'csv', fields: FIELDS }], f, s.dir), /"jsonl"/);
  assert.throws(() => validateUsageLedgers([{ id: 'g', file: 'x.jsonl', fields: FIELDS }, { id: 'g', file: 'y.jsonl', fields: FIELDS }], f, s.dir), /twice/);
  const ok = validateUsageLedgers([{ id: 'g', file: 'sub/x.jsonl', fields: FIELDS, ok_values: ['OK', 'done'], timezone: 'utc' }], f, s.dir)[0];
  assert.deepEqual([ok.file, ok.ok_values, ok.timezone, ok.project_match], [path.join(s.dir, 'sub', 'x.jsonl'), ['ok', 'done'], 'utc', 'path']);
  const project = validateProject({ id: 'demo', name: 'Demo', root: 'game', work_orders: 'orders', state_dir: 'state', usage_ledgers: [{ id: 'p', file: 'p.jsonl', fields: FIELDS }] }, f);
  assert.equal(project.usage_ledgers?.[0].id, 'p');
  const workers = validateWorkers({ workers: [{ id: 'w', engine: 'x', concurrency: 1, launch: { template: 'c', program: 'p', args: [] } }], usage_ledgers: [{ id: 'w1', file: 'w.jsonl', fields: FIELDS }] }, path.join(s.dir, 'workers.yaml'));
  assert.equal(workers.usage_ledgers?.[0].id, 'w1');
});
