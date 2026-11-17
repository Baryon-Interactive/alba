import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import type { OrderDoc, Run } from '../src/orders/model.ts';
import { Orders } from '../src/orders/service.ts';
import { validateRoles, validateRouting } from '../src/roles/config.ts';
import { chooseWorker, type Choosable } from '../src/routing/choose.ts';
import { systemProbes, tick } from '../src/tick/gather.ts';
import { scorecard } from '../src/usage/scorecard.ts';
import { replaceRunUsage } from '../src/usage/store.ts';
import type { UsageRow } from '../src/usage/types.ts';
import { validateWorkers, type WorkerConfig } from '../src/workers/config.ts';
import { fixture } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';
import { selectTestBackend, testStore, validateProject } from './state-helper.ts';

const SINCE = '2026-03-01T00:00:00.000Z';
const UNTIL = '2026-03-15T00:00:00.000Z';

function makeDoc(
  tag: string,
  kind: string,
  runs: Partial<Run>[],
  actions: { seq: number; kind: 'approve' | 'rework' | 'queue' | 'cancel'; at?: string; override?: boolean }[] = [],
  orderExtra: Partial<OrderDoc['order']> = {},
): OrderDoc {
  return {
    version: 1,
    order: {
      tag,
      title: `Order ${tag}`,
      kind,
      needs: [],
      created: '2026-03-01T00:00:00.000Z',
      updated: '2026-03-10T00:00:00.000Z',
      ...orderExtra,
    },
    runs: runs.map((r, idx) => ({
      id: r.id ?? `r${idx + 1}`,
      seq: r.seq ?? (idx + 1) * 10,
      worker: r.worker ?? 'paid-a',
      started: r.started ?? '2026-03-05T10:00:00.000Z',
      ...(r.ended !== undefined ? { ended: r.ended } : {}),
      ...(r.outcome !== undefined ? { outcome: r.outcome } : {}),
      ...r,
    })),
    reports: [],
    actions: actions.map(a => ({
      seq: a.seq,
      at: a.at ?? '2026-03-05T12:00:00.000Z',
      kind: a.kind,
      ...(a.override ? { override: true } : {}),
    })),
  };
}

function makeUsageRow(overrides: Partial<UsageRow> & { order: string; run: string }): UsageRow {
  return {
    project: 'demo',
    worker: 'paid-a',
    engine: 'claude-cli',
    model: 'model-alpha',
    turn: 1,
    at: '2026-03-05T10:30:00.000Z',
    kind: 'ue',
    rework: false,
    resume: false,
    open: false,
    merged: false,
    source: 'claude-json',
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
    ...overrides,
  };
}

