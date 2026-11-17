import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OrderDoc, Run } from '../src/orders/model.ts';
import { workerTrip } from '../src/routing/breaker.ts';
import { workerHistory } from '../src/routing/history.ts';
import { runCapExceeded } from '../src/run/token-cap.ts';
import { parseOrderSections } from '../src/verify/verify.ts';
import { validateWorkers } from '../src/workers/config.ts';

let seq = 0;
const run = (minutesAgo: number, fields: Partial<Run>): Run => ({
  id: `r${++seq}`, seq, worker: 'w', started: new Date(Date.now() - (minutesAgo + 5) * 60000).toISOString(),
  ended: new Date(Date.now() - minutesAgo * 60000).toISOString(), ...fields,
} as Run);
const died = (minutesAgo: number) => run(minutesAgo, { outcome: 'failed', missing_report: true });

test('breaker: three runs in a row that died without a report pause the worker, and the pause ends', () => {
  const now = new Date();
  assert.equal(workerTrip([died(30), died(20)], {}, now), undefined, 'two are not enough');
  const trip = workerTrip([died(30), died(20), died(10)], {}, now);
  assert.equal(trip?.failures, 3);
  assert.ok(Date.parse(trip!.until) > now.getTime());
  assert.equal(workerTrip([died(90), died(80), died(70)], {}, now), undefined, 'the default pause of 60 minutes is over');
  assert.ok(workerTrip([died(90), died(80), died(70)], { trip_minutes: 120 }, now));
  assert.equal(workerTrip([died(30), died(20), died(10)], { trip_after_failures: 0 }, now), undefined, '0 turns it off');
});

test('breaker: a delivered run closes it; cancelled, capacity and alba-stopped runs neither count nor close it', () => {
  const now = new Date();
  const ok = run(5, { outcome: 'completed' });
  assert.equal(workerTrip([died(30), died(20), died(10), ok], {}, now), undefined);
  const honest = run(5, { outcome: 'failed' });
  assert.equal(workerTrip([died(30), died(20), died(10), honest], {}, now), undefined, 'a failed run with a report is the task, not the worker');
  const noise = [run(9, { outcome: 'cancelled' }), run(8, { outcome: 'capacity' }), run(7, { outcome: 'failed', missing_report: true, end: { kind: 'killed-by-alba', detail: '', why: '' } })];
  assert.equal(workerTrip([died(30), died(20), ...noise], {}, now), undefined);
  assert.ok(workerTrip([died(30), died(20), ...noise, died(1)], {}, now));
});

test('routing history: runs that died without a report weigh against the accepted share', () => {
  const doc = (tag: string, runs: Run[], actions: { kind: string; seq: number }[]): OrderDoc => ({ order: { tag, kind: 'docs' }, runs, actions, reports: [] } as unknown as OrderDoc);
  const workers = validateWorkers({ workers: [{ id: 'w', engine: 'codex-cli' }] }, 'w.yaml').workers;
  const docs = [
    doc('A', [{ ...run(50, { outcome: 'completed' }), seq: 1 }], [{ kind: 'approve', seq: 2 }]),
    doc('B', [{ ...run(40, { outcome: 'completed' }), seq: 1 }], [{ kind: 'approve', seq: 2 }]),
    doc('C', [{ ...died(30), seq: 1 }, { ...died(20), seq: 2 }], []),
  ];
  const h = workerHistory(docs, workers).w!.docs!;
  assert.deepEqual({ accepted: h.accepted, reworked: h.reworked, failed: h.failed, samples: h.samples }, { accepted: 2, reworked: 0, failed: 2, samples: 4 });
  assert.equal(h.rate, 0.5);
});

test('run caps: minutes and dollars stop a run like tokens do', () => {
  const now = new Date();
  const r = { started: new Date(now.getTime() - 200 * 60000).toISOString() };
  assert.equal(runCapExceeded(r, {}, undefined, now), undefined);
  assert.equal(runCapExceeded(r, { max_minutes_per_run: 240 }, undefined, now), undefined);
  assert.match(runCapExceeded(r, { max_minutes_per_run: 180 }, undefined, now)!.summary, /max_minutes_per_run exceeded \(200 > 180 minutes\)/);
  assert.match(runCapExceeded(r, { max_usd_per_run: 20 }, { source: 'claude-json', cost_usd: 25.5 }, now)!.summary, /max_usd_per_run exceeded \(\$25\.50 > \$20\)/);
  const priced = runCapExceeded(r, { max_usd_per_run: 1, price: { per_mtok: 10 } }, { source: 'codex-json', total_tokens: 200000 }, now);
  assert.equal(priced?.cap, 'usd', 'without an engine figure the worker price is used');
  assert.equal(runCapExceeded(r, { max_usd_per_run: 1 }, { source: 'codex-json', total_tokens: 200000 }, now), undefined, 'no figure and no price: unknown cost is not over a cap');
  assert.equal(runCapExceeded(r, { max_tokens_per_run: 100 }, { source: 'codex-json', total_tokens: 200 }, now)?.cap, 'tokens');
});

