import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject, validateProject } from './state-helper.ts';
import { openCommand } from '../src/workers/adapters/codex-log.ts';
import { isTransientError } from '../src/run/transient.ts';
import { planWorktree } from '../src/run/worktree.ts';
import { syncOrders } from '../src/sync/sync.ts';
import type { GitFacts, GitProbe } from '../src/sync/git.ts';
import { importTable } from '../src/table/import.ts';
import { planTick, type TickInput } from '../src/tick/plan.ts';
import { tempOrders } from './helpers.ts';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

test('codex log: its harmless ERROR lines are not transient errors, and a command with no result is seen as still running', () => {
  const log = fixture('codex-noise.log');
  assert.ok(!isTransientError(log));
  assert.ok(!isTransientError('2026-11-03T13:25:18.774978Z ERROR codex_models_manager::manager: failed to refresh available models: stream disconnected before completion'));
  assert.ok(isTransientError('ERROR: stream disconnected before completion: error sending request'));   // a real one still counts
  assert.equal(openCommand(log), 'bash tools/remote/run.sh t1 "scenario long --days 365 --seed 120"');
  // up to the point where the last command has not started yet, everything has a result
  assert.equal(openCommand(log.slice(0, log.indexOf('codex\nThe change is in place'))), undefined);
  // two commands started together; one result has come back, so the other is still open
  assert.equal(openCommand('exec\n"powershell.exe" -Command \'sleep 9\' in workspace/w\nexec\n"powershell.exe" -Command \'echo hi\' in workspace/w\n succeeded in 3ms:\nhi\n'), 'echo hi');
});

const input = (over: Partial<TickInput>): TickInput => ({
  now: new Date('2026-01-01T12:00:00Z'),
  orders: [{ tag: 'T1', stage: 'running', kind: 'sim', row: 0, rework: false, resume: false, endedWithoutReport: false, runStartedAt: '2026-01-01T06:00:00Z' }],
  activity: { T1: { worktree: 'w', lastCommitAt: '2026-01-01T07:00:00Z', logAt: '2026-01-01T09:00:00Z', dirtyFiles: 0, openCommand: 'bash tools/remote/run.sh t1 "scenario long --days 365 --seed 120"' } },
  workers: [], caps: {}, reworkReserve: 1, stallMinutes: 60, longCommandMinutes: 240, alerts: [], ...over,
});

test('a quiet worker whose last command is still running is waiting, not stalled, until the long-command limit', () => {
  const waiting = planTick(input({}));
  assert.deepEqual(waiting.problems, []);
  assert.equal(waiting.exitCode, 0);
  assert.match(waiting.waiting[0].text, /^T1: waiting for a command: bash tools\/remote\/run\.sh t1 "scenario long --days 365 --seed, 180 min$/);
  const over = planTick(input({ longCommandMinutes: 120 }));
  assert.equal(over.problems[0]?.kind, 'stalled');
  const noCommand = planTick(input({ activity: { T1: { worktree: 'w', lastCommitAt: '2026-01-01T07:00:00Z', logAt: '2026-01-01T09:00:00Z', dirtyFiles: 0 } } }));
  assert.equal(noCommand.problems[0]?.kind, 'stalled');
});

const TABLE = [
  '# Plan', '', '## Queue', '',
  '| Status | Order | Worker | Needs |', '|---|---|---|---|',
  '| todo | N1 from a list | Codex | A1,A2 |',
  '| todo | N2 marker | Codex | B1 merged(D5);C1 and C2 merged |',
  '| todo | N3 delivered not merged | Codex | A1 delivered (not merged) |',
  '| todo | N4 after | Codex | E1 after merge(E* belongs to E1) |',
  '| todo | N5 plain | Codex | — |',
  '| todo | N6 branch in the order cell (from feature-x branch) | Codex | — |',
  '',
].join('\n');
const YAML = [
  'id: demo', 'name: Demo', 'root: .', 'work_orders: .', 'state_dir: state', 'workers: ../workers.yaml',
  'dispatch_table:', '  file: plan.md', '  section: Queue', '  status_column: 1', '  order_column: 2', '  worker_column: 3', '  needs_column: 4', '  untagged: synthetic',
  '  needs_markers: [merged, after merge, after]', String.raw`  base_pattern: 'from\s*(\S+)\s*branch'`, '  status_map: { todo: queued }', '',
].join('\n');

test('table: only plain tag lists and "X <marker>" are needs; a branch to start from is read from the row', () => {
  const { orders, dir } = tempOrders();
  writeFileSync(path.join(dir, 'plan.md'), TABLE);
  writeFileSync(path.join(dir, 'alba.yaml'), YAML);
  const cfg = loadProject(path.join(dir, 'alba.yaml'));
  assert.equal(cfg.workers, path.resolve(dir, '..', 'workers.yaml'));
  importTable(orders, cfg.dispatch_table!, TABLE);
  const needs = (tag: string) => orders.get(tag).order.needs;
  assert.deepEqual(needs('N1'), ['A1', 'A2']);
  assert.deepEqual(needs('N2'), ['B1', 'C1', 'C2']);
  assert.deepEqual(needs('N3'), []);               // "A1 delivered (not merged)" is not a need
  assert.deepEqual(needs('N4'), ['E1']);           // "E*" in the explanation is not one
  assert.equal(orders.get('N6').order.base_ref, 'feature-x');
  assert.equal(orders.get('N1').order.base_ref, undefined);
  // without needs_markers every tag in the cell still counts (the first behaviour)
  const { orders: o2 } = tempOrders();
  importTable(o2, { ...cfg.dispatch_table!, needs_markers: undefined }, TABLE);
  assert.deepEqual(o2.get('N3').order.needs, ['A1']);
});

test('an order can start from its own local branch, never from a remote-tracking one', () => {
  const { dir } = tempOrders();
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: dir, base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  assert.equal(planWorktree(project, { tag: 'T1' }).baseRef, 'refs/heads/main');
  assert.equal(planWorktree(project, { tag: 'T1', base_ref: 'ai0-league' }).baseRef, 'refs/heads/ai0-league');
  assert.throws(() => planWorktree(project, { tag: 'T1', base_ref: 'origin/main' }), /local branch/);
});

function gitProject(over: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const work = path.join(dir, 'orders');
  mkdirSync(work);
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: work, state_dir: path.join(dir, 'state'), dispatch: { stall_minutes: 60 }, sync: { git_signal: true }, ...over }, path.join(dir, 'alba.yaml'));
  for (const tag of ['G1', 'G2']) { orders.add({ tag, title: tag, kind: 'k', worker: 'Claude session' }); orders.act(tag, 'queue'); orders.runStart(tag, { worker: 'Claude session' }, true); }
  const facts: Record<string, GitFacts> = {};
  const git: GitProbe = { worktrees: () => ['g1', 'g2'].map(n => ({ path: `/w/demo-${n}`, branch: `demo-${n}` })), facts: wt => facts[wt.slice(-2).toUpperCase()] };
  const now = () => new Date('2026-01-01T12:00:00Z');
  return { orders, project, facts, git, now };
}
const done: GitFacts = { dirty: 0, ahead: ['aaa1111', 'bbb2222'], lastSubject: 'G1: report and playtest', lastAt: '2026-01-01T09:00:00.000Z' };

