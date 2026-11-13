import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { designFixture, initialDesign } from './fixtures/design.ts';
import { applyChangeSet, designHistory } from '../src/design/library.ts';
import { designChangeProblem, writeDesignSnapshot } from '../src/design/worker.ts';
import { applyFinish } from '../src/run/finish.ts';
import { pendingNotes } from '../src/run/prompt.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function delivery() {
  const f = designFixture();
  writeFileSync(path.join(f.root, '.gitignore'), 'state/\norders/\nalba.yaml\n');
  git(f.root, 'init', '-qb', 'main'); git(f.root, 'config', 'user.name', 'Test'); git(f.root, 'config', 'user.email', 'test@example.com');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'Initial game');
  const worktree = path.join(f.root, 'worker');
  git(f.root, 'worktree', 'add', '-qb', 'delivery', worktree);
  writeFileSync(path.join(f.root, '.git/info/exclude'), 'worker/\n');
  applyChangeSet(f.project, f.orders, initialDesign());
  f.orders.add({ tag: 'DEMO', title: 'Income delivery', kind: 'code', branch: 'delivery', worktree });
  f.orders.act('DEMO', 'queue');
  writeDesignSnapshot(f.project, worktree);
  mkdirSync(path.join(worktree, '.alba/design/changes'), { recursive: true });
  return { ...f, worktree };
}

const proposal = (base_version: number) => JSON.stringify({ title: 'Clarify income', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version, fields: { text: 'Credit income exactly once per turn.' } }] });
const ready = { status: 'ready' as const, summary: 'Income works', evidence: [], commits: [], design_changes: ['.alba/design/changes/income.json'] };

test('a delivery whose design change sets would be refused at approval goes back to the worker once, with the reason', () => {
  const f = delivery();
  writeFileSync(path.join(f.worktree, '.alba/design/changes/income.json'), proposal(4));
  const before = designHistory(f.project).length;
  assert.equal(designChangeProblem(f.project, f.orders, 'DEMO'), undefined, 'no report yet: nothing listed');
  const finish = () => {
    const { run } = f.orders.runStart('DEMO', { worker: 'fake' });
    applyFinish(f.orders, { tag: 'DEMO', run: run.id, outcome: 'completed', report: ready, why: 'done' }, f.project);
  };
  finish();
  let doc = f.orders.get('DEMO');
  assert.equal(f.orders.stage(doc).stage, 'queued');
  const note = pendingNotes(doc).at(-1)!;
  assert.equal(note.kind, 'message');
  assert.match(note.text, /would be refused at approval: Conflict on rule:ECON-R01: base_version 4, current version 1\./);
  assert.match(note.text, /Files: \.alba\/design\/changes\/income\.json\./);
  assert.equal(designHistory(f.project).length, before, 'the dry run wrote nothing');
  // The worker delivers the same again: no second bounce, the reviewer sees it.
  finish();
  doc = f.orders.get('DEMO');
  assert.equal(f.orders.stage(doc).stage, 'awaiting-review');
  assert.ok(f.orders.store.events({ tag: 'DEMO' }).some(e => e.type === 'accept-warning' && /base_version 4/.test(String(e.data?.reason))));
});

test('valid change sets pass the check before review', () => {
  const f = delivery();
  writeFileSync(path.join(f.worktree, '.alba/design/changes/income.json'), proposal(1));
  const { run } = f.orders.runStart('DEMO', { worker: 'fake' });
  applyFinish(f.orders, { tag: 'DEMO', run: run.id, outcome: 'completed', report: ready, why: 'done' }, f.project);
  assert.equal(f.orders.stage(f.orders.get('DEMO')).stage, 'awaiting-review');
  assert.equal(designChangeProblem(f.project, f.orders, 'DEMO'), undefined);
  assert.ok(!f.orders.store.events({ tag: 'DEMO' }).some(e => e.type === 'design-bounced'));
});
