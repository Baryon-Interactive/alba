import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Run } from '../src/orders/model.ts';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { startRun } from '../src/run/launch.ts';
import { executeTick } from '../src/tick/execute.ts';
import { childIntegrationPrompt } from '../src/run/phase.ts';
import { approve } from '../src/run/review.ts';
import { humanAction } from '../src/service/actions.ts';
import { acceptSplit } from '../src/service/split.ts';
import { fixture, git, probes, workersFile } from './run-fixture.ts';

function splitFixture(auto = false) {
  const { project, orders, root } = fixture();
  const workers = workersFile(), fake = probes();
  project.phases = { sim: [{ id: 'divide', mode: 'split' }, { id: 'assemble', mode: 'write' }] };
  if (auto) project.split = { approve: { sim: 'auto' } };
  const base = git(root, 'rev-parse', 'main').trim();
  const start = (tag: string) => {
    startRun({ project, orders, workers, probes: fake }, tag, 'coder');
    return orders.get(tag).runs.at(-1)!;
  };
  const finish = (run: Run, fields: object = {}) => {
    const block = ['--- alba-report ---', JSON.stringify({ status: 'ready', run: run.id, summary: 'Prepared', ...fields }), '--- end ---'].join('\n');
    const p = probes({ fileTime: file => file === run.last_file ? run.started : undefined, readText: file => file === run.last_file ? block : undefined });
    applyFinish(orders, findFinishes(project, orders, p, workers)[0], project);
  };
  const subtasks = ['data', 'view', 'test'].map(key => ({ key, title: key, kind: 'task', body: '## Acceptance\n- Render the sample.', ...(key === 'test' ? { needs: ['data'] } : {}) }));
  const lead = start('T1');
  assert.ok(fake.spawned.at(-1)?.args.includes('read-only'));
  finish(lead, { subtasks });
  return { project, orders, root, base, start, finish };
}

test('split approval supports edits, auto approval and returning a proposal to the lead', () => {
  for (const auto of [false, true]) {
    const { project, orders, root, base } = splitFixture(auto);
    if (!auto) {
      assert.equal(orders.stage(orders.get('T1')).waitingFor, 'card');
      assert.throws(() => acceptSplit(project, orders, 'T1', [{ key: 'data', kind: 'sim' }, { key: 'view' }]), /nested split/);
      acceptSplit(project, orders, 'T1', [{ key: 'view', title: 'Display' }, { key: 'test' }]);
      assert.equal(orders.get('T1.1').order.title, 'Display');
      assert.deepEqual(orders.get('T1.2').order.needs, []);
    } else assert.deepEqual(orders.get('T1.3').order.needs, ['T1.1']);
    assert.equal(orders.get('T1.1').order.parent, 'T1');
    if (auto) {
      project.phases!.task = project.phases!.sim;
      assert.throws(() => startRun({ project, orders, workers: workersFile(), probes: probes() }, 'T1.1', 'coder'), /child order cannot split/);
      delete project.phases!.task;
      for (const child of orders.children(orders.get('T1'))) orders.act(child.order.tag, 'cancel');
      assert.equal(orders.stage(orders.get('T1')).stage, 'queued');
      assert.match(childIntegrationPrompt(orders, orders.get('T1')), /T1\.1 \(cancelled\)/);
    }
    assert.equal(orders.get('T1.1').order.base_ref, orders.get('T1').order.branch);
    assert.equal(orders.get('T1').actions.at(-1)?.kind, 'accept-split');
    assert.equal(!!orders.get('T1').actions.at(-1)?.automatic, auto);
    assert.equal(git(root, 'rev-parse', 'main').trim(), base);
  }
  const { project, orders, root, base } = splitFixture();
  humanAction(project, orders, 'T1', 'rework', 'Separate the renderer.');
  assert.equal(orders.get('T1').actions.at(-1)?.phase, 'divide');
  assert.equal(orders.stage(orders.get('T1')).stage, 'queued');
  assert.equal(git(root, 'rev-parse', 'main').trim(), base);
});

