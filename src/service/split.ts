import { readFileSync, rmSync } from 'node:fs';
import type { ProjectConfig } from '../config.ts';
import { fail } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { childKinds, validateSubtasks } from '../orders/subtasks.ts';
import { baseRefOf, commonGitDir, ensureWorktree, planWorktree, worktreeGitDir } from '../run/worktree.ts';
import { fillOrderBody } from '../orders/templates.ts';
import { findOrderFile } from '../run/prompt.ts';
import { createOrder } from './new-order.ts';

export function autoAcceptSplit(project: ProjectConfig, orders: Orders, tag: string) {
  if (!project.split) return;
  const doc = orders.get(tag), report = doc.reports.at(-1);
  const policy = project.split.approve;
  const approval = typeof policy === 'string' ? policy : policy[doc.runs.at(-1)?.routing?.kind || doc.order.kind];
  if (!report?.subtasks || approval !== 'auto' || orders.stage(doc).waitingFor !== 'card') return;
  if (orders.store.events({ tag }).some(e => e.type === 'split-approval-failed' && e.data?.report === report.seq)) return;
  try { acceptSplit(project, orders, tag, undefined, report.seq, true); }
  catch (error) { orders.record(tag, 'split-approval-failed', { report: report.seq, reason: (error as Error).message }); }
}

export function acceptSplit(project: ProjectConfig, orders: Orders, tag: string, edits?: unknown, reportSeq?: number, automatic = false) {
  const files: string[] = [];
  return orders.store.transaction(() => {
    try {
      const doc = orders.get(tag), report = doc.reports.at(-1);
      if (doc.order.parent || doc.actions.some(a => a.kind === 'accept-split') || !report?.subtasks
        || (reportSeq !== undefined && report.seq !== reportSeq) || doc.runs.some(r => !r.ended)
        || orders.stage(doc).waitingFor !== 'card') fail('There is no current split proposal to accept.');
      const proposed = report.subtasks;
      let tasks = proposed;
      if (edits !== undefined) {
        if (!Array.isArray(edits)) fail('Split edits must list the retained children.');
        const kept = new Set(edits.map(e => e?.key));
        tasks = edits.map(edit => {
          const original = proposed.find(t => t.key === edit?.key);
          if (!original || Object.keys(edit).some(k => !['key', 'title', 'kind'].includes(k))) fail('A split edit can retain a key and change its title or kind.');
          return { ...original, ...edit, needs: original.needs?.filter(key => kept.has(key)) };
        });
      }
      tasks = validateSubtasks(tasks, childKinds(project));
      const tags = new Map(tasks.map((task, index) => [task.key, doc.order.tag + '.' + (index + 1)]));
      const plan = planWorktree(project, doc.order);
      if (('refs/heads/' + plan.branch).toLowerCase() === baseRefOf(project).toLowerCase()) fail('The integration branch must be separate from the project base.');
      ensureWorktree(project, plan);
      if (commonGitDir(plan.path) !== commonGitDir(project.root) || [worktreeGitDir(project.root), commonGitDir(project.root)].includes(worktreeGitDir(plan.path))) fail('Integration requires a linked parent worktree.');
      orders.setGit(tag, { branch: plan.branch, worktree: plan.path });
      for (const task of tasks) {
        const childTag = tags.get(task.key)!;
        // An interrupted transaction can leave an order body on disk. Reuse it only when its complete contents match.
        let body: string | undefined = task.body;
        let existing: string | undefined;
        try { existing = findOrderFile(project.work_orders, childTag); } catch { /* first materialization */ }
        if (existing) {
          const expected = fillOrderBody(project, task.kind, childTag, task.body).body;
          if (readFileSync(existing, 'utf8') === (expected.endsWith('\n') ? expected : expected + '\n')) body = undefined;
        }
        const child = createOrder({ ...project, dispatch_table: undefined }, orders, {
          parent: doc.order.tag, tag: childTag, kind: task.kind, title: task.title, body,
          base_ref: plan.branch, needs: task.needs?.map(key => tags.get(key)!), queue: true,
        });
        if (child.file) files.push(child.file);
      }
      orders.recordSplit(tag, report.seq, tasks.map(({ key, title, kind }) => ({ key, title, kind, tag: tags.get(key)! })), plan.branch, automatic);
    } catch (error) {
      for (const file of files) rmSync(file, { force: true });
      throw error;
    }
  });
}
