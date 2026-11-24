import { execFileSync } from 'node:child_process';

export const GIT_LOCK_RETRY_DELAYS_MS = [50, 150, 400, 1000] as const;
export const GIT_LOCK_HELD_SENTENCE = 'Git could not acquire a lock held by another git process after retries.';

const GIT_LOCK_PATTERNS: readonly RegExp[] = [
  /unable to create ['"]?[^\r\n'"]*\.lock['"]?: file exists/i,
  /cannot lock ref/i,
  /could not lock config file/i,
  /another git process seems to be running/i,
];

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

export const sleepAsync = (ms: number): Promise<void> => (ms <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms)));

export function gitErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    return [e.stderr ? String(e.stderr) : '', e.message ?? '', e.stdout ? String(e.stdout) : ''].filter(Boolean).join('\n');
  }
  return String(error ?? '');
}

export function isGitLockError(error: unknown): boolean {
  const text = gitErrorText(error);
  return GIT_LOCK_PATTERNS.some(pattern => pattern.test(text));
}

function withGitLockNote(error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error ?? ''));
  const rawStderr = (err as { stderr?: Buffer | string }).stderr;
  if (rawStderr !== undefined) {
    const text = String(rawStderr).trim();
    const lines = text ? text.split(/\r?\n/) : [];
    if (!lines.length) lines.push(GIT_LOCK_HELD_SENTENCE);
    else if (!lines[0].includes(GIT_LOCK_HELD_SENTENCE)) lines[0] = `${lines[0]} ${GIT_LOCK_HELD_SENTENCE}`;
    (err as { stderr?: string }).stderr = lines.join('\n');
  }
  const msg = err.message.trim();
  const msgLines = msg ? msg.split(/\r?\n/) : [];
  if (!msgLines.length) err.message = GIT_LOCK_HELD_SENTENCE;
  else if (!msgLines[0].includes(GIT_LOCK_HELD_SENTENCE)) {
    msgLines[0] = `${msgLines[0]} ${GIT_LOCK_HELD_SENTENCE}`;
    err.message = msgLines.join('\n');
  }
  return err;
}

export interface GitLockRetryOptions {
  delays?: readonly number[];
  sleep?: (ms: number) => void;
}

export interface GitLockRetryAsyncOptions {
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Retries a synchronous git operation on lock contention without deleting lock files or busy-waiting. */
export function withGitLockRetrySync<T>(fn: () => T, options: GitLockRetryOptions = {}): T {
  const delays = options.delays ?? GIT_LOCK_RETRY_DELAYS_MS;
  const wait = options.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (!isGitLockError(error)) throw error;
      if (attempt >= delays.length) throw withGitLockNote(error);
      wait(delays[attempt]);
    }
  }
}

/** Retries an asynchronous git operation on lock contention without deleting lock files. */
export async function withGitLockRetry<T>(fn: () => Promise<T>, options: GitLockRetryAsyncOptions = {}): Promise<T> {
  const delays = options.delays ?? GIT_LOCK_RETRY_DELAYS_MS;
  const wait = options.sleep ?? sleepAsync;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isGitLockError(error)) throw error;
      if (attempt >= delays.length) throw withGitLockNote(error);
      await wait(delays[attempt]);
    }
  }
}

/** What the git state of an order's worktree says. */
export interface GitFacts {
  dirty: number;            // uncommitted files
  ahead: string[];          // commits on the worktree's branch that the base does not have, oldest first (short hashes)
  lastSubject: string;      // subject line of the last commit
  lastAt: string;           // when it was committed (ISO)
}

export interface GitProbe {
  worktrees(root: string): { path: string; branch?: string }[];
  facts(worktree: string, baseRef: string): GitFacts | undefined;
}

const run = (cwd: string, args: string[]) => withGitLockRetrySync(() =>
  execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
);

export const systemGit: GitProbe = {
  worktrees(root) {
    try {
      return run(root, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/).map(block => {
        const p = /^worktree (.+)$/m.exec(block)?.[1];
        const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
        return p ? { path: p, branch: b } : undefined;
      }).filter((x): x is { path: string; branch: string | undefined } => x !== undefined);
    } catch { return []; }
  },
  facts(worktree, baseRef) {
    try {
      const dirty = run(worktree, ['status', '--porcelain']).split('\n').filter(Boolean).length;
      const ahead = run(worktree, ['rev-list', '--reverse', '--abbrev-commit', `${baseRef}..HEAD`]).split('\n').map(s => s.trim()).filter(Boolean);
      const [lastSubject, at] = run(worktree, ['log', '-1', '--format=%s%x00%cI']).trim().split('\0');
      return { dirty, ahead, lastSubject: lastSubject ?? '', lastAt: new Date(at).toISOString() };
    } catch { return undefined; }
  },
};