test('workers file: the new limits are validated', () => {
  const w = validateWorkers({ workers: [{ id: 'w', engine: 'codex-cli', max_minutes_per_run: 240, max_usd_per_run: 30, trip_after_failures: 2, trip_minutes: 15 }] }, 'w.yaml').workers[0]!;
  assert.deepEqual([w.max_minutes_per_run, w.max_usd_per_run, w.trip_after_failures, w.trip_minutes], [240, 30, 2, 15]);
  assert.throws(() => validateWorkers({ workers: [{ id: 'w', engine: 'codex-cli', max_minutes_per_run: 0 }] }, 'w.yaml'));
  assert.throws(() => validateWorkers({ workers: [{ id: 'w', engine: 'codex-cli', max_usd_per_run: -1 }] }, 'w.yaml'));
});

test('order sections: numbered headings with a note are recognised', () => {
  const s = parseOrderSections('# X\n\n## 4. Acceptance (the lead re-captures and measures)\n\n1. The sea moves.\n\n## Evidence: required\n\n- artifacts/X/*.png: the sea\n');
  assert.deepEqual(s.acceptance, ['The sea moves.']);
  assert.deepEqual(s.evidence.map(e => e.path), ['artifacts/X/*.png']);
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(parseOrderSections('# X\nNo sections.\n').warnings, ['Order has no ## Acceptance section.'], 'a missing Evidence section is not a warning');
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateProject } from './state-helper.ts';
import { startRun } from '../src/run/launch.ts';
import { stopStalledRun, STALL_CONTINUATION } from '../src/run/watch.ts';
import { rework } from '../src/run/review.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tempOrders } from './helpers.ts';

function started(dispatch: Record<string, unknown> = {}) {
  const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game'); mkdirSync(root, { recursive: true });
  gitIn(root, 'init', '-q', '-b', 'main'); writeFileSync(path.join(root, 'a.txt'), 'a'); gitIn(root, 'add', '.'); gitIn(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders'); mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-x.md'), '# T1\nX.\n');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main', ...dispatch } }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', launch: { template: 'c', program: 'coder', args: ['{prompt_file}'] } }] }, 'w.yaml');
  const probes: Probes = { now: () => new Date(), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => 4242 };
  orders.add({ tag: 'T1', title: 'X', kind: 'ue' }); orders.act('T1', 'queue');
  startRun({ project, orders, workers, probes }, 'T1', 'coder');
  return { orders, project, workers, probes };
}

test('stall: the first stall is stopped and continued on the same worker; the second goes to a person', () => {
  const f = started({ on_stall: 'continue', stall_minutes: 30 });
  assert.equal(f.project.dispatch.on_stall, 'continue');
  assert.match(stopStalledRun(f.project, f.orders, f.probes, 'T1', 'T1: no commit for 2 h'), /queued one continuation/);
  let doc = f.orders.get('T1');
  assert.equal(doc.runs[0]!.outcome, 'stalled');
  assert.equal(doc.actions.at(-1)!.note, STALL_CONTINUATION);
  assert.equal(f.orders.stage(doc).stage, 'queued');
  startRun({ project: f.project, orders: f.orders, workers: f.workers, probes: f.probes }, 'T1', 'coder');
  assert.match(stopStalledRun(f.project, f.orders, f.probes, 'T1', 'T1: no commit for 2 h'), /stalled again/);
  doc = f.orders.get('T1');
  assert.equal(f.orders.stage(doc).stage, 'failed');
  assert.equal(f.orders.store.events({ tag: 'T1' }).filter(e => e.type === 'stall-stopped').length, 2);
});

test('rework limit: past dispatch.max_reworks a send-back needs --override', () => {
  const f = started({ max_reworks: 1 });
  f.orders.report('T1', { status: 'ready', summary: 'done', evidence: [], commits: [] });
  f.orders.runEnd('T1');
  rework(f.orders, 'T1', 'fix it', { max: f.project.dispatch.max_reworks });
  f.orders.report('T1', { status: 'ready', summary: 'done again', evidence: [], commits: [] });
  assert.throws(() => rework(f.orders, 'T1', 'and again', { max: f.project.dispatch.max_reworks }), /sent back 1 times \(dispatch\.max_reworks is 1\)/);
  rework(f.orders, 'T1', 'and again', { max: f.project.dispatch.max_reworks, override: true });
  assert.equal(f.orders.get('T1').actions.filter(a => a.kind === 'rework').length, 2);
});

import { mergeListFlags } from '../src/cli/args.ts';

test('cli: a list flag given twice adds up instead of the last one winning', () => {
  assert.deepEqual(mergeListFlags(['orders', 'add', 'X', '--needs', 'A', '--title', 't', '--needs=B,C']), ['orders', 'add', 'X', '--needs', 'A,B,C', '--title', 't']);
  assert.deepEqual(mergeListFlags(['orders', 'add', 'X', '--needs', 'A']), ['orders', 'add', 'X', '--needs', 'A']);
  assert.deepEqual(mergeListFlags(['--title', 'needs', '--json']), ['--title', 'needs', '--json'], 'other flags are untouched');
});
