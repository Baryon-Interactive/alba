import { execFileSync } from 'node:child_process';

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

const run = (cwd: string, args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

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