test('a tick can finish an interrupted automatic split with an existing matching body', () => {
  const { project, orders, root, base } = splitFixture();
  const text = orders.get('T1').reports.at(-1)!.subtasks![0].body + '\n';
  writeFileSync(path.join(project.work_orders, 'T1.1-data.md'), text);
  project.split = { approve: 'auto' };
  executeTick({ project, orders, workers: workersFile(), probes: probes() }, { maxDispatch: 0 });
  assert.deepEqual(orders.children(orders.get('T1')).map(c => c.order.tag), ['T1.1', 'T1.2', 'T1.3']);
  assert.equal(orders.stage(orders.get('T1')).stage, 'waiting-children');
  assert.equal(git(root, 'rev-parse', 'main').trim(), base);
});

test('dependent children integrate on the parent and the final phase reviews their commits', () => {
  const { project, orders, root, base, start, finish } = splitFixture();
  acceptSplit(project, orders, 'T1');
  const stage = (tag: string) => orders.stage(orders.get(tag));
  assert.equal(stage('T1').stage, 'waiting-children');
  assert.match(stage('T1').why, /3/);
  assert.equal(stage('T1.3').stage, 'waiting-needs');
  const branch = orders.get('T1').order.branch!;
  const tips: string[] = [];
  for (const tag of ['T1.1', 'T1.2', 'T1.3']) {
    const current = git(root, 'rev-parse', branch).trim();
    const run = start(tag);
    assert.equal(git(run.cwd!, 'rev-parse', 'HEAD').trim(), current);
    writeFileSync(path.join(run.cwd!, tag), tag);
    git(run.cwd!, 'add', tag);
    git(run.cwd!, 'commit', '-qm', 'Implement ' + tag);
    const tip = git(run.cwd!, 'rev-parse', 'HEAD').trim();
    tips.push(tip);
    finish(run);
    assert.throws(() => orders.act(tag, 'approve', { imported: true }), /branch approval/);
    approve(project, orders, tag);
    const merged = orders.store.events({ tag }).find(e => e.type === 'merged-into-parent')!;
    assert.equal(merged.data?.commit, git(root, 'rev-parse', branch).trim());
    assert.deepEqual(git(root, 'show', '-s', '--format=%P', branch).trim().split(' '), [current, tip]);
    assert.equal(stage(tag).stage, 'merged');
    assert.equal(git(root, 'rev-parse', 'main').trim(), base);
  }
  assert.equal(stage('T1').stage, 'queued');
  const integration = start('T1');
  assert.equal(integration.phase, 'assemble');
  assert.equal(git(integration.cwd!, 'branch', '--show-current').trim(), branch);
  for (const tip of tips) git(integration.cwd!, 'merge-base', '--is-ancestor', tip, 'HEAD');
  finish(integration);
  assert.equal(stage('T1').stage, 'awaiting-review');
  assert.throws(() => approve(project, orders, 'T1'), /Merge it yourself/);
  assert.equal(git(root, 'rev-parse', 'main').trim(), base);
});

test('a conflicting child receives rework and parent cancellation uses the child stop path', () => {
  const { project, orders, root, base, start, finish } = splitFixture(true);
  const branch = orders.get('T1').order.branch!;
  for (const tag of ['T1.1', 'T1.2']) {
    const run = start(tag);
    writeFileSync(path.join(run.cwd!, 'a.txt'), tag);
    git(run.cwd!, 'commit', '-qam', 'Revise sample');
    finish(run);
  }
  approve(project, orders, 'T1.1');
  const before = git(root, 'rev-parse', branch).trim();
  assert.throws(() => approve(project, orders, 'T1.2'), /a\.txt/);
  const rework = orders.get('T1.2').actions.at(-1)!;
  assert.equal(rework.kind, 'rework');
  assert.ok(rework.note?.includes(before));
  assert.equal(git(root, 'rev-parse', branch).trim(), before);
  orders.runStart('T1.3', { worker: 'fixture' });
  assert.throws(() => orders.act('T1', 'cancel'), /confirm/i);
  orders.act('T1', 'cancel', { confirm: true });
  assert.equal(orders.stage(orders.get('T1.1')).stage, 'merged');
  for (const tag of ['T1', 'T1.2', 'T1.3']) assert.equal(orders.stage(orders.get(tag)).stage, 'cancelled');
  assert.equal(orders.get('T1.3').runs.at(-1)?.outcome, 'cancelled');
  assert.equal(git(root, 'rev-parse', 'main').trim(), base);
});
