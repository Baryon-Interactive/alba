import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { loadProject } from '../../src/config.ts';
import { stateStore } from '../../src/orders/backend.ts';
import { Orders } from '../../src/orders/service.ts';
import { loadWorkers } from '../../src/workers/config.ts';
import { executeTick } from '../../src/tick/execute.ts';
import { systemProbes } from '../../src/tick/gather.ts';
import { approve } from '../../src/run/review.ts';
import { createBoard } from '../../src/web/server.ts';
import { addShowcase } from './showcase.ts';

/** Real dispatch, detached script, report ingestion, review and HTTP console on a disposable repository. */
export async function runDemo(options: { checkEnvironment?: boolean; showcase?: boolean } = {}): Promise<{ directory: string; revision: string }> {
  const temporaryRoot = path.resolve(import.meta.dirname, '../../.alba/demo');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(path.join(temporaryRoot, 'alba-demo-'));
  const root = path.join(directory, 'project');
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Demo');
  git('config', 'user.email', 'demo@example.test');
  copyFileSync(new URL('./worker.mjs', import.meta.url), path.join(root, 'worker.mjs'));
  writeFileSync(path.join(root, '.gitignore'), '.alba/\norders/\n');
  for (const file of ['alba.yaml', 'workers.yaml']) copyFileSync(new URL('./' + file, import.meta.url), path.join(root, file));
  git('add', '.'); git('commit', '-m', 'Initialize the demo project');
  mkdirSync(path.join(root, 'orders'));
  const project = loadProject(path.join(root, 'alba.yaml'));
  mkdirSync(project.work_orders, { recursive: true });
  writeFileSync(path.join(project.work_orders, 'DEMO1-greeting.md'), '# DEMO1\n\nCreate greeting.txt containing Hello from Alba!, commit it, and report the revision.\n');
  const orders = new Orders(stateStore(project));
  const workers = loadWorkers(path.join(root, 'workers.yaml'));
  if (options.checkEnvironment) {
    workers.workers[0]!.launch!.args.push('--check-environment');
    workers.workers[0]!.launch!.env.ALBA_DEMO_EXPLICIT = 'explicit';
    workers.workers[0]!.launch!.env_unset.push('DEMO_REMOVE');
  }
  orders.add({ tag: 'DEMO1', title: 'Create the demo greeting', kind: 'task', role: 'local' });
  orders.act('DEMO1', 'queue');
  const ctx = { project, orders, workers, probes: systemProbes };
  executeTick(ctx, { maxDispatch: 1 });
  assert.equal(orders.stage(orders.get('DEMO1')).stage, 'running');
  const deadline = Date.now() + 90_000;
  while (orders.stage(orders.get('DEMO1')).stage === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    executeTick(ctx, { maxDispatch: 0 });
  }
  const delivered = orders.get('DEMO1');
  assert.equal(orders.stage(delivered).stage, 'awaiting-review', JSON.stringify({ directory, runs: delivered.runs, reports: delivered.reports, files: delivered.runs.flatMap(run => [run.log, run.last_file]).filter((file): file is string => !!file).map(file => ({ file, ...(existsSync(file) ? { modified: statSync(file).mtime.toISOString(), text: readFileSync(file, 'utf8').slice(-4000) } : { missing: true }) })) }, null, 2));
  assert.notEqual(delivered.order.worktree, root);
  assert.equal(readFileSync(path.join(delivered.order.worktree!, 'greeting.txt'), 'utf8'), 'Hello from Alba!\n');
  assert.equal(git('status', '--porcelain'), '');
  git('merge', '--ff-only', delivered.order.branch!);
  approve(project, orders, 'DEMO1', 'Reviewed the committed greeting.');
  assert.equal(orders.stage(orders.get('DEMO1')).stage, 'merged');
  if (options.showcase) addShowcase(project, orders);
  const board = createBoard({ projects: [project], workers, port: 0, probes: systemProbes, background: false, snapshotTtlMs: 0 });
  if (!board.server.listening) await once(board.server, 'listening');
  try {
    const address = board.server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    // A program proves itself with the console key (a browser signs in with the link alba serve prints).
    const headers = { 'x-alba-token': board.ctx.token };
    const detail = await (await fetch(`${base}/api/orders/DEMO1?project=demo`, { headers })).json() as { stage: string };
    assert.equal(detail.stage, 'merged');
    const page = await (await fetch(`${base}/legacy/o/demo/DEMO1`, { headers })).text();
    assert.ok(page.includes('DEMO1') && page.includes('merged'));
  } finally {
    board.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => board.server.close(error => error ? reject(error) : resolve()));
  }
  return { directory, revision: git('rev-parse', 'HEAD') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  console.log(JSON.stringify(await runDemo(), null, 2));
}
