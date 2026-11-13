// node --disable-warning=ExperimentalWarning test/bench-overview.ts [--serve]
// Synthetic local data only; generated files stay under ignored .alba/evidence.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { withRevision } from '../src/orders/store.ts';
import type { OrderDoc } from '../src/orders/model.ts';
import { createBoard } from '../src/web/server.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { writeStateFile } from '../src/orders/state-files.ts';

const dir = path.resolve('.alba/evidence');
mkdirSync(dir, { recursive: true });
const now = new Date();
const at = (hours: number) => new Date(now.getTime() - hours * 3600000).toISOString();
const config = (id: string, name: string) => validateProject({ id, name, root: dir, work_orders: dir, state_dir: path.join(dir, id), dispatch: { min_free_ram_gb: 4, stall_minutes: 120 }, ...(id === 'busy' ? { resources: { 'build-lane': { slots: 3, lease_minutes: 60 } } } : {}) }, path.join(dir, `${id}.yaml`));
const busy = config('busy', 'Demo workshop');
const empty = config('empty', 'Next project');
const store = stateStore(busy) as SqliteStore;
store.db.exec('DELETE FROM orders; DELETE FROM events');
store.transaction(() => {
  for (let i = 0; i < 500; i++) {
    const started = at(i < 8 ? .5 + i / 10 : 48 + i % 10);
    const ended = at(i % 14 * 24 + 1);
    const doc: OrderDoc = { version: 1, order: { tag: `T${i}`, title: ['Improve the playable demo', 'Build the next scene', 'Review the new controls', 'Polish the map transitions'][i % 4], kind: 'sim', needs: [], created: at(500), updated: started }, runs: [], reports: [], actions: [{ seq: 1, kind: 'queue', at: at(500) }] };
    if (i < 8) {
      doc.order.worktree = path.join(dir, `tree-${i}`);
      doc.runs.push({ id: 'r1', seq: 2, worker: i % 2 ? 'coder' : 'reviewer', started });
    }
    else if (i < 470) {
      doc.runs.push({ id: 'r1', seq: 2, worker: 'coder', started: at(490), ended, outcome: i % 7 ? 'completed' : 'failed', usage: { source: 'unknown', cost_usd: .02 } });
      if (i % 7 === 0) doc.actions.push({ seq: 3, kind: 'rework', at: ended, note: 'Refine the result' });
      doc.actions.push({ seq: 4, kind: 'approve', at: ended });
    } else if (i < 474) {
      doc.runs.push({ id: 'r1', seq: 2, worker: 'coder', started, ended: at(.1), outcome: 'completed' });
      doc.reports.push({ seq: 3, at: at(.1), status: i < 472 ? 'waiting' : 'ready', summary: 'Ready for the next decision', ...(i < 472 ? { question: 'Which control layout should we use?' } : {}), evidence: [], commits: [] });
    } else if (i === 474) {
      doc.runs.push({ id: 'r1', seq: 2, worker: 'coder', started, ended: at(.1), outcome: 'completed' });
      doc.reports.push({ seq: 3, at: at(.1), status: 'monitoring', summary: 'Build running', monitor: { check: ['node', '--version'], done_when: { exit_code: 0 }, deadline_minutes: 180 }, evidence: [], commits: [] });
      doc.monitor = { report_seq: 3, started: at(.1), deadline: new Date(now.getTime() + 7200000).toISOString(), checks: 5, last_at: at(.02), last_result: 'waiting' };
    }
    store.write(withRevision(doc, 0));
  }
  for (let i = 0; i < 20000; i++) store.appendEvent({ at: at(1), tag: `T${i % 500}`, type: 'synthetic' });
});
writeStateFile(busy, '_leases.json', JSON.stringify({ leases: [{ resource: 'build-lane', tag: 'T0', run: 'r1', since: at(1), expires: at(-1) }] }));
const workers = validateWorkers({ quota_sources: { shared: { type: 'static', windows: [{ name: 'weekly', used_percent: 64, usedPercent: 64, resets_at: at(-48), resetsAt: at(-48) }], balance: '120 credits' } }, workers: [
  { id: 'coder', engine: 'x', quota: 'shared', concurrency: 6, daily_runs: 40, daily_cap_usd: 10, launch: { program: 'synthetic', args: [] } },
  { id: 'reviewer', engine: 'x', quota: 'shared', concurrency: 6, daily_runs: 40, launch: { program: 'synthetic', args: [] } },
  { id: 'editor', engine: 'claude-session', enabled: false },
] }, 'synthetic.yaml');
store.appendQuotaReading({ source: 'shared', at: at(24.1), ok: true, windows: [], balance: { raw: '125 credits', amount: 125 }, entries: 1 });
const probes = { now: () => new Date(), runCommand: () => '[]', freeRamGb: () => 24, worktrees: () => [],
  gitActivity: (tree: string) => ({ lastCommitAt: at(.1 + Number(path.basename(tree).replace('tree-', '')) / 10) }),
  fileTime: (file: string) => file.endsWith('.progress.json') ? at(.01) : undefined,
  isAlive: () => true, tail: () => '', readText: () => JSON.stringify({ plan: [{ step: 'Read', status: 'done' }, { step: 'Implement', status: 'done' }, { step: 'Verify', status: 'doing' }, { step: 'Document', status: 'todo' }] }),
} as unknown as Probes;
const board = createBoard({ projects: [busy, empty], workers, probes, port: 0, loop: () => ({ everyMinutes: 15, lastTickAt: at(.05) }) });
await new Promise<void>(resolve => board.server.once('listening', resolve));
const base = `http://127.0.0.1:${(board.server.address() as AddressInfo).port}`;
if (process.argv.includes('--serve')) {
  writeFileSync(path.join(dir, 'fixture-url.txt'), base);
  console.log('Serving the synthetic Overview fixture until stopped.');
} else {
  const samples: number[] = [];
  let payload: any;
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    const response = await fetch(`${base}/api/overview/all`, { headers: { 'x-alba-token': board.ctx.token } });
    assert.equal(response.status, 200, await response.clone().text());
    payload = await response.json();
    if (i) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const report = { orders: 500, events: 20000, backend: 'sqlite', samples: samples.length, medianMs: Number(samples[10].toFixed(2)), p95Ms: Number(samples[18].toFixed(2)), maxMs: Number(samples[19].toFixed(2)) };
  writeFileSync(path.join(dir, 'overview-timing.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(dir, 'overview-fixture.json'), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ ...report, url: base }));
  assert.ok(report.p95Ms < 200, `p95 ${report.p95Ms} ms exceeds 200 ms`);
  board.hub.stop(); board.server.closeAllConnections(); board.server.close();
}
