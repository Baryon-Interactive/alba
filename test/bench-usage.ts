// Actual CLI process timing, including startup and reading 20,000 ledger rows, with both stores.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { stateStore } from '../src/orders/backend.ts';
import { withRevision, revisionOf } from '../src/orders/store.ts';
import type { UsageRow } from '../src/usage/types.ts';

const root = path.resolve('.alba/evidence/usage-bench'); mkdirSync(root, { recursive: true });
const rows: UsageRow[] = Array.from({ length: 20000 }, (_, i) => ({ project: 'sample', order: `T${i % 200}`, run: 'r1', turn: Math.floor(i / 200) + 1, at: new Date().toISOString(), worker: `w${i % 4}`, engine: 'codex-cli', model: 'example', source: 'codex-json', kind: ['sim', 'research', 'merge'][(i % 200) % 3], total_tokens: 1100, input_tokens: 1000, cached_tokens: 600, output_tokens: 100, rework: false, resume: false, open: false, merged: false, ...(i < 200 ? { signals: [], signal_rules: '{}' } : {}) }));
const timings: { backend: string; by: string; ms: number; tokens: number }[] = [];
for (const backend of ['files', 'sqlite'] as const) {
  const stateDir = path.join(root, backend); mkdirSync(stateDir, { recursive: true });
  const store = stateStore({ state_dir: stateDir, state: { backend } });
  store.writeMeta('usage', rows);
  store.transaction(() => { for (let i = 0; i < 200; i++) {
    const tag = `T${i}`, at = rows[0].at;
    store.write(withRevision({ version: 1, order: { tag, title: 'Synthetic usage order', kind: ['sim', 'research', 'merge'][i % 3], needs: [], created: at, updated: at }, runs: [{ id: 'r1', seq: 1, worker: `w${i % 4}`, engine: 'codex-cli', model: 'example', started: at, ended: at }], actions: [], reports: [] }, revisionOf(store.read(tag) ?? {} as never)));
  } });
  const file = path.join(root, `${backend}.yaml`);
  writeFileSync(file, `id: sample\nname: Sample\nroot: .\nwork_orders: .\nstate_dir: ${backend}\nstate: { backend: ${backend} }\n`);
  for (const by of ['day', 'worker', 'project', 'order', 'kind']) {
    const start = performance.now();
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/main.ts', 'usage', '--project', file, '--since', '7d', '--by', by, '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const ms = performance.now() - start;
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.total.tokens, report.rows.reduce((n: number, r: { tokens: number }) => n + r.tokens, 0));
    assert.equal(report.total.tokens, 22000000);
    timings.push({ backend, by, ms: Math.round(ms * 100) / 100, tokens: report.total.tokens });
    assert.ok(ms < 1000, `${backend}/${by} took ${ms.toFixed(1)} ms`);
  }
}
writeFileSync(path.join(root, 'timing.json'), JSON.stringify({ rows: rows.length, timings }, null, 2));
console.log(JSON.stringify(timings));