test('scorecard credit: attributes first-pass, rework, failed, override approve, cancelled, pending, open, and ignores imported and out-of-window runs', () => {
  const workers = validateWorkers({
    workers: [{ id: 'paid-a', engine: 'claude-cli', paid: true }],
  }, 'workers.yaml');

  const docs: { project: string; doc: OrderDoc }[] = [
    // 1. First-pass approve
    {
      project: 'demo',
      doc: makeDoc(
        'T1', 'ue',
        [{ id: 'r1', seq: 1, started: '2026-03-02T10:00:00Z', ended: '2026-03-02T10:20:00Z', outcome: 'completed' }],
        [{ seq: 2, kind: 'approve', at: '2026-03-16T00:00:00Z' }], // verdict arrives after until, still credits run
      ),
    },
    // 2. Rework then approve on the same worker
    {
      project: 'demo',
      doc: makeDoc(
        'T2', 'ue',
        [
          { id: 'r1', seq: 1, started: '2026-03-03T10:00:00Z', ended: '2026-03-03T10:30:00Z', outcome: 'completed' },
          { id: 'r2', seq: 3, started: '2026-03-03T11:00:00Z', ended: '2026-03-03T11:15:00Z', outcome: 'completed' },
        ],
        [
          { seq: 2, kind: 'rework' },
          { seq: 4, kind: 'approve' },
        ],
      ),
    },
    // 3. Failed run without report (brokenRun)
    {
      project: 'demo',
      doc: makeDoc(
        'T3', 'ue',
        [{ id: 'r1', seq: 1, started: '2026-03-04T10:00:00Z', ended: '2026-03-04T10:10:00Z', outcome: 'failed', missing_report: true }],
      ),
    },
    // 4. Override approve after a failed run (counts as accepted, not failed)
    {
      project: 'demo',
      doc: makeDoc(
        'T4', 'ue',
        [{ id: 'r1', seq: 1, started: '2026-03-05T10:00:00Z', ended: '2026-03-05T10:25:00Z', outcome: 'failed', missing_report: true }],
        [{ seq: 2, kind: 'approve', override: true }],
      ),
    },
    // 5. Cancelled run
    {
      project: 'demo',
      doc: makeDoc(
        'T5', 'ue',
        [{ id: 'r1', seq: 1, started: '2026-03-06T10:00:00Z', ended: '2026-03-06T10:05:00Z', outcome: 'cancelled' }],
      ),
    },
    // 6. Pending run (ended completed, no verdict yet)
    {
      project: 'demo',
      doc: makeDoc(
        'T6', 'ue',
        [{ id: 'r1', seq: 1, started: '2026-03-07T10:00:00Z', ended: '2026-03-07T10:15:00Z', outcome: 'completed' }],
      ),
    },
    // 7. Imported run (ignored) and out-of-window runs (ignored), plus capacity (other) and open run
    {
      project: 'demo',
      doc: makeDoc(
        'T7', 'ue',
        [
          { id: 'r-imp', seq: 1, started: '2026-03-08T10:00:00Z', ended: '2026-03-08T10:10:00Z', outcome: 'completed', imported: true },
          { id: 'r-old', seq: 2, started: '2026-02-20T10:00:00Z', ended: '2026-02-20T10:10:00Z', outcome: 'completed' },
          { id: 'r-late', seq: 3, started: '2026-03-20T10:00:00Z', ended: '2026-03-20T10:10:00Z', outcome: 'completed' },
          { id: 'r-cap', seq: 4, started: '2026-03-09T10:00:00Z', ended: '2026-03-09T10:05:00Z', outcome: 'capacity' },
          { id: 'r-open', seq: 5, started: '2026-03-10T10:00:00Z' },
        ],
      ),
    },
  ];

  const sc = scorecard({ docs, rows: [], workers, since: SINCE, until: UNTIL, by: 'worker' });
  assert.equal(sc.rows.length, 1);
  const row = sc.rows[0]!;
  assert.equal(row.key, 'paid-a');
  assert.equal(row.kind, 'ue');
  assert.equal(row.runs, 9);
  assert.equal(row.accepted_first_pass, 2); // T1/r1 and T4/r1 (override approve)
  assert.equal(row.accepted_after_rework, 1); // T2/r2
  assert.equal(row.accepts, 3);
  assert.equal(row.reworks, 1); // T2/r1
  assert.equal(row.failed, 1); // T3/r1 only; T4/r1 got override approve
  assert.equal(row.cancelled, 1); // T5/r1
  assert.equal(row.pending, 1); // T6/r1
  assert.equal(row.other, 1); // T7/r-cap
  assert.equal(row.open, 1); // T7/r-open
  // First attempts: T1/r1 (approve), T2/r1 (rework), T3/r1 (failed), T4/r1 (override approve) = 4
  assert.equal(row.first_attempts, 4);
  assert.equal(row.first_pass_rate, 2 / 4);
  assert.equal(row.acceptance_rate, 3 / 5); // 3 accepts / (4 verdicts + 1 failed)
});

