import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateProject } from './state-helper.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

export const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A real temporary repository plus a project configuration for it. */
export function fixture(extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  writeFileSync(path.join(workOrders, 'T1-do-something.md'), '# T1\nDo something.\n');
  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main', stall_minutes: 60, ...extra },
  }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Do something', kind: 'sim' });
  orders.act('T1', 'queue');
  return { orders, dir, root, project, workOrders };
}

export function probes(over: Partial<Probes> = {}): Probes & { spawned: { program: string; args: string[]; cwd: string }[] } {
  const spawned: { program: string; args: string[]; cwd: string }[] = [];
  return {
    spawned, now: () => new Date('2026-01-01T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
    fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined,
    spawnDetached(program, args, options) { spawned.push({ program, args, cwd: options.cwd }); return 4242; },
    ...over,
  };
}

export const workersFile = () => validateWorkers({
  workers: [
    { id: 'coder', engine: 'codex-cli', launch: { template: 'coder-v1', program: 'coder', args: ['exec', '-C', '{cwd}', '-o', '{last_file}', '-c', 'writable_roots=["{git_dir}"]', 'Read the UTF-8 file {prompt_file} in full and follow it exactly.'], env: { A: '1' } } },
    { id: 'editor', engine: 'claude-session' },
  ],
}, 'w.yaml');
