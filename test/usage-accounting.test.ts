import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UsageFold } from '../src/usage/fold.ts';
import { budgetWarnings, collectUsage, estimate, pricingOf, rolloutTotal, usageDashboard, usageReport } from '../src/usage/accounting.ts';
import { usageRows, replaceRunUsage } from '../src/usage/store.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { systemProbes } from '../src/tick/gather.ts';
import type { UsageRow } from '../src/usage/types.ts';
import { migrateState, exportState } from '../src/orders/state.ts';
import { fixture } from './api-fixture.ts';
import { tick } from '../src/tick/gather.ts';
import { writeStateFile } from '../src/orders/state-files.ts';

const at = '2026-01-01T12:00:00Z';
const record = readFileSync(path.join(import.meta.dirname, 'fixtures/codex-turns.jsonl'), 'utf8');
const fold = (text = record) => { const f = new UsageFold(); for (const line of text.split('\n').filter(Boolean)) f.event(JSON.parse(line), at); return f; };
const row = (more: Partial<UsageRow> = {}): UsageRow => ({ project: 'demo', order: 'T1', run: 'T1-r1', worker: 'coder', engine: 'codex-cli', model: 'example', turn: 1, at, kind: 'sim', rework: false, resume: false, open: true, merged: false, source: 'codex-json', input_tokens: 1000, cached_tokens: 600, output_tokens: 100, total_tokens: 1100, ...more });
function setup() {
  const { orders, dir } = tempOrders();
  const cfg = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Example', kind: 'sim' }); orders.act('T1', 'queue');
  return { orders, dir, cfg };
}

