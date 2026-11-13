import { execFileSync } from 'node:child_process';
import type { MergeReadiness, ReadinessOverlap } from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { UserError, fail } from '../i18n.ts';
import { baseRefOf } from '../run/worktree.ts';

/** How many overlapping paths to name for one other order. */
const OVERLAP_FILES = 10;

/** One git invocation. `code` is the process exit code; a conflict from merge-tree is 1, not a thrown error. */
export interface GitRun { code: number; stdout: string; stderr: string }

/**
 * The git calls readiness makes, so a test can substitute them.
 * Commands stay read-only apart from `merge-tree --write-tree`, which writes a tree object and nothing else:
 * no ref, no index, no worktree.
 */
export interface ReadinessProbe {
  git(repo: string, args: string[]): GitRun;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : '');

export const systemReadiness: ReadinessProbe = {
  git(repo, args) {
    try {
      const stdout = execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', '-C', repo, ...args], {
        encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (e) {
      const err = e as { status?: number | null; stdout?: unknown; stderr?: unknown; message?: string };
      return { code: typeof err.status === 'number' ? err.status : 128, stdout: text(err.stdout), stderr: text(err.stderr) || err.message || '' };
    }
  },
};

/** Another order whose branch is compared for overlapping paths. */
export interface ReadinessPeer { tag: string; branch: string; baseRef: string }

export interface ReadinessQuery {
  /** The project's repository. Every git command runs here, never inside an order's worktree. */
  repo: string;
  tag: string;
  branch: string;
  baseRef: string;
  peers: readonly ReadinessPeer[];
  /** ISO time stamped on the answer. */
  now: string;
}

/** The base ref of an order: its own `base_ref`, otherwise the project's. A remote-tracking ref is refused. */
export function orderBaseRef(project: ProjectConfig, order: { tag: string; base_ref?: string }): string {
  if (!order.base_ref) return baseRefOf(project);
  const ref = order.base_ref;
  if (/^(origin\/|refs\/remotes\/)/.test(ref)) fail('{what} is {ref}: use a local branch such as refs/heads/main, not a remote-tracking ref.', { what: `${order.tag}: base_ref`, ref });
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

const branchRef = (branch: string): string => (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`);

const gitOk = (probe: ReadinessProbe, repo: string, args: string[]): string => {
  const r = probe.git(repo, args);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout || `git exited ${r.code}`).trim().split('\n')[0];
    fail('Could not read merge readiness: {why}', { why });
  }
  return r.stdout;
};

const headOf = (probe: ReadinessProbe, repo: string, ref: string, missing: () => never): string => {
  const r = probe.git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.code !== 0 || sha === '') missing();
  return sha;
};

/** Conflicted paths from `merge-tree --write-tree --name-only`. Messages, if a git still prints them, follow a blank line. */
const conflictFiles = (stdout: string): string[] => {
  const files: string[] = [];
  for (const line of stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').slice(1)) {
    if (line === '') break;
    files.push(line);
  }
  return [...new Set(files)].sort();
};

const diffNames = (stdout: string): string[] => [...new Set(stdout.split('\0').filter(s => s.length > 0))].sort();

interface Facts {
  branchHead: string;
  baseHead: string;
  behind: number;
  ahead: number;
  conflicts: boolean;
  conflictFiles: string[];
  files: string[];
}

/**
 * One entry per branch ref. It is reused only while both heads are the ones it was built from,
 * so a request does not merge again until the branch head or the base head moves.
 * Finding out whether they moved is two `rev-parse` calls; that is the whole of a cache hit.
 */
const cache = new Map<string, Facts>();

const facts = (probe: ReadinessProbe, repo: string, branch: string, baseRef: string): Facts => {
  const ref = branchRef(branch);
  const branchHead = headOf(probe, repo, ref, () => fail('Branch "{branch}" does not exist, so merge readiness cannot be read.', { branch }));
  const baseHead = headOf(probe, repo, baseRef, () => fail('Base ref "{ref}" does not exist, so merge readiness cannot be read.', { ref: baseRef }));
  const slot = `${repo}\0${ref}\0${baseRef}`;
  const hit = cache.get(slot);
  if (hit && hit.branchHead === branchHead && hit.baseHead === baseHead) return hit;
  const count = (range: string) => Number(gitOk(probe, repo, ['rev-list', '--count', range]).trim());
  const merged = probe.git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '--', baseHead, branchHead]);
  if (merged.code !== 0 && merged.code !== 1) {
    const why = (merged.stderr || merged.stdout || `git exited ${merged.code}`).trim().split('\n')[0];
    fail('Could not read merge readiness: {why}', { why });
  }
  const made: Facts = {
    branchHead, baseHead,
    behind: count(`${branchHead}..${baseHead}`),
    ahead: count(`${baseHead}..${branchHead}`),
    files: diffNames(gitOk(probe, repo, ['diff', '--name-only', '-z', `${baseHead}...${branchHead}`])),
    conflicts: merged.code === 1,
    conflictFiles: merged.code === 1 ? conflictFiles(merged.stdout) : [],
  };
  cache.set(slot, made);
  return made;
};

const peerFacts = (probe: ReadinessProbe, repo: string, peer: ReadinessPeer): Facts | undefined => {
  try {
    return facts(probe, repo, peer.branch, peer.baseRef);
  } catch (e) {
    if (e instanceof UserError) return undefined;
    throw e;
  }
};

/** Ahead, behind, conflicts and file overlaps for one order. Pure apart from the probe. */
export function mergeReadiness(q: ReadinessQuery, probe: ReadinessProbe = systemReadiness): Omit<MergeReadiness, 'project'> {
  const self = facts(probe, q.repo, q.branch, q.baseRef);
  const mine = new Set(self.files);
  const overlaps: ReadinessOverlap[] = [];
  for (const peer of q.peers) {
    if (peer.tag === q.tag || !peer.branch) continue;
    const other = peerFacts(probe, q.repo, peer);
    if (!other) continue;
    const both = other.files.filter(f => mine.has(f)).slice(0, OVERLAP_FILES);
    if (both.length > 0) overlaps.push({ tag: peer.tag, files: both });
  }
  overlaps.sort((a, b) => a.tag.localeCompare(b.tag));
  return {
    tag: q.tag,
    branch: q.branch,
    base: q.baseRef.replace(/^refs\/heads\//, ''),
    behind: self.behind,
    ahead: self.ahead,
    conflicts: self.conflicts,
    conflictFiles: self.conflictFiles,
    files: self.files,
    overlaps,
    computedAt: q.now,
  };
}
