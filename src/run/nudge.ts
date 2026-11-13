import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import type { OrderActivity, Problem } from '../tick/plan.ts';
import type { Probes } from '../tick/gather.ts';
import { appendInbox } from './inbox.ts';
import { readStateJson, writeStateFile, stateTransaction } from '../orders/state-files.ts';
import type { StateProject } from '../orders/backend.ts';

/** One reminder already sent for an open run. `count` is how many, `at` is the last one. */
export interface NudgeRecord { at: string; count: number; files: number; minutes: number }

export function readNudges(target: StateProject | string): Record<string, NudgeRecord> { return readStateJson(target, '_nudges.json', {}); }

export const nudgeKey = (tag: string, runId: string): string => `${tag}:${runId}`;

/** The inbox sentence. One per period, and only while files are still changed. */
export function nudgeSentence(files: number, minutes: number): string {
  return t('You have {n} changed files and no commit for {m} minutes: commit now (work in progress is fine), then go on.', { n: files, m: minutes });
}

/** Quiet time starts at the later of the run's start and a commit made during the run. */
function quietAnchor(started: string, lastCommitAt: string | undefined): string {
  if (!lastCommitAt || Date.parse(lastCommitAt) <= Date.parse(started)) return started;
  return lastCommitAt;
}

/**
 * Open runs with changed files and no commit for `commit_nudge_minutes`.
 * A real tick (`write`) leaves one inbox message per full period. The second one, while the tree is still dirty, is a finding.
 * `0` turns the reminder off. Reading an earlier second nudge still reports it on a dry run.
 */
export function applyNudges(project: ProjectConfig, orders: Orders, probes: Probes, activity: Record<string, OrderActivity>, write: boolean): Problem[] {
  return stateTransaction(project, () => {
    const period = project.dispatch.commit_nudge_minutes;
    const state = readNudges(project);
    const problems: Problem[] = [];
    let changed = false;
    const now = probes.now().getTime();
    for (const doc of orders.all()) {
      const open = doc.runs.find(r => r.ended === undefined && !r.imported);
      if (!open) continue;
      const tag = doc.order.tag;
      const act = activity[tag];
      const files = act?.dirtyFiles ?? 0;
      const worktree = doc.order.worktree ?? act?.worktree;
      const key = nudgeKey(tag, open.id);
      const prev = state[key];
      const quietMin = Math.floor((now - Date.parse(quietAnchor(open.started, act?.lastCommitAt))) / 60000);
      if (write && period > 0 && files > 0 && worktree && quietMin >= period) {
        const due = !prev || now - Date.parse(prev.at) >= period * 60000;
        if (due) {
          const text = nudgeSentence(files, quietMin);
          appendInbox(worktree, { at: new Date(now).toISOString(), author: 'alba', text });
          orders.record(tag, 'commit-nudge', { run: open.id, files, minutes: quietMin, text });
          state[key] = { at: new Date(now).toISOString(), count: (prev?.count ?? 0) + 1, files, minutes: quietMin };
          changed = true;
        }
      }
      const current = state[key];
      if (period > 0 && current && current.count >= 2 && files > 0) {
        problems.push({ kind: 'commit-nudge', tag, text: t('{tag}: nudged twice to commit ({n} changed files, quiet for {m} min).', { tag, n: files, m: quietMin }) });
      }
    }
    if (changed) {
      writeStateFile(project, '_nudges.json', JSON.stringify(state));
    }
    return problems;
  });
}
