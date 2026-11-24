import { mkdtempSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { baseRefOf, commonGitDir, ensureWorktree, git, planWorktree, worktreeGitDir } from '../run/worktree.ts';

/** Prepare the exact two-parent commit off branch. Only a successful approval advances the linked parent checkout. */
export function mergeChild(project: ProjectConfig, orders: Orders, tag: string, branch: string, note: string | undefined,
  override: boolean, check: (commit: string) => void) {
  const result = orders.store.transaction(() => {
    const child = orders.get(tag), parent = orders.get(child.order.parent!);
    const decision = parent.actions.find(a => a.kind === 'accept-split');
    const plan = planWorktree(project, parent.order);
    if (!decision?.children?.includes(child.order.tag) || decision.branch !== plan.branch || child.order.base_ref !== plan.branch
      || branch === plan.branch || ('refs/heads/' + plan.branch).toLowerCase() === baseRefOf(project).toLowerCase()) fail('The recorded parent integration branch does not match.');
    if (parent.runs.some(r => !r.ended) || child.runs.some(r => !r.ended) || orders.stage(parent).stage === 'cancelled') fail('Cannot integrate while a run is open or the parent is cancelled.');
    if (child.order.branch !== branch) fail('The child branch changed before integration.');
    ensureWorktree(project, plan);
    if (commonGitDir(plan.path) !== commonGitDir(project.root) || worktreeGitDir(plan.path) === worktreeGitDir(project.root)
      || git(plan.path, ['symbolic-ref', 'HEAD']).trim() !== 'refs/heads/' + plan.branch
      || git(plan.path, ['status', '--porcelain', '--untracked-files=no']).trim()) fail('Integration requires a clean linked worktree on the recorded parent branch.');
    const before = git(plan.path, ['rev-parse', 'HEAD']).trim();
    const tip = git(project.root, ['rev-parse', '--verify', 'refs/heads/' + branch + '^{commit}']).trim();
    const temp = mkdtempSync(path.join(project.state_dir, 'child-merge-'));
    let registered = false;
    try {
      git(project.root, ['worktree', 'add', '--detach', temp, before]);
      registered = true;
      try {
        git(temp, ['-c', 'user.name=Alba', '-c', 'user.email=alba@localhost', 'merge', '--no-ff', '--no-edit', '-m', 'Integrate ' + child.order.tag, tip]);
      } catch (error) {
        const files = git(temp, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
        if (!files.length) throw error;
        const conflict = t('Merge or rebase from {branch} at {commit} and resolve: {files}', { branch: plan.branch, commit: before, files: files.join(', ') });
        orders.act(tag, 'rework', { note: conflict });
        return { conflict };
      }
      const commit = git(temp, ['rev-parse', 'HEAD']).trim();
      check(commit);
      orders.act(tag, 'approve', { note, override, commit });
      orders.record(tag, 'merged-into-parent', { parent: parent.order.tag, branch: plan.branch, commit, tip });
      if (git(plan.path, ['rev-parse', 'HEAD']).trim() !== before) fail('The parent advanced during integration. Retry approval.');
      git(plan.path, ['merge', '--ff-only', commit]);
      return { commit };
    } finally {
      if (registered) git(project.root, ['worktree', 'remove', '--force', temp]);
      else rmdirSync(temp);
    }
  });
  // A conflict is a durable rework decision, even though the approval request returns an error.
  if (result.conflict) fail('{reason}', { reason: result.conflict });
  return result.commit!;
}
