import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadProject } from '../../src/config.ts';
import { Orders } from '../../src/orders/service.ts';
import { stateStore } from '../../src/orders/backend.ts';
import { loadWorkers } from '../../src/workers/config.ts';
import { createBoard } from '../../src/web/server.ts';
import type { Probes } from '../../src/tick/gather.ts';

/** Synthetic supply and jobs, isolated inside this worktree. Never invokes an engine. */
export function workerRoleFixture() {
  const parent = path.resolve('.alba/TASK47'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, 'fixture-'));
  mkdirSync(path.join(dir, 'orders')); mkdirSync(path.join(dir, 'rules'));
  const file = path.join(dir, 'alba.yaml'), workersFile = path.join(dir, 'workers.yaml');
  writeFileSync(file, `id: demo
name: Demo studio
root: .
work_orders: orders
state_dir: state
state: { backend: files }
workers: workers.yaml
roles:
  builder:
    description: Build and verify project changes
    kinds: [build]
    requires: [shell, edit, git]
    rules: rules/build.md
    skills: [alba-worker-rules]
    effort: high
    workers: { prefer: [included, visual], avoid: [offline] }
  visual:
    description: Inspect and revise visual work
    kinds: [art]
    requires: [vision, mcp]
    workers: { prefer: [visual-family], only: [visual] }
    mcp:
      image: { command: fixture-image-server, args: [--stdio] }
  default:
    description: General work with no matching kind
    requires: [shell]
    workers: { prefer: [included] }
  no-supply:
    description: Requires unavailable hardware
    requires: [hardware-encoder]
`);
  writeFileSync(path.join(dir, 'rules/build.md'), 'Run the project checks and attach the output before delivery.\n');
  writeFileSync(workersFile, `workers:
  - id: included
    engine: codex-cli
    model: example-coder
    route: subscription
    capabilities: [shell, edit, git, mcp, long-run, cheap]
    cost: included
    concurrency: 2
    daily_runs: 12
    max_tokens_per_run: 200000
    notes: Included weekly window; two simultaneous sessions.
    launch: { program: fixture-engine-never-run, args: ['{prompt_file}'] }
  - id: visual
    engine: claude-cli
    model: example-visual
    model_family: visual-family
    aliases: [pictures]
    route: direct
    capabilities: [shell, edit, git, vision, mcp, long-context]
    cost: paid
    concurrency: 1
    daily_cap_usd: 10
    notes: Separate paid balance with a daily spend cap.
    price: { input_per_mtok: 1, output_per_mtok: 5 }
    launch: { program: fixture-engine-never-run, args: ['{prompt_file}'] }
  - id: offline
    engine: opencode
    capabilities: [shell, edit, git]
    enabled: false
    notes: Temporarily disabled for maintenance.
`);
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
  const project = loadProject(file), workers = loadWorkers(workersFile), orders = new Orders(stateStore(project));
  for (const [tag, kind, role] of [['DEMO1', 'build', undefined], ['DEMO2', 'art', undefined], ['DEMO3', 'misc', undefined], ['DEMO4', 'misc', 'no-supply']] as const) {
    orders.add({ tag, title: `Synthetic ${kind} task`, kind, ...(role ? { role } : {}) }); orders.act(tag, 'queue');
  }
  for (let i = 0; i < 3; i++) {
    const tag = `HISTORY${i}`;
    orders.add({ tag, title: 'Synthetic reviewed build', kind: 'build' }); orders.act(tag, 'queue');
    orders.runStart(tag, { worker: 'included', extra: { role: 'builder', role_source: 'kind', usage: { source: 'unknown', total_tokens: 1000 + i * 100 } } });
    orders.runEnd(tag); orders.report(tag, { status: 'ready', summary: 'Synthetic delivery', evidence: [], commits: [] });
    orders.act(tag, i === 2 ? 'rework' : 'approve', { note: 'Synthetic review' });
  }
  const probes = { now: () => new Date(), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => { throw new Error('Fixture forbids launching models.'); } } as unknown as Probes;
  return { dir, file, workersFile, project, workers, orders, probes };
}

export async function workerRoleBoard() {
  const fixture = workerRoleFixture();
  const board = createBoard({ projects: [fixture.project], workers: fixture.workers, probes: fixture.probes, port: 0, uiDir: path.resolve('ui/dist'), hubCheckMs: 100000 });
  await new Promise<void>(resolve => board.server.once('listening', resolve));
  const address = board.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return { ...fixture, base: `http://127.0.0.1:${address.port}`, close: () => { board.hub.stop(); board.server.closeAllConnections(); board.server.close(); } };
}
