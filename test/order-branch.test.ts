import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Orders } from '../src/orders/service.ts';
import { testStore } from './state-helper.ts';
import { fixture, git } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { ready, tempOrders } from './helpers.ts';

/** A repository with a project on it, and an order from a table: awaiting review and no branch recorded. */
function repoWithBranchlessOrder() {
  const { dir } = tempOrders();
  const file = projectDir(dir, 'dispatch:\n  base_ref: refs/heads/main\n');
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), 'state/\n');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  run('add', '.'); run('commit', '-q', '-m', 'first');
  const orders = new Orders(testStore(path.join(dir, 'state')));
  orders.add({ tag: 'T1', title: 'From a table', kind: 'sim' });
  orders.act('T1', 'queue'); orders.runStart('T1', { worker: 'coder' }, true); orders.runEnd('T1'); orders.report('T1', ready);
  assert.equal(orders.stage(orders.get('T1')).stage, 'awaiting-review');
  assert.equal(orders.get('T1').order.branch, undefined);
  return { dir, file, run, orders: () => new Orders(testStore(path.join(dir, 'state'))) };
}

test('Orders.setGit records branch, worktree and base with an event, and shape-checks them', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'T1', title: 'x', kind: 'sim' });
  const doc = orders.setGit('T1', { branch: 'refs/heads/feature/x', worktree: 'workspace/trees/x', base_ref: 'main' });
  assert.deepEqual([doc.order.branch, doc.order.worktree, doc.order.base_ref], ['feature/x', 'workspace/trees/x', 'main']);
  const ev = orders.store.events().filter(e => e.tag === 'T1' && e.type === 'order-git-set');
  assert.equal(ev.length, 1);
  assert.deepEqual((ev[0].data as { fields: string[] }).fields, ['branch', 'worktree', 'base_ref']);
  orders.setGit('T1', { branch: 'feature/x' });                       // the same: nothing is written
  assert.equal(orders.store.events().filter(e => e.type === 'order-git-set').length, 1);
  orders.setGit('T1', { branch: 'feature/y' });
  const again = orders.store.events().filter(e => e.type === 'order-git-set')[1].data as { from: Record<string, string>; to: Record<string, string> };
  assert.deepEqual([again.from.branch, again.to.branch], ['feature/x', 'feature/y']);
  assert.throws(() => orders.setGit('T1', { branch: '  ' }), /branch cannot be empty/);
  assert.throws(() => orders.setGit('T1', { branch: 'two words' }), /not a branch name/);
  assert.throws(() => orders.setGit('T1', { branch: '--force' }), /not a branch name/);
  assert.equal(orders.get('T1').order.branch, 'feature/y');
});

test('alba orders set records the branch (and says what changed); approve --branch records it, then checks the merge', () => {
  const { file, run, orders } = repoWithBranchlessOrder();
  // approve with no branch says how to give one
  const none = alba(file, ['orders', 'act', 'T1', 'approve']);
  assert.equal(none.code, 1);
  assert.match(none.err, /no branch recorded[\s\S]*alba orders set T1 --branch/);
  // a branch that does not exist is refused and nothing is recorded
  const ghost = alba(file, ['review', 'T1', 'approve', '--branch', 'nope']);
  assert.equal(ghost.code, 1);
  assert.match(ghost.err, /Branch "nope" does not exist/);
  assert.equal(orders().get('T1').order.branch, undefined);
  // set on its own
  run('branch', 'feature-x');
  const set = alba(file, ['orders', 'set', 'T1', '--branch', 'feature-x']);
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /branch: - -> feature-x/);
  assert.equal(orders().get('T1').order.branch, 'feature-x');
  assert.equal(alba(file, ['orders', 'set', 'T1', '--branch', 'feature-x']).out.includes('nothing changed'), true);
  assert.equal(alba(file, ['orders', 'set', 'T1']).code, 1);
  // `feature-x` is at main's tip: merged. The plain approve now works.
  assert.equal(alba(file, ['orders', 'act', 'T1', 'approve', '--note', 'ok']).code, 0);
  assert.equal(orders().stage(orders().get('T1')).stage, 'merged');
  assert.ok(existsSync(path.join(path.dirname(file), 'orders', 'T1.accept.md')));
});

test('approve --branch: the branch is recorded even when it is not merged yet, and the merge is still checked', () => {
  const { dir, file, run, orders } = repoWithBranchlessOrder();
  run('checkout', '-q', '-b', 'topic');
  writeFileSync(path.join(dir, 'c.txt'), 'c');
  run('add', 'c.txt'); run('commit', '-q', '-m', 'work');
  run('checkout', '-q', 'main');
  const r = alba(file, ['review', 'T1', 'approve', '--branch', 'topic']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Branch "topic" is not in main yet/);
  assert.equal(orders().get('T1').order.branch, 'topic');
  assert.equal(orders().stage(orders().get('T1')).stage, 'awaiting-review');
  assert.ok(orders().store.events().some(e => e.type === 'order-git-set' && e.tag === 'T1'));
  run('merge', '--ff-only', 'topic');
  const ok = alba(file, ['review', 'T1', 'approve', '--branch', 'topic']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(orders().stage(orders().get('T1')).stage, 'merged');
  // --branch belongs to approve
  const wrong = alba(file, ['orders', 'act', 'T1', 'hold', '--branch', 'topic']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /only goes with approve/);
});

test('API: approve takes "branch"; the list shows whether an order has one', async () => {
  const f = await fixture();
  f.orders.update('R1', { branch: undefined });
  const list = (await f.get('/api/orders?project=demo')).body;
  const rows = Array.isArray(list) ? list : list.items;
  assert.equal(rows.find((o: { tag: string }) => o.tag === 'Q1').branch, undefined);
  assert.equal(rows.find((o: { tag: string }) => o.tag === 'R1').branch, undefined);
  const refused = await f.write('/api/orders/R1/actions', { action: 'approve' });
  assert.ok(refused.status >= 400 && refused.status < 500);
  assert.match(JSON.stringify(refused.body), /no branch recorded/);
  const unmerged = await f.write('/api/orders/R1/actions', { action: 'approve', branch: 'game-r1' });
  assert.ok(unmerged.status >= 400 && unmerged.status < 500);
  assert.match(JSON.stringify(unmerged.body), /not in main yet/);
  assert.equal((await f.get('/api/orders/R1')).body.order.branch, 'game-r1');
  const after = (await f.get('/api/orders?project=demo')).body;
  assert.equal((Array.isArray(after) ? after : after.items).find((o: { tag: string }) => o.tag === 'R1').branch, 'game-r1');
  git(f.root, 'merge', '--ff-only', 'game-r1');
  const ok = await f.write('/api/orders/R1/actions', { action: 'approve' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.stage, 'merged');
});
