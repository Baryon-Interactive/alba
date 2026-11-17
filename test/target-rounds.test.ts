import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { stringify } from 'yaml';
import type { ProjectConfig } from '../src/config.ts';
import { Orders } from '../src/orders/service.ts';
import { acceptanceCard, attemptAcceptance, mergeAcceptance, trialAcceptance } from '../src/review/acceptance.ts';
import { reworkCount } from '../src/run/review.ts';
import { computeBlockTrend, computeRowTrend, parseTargetSection } from '../src/verify/target.ts';
import { applyTargetOutcome } from '../src/verify/target-rounds.ts';
import { tempOrders } from './helpers.ts';
import { testBackend, testStore, validateProject } from './state-helper.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const fakeGame = path.resolve('examples/capture/fake-game.mjs').replace(/\\/g, '/');

function withLockDir<T>(lockDir: string, fn: () => T): T {
  const prev = process.env.ALBA_LOCK_DIR;
  process.env.ALBA_LOCK_DIR = lockDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ALBA_LOCK_DIR;
    else process.env.ALBA_LOCK_DIR = prev;
  }
}

interface RoundEnv {
  dir: string;
  root: string;
  worktree: string;
  workOrders: string;
  stateDir: string;
  lockDir: string;
  yamlFile: string;
  orders: Orders;
  makeProject: (extra?: Record<string, unknown>, scene?: string) => ProjectConfig;
  deliverRound: (tag: string, label: string) => string;
}

