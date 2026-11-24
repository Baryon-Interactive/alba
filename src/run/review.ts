import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { readTemplate } from './prompt.ts';
import { mergeChild } from '../review/child-merge.ts';
import { branchIsMerged, baseRefOf } from './worktree.ts';
import { acceptanceMergeRunning, approveInTransaction, mergeAcceptance, recoverAcceptanceMerge, trialAcceptance } from '../review/acceptance.ts';
import { acceptDesignChanges, DesignAcceptanceError } from '../design/worker.ts';
import type { OrderDoc } from '../orders/model.ts';
import { intakeOutputDir } from '../design/docs.ts';
import { assertIndependentCheckPassed } from '../review/independent.ts';

export interface ApproveResult { acceptFile: string; merge: string; accept: string; parent?: string }

/**
 * Approve an order that is waiting for review. An optional acceptance pipeline owns trial and merge;
 * otherwise a person merges the branch and approve checks that it is already in the base branch:
 *  1. the stage must allow approving, and no run of the order may be open;
 *  2. the branch must already be merged (with a pipeline, a branch with no commits of its own must pass its trial);
 *  3. the project's accept command (if any) must succeed;
 *  4. <TAG>.accept.md is written (never overwritten); the design change sets and the approve action are recorded in one
 *     transaction, and the order becomes merged.
 * Nothing is recorded if a step fails, and a note this call wrote is removed again.
 */
