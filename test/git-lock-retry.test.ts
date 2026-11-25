import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  GIT_LOCK_HELD_SENTENCE,
  GIT_LOCK_RETRY_DELAYS_MS,
  isGitLockError,
  withGitLockRetry,
  withGitLockRetrySync,
} from '../src/sync/git.ts';
import { git } from '../src/run/worktree.ts';
import { tmpDir } from './tmp.ts';

function initTempRepo(): string {
  const dir = tmpDir('alba-lock-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Demo'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('D2: held index.lock released after 200ms lets synchronous git succeed', () => {
  const dir = initTempRepo();
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'change\n');
    const lockFile = path.join(dir, '.git', 'index.lock');
    writeFileSync(lockFile, '');
    const releaser = spawn(process.execPath, [
      '-e',
      'const fs=require("node:fs"); setTimeout(() => { try { fs.unlinkSync(process.argv[1]); } catch {} }, 200);',
      lockFile,
    ], { stdio: 'ignore', windowsHide: true });

    try {
      git(dir, ['add', 'a.txt']);
      const status = git(dir, ['status', '--porcelain']).trim();
      assert.equal(status, 'A  a.txt');
      assert.equal(existsSync(lockFile), false);
    } finally {
      releaser.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2: permanently held index.lock fails after retries with lock sentence and never deletes the lock', () => {
  const dir = initTempRepo();
  try {
    writeFileSync(path.join(dir, 'b.txt'), 'blocked\n');
    const lockFile = path.join(dir, '.git', 'index.lock');
    writeFileSync(lockFile, 'held');

    assert.throws(
      () => git(dir, ['add', 'b.txt']),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /index\.lock/i);
        assert.ok(message.includes(GIT_LOCK_HELD_SENTENCE), `expected lock sentence in: ${message}`);
        return true;
      },
    );
    assert.equal(existsSync(lockFile), true, 'lock file must never be deleted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2: async retry recovers when index.lock is released after 200ms', async () => {
  const dir = initTempRepo();
  try {
    writeFileSync(path.join(dir, 'c.txt'), 'async\n');
    const lockFile = path.join(dir, '.git', 'index.lock');
    writeFileSync(lockFile, '');
    const timer = setTimeout(() => { try { rmSync(lockFile, { force: true }); } catch { /* gone */ } }, 200);
    try {
      await withGitLockRetry(() => new Promise<void>((resolve, reject) => {
        execFile('git', ['-C', dir, 'add', 'c.txt'], { encoding: 'utf8', windowsHide: true }, (err, _out, stderr) => {
          if (err) {
            (err as { stderr?: string }).stderr = stderr;
            reject(err);
          } else {
            resolve();
          }
        });
      }));
      assert.equal(git(dir, ['status', '--porcelain']).trim(), 'A  c.txt');
    } finally {
      clearTimeout(timer);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2: injected runner retries lock errors with [50, 150, 400, 1000] and fails non-lock errors immediately', async () => {
  const lockMessages = [
    "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    "error: cannot lock ref 'refs/heads/main': is at abc",
    'error: could not lock config file .git/config: File exists',
    'Another git process seems to be running in this repository',
  ];
  for (const msg of lockMessages) assert.equal(isGitLockError(new Error(msg)), true, msg);
  assert.equal(isGitLockError(new Error('fatal: not a git repository')), false);

  // Non-lock error: fails at once (1 invocation, 0 sleeps)
  let nonLockCalls = 0;
  const nonLockSleeps: number[] = [];
  assert.throws(
    () => withGitLockRetrySync(() => {
      nonLockCalls++;
      throw new Error('fatal: pathspec did not match any files');
    }, { sleep: ms => nonLockSleeps.push(ms) }),
    /pathspec did not match/,
  );
  assert.equal(nonLockCalls, 1);
  assert.deepEqual(nonLockSleeps, []);

  // Lock error: retries 4 times (5 invocations total) with exact backoff delays and adds lock sentence
  let syncCalls = 0;
  const syncSleeps: number[] = [];
  class CustomGitError extends Error {}
  assert.throws(
    () => withGitLockRetrySync(() => {
      syncCalls++;
      throw new CustomGitError(`fatal: cannot lock ref 'refs/heads/main' (attempt ${syncCalls})`);
    }, { sleep: ms => syncSleeps.push(ms) }),
    (err: unknown) => {
      assert.ok(err instanceof CustomGitError);
      assert.match(err.message, /attempt 5/);
      assert.ok(err.message.includes(GIT_LOCK_HELD_SENTENCE));
      return true;
    },
  );
  assert.equal(syncCalls, 1 + GIT_LOCK_RETRY_DELAYS_MS.length);
  assert.deepEqual(syncSleeps, [...GIT_LOCK_RETRY_DELAYS_MS]);

  // Async non-lock fails at once; lock recovers on 3rd try
  let asyncNonLock = 0;
  await assert.rejects(
    () => withGitLockRetry(async () => {
      asyncNonLock++;
      throw new Error('fatal: bad revision');
    }, { sleep: async () => { throw new Error('should not sleep'); } }),
    /bad revision/,
  );
  assert.equal(asyncNonLock, 1);

  let asyncCalls = 0;
  const asyncSleeps: number[] = [];
  const val = await withGitLockRetry(async () => {
    asyncCalls++;
    if (asyncCalls < 3) throw new Error('error: could not lock config file .git/config');
    return 'ok';
  }, { sleep: async ms => { asyncSleeps.push(ms); } });
  assert.equal(val, 'ok');
  assert.equal(asyncCalls, 3);
  assert.deepEqual(asyncSleeps, [50, 150]);
});
