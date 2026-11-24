import { mkdtempSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { acceptDesignChanges } from '../design/worker.ts';
import { fail, t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { revisionOf } from '../orders/store.ts';
import { baseRefOf, commonGitDir, ensureWorktree, git, planWorktree, worktreeGitDir } from '../run/worktree.ts';
import { orderBaseRef } from './readiness.ts';
import { trialAcceptance } from './acceptance.ts';

/** Run the trial and prepare the merge off branch. Hold the state lock only to publish a decision on those exact inputs. */
export function mergeChild(project: ProjectConfig, orders: Orders, tag: string, branch: string, note: string | undefined,
  override: boolean, pipeline: boolean): string {
  const child = orders.get(tag), parent = orders.get(child.order.parent!);
  const decision = parent.actions.find(a => a.kind === 'accept-split');
  const plan = planWorktree(project, parent.order);
  const parentRef = 'refs/heads/' + plan.branch;
  if (!decision?.children?.includes(child.order.tag) || decision.branch !== plan.branch || orderBaseRef(project, child.order) !== parentRef
    || branch === plan.branch || parentRef.toLowerCase() === baseRefOf(project).toLowerCase()) fail('The recorded parent integration branch does not match.');
  if (parent.runs.some(r => !r.ended) || child.runs.some(r => !r.ended) || orders.stage(parent).stage === 'cancelled') fail('Cannot integrate while a run is open or the parent is cancelled.');
  if (child.order.branch !== branch) fail('The child branch changed before integration.');
  const sha = (ref: string) => git(project.root, ['rev-parse', '--verify', ref + '^{commit}']).trim();
  const childRef = 'refs/heads/' + branch, before = sha(parentRef), tip = sha(childRef);
  ensureWorktree(project, plan);
  const unchanged = () => {
    if (revisionOf(orders.get(tag)) !== revisionOf(child) || revisionOf(orders.get(parent.order.tag)) !== revisionOf(parent)
      || sha(parentRef) !== before || sha(childRef) !== tip) fail('Integration inputs changed. Retry approval.');
    const common = commonGitDir(project.root);
    if (commonGitDir(plan.path) !== common || [worktreeGitDir(project.root), common].includes(worktreeGitDir(plan.path))
      || git(plan.path, ['symbolic-ref', 'HEAD']).trim() !== parentRef
      || git(plan.path, ['status', '--porcelain', '--untracked-files=no']).trim()) fail('Integration requires a clean linked worktree on the recorded parent branch.');
  };
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
      orders.store.transaction(() => {
        unchanged();
        orders.act(tag, 'rework', { note: conflict });
      });
      return fail('{reason}', { reason: conflict });
    }
    const commit = git(temp, ['rev-parse', 'HEAD']).trim();
    if (pipeline) {
      const trial = trialAcceptance(project, orders, tag, false, override);
      if (trial.status !== 'passed') fail('Acceptance failed: {reason}', { reason: trial.reason || trial.status });
      if (trial.base !== before || trial.branch !== tip) fail('Integration inputs changed. Retry approval.');
    }
    orders.store.transaction(() => {
      unchanged();
      acceptDesignChanges(project, orders, tag, override, note, { commit });
      orders.act(tag, 'approve', { note, override, commit });
      orders.record(tag, 'merged-into-parent', { parent: parent.order.tag, branch: plan.branch, commit, tip });
      git(plan.path, ['merge', '--ff-only', commit]);
    });
    return commit;
  } finally {
    if (registered) git(project.root, ['worktree', 'remove', '--force', temp]);
    else rmdirSync(temp);
  }
}