export function approve(project: ProjectConfig, orders: Orders, tag: string, note?: string, withBranch?: string, override = false): ApproveResult {
  const doc = orders.get(tag);
  if (orders.actor === 'producer') assertIndependentCheckPassed(project, orders, tag);
  const stage = orders.stage(doc).stage;
  if (doc.order.kind === 'intake') {
    const changeDir = path.join(intakeOutputDir(project, orders, doc.order.tag), '.alba', 'design', 'changes');
    const systems = existsSync(changeDir) ? readdirSync(changeDir).filter(file => /^intake-.+\.json$/i.test(file)).map(file => file.replace(/^intake-/i, '').replace(/\.json$/i, '')) : [];
    const statuses = new Map<string, string>();
    for (const event of orders.store.events({ tag: doc.order.tag })) {
      if (event.type === 'run-start') for (const [system, status] of statuses) if (status === 'rejected') statuses.delete(system);
      if (['intake-system-accepted', 'intake-system-rejected', 'intake-system-dropped'].includes(event.type) && typeof event.data?.system === 'string') statuses.set(String(event.data.system), event.type.endsWith('accepted') ? 'accepted' : event.type.endsWith('dropped') ? 'dropped' : 'rejected');
    }
    const missing = systems.filter(system => !['accepted', 'dropped'].includes(statuses.get(system) ?? 'pending'));
    if (missing.length) fail('{tag} still has intake systems awaiting review: {systems}.', { tag: doc.order.tag, systems: missing.join(', ') });
  }
  if (stage === 'awaiting-user' && doc.reports.at(-1)?.subtasks) fail('Decide the split before approving the parent.');
  const overrideStage = ['failed', 'blocked', 'idle'].includes(stage) || (stage === 'awaiting-user' && doc.reports.length > 0);
  if (stage !== 'awaiting-review' && !overrideStage) fail('{tag} is {stage}; only an order that is awaiting review can be approved.', { tag: doc.order.tag, stage });
  if (overrideStage && !override) fail('{tag} is {stage}; approving it needs --override and a note of at least 10 characters.', { tag: doc.order.tag, stage });
  if (overrideStage && (note?.trim().length ?? 0) < 10) fail('An override approval needs a note of at least 10 characters.');
  // A run that is still open could change the branch or the worktree while the approval checks, merges and records them.
  const open = doc.runs.find(run => run.ended === undefined);
  if (open) fail('Run {run} of {tag} is still open; wait for it to end (or stop it) before approving.', { run: open.id, tag: doc.order.tag });
  // An order that came from a table has no branch: a person can name it here. It is recorded (when it exists), then checked as usual.
  if (withBranch?.trim()) {
    const named = withBranch.trim().replace(/^refs\/heads\//, '');
    if (named !== doc.order.branch) {
      branchIsMerged(project, named); // fails when the branch does not exist: nothing is recorded then
      orders.setGit(doc.order.tag, { branch: named });
    }
  }
  const branch = orders.get(doc.order.tag).order.branch;
  if (!branch) fail('{tag} has no branch recorded, so the merge cannot be checked. Name it: alba orders set {tag} --branch <branch>, or approve with --branch.', { tag: doc.order.tag });
  // A person who already merged the branch (by hand, with their own conflict fixes or as part of a batch) approves on the
  // manual path below: there is nothing left for the pipeline to trial or merge, and their acceptance note is kept.
  // While the pipeline merges (any order), its merge may already be on the base branch and still be rolled back by a failing
  // post-merge step: the "merged by hand" path below must not take that as a finished merge.
  const pipeline = !!project.accept || doc.order.kind === 'intake';
  if (pipeline && acceptanceMergeRunning(project)) fail('Acceptance failed: {reason}', { reason: 'Another acceptance merge is running.' });
  // A merge whose process died midway is rolled back to its recorded state before anything here reads the base branch.
  if (pipeline) {
    try { recoverAcceptanceMerge(project, orders); }
    catch (error) { fail('Acceptance failed: {reason}', { reason: (error as Error).message }); }
  }
  if (pipeline && !doc.order.parent && !doc.actions.some(a => a.kind === 'accept-split') && !branchIsMerged(project, branch)) {
    try { return mergeAcceptance(project, orders, doc.order.tag, note, orders.actor, override); }
    catch (error) { fail('Acceptance failed: {reason}', { reason: (error as Error).message }); }
  }
  if (!doc.order.parent && !branchIsMerged(project, branch)) {
    fail('Branch "{branch}" is not in {base} yet. Merge it yourself first (merging is manual in this version), then approve.', { branch, base: baseRefOf(project).replace('refs/heads/', '') });
  }
  // The branch is in the base. A person who merged it by hand made their own merge; a branch with no commits of its own
  // delivered nothing to merge, and its trial still has to pass: the pipeline's steps are never skipped for it.
  if (!doc.order.parent && (doc.order.kind === 'intake' || (project.accept && !mergedByHand(project, doc, branch)))) {
    const trial = trialAcceptance(project, orders, doc.order.tag, false, override);
    if (trial.status !== 'passed') fail('Acceptance failed: {reason}', { reason: trial.reason ?? `${doc.order.kind === 'intake' ? 'Intake check' : 'Trial'} ${trial.status}.` });
  }
  let accept = t('no accept command configured');
  if (project.dispatch.accept_command) {
    const cwd = doc.order.worktree && existsSync(doc.order.worktree) ? doc.order.worktree : project.root;
    const [program, ...args] = project.dispatch.accept_command.map(a => a.replace(/\{tag\}/g, doc.order.tag).replace(/\{cwd\}/g, cwd));
    try {
      execFileSync(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3600000, windowsHide: true, encoding: 'utf8' });
      accept = t('passed: {cmd}', { cmd: path.basename(program) });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      const tailText = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n');
      fail('The accept command failed:\n{tail}', { tail: tailText || err.message });
    }
  }
  if (doc.order.parent) {
    const merge = mergeChild(project, orders, tag, branch, note, override, commit => {
      if (pipeline) {
        const trial = trialAcceptance(project, orders, tag, false, override);
        if (trial.status !== 'passed') fail('Acceptance failed: {reason}', { reason: trial.reason || trial.status });
      }
      acceptDesignChanges(project, orders, tag, override, note, { commit });
    });
    return { acceptFile: '', merge, accept, parent: doc.order.parent };
  }
  const acceptFile = path.join(project.work_orders, `${doc.order.tag}.accept.md`);
  const noteWritten = !existsSync(acceptFile);
  if (noteWritten) {
    const latest = [...doc.reports].sort((a, b) => b.seq - a.seq)[0];
    const run = [...doc.runs].sort((a, b) => b.seq - a.seq)[0];
    const fill: Record<string, string> = {
      tag: doc.order.tag, date: new Date().toISOString().slice(0, 10), title: doc.order.title,
      run: run?.id ?? '-', worker: run?.worker ?? '-', status: latest?.status ?? '-', summary: latest?.summary ?? '-',
      commits: latest?.commits.join(', ') || '-', evidence: latest?.evidence.join(', ') || '-',
      merge: t('branch {branch} is in {base}', { branch, base: baseRefOf(project).replace('refs/heads/', '') }), accept,
    };
    writeFileSync(acceptFile, readTemplate('accept.md').replace(/\{(\w+)\}/g, (_, k: string) => fill[k] ?? ''), 'utf8');
  }
  // Library changes (read from the merged branch) and the approve action are recorded together or not at all; a note written
  // here is taken back when they are not, so no leftover note can approve the order later.
  let tip: string | undefined;
  try { tip = execFileSync('git', ['-C', project.root, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* checked above: the branch exists */ }
  try {
    approveInTransaction(project, orders, () => {
      acceptDesignChanges(project, orders, doc.order.tag, override, note, tip ? { commit: tip } : {});
      orders.act(doc.order.tag, 'approve', { note, ...(override ? { override: true } : {}) });
    });
  } catch (error) {
    if (noteWritten) rmSync(acceptFile, { force: true });
    if (error instanceof DesignAcceptanceError) {
      orders.record(doc.order.tag, 'accept-step', { name: 'design-changesets', status: 'failed', duration_ms: 0, reason: error.message });
      fail('Acceptance failed: {reason}', { reason: error.message });
    }
    throw error;
  }
  return { acceptFile: acceptFile.replace(/\\/g, '/'), merge: branch, accept };
}

/**
 * Did the branch bring commits of its own into the base (a person merged it by hand), or is it in the base only because it
 * never moved from where it started (a delivery with no commits)? The branch's reflog knows where it was created; without one,
 * a tip that came in through a merge (off the base's first-parent line) or a report that lists commits counts as merged.
 */
export function mergedByHand(project: ProjectConfig, doc: OrderDoc, branch: string): boolean {
  const run = (...args: string[]) => execFileSync('git', ['-C', project.root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const tip = run('rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
  let created: string | undefined;
  try { created = run('reflog', 'show', '--format=%H', `refs/heads/${branch}`).split('\n').filter(Boolean).at(-1); } catch { /* no reflog */ }
  if (created) return created !== tip;
  if (doc.reports.at(-1)?.commits.length) return true;
  return !run('rev-list', '--first-parent', baseRefOf(project)).split('\n').includes(tip);
}

/** Send-backs a person (or the producer) made on an order; automatic report, design and evidence bounces do not count. */
export function reworkCount(doc: OrderDoc): number {
  return doc.actions.filter(a => a.kind === 'rework' && !a.bounce).length;
}

/**
 * Send an order back with a note; the note goes into the next run's prompt. With `dispatch.max_reworks` set, a send-back past the
 * limit is refused unless `override` is given: an order that went back that often needs a new approach, a split or a person.
 */
export function rework(orders: Orders, tag: string, note: string | undefined, options: { max?: number; override?: boolean; phase?: string } = {}): void {
  const done = reworkCount(orders.get(tag));
  if (options.max !== undefined && done >= options.max && !options.override)
    fail('{tag} has been sent back {n} times (dispatch.max_reworks is {max}). Change the approach: split the order, write a new one, do it by hand, or send it back once more with --override.', { tag: orders.get(tag).order.tag, n: done, max: options.max });
  orders.act(tag, 'rework', { note, phase: options.phase });
}