function setupRoundEnv(t: TestContext): RoundEnv {
  const { dir } = tempOrders();
  const root = path.join(dir, 'repo');
  const worktree = path.join(dir, 'wt-t1');
  const workOrders = path.join(dir, 'orders');
  const stateDir = path.join(dir, 'state');
  const lockDir = path.join(dir, 'locks');
  const yamlFile = path.join(dir, 'alba.yaml');
  mkdirSync(path.join(root, 'art', 'targets'), { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  mkdirSync(lockDir, { recursive: true });

  const refPng = path.join(root, 'art', 'targets', 'day-ref.png');
  const gen = spawnSync(process.execPath, [fakeGame, '--out', refPng, '--scene', 'day', '--size', '320x180'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(gen.status, 0, gen.stderr);

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'app.txt'), 'base\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');

  git(root, 'worktree', 'add', '-qb', 'branch-t1', worktree, 'main');

  const orders = new Orders(testStore(stateDir));

  const makeProject = (extra: Record<string, unknown> = {}, scene = 'night'): ProjectConfig => {
    const raw: Record<string, unknown> = {
      id: 'demo',
      name: 'Demo',
      root,
      work_orders: workOrders,
      state_dir: stateDir,
      state: { backend: testBackend() },
      dispatch: { base_ref: 'main', worktree_parent: dir, ...((extra.dispatch as Record<string, unknown>) ?? {}) },
      verify: { max_visual_rounds: 2, ...((extra.verify as Record<string, unknown>) ?? {}) },
      capture: (extra.capture as Record<string, unknown> | undefined) ?? {
        recipes: [{
          name: 'demo',
          kinds: ['visual'],
          launch: [process.execPath, fakeGame, '--out', '{out}', '--size', '320x180'],
          shots: [{ name: 'day', args: ['--scene', scene] }],
        }],
      },
      ...(extra.accept !== undefined ? { accept: extra.accept } : {}),
      ...(extra.review !== undefined ? { review: extra.review } : {}),
    };
    writeFileSync(yamlFile, stringify(raw), 'utf8');
    return validateProject(raw, yamlFile);
  };

  let commitCounter = 0;
  const deliverRound = (tag: string, label: string): string => {
    commitCounter++;
    writeFileSync(path.join(worktree, 'app.txt'), `${label}-${commitCounter}\n`, 'utf8');
    git(worktree, 'add', 'app.txt');
    git(worktree, 'commit', '-qm', `round ${commitCounter}: ${label}`);
    const head = git(worktree, 'rev-parse', 'HEAD');
    orders.runStart(tag, { worker: 'w1' });
    orders.runEnd(tag, 'completed');
    orders.report(tag, { status: 'ready', summary: `Delivered ${label}`, evidence: [], commits: [head] });
    return head;
  };

  t.after(() => {
    try { git(root, 'worktree', 'remove', '--force', worktree); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, root, worktree, workOrders, stateDir, lockDir, yamlFile, orders, makeProject, deliverRound };
}

const STANDARD_ORDER_MD = [
  '# T1: Sea look',
  '',
  '## Acceptance',
  '- Matches noon sea target.',
  '',
  '## Target',
  '- shot: day',
  '- reference: art/targets/day-ref.png',
  '- luminance: region 0,0,1,0.5 within 0.06',
  '- saturation: within 0.08',
  '- histogram: max 0.25',
  '',
].join('\n');

test('rounds (max_visual_rounds: 2) & trend: two automatic reworks with measured values, third miss records target-not-converging with 3 history rows and stalled mark, repeat call is a no-op', t => {
  const env = setupRoundEnv(t);
  writeFileSync(path.join(env.workOrders, 'T1.md'), STANDARD_ORDER_MD, 'utf8');
  env.orders.add({ tag: 'T1', title: 'Sea look', kind: 'visual', branch: 'branch-t1', worktree: env.worktree });
  const project = env.makeProject({ verify: { max_visual_rounds: 2 } }, 'night');

  // Round 1 miss -> automatic rework #1
  env.deliverRound('T1', 'r1');
  const trial1 = withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'))!;
  assert.equal(trial1.status, 'failed');
  assert.equal(reworkCount(env.orders.get('T1')), 1);
  assert.equal(env.orders.stage(env.orders.get('T1')).stage, 'queued');

  const r1Block = trial1.steps.find(s => s.name === 'target')!.target![0]!;
  assert.equal(r1Block.round, 1);
  assert.equal(r1Block.trend, undefined);
  assert.equal(r1Block.stalled, undefined);
  const lumValStr = r1Block.rows[0]!.value.toFixed(3);
  const lumRefStr = r1Block.rows[0]!.reference!.toFixed(3);

  const note1 = env.orders.get('T1').actions.at(-1)!.note ?? '';
  assert.ok(note1.includes(lumValStr), `rework note 1 contains measured luminance ${lumValStr}`);
  assert.ok(note1.includes(lumRefStr), `rework note 1 contains reference luminance ${lumRefStr}`);
  assert.match(note1, /too dark/);
  assert.match(note1, /automatic round 1 of 2; after 2 a person decides/);
  assert.match(note1, /recipe "demo"/);
  assert.ok(note1.includes(r1Block.sheet), 'rework note 1 contains side-by-side sheet path');

  const bounceEvents1 = env.orders.store.events({ tag: 'T1' }).filter(e => e.type === 'target-bounced');
  assert.equal(bounceEvents1.length, 1);
  assert.equal(bounceEvents1[0]!.data?.round, 1);

  // Round 2 miss (same scene -> flat trend) -> automatic rework #2
  env.deliverRound('T1', 'r2');
  const trial2 = withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'))!;
  assert.equal(trial2.status, 'failed');
  assert.equal(reworkCount(env.orders.get('T1')), 2);
  assert.equal(env.orders.stage(env.orders.get('T1')).stage, 'queued');

  const r2Block = trial2.steps.find(s => s.name === 'target')!.target![0]!;
  assert.equal(r2Block.round, 2);
  assert.equal(r2Block.trend, 'flat');
  assert.equal(r2Block.stalled, undefined);

  const note2 = env.orders.get('T1').actions.at(-1)!.note ?? '';
  assert.ok(note2.includes(lumValStr));
  assert.match(note2, /automatic round 2 of 2; after 2 a person decides/);

  // Round 3 miss (same scene for 3rd time -> two flat rounds in a row -> stalled!) -> NO rework, target-not-converging with 3 history rows
  env.deliverRound('T1', 'r3');
  const trial3 = withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'))!;
  assert.equal(trial3.status, 'failed');
  assert.equal(reworkCount(env.orders.get('T1')), 2, 'third miss creates no rework');
  assert.equal(env.orders.stage(env.orders.get('T1')).stage, 'awaiting-review', 'order stays awaiting-review for the lead');

  const r3Step = trial3.steps.find(s => s.name === 'target')!;
  const r3Block = r3Step.target![0]!;
  assert.equal(r3Block.round, 3);
  assert.equal(r3Block.trend, 'stalled');
  assert.equal(r3Block.stalled, true);
  assert.ok(r3Step.tail.startsWith('Not converging after 3 rounds:'), `step tail starts with Not converging header: ${r3Step.tail}`);
  assert.match(r3Step.tail, /\[stalled\]/);

  // AcceptanceCard reads the persisted step tail as well
  const card = acceptanceCard(project, env.orders, 'T1')!;
  assert.ok(card.trial?.steps.find(s => s.name === 'target')?.tail.startsWith('Not converging after 3 rounds:'));

  const ncEvents = env.orders.store.events({ tag: 'T1' }).filter(e => e.type === 'target-not-converging');
  assert.equal(ncEvents.length, 1);
  assert.equal(ncEvents[0]!.data?.rounds, 3);
  assert.equal(ncEvents[0]!.data?.max, 2);
  assert.equal(ncEvents[0]!.data?.reason, 'not converging');
  const history = ncEvents[0]!.data?.history as { round: number; stalled?: boolean }[];
  assert.equal(Array.isArray(history), true);
  assert.equal(history.length, 3);
  assert.equal(history[2]!.stalled, true);

  // Calling attemptAcceptance again on the same trial adds nothing
  const eventsBefore = env.orders.store.events({ tag: 'T1' }).length;
  const actionsBefore = env.orders.get('T1').actions.length;
  const again = withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'))!;
  assert.equal(again.id, trial3.id);
  assert.equal(env.orders.store.events({ tag: 'T1' }).length, eventsBefore);
  assert.equal(env.orders.get('T1').actions.length, actionsBefore);
});

test('rounds policy guards: held order, review: manual, max_reworks: 1 reached, max_visual_rounds: 0, unmeasured target, and passing target-round', t => {
  // 1. Held order -> no rework, reason "order is held"
  {
    const env = setupRoundEnv(t);
    writeFileSync(path.join(env.workOrders, 'T1.md'), STANDARD_ORDER_MD, 'utf8');
    env.orders.add({ tag: 'T1', title: 'Held case', kind: 'visual', branch: 'branch-t1', worktree: env.worktree });
    const project = env.makeProject({ verify: { max_visual_rounds: 2 } }, 'night');
    env.deliverRound('T1', 'held-1');
    const trial = withLockDir(env.lockDir, () => trialAcceptance(project, env.orders, 'T1'));
    env.orders.act('T1', 'hold', { note: 'hold before round check' });
    applyTargetOutcome(project, env.orders, 'T1', trial);
    assert.equal(reworkCount(env.orders.get('T1')), 0);
    const nc = env.orders.store.events({ tag: 'T1' }).find(e => e.type === 'target-not-converging');
    assert.ok(nc);
    assert.equal(nc.data?.reason, 'order is held');
    assert.ok(trial.steps.find(s => s.name === 'target')!.tail.startsWith('To the lead: order is held'));
  }

  // 2. review: manual -> no rework, reason "review is manual"
  {
    const env = setupRoundEnv(t);
    writeFileSync(path.join(env.workOrders, 'T1.md'), STANDARD_ORDER_MD, 'utf8');
    env.orders.add({ tag: 'T1', title: 'Manual review case', kind: 'visual', review: 'manual', branch: 'branch-t1', worktree: env.worktree });
    const project = env.makeProject({ verify: { max_visual_rounds: 2 } }, 'night');
    env.deliverRound('T1', 'manual-1');
    const trial = withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'))!;
    assert.equal(reworkCount(env.orders.get('T1')), 0);
    const nc = env.orders.store.events({ tag: 'T1' }).find(e => e.type === 'target-not-converging');
    assert.ok(nc);
    assert.equal(nc.data?.reason, 'review is manual');
    assert.ok(trial.steps.find(s => s.name === 'target')!.tail.startsWith('To the lead: review is manual'));
  }

  // 3. dispatch.max_reworks: 1 reached (while max_visual_rounds is 2) -> Miss 1 reworks, Miss 2 stops with reason "max_reworks reached"
  {
    const env = setupRoundEnv(t);
    writeFileSync(path.join(env.workOrders, 'T1.md'), STANDARD_ORDER_MD, 'utf8');
    env.orders.add({ tag: 'T1', title: 'Max reworks case', kind: 'visual', branch: 'branch-t1', worktree: env.worktree });
    const project = env.makeProject({ dispatch: { max_reworks: 1 }, verify: { max_visual_rounds: 2 } }, 'night');
    env.deliverRound('T1', 'mr-1');
    withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'));
    assert.equal(reworkCount(env.orders.get('T1')), 1);

    env.deliverRound('T1', 'mr-2');
    const trial2 = withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'))!;
    assert.equal(reworkCount(env.orders.get('T1')), 1, 'second miss blocked by max_reworks: 1');
    const nc = env.orders.store.events({ tag: 'T1' }).find(e => e.type === 'target-not-converging');
    assert.ok(nc);
    assert.equal(nc.data?.reason, 'max_reworks reached');
    assert.ok(trial2.steps.find(s => s.name === 'target')!.tail.startsWith('To the lead: max_reworks reached'));
  }

  // 4. max_visual_rounds: 0 -> never sends back
  {
    const env = setupRoundEnv(t);
    writeFileSync(path.join(env.workOrders, 'T1.md'), STANDARD_ORDER_MD, 'utf8');
    env.orders.add({ tag: 'T1', title: 'Zero rounds case', kind: 'visual', branch: 'branch-t1', worktree: env.worktree });
    const project = env.makeProject({ verify: { max_visual_rounds: 0 } }, 'night');
    env.deliverRound('T1', 'zero-1');
    withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'));
    assert.equal(reworkCount(env.orders.get('T1')), 0);
    const nc = env.orders.store.events({ tag: 'T1' }).find(e => e.type === 'target-not-converging');
    assert.ok(nc);
    assert.equal(nc.data?.max, 0);
  }

  // 5. Unmeasured target -> never sends back
  {
    const env = setupRoundEnv(t);
    writeFileSync(
      path.join(env.workOrders, 'T1.md'),
      '# T1\n\n## Acceptance\n- Sea.\n\n## Target\n- shot: missing-shot\n- luminance: between 0.2 and 0.8\n',
      'utf8',
    );
    env.orders.add({ tag: 'T1', title: 'Unmeasured case', kind: 'visual', branch: 'branch-t1', worktree: env.worktree });
    const project = env.makeProject({ verify: { max_visual_rounds: 2 } }, 'day');
    env.deliverRound('T1', 'unm-1');
    const trial = withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'))!;
    assert.equal(trial.status, 'failed');
    assert.ok(trial.steps.find(s => s.name === 'target')!.target![0]!.unmeasured);
    assert.equal(reworkCount(env.orders.get('T1')), 0);
    assert.equal(env.orders.store.events({ tag: 'T1' }).some(e => e.type === 'target-bounced' || e.type === 'target-not-converging'), false);
  }

  // 6. Passing target step -> records target-round { pass: true } and creates no rework
  {
    const env = setupRoundEnv(t);
    writeFileSync(path.join(env.workOrders, 'T1.md'), STANDARD_ORDER_MD, 'utf8');
    env.orders.add({ tag: 'T1', title: 'Passing case', kind: 'visual', branch: 'branch-t1', worktree: env.worktree });
    const project = env.makeProject({ verify: { max_visual_rounds: 2 } }, 'day');
    env.deliverRound('T1', 'pass-1');
    const trial = withLockDir(env.lockDir, () => attemptAcceptance(project, env.orders, 'T1'))!;
    assert.equal(trial.status, 'passed');
    assert.equal(reworkCount(env.orders.get('T1')), 0);
    const roundEv = env.orders.store.events({ tag: 'T1' }).find(e => e.type === 'target-round');
    assert.ok(roundEv);
    assert.equal(roundEv.data?.pass, true);
    assert.equal(roundEv.data?.round, 1);
  }
});

test('approval boundary: mergeAcceptance on an order whose target misses fails as before and creates no rework action', t => {
  const env = setupRoundEnv(t);
  writeFileSync(path.join(env.workOrders, 'T1.md'), STANDARD_ORDER_MD, 'utf8');
  env.orders.add({ tag: 'T1', title: 'Approval guard', kind: 'visual', branch: 'branch-t1', worktree: env.worktree });
  const project = env.makeProject({ verify: { max_visual_rounds: 2 } }, 'night');
  env.deliverRound('T1', 'merge-attempt');

  assert.throws(
    () => withLockDir(env.lockDir, () => mergeAcceptance(project, env.orders, 'T1', 'attempt approve', 'lead')),
    /Acceptance trial failed: Step target failed/,
  );
  assert.equal(reworkCount(env.orders.get('T1')), 0, 'mergeAcceptance must never send an order back');
  assert.equal(env.orders.stage(env.orders.get('T1')).stage, 'awaiting-review');
  assert.equal(env.orders.store.events({ tag: 'T1' }).some(e => e.type === 'target-bounced'), false);
});

test('trend direction: closer, farther, flat (< 10% of bound) and two flat rounds marking stalled', () => {
  const rule = parseTargetSection('## Target\n- shot: day\n- reference: art/ref.png\n- luminance: within 0.10\n').blocks[0]!.rows[0]!;
  const rowCloser = { metric: 'luminance' as const, label: 'mean luminance', value: 0.48, reference: 0.55, bound: 'within 0.1', pass: true };
  assert.equal(computeRowTrend(rule, rowCloser, 0.30), 'closer');

  const rowFarther = { ...rowCloser, value: 0.25, pass: false };
  assert.equal(computeRowTrend(rule, rowFarther, 0.42), 'farther');

  const rowFlat = { ...rowFarther, value: 0.305 };
  assert.equal(computeRowTrend(rule, rowFlat, 0.30), 'flat');

  const round2 = computeBlockTrend([{ ...rowFlat, trend: 'flat' }], undefined);
  assert.equal(round2.trend, 'flat');
  assert.equal(round2.stalled, undefined);

  const round3 = computeBlockTrend([{ ...rowFlat, trend: 'flat' }], round2.trend);
  assert.equal(round3.trend, 'stalled');
  assert.equal(round3.stalled, true);
});
