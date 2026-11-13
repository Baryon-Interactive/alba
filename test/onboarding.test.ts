import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveRole } from '../src/roles/config.ts';
import { startRun } from '../src/run/launch.ts';
import { baseRefOf, planWorktree } from '../src/run/worktree.ts';
import { systemProbes, type Probes } from '../src/tick/gather.ts';
import { availability, claudeCredentialsMissing } from '../src/workers/quota.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });

/** A new project as a newcomer writes it: no roles, no worktree_parent, no base_ref, a repository on `master`. */
function newcomer() {
  const { dir, orders } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(path.join(root, 'orders'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'master', root]);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const project = validateProject({ id: 'game', name: 'Game', root, work_orders: 'orders', state_dir: path.join(dir, 'state') }, path.join(root, 'alba.yaml'));
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', launch: { program: 'codex', args: ['exec', '{prompt_file}'] } }] }, path.join(dir, 'workers.yaml'));
  return { dir, root, orders, project, workers };
}

test('a setup without roles routes every order to any worker (an implicit default role)', () => {
  assert.deepEqual(resolveRole({}, { kind: 'anything' }), { id: 'default', source: 'default', definition: { sources: {} } });
  assert.deepEqual(resolveRole({ art: { kinds: ['art'], sources: {} } }, { kind: 'code' }), { source: 'none' }, 'with roles written, an order no role takes is still unrouted');
});

test('defaults for a new project: worktrees next to the repository, the base is the branch the repository is on when it has no main', () => {
  const { dir, root, project } = newcomer();
  const plan = planWorktree(project, { tag: 'T1' });
  assert.equal(plan.path, path.join(dir, 'game-worktrees', 'game-t1').split(path.sep).join('/'));
  assert.equal(plan.baseRef, 'refs/heads/master');
  assert.equal(baseRefOf(project), 'refs/heads/master');
  git(root, 'branch', 'main');
  assert.equal(baseRefOf({ ...project, root: root + path.sep }), 'refs/heads/main', 'main wins when the repository has it');
});

test('a dry run already says what a real start would fail on: the missing work-order file, an unknown base branch', () => {
  const { root, orders, project, workers } = newcomer();
  const probes = { ...systemProbes, spawnDetached: () => { throw new Error('nothing may start'); } } as Probes;
  orders.add({ tag: 'T1', title: 'One', kind: 'code' }); orders.act('T1', 'queue');
  assert.throws(() => startRun({ project, orders, workers, probes }, 'T1', 'coder', { dryRun: true }), /No work-order file for T1/);
  writeFileSync(path.join(root, 'orders', 'T1-one.md'), '# T1\n');
  assert.equal(startRun({ project, orders, workers, probes }, 'T1', 'coder', { dryRun: true }).mode, 'start');
  const elsewhere = { ...project, dispatch: { ...project.dispatch, base_ref: 'refs/heads/trunk' } };
  assert.throws(() => startRun({ project: elsewhere, orders, workers, probes }, 'T1', 'coder', { dryRun: true }), /Base ref refs\/heads\/trunk does not exist .*set "dispatch\.base_ref"/);
});

test('workers: one without a launch template is not available; a Claude worker that names no sign-in is warned about', () => {
  const now = new Date();
  const { workers } = validateWorkers({ workers: [
    { id: 'bare', engine: 'codex-cli' },
    { id: 'claude', engine: 'claude-cli', launch: { program: 'claude', args: ['-p', '{prompt_file}'] } },
    { id: 'signed', engine: 'claude-cli', launch: { program: 'claude', args: ['-p', '{prompt_file}'], env: { CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_CODE_OAUTH_TOKEN}' } } },
  ] }, 'workers.yaml');
  const [bare, claude, signed] = workers;
  assert.deepEqual(availability(bare!, undefined, [], now), { available: false, reasons: ['it has no launch template, so alba cannot start it'], alerts: [] });
  const warned = availability(claude!, undefined, [], now);
  assert.equal(warned.available, true);
  assert.match(warned.alerts[0]!, /claude: launch\.env names no Claude sign-in.*claude setup-token.*CLAUDE_CODE_OAUTH_TOKEN/);
  assert.equal(claudeCredentialsMissing(signed!), undefined);
});

test('skills.engine: other says the project has none of the known engines: engine skills are left out, the rest stay', async () => {
  const { readRegistry } = await import('../src/skills/registry.ts');
  const { root, project } = newcomer();
  const web = validateProject({ id: 'web', name: 'Web', root, work_orders: 'orders', state_dir: path.join(root, '..', 'state2'), skills: { engine: 'other' } }, path.join(root, 'alba.yaml'));
  const reg = readRegistry(undefined, web);
  assert.equal(reg.skills.find(s => s.name === 'unreal-headless-pipeline')!.inapplicable, 'for unreal, the project is other');
  assert.ok(reg.skills.find(s => s.name === 'game-capture-windows')!.applicable);
  assert.throws(() => validateProject({ id: 'w', name: 'W', root, work_orders: 'orders', state_dir: 's', skills: { engine: 'web' } }, path.join(root, 'alba.yaml')), /"skills\.engine" must be one of unreal, unity, godot, other, any/);
  assert.equal(project.skills, undefined);
});
