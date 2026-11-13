import { zh as translated } from '../src/i18n-zh.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mergeReadiness, systemReadiness, type ReadinessProbe, type ReadinessQuery } from '../src/review/readiness.ts';
import { fixture, git as fixtureGit, shape } from './api-fixture.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const write = (dir: string, name: string, text: string) => writeFileSync(path.join(dir, name), text);
const commit = (dir: string, message: string) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); };

/** A repository with one root commit on `main` (`a.txt`, `shared.txt`). */
function init(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-ready-'));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'a.txt', 'a\n');
  write(dir, 'shared.txt', 'base\n');
  commit(dir, 'root');
  return dir;
}

const at = '2026-11-04T00:00:00.000Z';
const ask = (dir: string, tag: string, branch: string, peers: ReadinessQuery['peers'] = [], probe: ReadinessProbe = systemReadiness) =>
  mergeReadiness({ repo: dir, tag, branch, baseRef: 'refs/heads/main', peers, now: at }, probe);

test('a clean merge reports ahead, behind and no conflicts', () => {
  const dir = init();
  git(dir, 'branch', 'clean');
  write(dir, 'other.txt', 'main\n');
  commit(dir, 'main moves');
  git(dir, 'checkout', '-q', 'clean');
  write(dir, 'a.txt', 'clean\n');
  write(dir, 'extra.txt', 'x\n');
  commit(dir, 'clean work');
  const r = ask(dir, 'C1', 'clean');
  assert.equal(r.conflicts, false);
  assert.deepEqual(r.conflictFiles, []);
  assert.equal(r.ahead, 1);
  assert.equal(r.behind, 1);
  assert.deepEqual(r.files, ['a.txt', 'extra.txt']);
  assert.equal(r.base, 'main');
  assert.equal(r.computedAt, at);
});

test('a conflicting merge names the files', () => {
  const dir = init();
  git(dir, 'branch', 'clash');
  write(dir, 'shared.txt', 'from main\n');
  write(dir, 'twice.txt', 'from main\n');
  write(dir, 'other.txt', 'main only\n');
  commit(dir, 'main edits');
  git(dir, 'checkout', '-q', 'clash');
  write(dir, 'shared.txt', 'from clash\n');
  write(dir, 'twice.txt', 'from clash\n');
  write(dir, 'also.txt', 'clash only\n');
  commit(dir, 'clash edits');
  const r = ask(dir, 'C2', 'clash');
  assert.equal(r.conflicts, true);
  assert.deepEqual(r.conflictFiles, ['shared.txt', 'twice.txt']);
  assert.deepEqual(r.files, ['also.txt', 'shared.txt', 'twice.txt']);
  assert.equal(r.ahead, 1);
  assert.equal(r.behind, 1);
});

