/** Synthetic console fixture. Build UI first, then run with Node. Never dispatches or starts a model. */
import { copyFileSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateProject } from '../../src/config.ts';
import { stateStore } from '../../src/orders/backend.ts';
import { withRevision, revisionOf } from '../../src/orders/store.ts';
import { Orders } from '../../src/orders/service.ts';
import { writeStateFile } from '../../src/orders/state-files.ts';
import type { OrderDoc } from '../../src/orders/model.ts';
import { createBoard } from '../../src/web/server.ts';
import { validateWorkers } from '../../src/workers/config.ts';
import type { Probes } from '../../src/tick/gather.ts';
import { collectUsage } from '../../src/usage/accounting.ts';

const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, '.alba/evidence/console-design');
const now = new Date();
const at = (minutes: number) => new Date(now.getTime() - minutes * 60000).toISOString();
for (const folder of ['orders', 'evidence', 'picks']) mkdirSync(path.join(dir, folder), { recursive: true });
for (const name of ['a', 'b']) copyFileSync(path.join(root, `docs/img/${name === 'a' ? 'console' : 'board'}.png`), path.join(dir, `evidence/preview-${name}.png`));
writeFileSync(path.join(dir, 'evidence/checks.txt'), 'Synthetic evidence: interface and interaction checks passed.\n');
writeFileSync(path.join(dir, 'picks/style.yaml'), JSON.stringify({ id: 'demo-style', title: 'Workspace layout choice', options: [{ key: 'a', label: 'Compact layout', images: ['evidence/preview-a.png'] }, { key: 'b', label: 'Spacious layout', images: ['evidence/preview-b.png'] }] }));
const config = validateProject({ id: 'console-demo', name: 'Demo studio', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), state: { backend: 'files' },
  dispatch: { caps: { ue: 6, web: 4 }, min_free_ram_gb: 4 }, picks: { dir: 'picks' },
  resources: { build: { slots: 6 } }, producer: { enabled: true, session: { enabled: false } },
}, path.join(dir, 'alba.yaml'));
const workers = validateWorkers({ quota_sources: {
  demo: { type: 'static', windows: [{ name: 'Five hours', used_percent: 38, resets_at: at(-180) }, { name: 'Weekly', used_percent: 67, resets_at: at(-2880) }] },
  shared: { type: 'static', windows: [{ name: 'Weekly', used_percent: 92, resets_at: at(-1440) }] },
}, workers: [
  { id: 'worker-a', engine: 'codex-cli', concurrency: 3, quota: 'demo', cost: 'included', launch: { program: 'synthetic', args: [] } },
  { id: 'worker-b', engine: 'codex-cli', concurrency: 3, quota: 'shared', cost: 'included', launch: { program: 'synthetic', args: [] } },
] }, 'synthetic-workers.yaml');
const store = stateStore(config);
store.transaction(() => {
  for (let i = 1; i <= 46; i++) {
    const tag = `DEMO${String(i).padStart(2, '0')}`;
    const titles = ['Improve combat feedback and hit indicators', 'Improve character movement and camera follow', 'Check save recovery and boundary conditions', 'Build the task list and tracking interface'];
    const doc: OrderDoc = { version: 1, order: { tag, title: titles[(i - 1) % titles.length], kind: i % 2 ? 'ue' : 'web', needs: i === 13 ? ['DEMO30'] : [], created: at(10080), updated: at(i), ...(i <= 6 ? { branch: `demo-${i}`, worktree: path.join(dir, `work-${i}`) } : {}) }, runs: [], actions: [], reports: [] };
    const historical = i >= 16 && i <= 23 ? (i - 16) * 1440 : 0;
    const addRun = (open = false) => { doc.actions.push({ seq: 1, kind: 'queue', at: at(historical + 240) }); doc.runs.push({ id: 'r1', seq: 2, worker: i % 2 ? 'worker-a' : 'worker-b', engine: 'codex-cli', started: at(historical + 90 + i * 5), ...(open ? { pid: 10000 + i } : { ended: at(historical + 15), outcome: 'completed' as const }), usage: { source: 'codex-json', input_tokens: 10000 * i, output_tokens: 2000 * i, total_tokens: 12000 * i } }); };
    const report = (status: 'ready' | 'waiting' | 'blocked' | 'failed' | 'dropped' | 'monitoring') => doc.reports.push({ seq: 3, at: at(10), status, summary: status === 'ready' ? 'Finished interface changes; interaction and both theme checks passed. Review the screenshots.' : status === 'failed' ? 'Build checks failed; dispatch a repair.' : status === 'blocked' ? 'Waiting for dependent resources; confirm the next steps.' : status === 'dropped' ? 'The approach no longer applies; awaiting reassignment.' : 'Waiting for the next step.', ...(status === 'waiting' ? { question: 'Prioritize combat feedback or task tracking?' } : {}), evidence: status === 'ready' ? ['evidence/preview-a.png', 'evidence/preview-b.png', 'evidence/checks.txt'] : [], commits: status === 'ready' ? ['abc1234', 'def5678'] : [], ...(status === 'monitoring' ? { monitor: { check: ['node', '--version'], done_when: { exit_code: 0 }, deadline_minutes: 120 } } : {}) });
    if (i <= 4) {
      addRun(true);
      writeFileSync(path.join(dir, 'orders', `${tag}.progress.json`), JSON.stringify({ plan: [{ step: 'Read the order and existing implementation', status: 'done' }, { step: titles[(i - 1) % titles.length], status: 'doing' }, { step: 'Run checks and deliver', status: 'todo' }], note: 'Implementing and validating the current step.' }));
      utimesSync(path.join(dir, 'orders', `${tag}.progress.json`), new Date(at(i)), new Date(at(i)));
    } else if (i <= 6) { addRun(); report('ready'); }
    else if (i <= 11) { addRun(); report((['waiting', 'blocked', 'failed', 'dropped', 'monitoring'] as const)[i - 7]); }
    else if (i === 12) addRun();
    else if (i === 13 || (i >= 24 && i <= 29)) doc.actions.push({ seq: 1, kind: 'queue', at: at(30) });
    else if (i === 14 || i >= 44) doc.actions.push({ seq: 1, kind: 'hold', at: at(30) });
    else if (i === 15) doc.actions.push({ seq: 1, kind: 'cancel', at: at(30) });
    else if (i >= 16 && i <= 23) { addRun(); report('ready'); doc.actions.push({ seq: 4, kind: 'approve', at: at((i - 15) * 1440 - 30) }); }
    if (i === 30) doc.quotes = [{ id: 'demo-quote', service: 'Test asset generation', unit: 'credits', cap_requested: 20, created: at(10), by: 'fixture', status: 'pending', ledger: [] }];
    if (i === 11) doc.monitor = { report_seq: 3, started: at(60), deadline: at(-60), checks: 8, last_at: at(5), last_result: 'waiting' };
    store.write(withRevision(doc, revisionOf(store.read(tag) ?? {} as never)));
  }
});
writeStateFile(config, '_producer-session.json', JSON.stringify({ state: 'stopped', turns: 0, usage: {} }));
const noExternal = () => { throw new Error('Synthetic fixture cannot dispatch or run commands.'); };
const read = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } };
const probes = { now: () => now, isAlive: () => true, tail: (file: string) => read(file) ?? '', head: (file: string) => read(file) ?? '', readText: read, fileTime: (file: string) => { try { return statSync(file).mtime.toISOString(); } catch { return undefined; } },
  runCommand: noExternal, freeRamGb: () => 32, worktrees: () => [], gitActivity: (worktree: string) => ({ lastCommitAt: at(worktree.endsWith('work-1') ? 70 : worktree.endsWith('work-2') ? 50 : 12), dirtyFiles: 1 }), spawnDetached: noExternal,
} as unknown as Probes;
collectUsage(config, new Orders(store).all(), workers, probes);
const board = createBoard({ projects: [config], workers, port: 0, probes, uiDir: path.join(root, 'ui/dist') });
board.server.on('listening', () => {
  const url = `http://127.0.0.1:${(board.server.address() as { port: number }).port}`;
  writeFileSync(path.join(dir, 'url.txt'), url);
  writeFileSync(path.join(dir, 'server.pid'), String(process.pid));
  // the sign-in link: it carries this fixture's key and goes on to the page
  console.log(`${url}/login?key=${board.ctx.token}&next=${encodeURIComponent('/p/console-demo')}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { board.hub.stop(); board.server.closeAllConnections(); board.server.close(); });
