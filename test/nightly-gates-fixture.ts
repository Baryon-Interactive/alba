import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { validateProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import type { NightlyGate } from '../src/gates/config.ts';
import { type GateRunOptions, runNightlyGates } from '../src/gates/runner.ts';
import { activeLeases } from '../src/resources/leases.ts';

export const gate = (name = 'reference', script = 'console.log("ok")', extra: Partial<NightlyGate> = {}): NightlyGate => ({ name, argv: [process.execPath, '-e', script], timeout_minutes: 1, ...extra });
export async function until(check: () => boolean, message = 'async state ready') {
  const end = Date.now() + 20_000;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), message);
}
// Scheduling and result fixtures run single-process commands. Dedicated tree and timeout
// tests use the native identity lookup, descendant scan and verified shutdown.
export function runFixtureGates(project: Parameters<typeof runNightlyGates>[0], orders: Orders, options: GateRunOptions) {
  return runNightlyGates(project, orders, { ...options, commandOptions: { sweep: false, lookupStartedAt: async () => undefined } });
}

let seedRepo: string | undefined;
export function fixture(backend: 'sqlite' | 'files' = 'sqlite', gates = [gate()]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-nightly-')), root = path.join(dir, 'game'), file = path.join(dir, 'alba.yaml');
  mkdirSync(root); mkdirSync(path.join(dir, 'orders'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  if (!seedRepo) {
    git('init', '-q', '-b', 'main'); writeFileSync(path.join(root, 'input.txt'), 'baseline'); git('add', '.'); git('commit', '-qm', 'Baseline');
    seedRepo = mkdtempSync(path.join(os.tmpdir(), 'alba-gate-seed-'));
    cpSync(root, seedRepo, { recursive: true });
  } else cpSync(seedRepo, root, { recursive: true });
  const raw = { id: 'sample', name: 'Sample', root, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), state: { backend }, dispatch: { caps: { sim: 1 } }, resources: { rig: { slots: 2 } }, gates: { nightly: gates, window: '01:00-06:00' } };
  writeFileSync(file, stringify(raw));
  const project = validateProject(raw, file), orders = new Orders(stateStore(project));
  function merge(tag = 'DEMO-A') {
    git('checkout', '-qb', `change-${tag}`); writeFileSync(path.join(root, `${tag}.txt`), tag); git('add', '.'); git('commit', '-qm', `Change ${tag}`);
    git('checkout', '-q', 'main'); git('merge', '--no-ff', '-qm', `Merge ${tag}`, `change-${tag}`);
    const commit = git('rev-parse', 'HEAD'); orders.record(tag, 'accept-merged', { merge: commit }); return commit;
  }
  const at = (day = 1, hour = 2) => new Date(2026, 0, day, hour, 0);
  return { dir, root, project, orders, git, merge, at, file };
}
export function noScratch(f: ReturnType<typeof fixture>) {
  // No scratch worktree of the gates is left (an order's own worktree, made by a start, is not scratch).
  const scratch = path.join(f.project.state_dir, 'nightly-gates').split(path.sep).join('/').toLowerCase();
  assert.deepEqual(f.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ') && l.slice(9).replace(/\\/g, '/').toLowerCase().startsWith(scratch)), []);
  assert.ok(readdirSync(path.join(f.project.state_dir, 'nightly-gates')).every(n => !n.startsWith('worktree-')));
  assert.equal(activeLeases(f.project, f.orders).length, 0);
}