test('sync from git: a clean, ahead worktree whose last commit says report and is old enough is a delivery; each missing condition is not', () => {
  const { orders, project, facts, git, now } = gitProject();
  facts.G1 = done;
  facts.G2 = { ...done, lastSubject: 'G2: more work' };
  const first = syncOrders(project, orders, { git, now });
  assert.deepEqual(first.changes.map(c => c.tag), ['G1']);
  assert.match(first.skipped.find(s => s.tag === 'G2')!.why, /does not say "report"/);
  const g1 = orders.get('G1');
  assert.equal(orders.stage(g1).stage, 'awaiting-review');
  assert.equal(g1.runs.length, 1);                                         // the imported open run was closed
  assert.equal(g1.runs[0].ended, '2026-01-01T09:00:00.000Z');
  assert.deepEqual([g1.reports[0].status, g1.reports[0].source, g1.reports[0].summary, g1.reports[0].commits], ['ready', 'inferred-git', 'G1: report and playtest', ['aaa1111', 'bbb2222']]);
  assert.deepEqual(syncOrders(project, orders, { git, now }).changes, []);   // idempotent
  // every other condition on its own
  for (const [what, patch, why] of [
    ['dirty', { dirty: 2 }, /uncommitted/], ['not ahead', { ahead: [] as string[] }, /not ahead/], ['too recent', { lastAt: '2026-01-01T11:30:00.000Z' }, /newer than 60 min/],
  ] as const) {
    const other = gitProject();
    other.facts.G1 = { ...done, ...patch };
    other.facts.G2 = { ...done, ...patch };
    const r = syncOrders(other.project, other.orders, { git: other.git, now: other.now });
    assert.deepEqual(r.changes, [], what);
    assert.match(r.skipped[0].why, why, what);
  }
  // off by default, and a run this tool started is never judged by it
  const off = gitProject({ sync: {} });
  off.facts.G1 = done;
  assert.deepEqual(syncOrders(off.project, off.orders, { git: off.git, now: off.now }).changes, []);
  const live = gitProject();
  live.facts.G1 = done;
  live.orders.runEnd('G1');
  live.orders.runStart('G1', { worker: 'codex', extra: { pid: 1 } });
  const lr = syncOrders(live.project, live.orders, { git: live.git, now: live.now });
  assert.ok(!lr.changes.some(c => c.tag === 'G1'));
  assert.match(lr.skipped.find(s => s.tag === 'G1')!.why, /started by this tool/);
});