test('scorecard cost: engine spend summed per run, summed estimates, included and unknown without zeroing', () => {
  const workers = validateWorkers({
    workers: [
      { id: 'engine-paid', engine: 'claude-cli', paid: true },
      { id: 'est-paid', engine: 'codex-cli', paid: true },
      { id: 'legacy-paid', engine: 'codex-cli', paid: true, price: { per_mtok: 4 } },
      { id: 'sub-worker', engine: 'codex-cli', cost: 'included' },
      { id: 'unpriced-paid', engine: 'codex-cli', paid: true },
    ],
  }, 'workers.yaml');

  const docs: { project: string; doc: OrderDoc }[] = [
    {
      project: 'demo',
      doc: makeDoc('T1', 'ue', [{ id: 'r1', seq: 1, worker: 'engine-paid', started: '2026-03-05T00:00:00Z', ended: '2026-03-05T00:30:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
    {
      project: 'demo',
      doc: makeDoc('T2', 'ue', [{ id: 'r1', seq: 1, worker: 'est-paid', started: '2026-03-05T00:00:00Z', ended: '2026-03-05T00:20:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
    {
      project: 'demo',
      doc: makeDoc('T3', 'ue', [{ id: 'r1', seq: 1, worker: 'legacy-paid', started: '2026-03-05T00:00:00Z', ended: '2026-03-05T00:10:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
    {
      project: 'demo',
      doc: makeDoc('T4', 'ue', [{ id: 'r1', seq: 1, worker: 'sub-worker', started: '2026-03-05T00:00:00Z', ended: '2026-03-05T00:40:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
    {
      project: 'demo',
      doc: makeDoc('T5', 'ue', [{ id: 'r1', seq: 1, worker: 'unpriced-paid', started: '2026-03-05T00:00:00Z', ended: '2026-03-05T00:50:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
  ];

  const rows: UsageRow[] = [
    // Per-turn engine spend on a single run (the fold stores increments of the running total): 12.57 + 4.35 + 0.65 = 17.57
    makeUsageRow({ order: 'T1', run: 'r1', worker: 'engine-paid', turn: 1, cost_usd: 12.57 }),
    makeUsageRow({ order: 'T1', run: 'r1', worker: 'engine-paid', turn: 2, cost_usd: 4.35 }),
    makeUsageRow({ order: 'T1', run: 'r1', worker: 'engine-paid', turn: 3, cost_usd: 0.65 }),
    // Per-turn USD estimates sum across turns
    makeUsageRow({ order: 'T2', run: 'r1', worker: 'est-paid', turn: 1, estimate: 1.25, currency: 'USD' }),
    makeUsageRow({ order: 'T2', run: 'r1', worker: 'est-paid', turn: 2, estimate: 2.75, currency: 'USD' }),
    // Legacy worker.price via summed tokens (500,000 * $4/mtok = $2)
    makeUsageRow({ order: 'T3', run: 'r1', worker: 'legacy-paid', turn: 1, total_tokens: 200_000 }),
    makeUsageRow({ order: 'T3', run: 'r1', worker: 'legacy-paid', turn: 2, total_tokens: 300_000 }),
    // Included worker
    makeUsageRow({ order: 'T4', run: 'r1', worker: 'sub-worker', turn: 1, subscription: true }),
    // Paid worker with tokens only, no engine figure and no pricing
    makeUsageRow({ order: 'T5', run: 'r1', worker: 'unpriced-paid', turn: 1, source: 'codex-json', total_tokens: 5000 }),
  ];

  const sc = scorecard({ docs, rows, workers, since: SINCE, until: UNTIL, by: 'worker' });
  const byKey = new Map(sc.rows.map(r => [r.key, r]));

  const eng = byKey.get('engine-paid')!;
  assert.equal(eng.cost.usd, 17.57);
  assert.deepEqual(eng.cost.sources, ['engine']);
  assert.equal(eng.cost_per_accept, 17.57);

  const est = byKey.get('est-paid')!;
  assert.equal(est.cost.usd, 4);
  assert.deepEqual(est.cost.sources, ['estimate']);
  assert.equal(est.cost_per_accept, 4);

  const leg = byKey.get('legacy-paid')!;
  assert.equal(leg.cost.usd, 2);
  assert.deepEqual(leg.cost.sources, ['estimate']);
  assert.equal(leg.cost_per_accept, 2);

  const sub = byKey.get('sub-worker')!;
  assert.equal(sub.cost.usd, undefined);
  assert.equal(sub.cost.included_runs, 1);
  assert.equal(sub.cost_per_accept, undefined);

  const unk = byKey.get('unpriced-paid')!;
  assert.equal(unk.cost.usd, undefined);
  assert.equal(unk.cost.unknown_runs, 1);
  assert.equal(unk.cost_per_accept, undefined);
});

test('scorecard derived numbers: cost and minutes per accept, MIN_SAMPLES=3 boundary, and unknown tokens', () => {
  const workers = validateWorkers({
    workers: [
      { id: 'three-samples', engine: 'claude-cli', paid: true },
      { id: 'two-samples', engine: 'claude-cli', paid: true },
    ],
  }, 'workers.yaml');

  const docs: { project: string; doc: OrderDoc }[] = [
    // three-samples: 3 first attempts (2 first-pass approve, 1 rework -> then approve after rework)
    {
      project: 'demo',
      doc: makeDoc('T1', 'ue', [{ id: 'r1', seq: 1, worker: 'three-samples', started: '2026-03-02T00:00:00Z', ended: '2026-03-02T00:20:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
    {
      project: 'demo',
      doc: makeDoc('T2', 'ue', [{ id: 'r1', seq: 1, worker: 'three-samples', started: '2026-03-03T00:00:00Z', ended: '2026-03-03T00:40:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
    {
      project: 'demo',
      doc: makeDoc(
        'T3', 'ue',
        [
          { id: 'r1', seq: 1, worker: 'three-samples', started: '2026-03-04T00:00:00Z', ended: '2026-03-04T00:30:00Z', outcome: 'completed' },
          { id: 'r2', seq: 3, worker: 'three-samples', started: '2026-03-04T01:00:00Z', ended: '2026-03-04T01:30:00Z', outcome: 'completed' },
        ],
        [{ seq: 2, kind: 'rework' }, { seq: 4, kind: 'approve' }],
      ),
    },
    // two-samples: only 2 first attempts
    {
      project: 'demo',
      doc: makeDoc('T4', 'ue', [{ id: 'r1', seq: 1, worker: 'two-samples', started: '2026-03-05T00:00:00Z', ended: '2026-03-05T00:15:00Z', outcome: 'completed', usage: { source: 'claude-json', cost_usd: 8 } }], [{ seq: 2, kind: 'approve' }]),
    },
    {
      project: 'demo',
      doc: makeDoc('T5', 'ue', [{ id: 'r1', seq: 1, worker: 'two-samples', started: '2026-03-06T00:00:00Z', ended: '2026-03-06T00:45:00Z', outcome: 'completed', usage: { source: 'claude-json', cost_usd: 12 } }], [{ seq: 2, kind: 'approve' }]),
    },
  ];

  const rows: UsageRow[] = [
    makeUsageRow({ order: 'T1', run: 'r1', worker: 'three-samples', cost_usd: 10, total_tokens: 1000 }),
    makeUsageRow({ order: 'T2', run: 'r1', worker: 'three-samples', cost_usd: 20, total_tokens: 2000 }),
    makeUsageRow({ order: 'T3', run: 'r1', worker: 'three-samples', cost_usd: 15, total_tokens: undefined, source: 'unknown' }),
    makeUsageRow({ order: 'T3', run: 'r2', worker: 'three-samples', cost_usd: 15, total_tokens: 3000 }),
  ];

  const sc = scorecard({ docs, rows, workers, since: SINCE, until: UNTIL, by: 'worker' });
  const three = sc.rows.find(r => r.key === 'three-samples')!;
  const two = sc.rows.find(r => r.key === 'two-samples')!;

  assert.equal(three.runs, 4);
  assert.equal(three.accepts, 3);
  assert.equal(three.minutes, 120); // 20 + 40 + 30 + 30
  assert.equal(three.minutes_per_accept, 40);
  assert.equal(three.cost.usd, 60);
  assert.equal(three.cost_per_accept, 20);
  assert.equal(three.first_attempts, 3);
  assert.equal(three.first_pass_rate, 2 / 3);
  assert.equal(three.tokens, 6000);
  assert.equal(three.tokens_unknown_runs, 1);

  assert.equal(two.first_attempts, 2);
  assert.equal(two.first_pass_rate, undefined);
  assert.equal(two.acceptance_rate, undefined);
  assert.equal(two.cost.usd, 20);
  assert.deepEqual(two.cost.sources, ['run-record']);
  assert.equal(two.cost_per_accept, 10);
  assert.equal(two.minutes_per_accept, 30);
  assert.equal(two.tokens, undefined);
  assert.equal(two.tokens_unknown_runs, 2);
});

test('scorecard filters: kind, since, by model, by family, and two projects in one scorecard', () => {
  const workers = validateWorkers({
    workers: [
      { id: 'shell-one', engine: 'codex-cli', model_family: 'gpt-family', paid: true },
      { id: 'shell-two', engine: 'opencode', model_family: 'gpt-family', paid: true },
      { id: 'solo-worker', engine: 'claude-cli', paid: true },
    ],
  }, 'workers.yaml');

  const docs: { project: string; doc: OrderDoc }[] = [
    {
      project: 'alpha',
      doc: makeDoc('T1', 'task', [{ id: 'r1', seq: 1, worker: 'shell-one', model: 'm-fast', routing: { kind: 'ue', why: 'r', rejected: [] }, started: '2026-03-10T00:00:00Z', ended: '2026-03-10T00:20:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
    {
      project: 'beta',
      doc: makeDoc('T1', 'ue', [{ id: 'r1', seq: 1, worker: 'shell-two', started: '2026-03-12T00:00:00Z', ended: '2026-03-12T00:40:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
    {
      project: 'alpha',
      doc: makeDoc('T2', 'docs', [{ id: 'r1', seq: 1, worker: 'solo-worker', model: 'm-writer', started: '2026-03-02T00:00:00Z', ended: '2026-03-02T00:10:00Z', outcome: 'completed' }], [{ seq: 2, kind: 'approve' }]),
    },
  ];

  // Both alpha and beta have T1/r1 with distinct costs, verifying project key isolation.
  const rows: UsageRow[] = [
    makeUsageRow({ project: 'alpha', order: 'T1', run: 'r1', worker: 'shell-one', cost_usd: 10 }),
    makeUsageRow({ project: 'beta', order: 'T1', run: 'r1', worker: 'shell-two', cost_usd: 30 }),
    makeUsageRow({ project: 'alpha', order: 'T2', run: 'r1', worker: 'solo-worker', kind: 'docs', cost_usd: 5 }),
  ];

  const byFamily = scorecard({ docs, rows, workers, since: SINCE, until: UNTIL, kind: 'ue', by: 'family' });
  assert.deepEqual(byFamily.projects, ['alpha', 'beta']);
  assert.equal(byFamily.rows.length, 1);
  assert.equal(byFamily.rows[0]!.key, 'gpt-family');
  assert.deepEqual(byFamily.rows[0]!.projects, ['alpha', 'beta']);
  assert.equal(byFamily.rows[0]!.runs, 2);
  assert.equal(byFamily.rows[0]!.cost.usd, 40);
  assert.equal(byFamily.rows[0]!.cost_per_accept, 20);

  const byModel = scorecard({ docs, rows, workers, since: '2026-03-09T00:00:00Z', until: UNTIL, by: 'model' });
  assert.deepEqual(byModel.rows.map(r => [r.key, r.kind, r.cost.usd]), [
    ['m-fast', 'ue', 10],
    ['unknown', 'ue', 30], // shell-two run had no run.model, T2 excluded by since
  ]);
});

test('CLI subprocess: alba usage scorecard prints the formatted table and --json over a temp project', () => {
  const { dir } = tempOrders();
  const root = path.join(dir, 'repo');
  const ordersDir = path.join(dir, 'orders');
  const stateDir = path.join(dir, 'state');
  mkdirSync(root, { recursive: true });
  mkdirSync(ordersDir, { recursive: true });

  const workersPath = path.join(dir, 'workers.yaml');
  writeFileSync(workersPath, stringify({
    workers: [
      { id: 'paid-worker', engine: 'claude-cli', paid: true },
      { id: 'partial-worker', engine: 'claude-cli', paid: true },
      { id: 'sub-worker', engine: 'codex-cli', cost: 'included' },
    ],
  }), 'utf8');

  const projectPath = path.join(dir, 'alba.yaml');
  writeFileSync(projectPath, stringify({
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: ordersDir,
    state_dir: stateDir,
    workers: workersPath,
  }), 'utf8');
  selectTestBackend(projectPath);

  const store = testStore(stateDir);
  const now = Date.now();
  let tickClock = 0;
  const orders = new Orders(store, () => new Date(now - 4 * 3600_000 + (tickClock++) * 60_000).toISOString());

  // paid-worker: 1 accepted run with cumulative Claude result stream
  orders.add({ tag: 'T1', title: 'First', kind: 'ue' });
  orders.act('T1', 'queue');
  const evFile = path.join(dir, 't1-r1.jsonl');
  writeFileSync(evFile, [
    JSON.stringify({ type: 'result', usage: { input_tokens: 500, output_tokens: 100 }, total_cost_usd: 12.5 }),
    JSON.stringify({ type: 'result', usage: { input_tokens: 800, output_tokens: 200 }, total_cost_usd: 18.0 }),
  ].join('\n') + '\n', 'utf8');
  orders.runStart('T1', { worker: 'paid-worker', extra: { events_file: evFile } });
  orders.runEnd('T1');
  orders.act('T1', 'approve', { force: true });

  // sub-worker: 1 accepted included run
  orders.add({ tag: 'T2', title: 'Second', kind: 'ue' });
  orders.act('T2', 'queue');
  orders.runStart('T2', { worker: 'sub-worker' });
  orders.runEnd('T2');
  orders.act('T2', 'approve', { force: true });

  // partial-worker: 9 runs, only 2 priced -> "unknown (2 of 9 runs priced)"
  orders.add({ tag: 'T3', title: 'Partial', kind: 'ue' });
  orders.act('T3', 'queue');
  for (let i = 0; i < 9; i++) {
    const pricedLog = path.join(dir, `p-${i}.jsonl`);
    if (i < 2) {
      writeFileSync(pricedLog, JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 5 }) + '\n', 'utf8');
    }
    orders.runStart('T3', { worker: 'partial-worker', extra: i < 2 ? { events_file: pricedLog } : {} });
    orders.runEnd('T3');
    if (i < 8) orders.act('T3', 'rework', { force: true, note: 'again' });
    else orders.act('T3', 'approve', { force: true });
  }
  if ('db' in store) (store as { db: { close(): void } }).db.close();

  const mainPath = path.resolve(import.meta.dirname, '../src/cli/main.ts');
  const textOut = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', mainPath, '--project', projectPath, 'usage', 'scorecard'], { encoding: 'utf8' });
  assert.match(textOut, /WORKER\s+KIND\s+RUNS\s+1ST-PASS\s+AFTER-RW\s+REWORK\s+FAILED\s+CANCELLED\s+MIN\s+COST\s+\$\/ACCEPT\s+MIN\/ACCEPT\s+FIRST-PASS/);
  assert.match(textOut, /paid-worker\s+ue\s+1\s+1\s+0\s+0\s+0\s+0\s+\d+\s+\$18\.00\s+\$18\.00\s+\d+\s+n<3/);
  assert.match(textOut, /sub-worker\s+ue\s+1\s+1\s+0\s+0\s+0\s+0\s+\d+\s+included\s+included\s+\d+\s+n<3/);
  assert.match(textOut, /unknown \(2 of 9 runs priced\)/);

  const jsonOut = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', mainPath, '--project', projectPath, 'usage', 'scorecard', '--json'], { encoding: 'utf8' }));
  assert.equal(jsonOut.by, 'worker');
  assert.deepEqual(jsonOut.projects, ['demo']);
  assert.equal(jsonOut.rows.find((r: any) => r.key === 'paid-worker').cost.usd, 18);
  assert.equal(jsonOut.rows.find((r: any) => r.key === 'partial-worker').cost.usd, undefined);
  assert.equal(jsonOut.rows.find((r: any) => r.key === 'partial-worker').cost.priced_runs, 2);
});

test('API on port 0: GET /api/usage/scorecard serves one project and all projects from stored rows', async () => {
  const f = await fixture({ populate: false, second: true });

  f.orders.add({ tag: 'T1', title: 'Demo work', kind: 'ue' });
  f.orders.act('T1', 'queue');
  const r1 = f.orders.runStart('T1', { worker: 'coder' }).run;
  f.orders.runEnd('T1');
  f.orders.act('T1', 'approve', { force: true });
  replaceRunUsage(f.board.ctx.projects[0]!, r1.id, [
    makeUsageRow({ project: 'demo', order: 'T1', run: r1.id, worker: 'coder', cost_usd: 14, at: r1.started }),
  ]);

  const otherCfg = f.board.ctx.projects[1]!;
  const otherOrders = new Orders(testStore(otherCfg.state_dir));
  otherOrders.add({ tag: 'T2', title: 'Other work', kind: 'ue' });
  otherOrders.act('T2', 'queue');
  const r2 = otherOrders.runStart('T2', { worker: 'coder' }).run;
  otherOrders.runEnd('T2');
  otherOrders.act('T2', 'approve', { force: true });
  replaceRunUsage(otherCfg, r2.id, [
    makeUsageRow({ project: 'other', order: 'T2', run: r2.id, worker: 'coder', cost_usd: 26, at: r2.started }),
  ]);

  const single = await f.get('/api/usage/scorecard?project=demo&since=14d');
  assert.equal(single.status, 200);
  assert.deepEqual(single.body.projects, ['demo']);
  assert.equal(single.body.rows.length, 1);
  assert.equal(single.body.rows[0].runs, 1);
  assert.equal(single.body.rows[0].cost.usd, 14);

  const all = await f.get('/api/usage/scorecard?since=14d');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.projects, ['demo', 'other']);
  assert.equal(all.body.rows.length, 1);
  assert.equal(all.body.rows[0].runs, 2);
  assert.equal(all.body.rows[0].cost.usd, 40);
  assert.equal(all.body.rows[0].cost_per_accept, 20);

  assert.equal((await f.get('/api/usage/scorecard?project=missing')).status, 404);
  assert.equal((await f.get('/api/usage/scorecard?by=invalid')).status, 400);
  assert.equal((await f.get('/api/usage/scorecard?since=bad')).status, 400);
});

test('routing rank_by: validates config, preserves default byte-for-byte, ranks by acceptance and cost-per-accept, ties within thresholds, and explains included fallback', () => {
  // Config validation rejects bad values naming the key on both roles and routes
  assert.throws(
    () => validateRoles({ ue: { kinds: ['ue'], rank_by: 'cheapest' } }, 'alba.yaml'),
    /roles\.ue\.rank_by.*preference, acceptance or cost-per-accept/,
  );
  assert.throws(
    () => validateRouting({ groups: { main: ['codex'] }, routes: { ue: { kinds: ['ue'], group: 'main', rank_by: 'fastest' } } }, 'workers.yaml'),
    /routing\.routes\.ue\.rank_by.*preference, acceptance or cost-per-accept/,
  );

  const workers = validateWorkers({
    workers: [
      { id: 'dear-worker', engine: 'claude-cli', paid: true, launch: { program: 'x', args: [] } },
      { id: 'cheap-worker', engine: 'claude-cli', paid: true, launch: { program: 'x', args: [] } },
      { id: 'codex', engine: 'codex-cli', cost: 'included', launch: { program: 'x', args: [] } },
    ],
  }, 'workers.yaml').workers;

  const makeChoosable = (w: WorkerConfig, kindScore?: Choosable['scorecard']): Choosable => ({
    config: w,
    available: true,
    reasons: [],
    running: 0,
    runsToday: 0,
    ...(kindScore ? { scorecard: kindScore } : {}),
  });

  const poolPaid: Choosable[] = [
    makeChoosable(workers[0]!, { ue: { first_attempts: 11, first_pass_rate: 0.45, accepts: 4, cost_per_accept: 41 } }),
    makeChoosable(workers[1]!, { ue: { first_attempts: 10, first_pass_rate: 0.8, accepts: 5, cost_per_accept: 12 } }),
  ];

  // Default (absent) and explicit `preference` produce byte-for-byte identical route text
  const absentChoice = chooseWorker({ kind: 'ue', tags: [], role: { id: 'ue', prefer: ['dear-worker', 'cheap-worker'] } }, poolPaid);
  const prefChoice = chooseWorker({ kind: 'ue', tags: [], role: { id: 'ue', prefer: ['dear-worker', 'cheap-worker'], rank_by: 'preference' } }, poolPaid);
  assert.equal(absentChoice.chosen, 'dear-worker');
  assert.deepEqual(prefChoice, absentChoice);

  // `acceptance` picks higher first-pass rate over earlier preference
  const accChoice = chooseWorker({ kind: 'ue', tags: [], role: { id: 'ue', prefer: ['dear-worker', 'cheap-worker'], rank_by: 'acceptance' } }, poolPaid);
  assert.equal(accChoice.chosen, 'cheap-worker');
  assert.match(accChoice.why, /first pass 80% of 10 ue orders vs 45% of 11/);

  // `cost-per-accept` picks cheaper worker over earlier preference and cites $12 vs $41
  const costChoice = chooseWorker({ kind: 'ue', tags: [], role: { id: 'ue', prefer: ['dear-worker', 'cheap-worker'], rank_by: 'cost-per-accept' } }, poolPaid);
  assert.equal(costChoice.chosen, 'cheap-worker');
  assert.match(costChoice.why, /cost per accepted ue order \$12 vs \$41 \(5 and 4 accepted, 14 days\)/);
  assert.match(costChoice.candidates[1]!.reason, /\$12 vs \$41/);

  // A 15% cost difference ($100 vs $85) is a tie -> falls back to role preference (`dear-worker` first)
  const tiePool: Choosable[] = [
    makeChoosable(workers[0]!, { ue: { first_attempts: 5, first_pass_rate: 0.76, accepts: 4, cost_per_accept: 100 } }),
    makeChoosable(workers[1]!, { ue: { first_attempts: 5, first_pass_rate: 0.8, accepts: 4, cost_per_accept: 85 } }),
  ];
  const tieCost = chooseWorker({ kind: 'ue', tags: [], role: { id: 'ue', prefer: ['dear-worker', 'cheap-worker'], rank_by: 'cost-per-accept' } }, tiePool);
  assert.equal(tieCost.chosen, 'dear-worker');
  const tieAcc = chooseWorker({ kind: 'ue', tags: [], role: { id: 'ue', prefer: ['dear-worker', 'cheap-worker'], rank_by: 'acceptance' } }, tiePool);
  assert.equal(tieAcc.chosen, 'dear-worker');

  // One side included (`codex`) falls back with the exact reason
  const mixedPool: Choosable[] = [
    makeChoosable(workers[0]!, { ue: { first_attempts: 6, first_pass_rate: 0.5, accepts: 4, cost_per_accept: 41 } }),
    makeChoosable(workers[2]!, { ue: { first_attempts: 8, first_pass_rate: 0.75, accepts: 6 } }),
  ];
  const subFallback = chooseWorker({ kind: 'ue', tags: [], role: { id: 'ue', prefer: ['dear-worker', 'codex'], rank_by: 'cost-per-accept' } }, mixedPool);
  assert.equal(subFallback.chosen, 'dear-worker');
  assert.match(subFallback.why, /rank_by cost-per-accept: no dollar figure for codex \(included\)/);
  assert.match(subFallback.candidates[1]!.reason, /rank_by cost-per-accept: no dollar figure for codex \(included\)/);

  // End-to-end gather.ts: fills WorkerState.scorecard only when rank_by !== 'preference'
  const { orders, dir } = tempOrders();
  mkdirSync(path.join(dir, 'repo'), { recursive: true });
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const baseCfg = validateProject({
    id: 'demo',
    name: 'Demo',
    root: path.join(dir, 'repo'),
    work_orders: path.join(dir, 'orders'),
    state_dir: path.join(dir, 'state'),
  }, path.join(dir, 'alba.yaml'));
  const wfDefault = validateWorkers({
    routing: { groups: { main: ['dear-worker', 'cheap-worker'] }, routes: { ue: { kinds: ['ue'], group: 'main' } } },
    workers: [
      { id: 'dear-worker', engine: 'claude-cli', paid: true, launch: { program: 'x', args: [] } },
      { id: 'cheap-worker', engine: 'claude-cli', paid: true, launch: { program: 'x', args: [] } },
    ],
  }, 'workers.yaml');
  const wfCost = validateWorkers({
    routing: { groups: { main: ['dear-worker', 'cheap-worker'] }, routes: { ue: { kinds: ['ue'], group: 'main', rank_by: 'cost-per-accept' } } },
    workers: [
      { id: 'dear-worker', engine: 'claude-cli', paid: true, launch: { program: 'x', args: [] } },
      { id: 'cheap-worker', engine: 'claude-cli', paid: true, launch: { program: 'x', args: [] } },
    ],
  }, 'workers.yaml');

  orders.add({ tag: 'T1', title: 'Past dear', kind: 'ue' }); orders.act('T1', 'queue');
  const dr = orders.runStart('T1', { worker: 'dear-worker' }).run; orders.runEnd('T1'); orders.act('T1', 'approve', { force: true });
  replaceRunUsage(baseCfg, dr.id, [makeUsageRow({ project: 'demo', order: 'T1', run: dr.id, worker: 'dear-worker', cost_usd: 41, at: dr.started })]);

  orders.add({ tag: 'T2', title: 'Past cheap', kind: 'ue' }); orders.act('T2', 'queue');
  const cr = orders.runStart('T2', { worker: 'cheap-worker' }).run; orders.runEnd('T2'); orders.act('T2', 'approve', { force: true });
  replaceRunUsage(baseCfg, cr.id, [makeUsageRow({ project: 'demo', order: 'T2', run: cr.id, worker: 'cheap-worker', cost_usd: 12, at: cr.started })]);

  writeFileSync(path.join(dir, 'orders', 'T3.md'), '# T3\n\n## Acceptance\n- pass\n', 'utf8');
  orders.add({ tag: 'T3', title: 'Next order', kind: 'ue' }); orders.act('T3', 'queue');

  const probes = { ...systemProbes, now: () => new Date(Date.parse(cr.started) + 3600_000), freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}) };
  const tDefault = tick(baseCfg, orders, wfDefault, probes, { record: false });
  assert.equal(tDefault.workers[0]!.scorecard, undefined);
  assert.equal(tDefault.report.moves[0]?.worker, 'dear-worker');

  const tCost = tick(baseCfg, orders, wfCost, probes, { record: false });
  assert.notEqual(tCost.workers[0]!.scorecard, undefined);
  assert.equal(tCost.report.moves[0]?.worker, 'cheap-worker');
  assert.match(tCost.report.moves[0]?.why ?? '', /\$12 vs \$41/);
});
