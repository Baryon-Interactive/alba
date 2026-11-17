import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { Run } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { orderBaseRef } from '../review/readiness.ts';
import { planWorktree } from '../run/worktree.ts';

interface GitOut {
  ok: boolean;
  out: string;
  err: string;
}

function gitRun(cwd: string, args: string[]): GitOut {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out, err: '' };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const out = typeof err.stdout === 'string' ? err.stdout : Buffer.isBuffer(err.stdout) ? err.stdout.toString('utf8') : '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : (err.message ?? '');
    return { ok: false, out, err: stderr.trim().split(/\r?\n/)[0] ?? '' };
  }
}

function canonical(p: string): string {
  try { return realpathSync.native(p); }
  catch { return path.resolve(p); }
}

function samePath(a: string, b: string): boolean {
  const ca = canonical(a), cb = canonical(b);
  return process.platform === 'win32' ? ca.toLowerCase() === cb.toLowerCase() : ca === cb;
}

/**
 * Merges the order's base branch into the order's linked worktree before delivery lint when
 * `dispatch.auto_merge_base` and `checks.base_merged` are both on and the branch is behind
 * the configured allowance. Never rebases, never resets, and never touches `project.root`
 * or any other checkout.
 */
export function mergeBaseBeforeReview(
  project: ProjectConfig,
  orders: Orders,
  tag: string,
  run?: Pick<Run, 'id' | 'cwd' | 'host'>,
): void {
  if (project.dispatch.auto_merge_base === false) return;
  if (!project.checks.base_merged) return;
  if (run?.host) return;

  let orderTag = tag;
  const runId = run?.id;
  try {
    const doc = orders.get(tag);
    orderTag = doc.order.tag;
    const plan = planWorktree(project, doc.order);
    const worktree = doc.order.worktree ?? run?.cwd ?? plan.path;
    if (!worktree || !existsSync(worktree)) return;

    const wtTopRes = gitRun(worktree, ['--no-optional-locks', 'rev-parse', '--show-toplevel']);
    const wtGitDirRes = gitRun(worktree, ['--no-optional-locks', 'rev-parse', '--git-dir']);
    const wtCommonRes = gitRun(worktree, ['--no-optional-locks', 'rev-parse', '--git-common-dir']);
    if (!wtTopRes.ok || !wtGitDirRes.ok || !wtCommonRes.ok) return;

    const wtTop = canonical(wtTopRes.out.trim());
    const wtGitDir = canonical(path.resolve(worktree, wtGitDirRes.out.trim()));
    const wtCommon = canonical(path.resolve(worktree, wtCommonRes.out.trim()));
    if (!samePath(wtTop, worktree)) return;
    if (samePath(wtGitDir, wtCommon)) return;

    const rootTopRes = gitRun(project.root, ['--no-optional-locks', 'rev-parse', '--show-toplevel']);
    const rootCommonRes = gitRun(project.root, ['--no-optional-locks', 'rev-parse', '--git-common-dir']);
    const rootTop = rootTopRes.ok && rootTopRes.out.trim() ? canonical(rootTopRes.out.trim()) : canonical(project.root);
    if (samePath(wtTop, project.root) || samePath(wtTop, rootTop)) return;
    if (rootCommonRes.ok && rootCommonRes.out.trim()) {
      const rootCommon = canonical(path.resolve(project.root, rootCommonRes.out.trim()));
      if (!samePath(wtCommon, rootCommon)) return;
    }

    const expectedBranch = (doc.order.branch ?? plan.branch).replace(/^refs\/heads\//, '');
    const headBranchRes = gitRun(worktree, ['--no-optional-locks', 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!headBranchRes.ok || headBranchRes.out.trim() !== expectedBranch) return;

    const baseRef = orderBaseRef(project, doc.order);
    const baseShaRes = gitRun(worktree, ['--no-optional-locks', 'rev-parse', '--verify', `${baseRef}^{commit}`]);
    if (!baseShaRes.ok || !baseShaRes.out.trim()) throw new Error(`base ref ${baseRef} could not be resolved`);
    const baseHead = baseShaRes.out.trim();

    const allowance = typeof project.checks.base_merged === 'object' ? project.checks.base_merged.max_behind : 0;
    const behindRes = gitRun(worktree, ['--no-optional-locks', 'rev-list', '--count', `HEAD..${baseHead}`]);
    if (!behindRes.ok) throw new Error(behindRes.err || 'could not count commits behind base');
    const behind = Number(behindRes.out.trim());
    if (!Number.isFinite(behind) || behind <= allowance) return;

    const mergeHeadPathRes = gitRun(worktree, ['--no-optional-locks', 'rev-parse', '--git-path', 'MERGE_HEAD']);
    const mergeHeadPath = mergeHeadPathRes.ok && mergeHeadPathRes.out.trim()
      ? path.resolve(worktree, mergeHeadPathRes.out.trim())
      : path.join(wtGitDir, 'MERGE_HEAD');
    if (existsSync(mergeHeadPath)) {
      orders.record(orderTag, 'base-merge-skipped', { ...(runId ? { run: runId } : {}), why: 'a merge is already in progress in the worktree' });
      return;
    }

    const trackedStatusRes = gitRun(worktree, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no']);
    if (!trackedStatusRes.ok) throw new Error(trackedStatusRes.err || 'could not read worktree status');
    if (trackedStatusRes.out.trim() !== '') {
      orders.record(orderTag, 'base-merge-skipped', { ...(runId ? { run: runId } : {}), why: 'worktree has uncommitted tracked changes' });
      return;
    }

    const beforeHeadRes = gitRun(worktree, ['--no-optional-locks', 'rev-parse', 'HEAD']);
    const beforePorcelainRes = gitRun(worktree, ['--no-optional-locks', 'status', '--porcelain']);
    if (!beforeHeadRes.ok || !beforeHeadRes.out.trim() || !beforePorcelainRes.ok) {
      throw new Error('could not snapshot worktree HEAD and status before merge');
    }
    const beforeHead = beforeHeadRes.out.trim();
    const beforePorcelain = beforePorcelainRes.out;

    const nameRes = gitRun(worktree, ['--no-optional-locks', 'config', '--get', 'user.name']);
    const emailRes = gitRun(worktree, ['--no-optional-locks', 'config', '--get', 'user.email']);
    const identityArgs: string[] = [];
    if (!nameRes.ok || !nameRes.out.trim()) identityArgs.push('-c', 'user.name=Alba');
    if (!emailRes.ok || !emailRes.out.trim()) identityArgs.push('-c', 'user.email=alba@localhost');

    const baseName = baseRef.replace(/^refs\/heads\//, '');
    const message = `Merge ${baseName} into ${expectedBranch} before review of ${orderTag} (Alba)`;
    const mergeRes = gitRun(worktree, [...identityArgs, 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', message, baseHead]);

    if (mergeRes.ok) {
      const afterHeadRes = gitRun(worktree, ['--no-optional-locks', 'rev-parse', 'HEAD']);
      if (!afterHeadRes.ok || !afterHeadRes.out.trim()) throw new Error('could not read HEAD after merge');
      orders.record(orderTag, 'base-merged-by-alba', {
        ...(runId ? { run: runId } : {}),
        base: baseName,
        base_head: baseHead,
        from: beforeHead,
        to: afterHeadRes.out.trim(),
        behind,
      });
      return;
    }

    const conflictListRes = gitRun(worktree, ['--no-optional-locks', '-c', 'core.quotepath=off', 'diff', '--name-only', '--diff-filter=U']);
    const files = conflictListRes.ok
      ? [...new Set(conflictListRes.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean))].sort()
      : [];

    if (existsSync(mergeHeadPath) || files.length > 0) {
      const abortRes = gitRun(worktree, ['merge', '--abort']);
      const afterHeadRes = gitRun(worktree, ['--no-optional-locks', 'rev-parse', 'HEAD']);
      const afterPorcelainRes = gitRun(worktree, ['--no-optional-locks', 'status', '--porcelain']);
      if (!abortRes.ok || !afterHeadRes.ok || !afterPorcelainRes.ok || afterHeadRes.out.trim() !== beforeHead || afterPorcelainRes.out !== beforePorcelain) {
        throw new Error(`merge --abort did not restore worktree state (${abortRes.err || 'state mismatch'})`);
      }
      orders.record(orderTag, 'base-merge-conflicted', {
        ...(runId ? { run: runId } : {}),
        base: baseName,
        files,
      });
      return;
    }

    const afterHeadRes = gitRun(worktree, ['--no-optional-locks', 'rev-parse', 'HEAD']);
    const afterPorcelainRes = gitRun(worktree, ['--no-optional-locks', 'status', '--porcelain']);
    if (!afterHeadRes.ok || !afterPorcelainRes.ok || afterHeadRes.out.trim() !== beforeHead || afterPorcelainRes.out !== beforePorcelain) {
      throw new Error(mergeRes.err || 'merge failed and changed worktree state');
    }
    orders.record(orderTag, 'base-merge-skipped', {
      ...(runId ? { run: runId } : {}),
      why: mergeRes.err || 'git merge refused before starting',
    });
  } catch (e) {
    try {
      orders.record(orderTag, 'base-merge-skipped', {
        ...(runId ? { run: runId } : {}),
        why: (e as Error).message.split(/\r?\n/)[0] || String(e),
      });
    } catch {
      /* recording failure must never stop finish */
    }
  }
}
