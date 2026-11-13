import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { fail } from '../i18n.ts';

export interface WorktreePlan { path: string; branch: string; baseRef: string }

const slash = (p: string) => p.replace(/\\/g, '/');

/**
 * Where an order's worktree goes and which branch it uses.
 * Path: <worktree_parent, default: <id>-worktrees next to the repository>/<project id>-<tag in lower case>; branch: the same name unless the order names one.
 * The base is always a local branch; a remote-tracking ref is refused because it may be stale.
 */
/** The main checkout as it is now: the base branch's head and its changed files (`git status --porcelain` lines). */
export function mainCheckoutState(project: ProjectConfig): { head?: string; dirty: string[] } {
  const run = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', project.root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  let head: string | undefined;
  try { head = run(['rev-parse', '--verify', `${baseRefOf(project)}^{commit}`]).trim(); } catch { /* no base branch yet */ }
  let dirty: string[] = [];
  try { dirty = run(['status', '--porcelain', '--untracked-files=no']).split('\n').map(l => l.trimEnd()).filter(Boolean).slice(0, 500); } catch { /* not a repository */ }
  return { head, dirty };
}

/**
 * What a run did outside its worktree, in the main checkout: commits made directly on the base branch while it ran (the branch's
 * reflog says "commit", not a merge, a reset or a pull), and files changed there that were not changed when it started.
 */
export function outsideWorktree(project: ProjectConfig, run: { started: string; main_head?: string; root_dirty?: string[] }, now = new Date()): { commits: string[]; files: string[] } | undefined {
  if (run.main_head === undefined) return undefined;
  const since = Date.parse(run.started) / 1000;
  let commits: string[] = [];
  try {
    const log = execFileSync('git', ['--no-optional-locks', '-C', project.root, 'log', '-g', '--date=unix', '--format=%H%x09%gd%x09%gs', baseRefOf(project)], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    commits = log.split('\n').flatMap(line => {
      const [hash, selector, subject] = line.split('\t');
      const at = Number(/@\{(\d+)\}/.exec(selector ?? '')?.[1]);
      return hash && at >= since && at <= now.getTime() / 1000 + 60 && /^commit( \(amend\))?:/.test(subject ?? '') ? [`${hash.slice(0, 9)} ${subject!.replace(/^commit( \(amend\))?: /, '')}`] : [];
    });
  } catch { /* no reflog */ }
  const before = new Set(run.root_dirty ?? []);
  const files = mainCheckoutState(project).dirty.filter(l => !before.has(l)).map(l => l.slice(3));
  return commits.length || files.length ? { commits, files } : undefined;
}

/** Where worktrees go: `dispatch.worktree_parent`, else a folder `<id>-worktrees` next to the repository (never inside it). */
export function worktreeParent(project: ProjectConfig): string {
  return project.dispatch.worktree_parent ? path.resolve(path.dirname(project.file), project.dispatch.worktree_parent) : path.resolve(project.root, '..', `${project.id}-worktrees`);
}

export function planWorktree(project: ProjectConfig, order: { tag: string; branch?: string; base_ref?: string; worktree?: string }): WorktreePlan {
  const name = `${project.id}-${order.tag.toLowerCase()}`;
  return { path: slash(order.worktree ?? path.join(worktreeParent(project), name)), branch: order.branch ?? name, baseRef: order.base_ref ? localRef(order.base_ref, `${order.tag}: base_ref`) : baseRefOf(project) };
}

/** A base must be a local branch: a remote-tracking ref may be stale. */
function localRef(ref: string, what: string): string {
  if (/^(origin\/|refs\/remotes\/)/.test(ref)) fail('{what} is {ref}: use a local branch such as refs/heads/main, not a remote-tracking ref.', { what, ref });
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

const defaultBase = new Map<string, string>();
/**
 * `dispatch.base_ref`, else `main` when the repository has it, else the branch the repository is on (`master`, `trunk`, ...).
 * The default is looked up once per repository.
 */
export function baseRefOf(project: ProjectConfig): string {
  if (project.dispatch.base_ref) return localRef(project.dispatch.base_ref, '"dispatch.base_ref"');
  let ref = defaultBase.get(project.root);
  if (!ref) {
    const run = (args: string[]) => { try { return execFileSync('git', ['-C', project.root, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
    ref = run(['rev-parse', '--verify', '--quiet', 'refs/heads/main']) ? 'refs/heads/main' : (run(['symbolic-ref', '--quiet', 'HEAD']) || 'refs/heads/main');
    defaultBase.set(project.root, ref);
  }
  return ref;
}

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    return fail('git {args} failed: {why}', { args: args.join(' '), why: String(err.stderr ?? err.message).trim().split('\n')[0] });
  }
}

const gitOk = (cwd: string, args: string[]): boolean => {
  try { execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 60000, windowsHide: true }); return true; } catch { return false; }
};

/** Fails with what to set when the base branch is not in the repository. */
export function checkBaseRef(project: ProjectConfig, ref: string): void {
  if (!gitOk(project.root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) fail('Base ref {ref} does not exist in {root}; set "dispatch.base_ref" in the project file to the branch work starts from.', { ref, root: project.root });
}

/** Creates the worktree if it is missing; reuses it if it already is on the right branch. Returns whether it was created. */
export function ensureWorktree(project: ProjectConfig, plan: WorktreePlan): { created: boolean } {
  checkBaseRef(project, plan.baseRef);
  if (existsSync(plan.path)) {
    const head = git(plan.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (head !== plan.branch) fail('{path} exists but is on branch "{head}", expected "{branch}". Not reusing it.', { path: plan.path, head, branch: plan.branch });
    return { created: false };
  }
  const branchExists = gitOk(project.root, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`]);
  git(project.root, branchExists ? ['worktree', 'add', plan.path, plan.branch] : ['worktree', 'add', '-b', plan.branch, plan.path, plan.baseRef]);
  return { created: true };
}

/** Is the branch's tip already part of the base branch? (The check behind `review approve` with manual merging.) */
export function branchIsMerged(project: ProjectConfig, branch: string): boolean {
  const ref = `refs/heads/${branch}`;
  if (!gitOk(project.root, ['show-ref', '--verify', '--quiet', ref])) fail('Branch "{branch}" does not exist in {root}; nothing to check the merge of.', { branch, root: project.root });
  return gitOk(project.root, ['merge-base', '--is-ancestor', ref, baseRefOf(project)]);
}

/** The shared git directory of a worktree: workers need write access to it to commit. */
export function commonGitDir(cwd: string): string {
  return slash(path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).trim()));
}

/** The private git directory of one worktree (inside the shared one): `<common>/worktrees/<name>`, or the shared one itself for the main checkout. */
export function worktreeGitDir(cwd: string): string {
  return slash(path.resolve(cwd, git(cwd, ['rev-parse', '--git-dir']).trim()));
}
