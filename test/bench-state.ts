// Run directly with Node 24+: node --disable-warning=ExperimentalWarning test/bench-state.ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Orders } from '../src/orders/service.ts';
import { FileStore, withRevision } from '../src/orders/store.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { stateStore, closeStateStores } from '../src/orders/backend.ts';
import { validateProject } from '../src/config.ts';
import { appendStateFile } from '../src/orders/state-files.ts';
import { tick, type Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import type { OrderDoc, OrderEvent } from '../src/orders/model.ts';
import type { QuotaReading } from '../src/workers/quota.ts';
import { tmpDir } from './tmp.ts';

const root = tmpDir('alba-bench-');
const measure = (run: () => unknown) => {
  run();
  const samples = Array.from({ length: 15 }, () => { const start = performance.now(); run(); return performance.now() - start; });
  return Number(samples.sort((a, b) => a - b)[7].toFixed(3));
};
const at = '2026-01-01T00:00:00.000Z';
const docs: OrderDoc[] = Array.from({ length: 500 }, (_, i) => ({ version: 1, order: { tag: `T${i}`, title: `Synthetic order ${i}`, kind: 'sim', needs: [], created: at, updated: at }, runs: [], actions: [], reports: [] }));
const events: OrderEvent[] = Array.from({ length: 20_000 }, (_, i) => ({ at, tag: `T${i % 500}`, type: 'synthetic', data: { i } }));
const history: QuotaReading[] = [];
let bytes = 0;
while (bytes < 1024 * 1024) {
  const n = history.length;
  const q: QuotaReading = { source: `q${n % 4}`, at: new Date(Date.parse(at) + n * 60_000).toISOString(), ok: true, windows: [{ name: 'hours', usedPercent: n % 100 }], entries: 1, balance: { raw: '1000 credits', amount: 1000 } };
  bytes += Buffer.byteLength(JSON.stringify(q) + '\n'); history.push(q);
}
const workers = validateWorkers({ workers: Array.from({ length: 4 }, (_, i) => ({ id: `w${i}`, engine: 'x', quota: `q${i}` })), quota_sources: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`q${i}`, { type: 'static', windows: [], balance: '999 credits' }])) }, 'workers.yaml');
let ticks = 0;
const probes = { now: () => new Date(Date.parse(history.at(-1)!.at) + (++ticks) * 60_000), worktrees: () => [] } as unknown as Probes;
const results = [];
try {
  for (const backend of ['files', 'sqlite'] as const) {
    const dir = path.join(root, backend); mkdirSync(dir);
    const store = backend === 'files' ? new FileStore(dir) : new SqliteStore(dir);
    if (store instanceof SqliteStore) store.transaction(() => { for (const doc of docs) store.write(withRevision(structuredClone(doc), 0)); for (const event of events) store.appendEvent(event); });
    else {
      for (const doc of docs) writeFileSync(path.join(dir, `${doc.order.tag}.json`), JSON.stringify({ ...doc, _storeVersion: 1 }, null, 2) + '\n');
      writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
    }
    const orders = new Orders(store);
    const all = measure(() => orders.all());
    const stages = measure(() => { const list = orders.all(); const merged = orders.mergedSet(list); return list.map(doc => orders.stage(doc, merged)); });
    const recentEvents = measure(() => store.events({ limit: 200 }));
    let doc = store.read('T0')!;
    const write = measure(() => { doc.order.updated = new Date().toISOString(); store.write(doc); });
    const quotaDir = path.join(root, `${backend}-quota`);
    const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: root, state_dir: quotaDir, state: { backend } }, path.join(root, 'alba.yaml'));
    const quotaOrders = new Orders(stateStore(project));
    appendStateFile(project, 'quota-history.jsonl', history.map(q => JSON.stringify(q) + '\n').join(''));
    const quotaTick = measure(() => tick(project, quotaOrders, workers, probes, { record: true }));
    results.push({ backend, all, stages, events: recentEvents, write, quotaTick });
    if (store instanceof SqliteStore) store.close();
  }
  console.log(JSON.stringify({ node: process.version, statistic: 'median of 15 warm samples', orders: 500, events: 20000, quotaBytes: bytes, quotaRows: history.length, quotaSources: 4, results }, null, 2));
} finally { closeStateStores(); rmSync(root, { recursive: true, force: true }); }
