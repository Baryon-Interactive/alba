// Synthetic screenshot fixture. Run after ui:build; Ctrl+C ends the local server.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { validateProject } from '../src/config.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { withRevision, revisionOf } from '../src/orders/store.ts';
import { Orders } from '../src/orders/service.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { collectUsage } from '../src/usage/accounting.ts';
import { createBoard } from '../src/web/server.ts';
import type { OrderDoc } from '../src/orders/model.ts';

const dir = path.resolve('.alba/evidence/usage-console'); mkdirSync(dir, { recursive: true });
const now = new Date(), at = (hours: number) => new Date(now.getTime() - hours * 3600000).toISOString();
const workers = validateWorkers({ pricing: { 'sample-model': { input_per_mtok: 2, cached_input_per_mtok: .5, output_per_mtok: 8, currency: 'USD' } }, quota_sources: { subscription: { type: 'static', windows: [{ name: 'weekly', used_percent: 38, resets_at: at(-48) }] } }, workers: [
  { id: 'coder', engine: 'codex-cli', concurrency: 6, cost: 'paid', launch: { program: 'synthetic', model: 'sample-model', args: [] } },
  { id: 'reviewer', engine: 'opencode', concurrency: 6, cost: 'included', quota: 'subscription', launch: { program: 'synthetic', model: 'sample-model', args: [] } },
  { id: 'editor', engine: 'claude-session', cost: 'included' },
] }, 'example-workers.yaml');
const projects = ['workshop', 'sandbox'].map((id, projectIndex) => {
  const config = validateProject({ id, name: projectIndex ? 'Sandbox' : 'Demo workshop', root: dir, work_orders: dir, state_dir: path.join(dir, id), usage_warnings: { tokens_without_commit: 1000000 }, budget: { tokens_per_order: 4000000 } }, path.join(dir, `${id}.yaml`));
  const store = stateStore(config);
  store.transaction(() => {
    for (let i = 1; i <= 12; i++) {
      const tag = `T${i}`, merged = i > 6, started = at(i > 3 ? i * 8 : 1), ended = at(i * 4);
      const worker = i % 3 === 0 ? 'reviewer' : 'coder', kind = ['sim', 'research', 'merge'][i % 3];
      const file = path.join(dir, `${id}-${tag}-r1.events.jsonl`);
      writeFileSync(file, Array.from({ length: 18 }, (_, turn) => JSON.stringify({ type: 'turn.completed', alba_at: at((i > 3 ? i * 8 : .5) + turn / 100), usage: { input_tokens: (100000 + i * 10000) / (projectIndex + 1), cached_input_tokens: (60000 + i * 7000) / (projectIndex + 1), output_tokens: 8000 + i * 1000, reasoning_output_tokens: i % 3 === 0 ? 8500 : 2000, cache_write_input_tokens: 0 } })).join('\n') + '\n');
      const doc: OrderDoc = { version: 1, order: { tag, title: ['Build the playable demo', 'Review simulation behavior', 'Merge the next milestone'][i % 3], kind, needs: [], created: at(180), updated: started }, runs: [{ id: 'r1', seq: 2, worker, engine: 'codex-cli', model: 'sample-model', started, events_file: file, ...(i > 3 ? { ended, outcome: 'completed' as const } : {}) }], actions: [{ seq: 1, kind: 'queue', at: at(180) }], reports: [] };
      if (i === 2 || i === 7) {
        doc.runs[0].ended = at(2); doc.runs[0].outcome = 'completed';
        doc.actions.push({ seq: 3, kind: 'rework', at: at(1.5), note: 'Refine the simulation' });
        const second = path.join(dir, `${id}-${tag}-r2.events.jsonl`);
        writeFileSync(second, JSON.stringify({ type: 'turn.completed', alba_at: at(.2), usage: { input_tokens: 1600000, cached_input_tokens: 1400000, output_tokens: 100000, reasoning_output_tokens: 20000 } }) + '\n');
        doc.runs.push({ id: 'r2', seq: 4, worker, model: 'sample-model', engine: 'codex-cli', started: at(1), events_file: second, ...(merged ? { ended: at(.1), outcome: 'completed' as const } : {}) });
      }
      if (merged) { doc.actions.push({ seq: 6, kind: 'approve', at: at(.1 + i / 10) }); doc.reports.push({ seq: 5, at: ended, status: 'ready', summary: 'Synthetic verification complete', commits: [], evidence: [] }); }
      store.write(withRevision(doc, revisionOf(store.read(tag) ?? {} as never)));
    }
  });
  collectUsage(config, new Orders(store).all(), workers, systemProbes);
  return config;
});
const board = createBoard({ projects, workers, port: 0, probes: { ...systemProbes, freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), isAlive: () => true } });
await new Promise<void>(resolve => board.server.once('listening', resolve));
writeFileSync(path.join(dir, 'url.txt'), `http://127.0.0.1:${(board.server.address() as AddressInfo).port}`);
writeFileSync(path.join(dir, 'sign-in.txt'), `http://127.0.0.1:${(board.server.address() as AddressInfo).port}/login?key=${board.ctx.token}`);
console.log('Synthetic Usage console is ready (sign-in.txt has the sign-in link).');