test('accounting: recorded Codex turns preserve all counters and raw fields', () => {
  const f = fold(); assert.equal(f.turns.length, 2); assert.equal(f.turns[0].raw.vendor_extra, 7);
  assert.equal(f.turns[0].usage.reasoning_tokens, 40); assert.equal(f.turns[0].usage.cache_write_tokens, 0);
  assert.equal(f.turns.reduce((n, t) => n + t.usage.total_tokens!, 0), 3300);
});
test('accounting: collection persists turns idempotently, backfills log totals, and records unknown engines', () => {
  const { orders, dir, cfg } = setup();
  const events = path.join(dir, 'events.jsonl'); writeFileSync(events, record);
  orders.runStart('T1', { worker: 'coder', extra: { events_file: events } });
  const probes = { ...systemProbes, now: () => new Date(at) };
  assert.equal(collectUsage(cfg, orders.all(), undefined, probes).rows.length, 2);
  assert.equal(collectUsage(cfg, orders.all(), undefined, probes).rows.length, 2);
  orders.runEnd('T1');
  const log = path.join(dir, 'legacy.log'); writeFileSync(log, 'tokens used\n1,234\n');
  orders.runStart('T1', { worker: 'legacy', extra: { log } }); orders.runEnd('T1');
  orders.runStart('T1', { worker: 'unknown' });
  const rows = collectUsage(cfg, orders.all(), undefined, probes).rows;
  assert.equal(rows.find(r => r.worker === 'legacy')?.total_tokens, 1234);
  assert.equal(rows.find(r => r.worker === 'legacy')?.source, 'codex-log');
  assert.equal(rows.find(r => r.worker === 'unknown')?.source, 'unknown');
  assert.equal(rows.find(r => r.worker === 'unknown')?.total_tokens, undefined);
});
test('accounting: every grouping totals its displayed rows, including top limits and unknowns', () => {
  const rows = [row(), row({ project: 'second', order: 'T2', worker: 'other', kind: 'research', total_tokens: 2000 }), row({ source: 'unknown', total_tokens: undefined })];
  for (const by of ['day', 'worker', 'project', 'order', 'kind']) for (const top of [undefined, 1]) {
    const report = usageReport(rows, by, '', top);
    assert.equal(report.total.tokens, report.rows.reduce((n, r) => n + r.tokens, 0));
    assert.equal(report.total.unknown, report.rows.reduce((n, r) => n + r.unknown, 0));
  }
});
test('accounting: absent split counters stay unknown in aggregate shares', () => {
  const total = usageReport([row({ cached_tokens: undefined })]).total;
  assert.equal(total.cache_unknown, 1); assert.equal(total.reasoning_unknown, 1);
});
test('accounting: merged quantiles use lifetime totals and incomplete prices have no average', () => {
  const rows = [row({ at: '2025-12-01T00:00:00Z', merged: true, merged_at: at, total_tokens: 1000 }), row({ merged: true, merged_at: at, total_tokens: 100, estimate: 1, currency: 'USD' }), row({ order: 'T2', merged: true, merged_at: at, total_tokens: undefined, source: 'unknown' })];
  const d = usageDashboard(rows, [], [], '2026-01-01T00:00:00Z', new Date(at));
  assert.equal(d.median, 1100); assert.equal(d.mergedKinds.rows[0].merged_pricing_complete, false);
  assert.equal(d.workers.total.tokens, 100);
});
test('accounting: prices resolve by worker and model and discount cached input', () => {
  const price = { input_per_mtok: 2, cached_input_per_mtok: .5, output_per_mtok: 8, currency: 'USD' };
  const workers = validateWorkers({ pricing: { example: price }, workers: [{ id: 'w', engine: 'x', launch: { program: 'x', args: [], model: 'example' } }] }, 'workers.yaml');
  assert.deepEqual(pricingOf(workers, workers.workers[0], 'example'), price);
  assert.equal(pricingOf(workers, workers.workers[0], 'earlier-model'), undefined);
  assert.equal(estimate(row(), price).estimate, .0019);
  assert.equal(estimate(row(), undefined).estimate, undefined);
  assert.equal(estimate(row({ cache_write_tokens: 5 }), price).estimate, undefined);
});
test('accounting: rollout uses only the last cumulative total and labels its source', () => {
  const { dir } = tempOrders(); mkdirSync(path.join(dir, 'sessions'));
  writeFileSync(path.join(dir, 'sessions', 'rollout-sample-session.jsonl'), [100, 200].map(n => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n, output_tokens: 20 } } } })).join('\n'));
  const u = rolloutTotal('session id: sample-session', dir);
  assert.equal(u?.source, 'codex-rollout'); assert.equal(u?.total_tokens, 220);
  assert.equal(rolloutTotal('session id: ../../private', dir), undefined);
});
const command = (cmd: string, output = '', exit_code = 0) => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: cmd, aggregated_output: output, exit_code } });
const turn = (usage: object) => JSON.stringify({ type: 'turn.completed', usage });
test('waste: tokens without a commit, and successful commit resets the evidence range', () => {
  assert.equal(fold(turn({ input_tokens: 1100000, output_tokens: 1 })).signals('T1', 'r1', 'sim')[0].kind, 'no-commit');
  assert.equal(fold([turn({ input_tokens: 1100000 }), command('git commit -m step'), turn({ input_tokens: 10 })].join('\n')).signals('T1', 'r1', 'sim').length, 0);
});
test('waste: low cached share only when the counter exists on a long run', () => {
  assert.ok(fold(turn({ input_tokens: 1100000, cached_input_tokens: 10 })).signals('T1', 'r1', 'sim').some(s => s.kind === 'low-cache'));
  assert.ok(!fold(turn({ input_tokens: 1100000 })).signals('T1', 'r1', 'sim').some(s => s.kind === 'low-cache'));
});
test('waste: large output names command and turn', () => {
  const s = fold(command('build', 'x'.repeat(100001))).signals('T1', 'r1', 'sim')[0]; assert.equal(s.command, 'build'); assert.deepEqual(s.turns, [1, 1]);
});
test('waste: repeated file reads name file and turn range', () => {
  const s = fold(Array(5).fill(command('Get-Content -LiteralPath src/example.ts')).join('\n')).signals('T1', 'r1', 'sim')[0]; assert.equal(s.file, 'src/example.ts');
});
test('waste: three consecutive identical failures reuse loop detector; success breaks streak', () => {
  const bad = command('build', 'error invalid input 42', 1);
  assert.ok(fold([bad, bad, bad].join('\n')).signals('T1', 'r1', 'sim').some(s => s.kind === 'failed-loop'));
  assert.ok(!fold([bad, command('build'), bad, bad].join('\n')).signals('T1', 'r1', 'sim').some(s => s.kind === 'failed-loop'));
});
test('waste: reasoning threshold can vary by kind', () => {
  const f = fold(turn({ input_tokens: 100, output_tokens: 100, reasoning_tokens: 90 }));
  assert.ok(f.signals('T1', 'r1', 'sim').some(s => s.kind === 'reasoning'));
  assert.equal(f.signals('T1', 'r1', 'research', { reasoning_by_kind: { research: .95 } }).length, 0);
});
test('budget: day, order and cost warnings never stop a run', () => {
  const { cfg, orders } = setup(); cfg.budget = { tokens_per_day: 100, tokens_per_order: 100, cost_per_day: .1 };
  assert.equal(budgetWarnings(cfg, [row({ estimate: 1, currency: 'USD' })], new Date(at)).length, 3);
  assert.equal(orders.stage(orders.get('T1')).stage, 'queued');
});
test('storage: usage survives file-to-SQLite migration and export', () => {
  const { dir } = tempOrders(); const state = path.join(dir, 'portable'); mkdirSync(state);
  const files = { state_dir: state, state: { backend: 'files' as const } };
  replaceRunUsage(files, 'T1-r1', [row()]); migrateState(state);
  const db = { state_dir: state, state: { backend: 'sqlite' as const } };
  assert.deepEqual(usageRows(db), [row()]);
  const out = path.join(dir, 'export'); exportState(state, out);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, '_usage.json'), 'utf8')), [row()]);
});
test('storage: identical run ids in different orders never overwrite each other', () => {
  const { cfg } = setup();
  replaceRunUsage(cfg, 'r1', [row({ run: 'r1' })]);
  replaceRunUsage(cfg, 'r1', [row({ order: 'T2', run: 'r1', total_tokens: 2000 })]);
  replaceRunUsage(cfg, 'r1', [row({ run: 'r1', total_tokens: 100 })]);
  assert.deepEqual(usageRows(cfg).map(r => [r.order, r.total_tokens]).sort(), [['T1', 100], ['T2', 2000]]);
});
test('engines: OpenCode preserves reasoning and cache writes, Grok reports totals, Claude reports assistant usage once', () => {
  const open = fold(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 60, write: 10 } }, cost: .001 } })).turns[0].usage;
  assert.deepEqual([open.source, open.total_tokens, open.reasoning_tokens, open.cache_write_tokens], ['opencode-json', 195, 5, 10]);
  const grok = fold(readFileSync(path.join(import.meta.dirname, 'fixtures/grok-done.log'), 'utf8')).turns[0].usage;
  assert.deepEqual([grok.source, grok.total_tokens, grok.reasoning_tokens, grok.cache_write_tokens], ['grok-end', 19125, 223, 0]);
  const claude = fold([{ type: 'assistant', message: { id: 'msg-1', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 } } }, { type: 'result', usage: { input_tokens: 100, output_tokens: 20 } }].map(e => JSON.stringify(e)).join('\n'));
  assert.equal(claude.turns.length, 1); assert.equal(claude.turns[0].usage.total_tokens, 190);
});
test('rollout: resumed runs subtract the prior cumulative session total', () => {
  const { dir } = tempOrders(); mkdirSync(path.join(dir, 'sessions'));
  writeFileSync(path.join(dir, 'sessions/rollout-sample-session.jsonl'), [10, 12, 14].map((h,i) => JSON.stringify({ timestamp: `2026-01-01T${h}:00:00Z`, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: (i + 1) * 100, output_tokens: (i + 1) * 10 } } } })).join('\n'));
  assert.equal(rolloutTotal('session id: sample-session', dir, { started: '2026-01-01T11:00:00Z', ended: '2026-01-01T13:00:00Z' })?.total_tokens, 110);
});
test('subscription: show observed window change, no estimate, and label a shared quota', () => {
  const { cfg, orders } = setup();
  const workers = validateWorkers({ quota_sources: { q: { type: 'static', unlimited: true } }, workers: [{ id: 'a', engine: 'x', quota: 'q' }, { id: 'b', engine: 'x', quota: 'q' }] }, 'workers.yaml');
  orders.runStart('T1', { worker: 'a' }); orders.runEnd('T1');
  writeStateFile(cfg, 'quota-history.jsonl', [orders.get('T1').runs[0].started, orders.get('T1').runs[0].ended!].map((at,i) => JSON.stringify({ at, source: 'q', ok: true, entries: 1, windows: [{ name: 'weekly', usedPercent: i * 10, resetsAt: '2026-01-08T00:00:00Z' }] })).join('\n'));
  const rows = collectUsage(cfg, orders.all(), workers, { ...systemProbes, now: () => new Date('2026-01-01T01:00:00Z') }).rows;
  assert.equal(rows[0].estimate, undefined); assert.deepEqual(rows[0].quota, [{ window: 'weekly', percent: 10, shared: true }]);
});
test('API: run usage, order totals and overview agree and invalid periods return a client error', async () => {
  const f = await fixture({ populate: false });
  f.orders.add({ tag: 'T1', title: 'Usage', kind: 'sim' }); f.orders.act('T1', 'queue');
  const events = path.join(f.dir, 'turns.jsonl'); writeFileSync(events, record.replaceAll('2026-01-01', new Date().toISOString().slice(0,10)));
  f.orders.runStart('T1', { worker: 'coder', extra: { events_file: events } });
  const usage = await f.get('/api/usage/runs?project=demo&since=7d');
  assert.equal(usage.status, 200); assert.equal(usage.body.workers.total.tokens, 3300);
  assert.equal((await f.get('/api/orders/T1?project=demo')).body.accounting.total.tokens, 3300);
  assert.equal((await f.get('/api/overview/all')).body.usage.week.total.tokens, 3300);
  assert.equal((await f.get('/api/usage/runs?project=demo&since=bad')).status, 400);
});
test('budget and waste: real tick warns without stopping, deduplicates thread events, and applies project thresholds', () => {
  const { cfg, orders, dir } = setup();
  cfg.budget = { tokens_per_order: 100, tokens_per_day: 100 };
  cfg.usage_warnings = { tokens_without_commit: 100 };
  const events = path.join(dir, 'budget-events.jsonl'); writeFileSync(events, record);
  orders.runStart('T1', { worker: 'coder', extra: { events_file: events } });
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli' }] }, 'workers.yaml');
  const probes = { ...systemProbes, now: () => new Date(at), freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}) };
  const first = tick(cfg, orders, workers, probes, { record: true });
  assert.ok(first.report.problems.some(p => p.kind === 'usage-budget'));
  assert.ok(first.report.problems.some(p => p.kind === 'usage-waste' && p.evidence?.[0].includes('turns')));
  assert.equal(orders.get('T1').runs[0].ended, undefined);
  const count = orders.store.events().filter(e => e.type === 'usage-budget').length;
  tick(cfg, orders, workers, probes, { record: true });
  assert.equal(orders.store.events().filter(e => e.type === 'usage-budget').length, count);
  delete cfg.usage_warnings;
  assert.ok(!tick(cfg, orders, workers, probes, { record: false }).report.problems.some(p => p.kind === 'usage-waste'));
});