test('an overlap between two branches lists the other order and at most 10 files', () => {
  const dir = init();
  git(dir, 'branch', 'left');
  git(dir, 'branch', 'right');
  git(dir, 'branch', 'far');
  const names = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, '0')}.txt`);
  git(dir, 'checkout', '-q', 'left');
  for (const n of names) write(dir, n, 'left\n');
  write(dir, 'only-left.txt', 'L\n');
  commit(dir, 'left');
  git(dir, 'checkout', '-q', 'right');
  for (const n of names) write(dir, n, 'right\n');
  write(dir, 'only-right.txt', 'R\n');
  commit(dir, 'right');
  git(dir, 'checkout', '-q', 'far');
  write(dir, 'far.txt', 'F\n');
  commit(dir, 'far');
  const r = ask(dir, 'LEFT', 'left', [
    { tag: 'LEFT', branch: 'left', baseRef: 'refs/heads/main' },
    { tag: 'ZED', branch: 'right', baseRef: 'refs/heads/main' },
    { tag: 'FAR', branch: 'far', baseRef: 'refs/heads/main' },
  ]);
  assert.equal(r.conflicts, false);
  assert.deepEqual(r.files, [...names, 'only-left.txt'].sort());
  assert.deepEqual(r.overlaps.map(o => o.tag), ['ZED']);
  assert.deepEqual(r.overlaps[0]?.files, names.slice(0, 10));
});

test('a cache hit does not merge again until a head moves', () => {
  const dir = init();
  git(dir, 'branch', 'feature');
  write(dir, 'm.txt', 'm\n');
  commit(dir, 'main');
  git(dir, 'checkout', '-q', 'feature');
  write(dir, 'f.txt', 'f\n');
  commit(dir, 'feature');
  const calls: string[][] = [];
  const probe: ReadinessProbe = {
    git(repo, args) {
      calls.push(args);
      return systemReadiness.git(repo, args);
    },
  };
  const first = ask(dir, 'F1', 'feature', [], probe);
  assert.equal(first.conflicts, false);
  assert.equal(first.ahead, 1);
  assert.equal(first.behind, 1);
  assert.ok(calls.some(a => a[0] === 'merge-tree'));
  const afterFirst = calls.length;
  const second = ask(dir, 'F1', 'feature', [], probe);
  const more = calls.slice(afterFirst);
  assert.ok(more.length > 0 && more.every(a => a[0] === 'rev-parse'), `a cache hit ran ${more.map(a => a[0]).join(', ')}`);
  assert.deepEqual(second.files, first.files);
  assert.equal(second.ahead, first.ahead);
  write(dir, 'g.txt', 'g\n');
  commit(dir, 'more');
  const afterSecond = calls.length;
  const third = ask(dir, 'F1', 'feature', [], probe);
  assert.ok(calls.slice(afterSecond).some(a => a[0] === 'merge-tree'));
  assert.ok(third.files.includes('g.txt'));
  assert.equal(third.ahead, 2);
});

test('GET /api/orders/:tag/readiness: a clean branch, an overlap, and 404 without a branch', async () => {
  const f = await fixture();
  const missing = await f.get('/api/orders/Q1/readiness');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
  assert.match(missing.body.error.message, /Q1 has no branch/);
  const zh = await f.get('/api/orders/Q1/readiness?lang=zh');
  assert.equal(zh.status, 404);
  assert.equal(zh.body.error.message, translated['{tag} has no branch, so merge readiness cannot be read.'].replace('{tag}', 'Q1'));

  f.orders.add({ tag: 'M1', title: 'Missing branch', kind: 'sim', branch: 'no-such-branch' });
  const absent = await f.get('/api/orders/M1/readiness');
  assert.equal(absent.status, 404);
  assert.match(absent.body.error.message, /no-such-branch/);

  const ok = await f.get('/api/orders/R1/readiness');
  assert.equal(ok.status, 200);
  shape(ok.body, {
    project: 'string', tag: 'string', branch: 'string', base: 'string', behind: 'number', ahead: 'number', conflicts: 'boolean',
    conflictFiles: ['string'], files: ['string'], overlaps: [{ tag: 'string', files: ['string'] }], computedAt: 'string',
  });
  assert.equal(ok.body.tag, 'R1');
  assert.equal(ok.body.branch, 'game-r1');
  assert.equal(ok.body.conflicts, false);
  assert.equal(ok.body.ahead, 1);
  assert.equal(ok.body.behind, 0);
  assert.ok(ok.body.files.includes('a.txt'));
  assert.deepEqual(ok.body.overlaps, []);

  const other = path.join(f.dir, 'other');
  fixtureGit(f.root, 'worktree', 'add', '-q', '-b', 'other', other, 'main');
  writeFileSync(path.join(other, 'a.txt'), 'other\n');
  fixtureGit(other, 'add', 'a.txt');
  fixtureGit(other, 'commit', '-q', '-m', 'other touches a');
  f.orders.add({ tag: 'O2', title: 'Running overlap', kind: 'sim', branch: 'other' });
  f.orders.act('O2', 'queue');
  f.orders.runStart('O2', { worker: 'coder' });
  f.orders.add({ tag: 'Z9', title: 'Draft with the same branch', kind: 'sim', branch: 'other' });
  const overlapped = await f.get('/api/orders/R1/readiness');
  assert.equal(overlapped.status, 200);
  assert.deepEqual(overlapped.body.overlaps, [{ tag: 'O2', files: ['a.txt'] }]);
});
