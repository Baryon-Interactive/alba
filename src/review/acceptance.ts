import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { acceptDesignChanges, DesignAcceptanceError, pinnedDesignChanges } from '../design/worker.ts';
import { lockHeld, tryLock } from '../fs/lock.ts';
import { stateStore } from '../orders/backend.ts';
import { writeFileAtomic } from '../orders/store.ts';
import { checkIntake, intakeOutputDir } from '../design/docs.ts';
import type { Orders } from '../orders/service.ts';
import { baseRefOf } from '../run/worktree.ts';
import { globToRegExp, type CheckItem } from '../check/general.ts';
import { deliveryChecks } from '../check/delivery.ts';
import { findOrderFile } from '../run/prompt.ts';
import { parseOrderSections } from '../verify/verify.ts';
import { acquireAcceptanceResources, releaseAcceptanceResources } from '../resources/leases.ts';
import { independentChecks, needsIndependentCheck, assertIndependentCheckPassed, type IndependentCheck } from './independent.ts';

/** Intake orders always have a mechanical acceptance step, even when the project
 * has no general acceptance pipeline configured. Other order kinds keep the
 * existing opt-in behaviour. */
function acceptConfigFor(project: ProjectConfig, kind: string): NonNullable<ProjectConfig['accept']> | undefined {
  if (project.accept) return project.accept;
  if (kind !== 'intake') return undefined;
  return {
    git_timeout_minutes: 2,
    conflicts: { take_base: [], take_branch: [], drop: [] },
    steps: [],
    merge_message: 'Merge {tag}: {title}',
    post_merge: [],
    push: false,
    parallel: 1,
  };
}

export interface AcceptStepResult { name: string; status: 'passed' | 'failed' | 'skipped'; duration_ms: number; code?: number | null; tail: string; log?: string; issues?: string[]; classified?: number; blocks?: number }
export interface AcceptanceTrial {
  id: string;
  fingerprint: string;
  report: number;
  base: string;
  branch: string;
  status: 'passed' | 'failed' | 'waiting';
  at: string;
  changed: string[];
  conflicts: string[];
  steps: AcceptStepResult[];
  reason?: string;
  retryable?: boolean;
  log_dir?: string;
}
export interface AcceptanceCard {
  pipelineRequired?: boolean;
  independent?: IndependentCheck[];
  independentRequired?: boolean;
  tag: string;
  title: string;
  href: string;
  lint: CheckItem[];
  trial?: AcceptanceTrial;
  changed: string[];
  images: string[];
}

function git(cwd: string, ...args: string[]): string {
  return timedGit(2, cwd, ...args);
}
function timedGit(minutes: number, cwd: string, ...args: string[]): string {
  const output = execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: Math.ceil(minutes * 60000), stdio: ['ignore', 'pipe', 'pipe'] });
  return args.includes('-z') ? output : output.trim();
}
const tail = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim().slice(-4000);
const matches = (file: string, globs: string[]) => globs.some(g => globToRegExp(g).test(file));
type CommandError = { stderr?: string; message?: string; code?: string; signal?: string; killed?: boolean };
const interrupted = (e: unknown): boolean => { const err = e as CommandError; return err.code === 'ETIMEDOUT' || !!err.signal || err.killed === true; };
const errorText = (e: unknown): string => {
  const err = e as CommandError;
  const prefix = err.code === 'ETIMEDOUT' ? 'Command timed out (ETIMEDOUT): ' : err.signal || err.killed ? `Command terminated (${err.signal || 'killed'}): ` : '';
  return prefix + tail(String(err.stderr || err.message || e));
};
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Cross-process slots; a stopped host's slot can be recovered without touching its checkout. */
function lock(project: ProjectConfig, name: string, slots = 1): (() => void) | undefined {
  const dir = path.join(project.state_dir, 'acceptance');
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < slots; index++) {
    const release = tryLock(path.join(dir, `${name}-${index}.lock`));
    if (release) return release;
  }
  return undefined;
}

/** An acceptance merge holds the project's merge slot right now (its process is alive). */
export function acceptanceMergeRunning(project: ProjectConfig): boolean {
  return lockHeld(path.join(project.state_dir, 'acceptance', 'merge-0.lock'));
}

/** Approval never runs beside a worker: a run that is still open could change the branch or the worktree under the merge. */
export function assertNoOpenRun(orders: Orders, tag: string): void {
  const open = orders.get(tag).runs.find(run => run.ended === undefined);
  if (open) throw new Error(`Run ${open.id} of ${tag} is still open; wait for it to end (or stop it) before approving.`);
}

/**
 * What an acceptance merge has done so far, written down before each step that changes something outside the state: the base
 * branch's tip before the merge, the merge commit, the note, and what the push changed on the remote. A merge that fails is
 * rolled back to it; one whose process died is rolled back by the next merge (or `recoverAcceptanceMerge`).
 */
interface MergeJournal {
  tag: string;
  at: string;
  original: string;
  branch: string;
  merge?: string;
  note?: string;
  push?: { remote: string; ref: string; before: string; done?: boolean };
}
const journalFile = (project: ProjectConfig) => path.join(project.state_dir, 'acceptance', 'merge-journal.json');
const writeJournal = (project: ProjectConfig, journal: MergeJournal) => writeFileAtomic(journalFile(project), JSON.stringify(journal, null, 2) + '\n');

/** Where `push` sends the base branch: its upstream, else origin with the same name. */
function pushTarget(project: ProjectConfig): { remote: string; ref: string } {
  const base = baseRefOf(project), name = base.replace(/^refs\/heads\//, '');
  const config = (key: string) => { try { return git(project.root, 'config', '--get', key); } catch { return ''; } };
  return { remote: config(`branch.${name}.remote`) || 'origin', ref: config(`branch.${name}.merge`) || base };
}

/** Puts everything a journal records back, newest first. Returns what could not be undone (empty when all of it was). */
function rollbackMerge(project: ProjectConfig, orders: Orders, journal: MergeJournal): string {
  const problems: string[] = [];
  const attempt = (what: string, undo: () => void) => { try { undo(); } catch (error) { problems.push(`${what}: ${errorText(error)}`); } };
  const timeout = project.accept?.git_timeout_minutes ?? 2;
  if (journal.push && journal.merge) {
    const push = journal.push;
    attempt('restore the remote branch', () => {
      // Only while the remote still has our merge: a newer push by someone else is never overwritten.
      const remote = timedGit(timeout, project.root, 'ls-remote', push.remote, push.ref).split(/\s+/)[0] ?? '';
      if (remote !== journal.merge) return;
      timedGit(timeout, project.root, 'push', `--force-with-lease=${push.ref}:${journal.merge}`, push.remote, push.before ? `${push.before}:${push.ref}` : `:${push.ref}`);
      orders.record(journal.tag, 'accept-push-reverted', { remote: push.remote, ref: push.ref, from: journal.merge, to: push.before || null });
    });
  }
  if (journal.note) attempt('remove the acceptance note', () => { if (existsSync(journal.note!)) unlinkSync(journal.note!); });
  attempt('restore the base branch', () => {
    const head = git(project.root, 'rev-parse', 'HEAD');
    const mergeHead = path.resolve(project.root, git(project.root, 'rev-parse', '--git-path', 'MERGE_HEAD'));
    if (journal.merge && head === journal.merge) {
      // Preserve any command output or concurrent edits before restoring the original branch tip.
      // Unlike a hard reset this keeps those files recoverable in Git's stash.
      if (git(project.root, 'status', '--porcelain=v1', '--untracked-files=all')) {
        git(project.root, 'stash', 'push', '--include-untracked', '-m', `Acceptance rollback ${journal.tag}`);
        orders.record(journal.tag, 'accept-rollback-saved', { stash: git(project.root, 'rev-parse', 'refs/stash') });
      }
      git(project.root, 'reset', '--merge', journal.original);
    } else if (!journal.merge && existsSync(mergeHead)) git(project.root, 'merge', '--abort');
    else if (head !== journal.original) throw new Error(`the base branch is at ${head.slice(0, 12)}, neither the merge nor ${journal.original.slice(0, 12)}; left as it is`);
  });
  return problems.join('; ');
}

/**
 * A merge whose process died midway left its journal: roll it back to the recorded state, unless the order was approved (then
 * only the journal is left to remove). Called under the merge lock.
 */
function recoverJournal(project: ProjectConfig, orders: Orders): void {
  const file = journalFile(project);
  if (!existsSync(file)) return;
  let journal: MergeJournal;
  try { journal = JSON.parse(readFileSync(file, 'utf8')) as MergeJournal; }
  catch { unlinkSync(file); return; }
  const approved = orders.stage(orders.get(journal.tag)).stage === 'merged';
  if (!approved) {
    const problems = rollbackMerge(project, orders, journal);
    orders.record(journal.tag, 'accept-merge-recovered', { original: journal.original, merge: journal.merge ?? null, ...(problems ? { rollback: problems } : {}) });
    if (problems) throw new Error(`An earlier acceptance merge of ${journal.tag} stopped midway and could not be rolled back: ${problems}. Fix it by hand, then delete ${file.replace(/\\/g, '/')}.`);
  }
  unlinkSync(file);
}

/** Rolls back an acceptance merge that stopped midway (its process died). Nothing happens while another merge is running. */
export function recoverAcceptanceMerge(project: ProjectConfig, orders: Orders): void {
  if (!existsSync(journalFile(project))) return;
  const release = lock(project, 'merge');
  if (!release) return;
  try { recoverJournal(project, orders); } finally { release(); }
}

function inputs(project: ProjectConfig, orders: Orders, tag: string, override = false) {
  const doc = orders.get(tag), report = doc.reports.at(-1);
  const accept = acceptConfigFor(project, doc.order.kind);
  if (!accept) throw new Error('No acceptance pipeline configured.');
  const stage = orders.stage(doc).stage;
  if (!report || !((stage === 'awaiting-review' && report.status === 'ready') || (override && ['failed', 'awaiting-user'].includes(stage)))) throw new Error('Acceptance requires a ready delivery awaiting review, or an explicit override for a failed or awaiting-user delivery with a report.');
  if (!doc.order.branch) throw new Error('Acceptance requires a recorded branch.');
  const base = git(project.root, 'rev-parse', '--verify', `${baseRefOf(project)}^{commit}`);
  const branch = git(project.root, 'rev-parse', '--verify', `refs/heads/${doc.order.branch}^{commit}`);
  const ancestor = git(project.root, 'merge-base', base, branch);
  const changed = git(project.root, 'diff', '--name-only', '--no-renames', '-z', ancestor, branch).split('\0').filter(Boolean);
  // Change sets that live only in the worktree are part of what was tried: an edit after the trial makes the inputs stale.
  const pins = report.design_changes?.length ? pinnedDesignChanges(project, orders, tag, branch) : {};
  const key = fingerprint({ base, branch, report: report.seq, accept, checks: project.checks, ...(Object.keys(pins).length ? { design: pins } : {}) });
  return { doc, report, base, branch, changed, key, accept, pins };
}

export function latestAcceptanceTrial(orders: Orders, tag: string): AcceptanceTrial | undefined {
  return orders.store.events({ tag }).filter(e => e.type === 'accept-trial').at(-1)?.data as unknown as AcceptanceTrial | undefined;
}

/** Merge from the base side in both trial and real checkout, so conflict sides have identical meanings. */
export function mergeWithRules(project: ProjectConfig, cwd: string, branch: string, accept = project.accept): string[] {
  const runGit = (...args: string[]) => timedGit(accept?.git_timeout_minutes ?? 2, cwd, ...args);
  try { runGit('merge', '--no-ff', '--no-commit', '--', branch); return []; }
  catch (error) {
    if (interrupted(error)) throw error;
    const conflicts = runGit('diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
    if (!conflicts.length) throw error;
    const unknown: string[] = [];
    for (const file of conflicts) {
      const rules = accept?.conflicts ?? { take_base: [], take_branch: [], drop: [] };
      const choices = (['take_base', 'take_branch', 'drop'] as const).filter(key => matches(file, rules[key]));
      if (choices.length !== 1) { unknown.push(file); continue; }
      const choice = choices[0];
      const stages = runGit('ls-files', '--unmerged', '--', file);
      if (choice === 'drop') {
        // Drop only modify/delete conflicts. An add/add or content conflict needs a reviewer.
        if (/ 2\t/.test(stages) && / 3\t/.test(stages)) { unknown.push(file); continue; }
        runGit('rm', '-f', '--', file);
      } else {
        const stage = choice === 'take_base' ? 2 : 3;
        if (!new RegExp(` ${stage}\\t`).test(stages)) runGit('rm', '-f', '--', file);
        else { runGit('checkout', choice === 'take_base' ? '--ours' : '--theirs', '--', file); runGit('add', '--', file); }
      }
    }
    return unknown;
  }
}

function runCommand(command: string[], cwd: string, minutes: number, log: string, name: string): AcceptStepResult {
  const started = Date.now();
  const fd = openSync(log, 'w');
  try {
    const ran = spawnSync(command[0], command.slice(1), { cwd, shell: false, windowsHide: true, timeout: minutes * 60000, stdio: ['ignore', fd, fd] });
    const output = readFileSync(log, 'utf8');
    return { name, status: !ran.error && ran.status === 0 ? 'passed' : 'failed', code: ran.status, duration_ms: Date.now() - started, tail: tail(output + (ran.error ? `\n${ran.error.message}` : '')), log };
  } finally { closeSync(fd); }
}

function runIntakeCheck(project: ProjectConfig, orders: Orders, scratch: string, log: string): AcceptStepResult {
  const started = Date.now();
  try {
    // The delivery checkout supplies only the worker outputs. Design documents
    // must be resolved from the real project records so this read-only check
    // cannot rewrite file-backed paths or versions in SQLite.
    const result = checkIntake({ ...project, root: scratch }, orders, path.join(scratch, '.alba'), project);
    writeFileSync(log, JSON.stringify(result, null, 2) + '\n', 'utf8');
    return { name: 'intake-check', status: result.ok ? 'passed' : 'failed', code: result.ok ? 0 : 1, duration_ms: Date.now() - started, tail: `${result.classified}/${result.blocks} blocks classified`, classified: result.classified, blocks: result.blocks, issues: result.issues.map(issue => issue.message), log };
  } catch (error) {
    const message = String((error as Error).message ?? error); writeFileSync(log, message + '\n', 'utf8');
    return { name: 'intake-check', status: 'failed', code: 1, duration_ms: Date.now() - started, tail: message, log };
  }
}

/** Check delivered intake output before a person reviews individual systems. */
export function runDeliveredIntakeCheck(project: ProjectConfig, orders: Orders, tag: string): AcceptStepResult | undefined {
  const doc = orders.get(tag), report = doc.reports.at(-1);
  if (doc.order.kind !== 'intake' || report?.status !== 'ready') return undefined;
  const prior = orders.store.events({ tag }).filter(event => event.type === 'accept-step' && event.data?.name === 'intake-check' && event.data?.report === report.seq).at(-1);
  if (prior?.data) return prior.data as unknown as AcceptStepResult;
  const started = Date.now(), output = intakeOutputDir(project, orders, tag);
  let result: AcceptStepResult;
  try {
    const checked = checkIntake({ ...project, root: output }, orders, path.join(output, '.alba'), project);
    result = { name: 'intake-check', status: checked.ok ? 'passed' : 'failed', code: checked.ok ? 0 : 1, duration_ms: Date.now() - started, tail: `${checked.classified}/${checked.blocks} blocks classified`, classified: checked.classified, blocks: checked.blocks, issues: checked.issues.map(issue => issue.message) };
  } catch (error) {
    const message = String((error as Error).message ?? error);
    result = { name: 'intake-check', status: 'failed', code: 1, duration_ms: Date.now() - started, tail: message, issues: [message] };
  }
  orders.record(tag, 'accept-step', { report: report.seq, ...result });
  return result;
}

/** Runs once for immutable delivery inputs; automatic callers delay interrupted Git retries. */
export function trialAcceptance(project: ProjectConfig, orders: Orders, tag: string, force = false, override = false, retryIntervalMs = 0): AcceptanceTrial {
  const input = inputs(project, orders, tag, override);
  const previous = latestAcceptanceTrial(orders, tag);
  if (!force && previous?.fingerprint === input.key && previous.status !== 'waiting') {
    if (!previous.retryable || (retryIntervalMs > 0 && Date.now() - Date.parse(previous.at) < retryIntervalMs)) return previous;
  }
  const result: AcceptanceTrial = { id: randomUUID(), fingerprint: input.key, report: input.report.seq, base: input.base, branch: input.branch, status: 'waiting', at: new Date().toISOString(), changed: input.changed, conflicts: [], steps: [] };
  const record = () => { if (result.status !== 'waiting' || previous?.reason !== result.reason || previous?.fingerprint !== result.fingerprint) orders.record(tag, 'accept-trial', { ...result }); return result; };
  const lint = deliveryChecks(project, input.doc, input.doc.order.worktree ?? project.root);
  if (lint.some(i => !i.ok)) { result.reason = 'Delivery lint must pass before a trial.'; return record(); }
  const release = lock(project, 'trial', input.accept.parallel);
  if (!release) { result.reason = 'Another acceptance trial holds the project slot.'; return record(); }
  let resources = false, creationAttempted = false;
  const scratch = path.resolve(project.state_dir, 'acceptance', `trial-${result.id}`);
  const trialGit = (...args: string[]) => timedGit(input.accept.git_timeout_minutes ?? 2, project.root, ...args);
  const logs = path.join(project.state_dir, 'acceptance', `logs-${result.id}`);
  result.log_dir = logs;
  try {
    mkdirSync(logs, { recursive: true });
    const needed = [...new Set(input.accept.steps.filter(s => !s.when_changed || input.changed.some(f => matches(f, s.when_changed!))).flatMap(s => s.resource ? [s.resource] : []))];
    const blocked = acquireAcceptanceResources(project, orders, tag, needed);
    if (blocked) { result.reason = blocked; return record(); }
    resources = true;
    creationAttempted = true;
    trialGit('worktree', 'add', '--detach', scratch, input.base);
    result.conflicts = mergeWithRules(project, scratch, input.branch, input.accept);
    if (result.conflicts.length) { result.status = 'failed'; result.reason = `Unknown conflicts: ${result.conflicts.join(', ')}`; }
    else {
      const steps = input.doc.order.kind === 'intake' ? [{ name: 'intake-check', command: [], timeout_minutes: 1 }, ...input.accept.steps] : input.accept.steps;
      for (const [index, step] of steps.entries()) {
        const stepResult: AcceptStepResult = step.when_changed && !input.changed.some(f => matches(f, step.when_changed!))
          ? { name: step.name, status: 'skipped', duration_ms: 0, tail: 'No matching changed paths.' }
          : step.name === 'intake-check' ? runIntakeCheck(project, orders, scratch, path.join(logs, `step-${index + 1}.log`)) : runCommand(step.command, scratch, step.timeout_minutes, path.join(logs, `step-${index + 1}.log`), step.name);
        result.steps.push(stepResult);
        orders.record(tag, 'accept-step', { trial: result.id, ...stepResult });
        if (stepResult.status === 'failed') { result.status = 'failed'; result.reason = `Step ${step.name} failed: ${stepResult.tail}`; break; }
      }
      if (result.status !== 'failed') result.status = 'passed';
    }
  } catch (e) { result.status = 'failed'; result.reason = errorText(e); if (interrupted(e)) result.retryable = true; }
  finally {
    try {
      // Double force is restricted to this generated state_dir/acceptance/trial-* path.
      if (creationAttempted) for (const args of [...(existsSync(scratch) ? [['worktree', 'remove', '-f', '-f', scratch]] : []), ['worktree', 'prune']]) {
        try { trialGit(...args); }
        catch (e) {
          result.status = 'failed';
          result.reason = [result.reason, `Scratch cleanup failed: ${errorText(e)}`].filter(Boolean).join('\n');
          if (interrupted(e)) result.retryable = true;
        }
      }
    }
    finally { try { if (resources) releaseAcceptanceResources(project, orders, tag); } finally { release(); } }
  }
  writeFileSync(path.join(logs, 'trial.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  return record();
}

/** Read-only view shared by the order, producer and session. Evidence globs expand in the delivery checkout. */
export function acceptanceCard(project: ProjectConfig, orders: Orders, tag: string): AcceptanceCard | undefined {
  const doc = orders.get(tag), root = doc.order.worktree ?? project.root;
  const independent = independentChecks(orders, doc.order.tag);
  const independentRequired = needsIndependentCheck(project, doc);
  if (!acceptConfigFor(project, doc.order.kind) && !independentRequired && !independent.length) return undefined;
  const events = orders.store.events({ tag: doc.order.tag });
  const lint = events.filter(e => e.type === 'check' && e.data?.delivery === true && e.data?.report === doc.reports.at(-1)?.seq).at(-1)?.data?.lint as CheckItem[] | undefined;
  let patterns: string[] = [];
  try { patterns = parseOrderSections(readFileSync(findOrderFile(project.work_orders, tag), 'utf8')).evidence.map(e => e.path.replace(/^`|`$/g, '').replace(/\{tag\}/g, tag).replace(/\{tag_lower\}/g, tag.toLowerCase())); } catch { /* absent body */ }
  const images = new Set<string>();
  const add = (file: string) => { if (/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file)) images.add(path.resolve(root, file)); };
  for (const pattern of patterns) {
    if (!/[*?]/.test(pattern)) { if (existsSync(path.resolve(root, pattern))) add(pattern); continue; }
    const normalized = pattern.replace(/\\/g, '/'), prefix = normalized.slice(0, normalized.search(/[*?]/));
    const start = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    const walk = (relative: string) => {
      const dir = path.resolve(root, relative);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.posix.join(relative, entry.name);
        if (entry.isFile() && matches(file, [normalized])) add(file);
        if (entry.isDirectory() && !['.git', 'node_modules', 'Intermediate', 'DerivedDataCache'].includes(entry.name)) walk(file);
      }
    };
    walk(start);
  }
  const trial = latestAcceptanceTrial(orders, doc.order.tag);
  return { tag: doc.order.tag, title: doc.order.title, href: `/p/${encodeURIComponent(project.id)}/orders/${encodeURIComponent(tag)}#acceptance`, pipelineRequired: !!acceptConfigFor(project, doc.order.kind), lint: lint ?? [], ...(trial ? { trial } : {}), independent, independentRequired, changed: trial?.changed ?? [], images: [...images] };
}

/** Delivery entry points must keep a mechanical failure reviewable, even with missing Git metadata. */
export function attemptAcceptance(project: ProjectConfig, orders: Orders, tag: string): AcceptanceTrial | undefined {
  const doc = orders.get(tag);
  if (!acceptConfigFor(project, doc.order.kind)) return undefined;
  try { return trialAcceptance(project, orders, tag, false, false, 30 * 60 * 1000); }
  catch (e) {
    const doc = orders.get(tag), reason = errorText(e), previous = latestAcceptanceTrial(orders, tag);
    if (previous?.reason === reason && previous.report === doc.reports.at(-1)?.seq) return previous;
    const result: AcceptanceTrial = { id: randomUUID(), fingerprint: '', report: doc.reports.at(-1)?.seq ?? 0, base: '', branch: '', status: 'failed', at: new Date().toISOString(), changed: [], conflicts: [], steps: [], reason };
    orders.record(tag, 'accept-trial', { ...result });
    return result;
  }
}

export function runAcceptanceTrials(project: ProjectConfig, orders: Orders): void {
  for (const doc of orders.all()) if (acceptConfigFor(project, doc.order.kind) && orders.stage(doc).stage === 'awaiting-review' && doc.reports.at(-1)?.status === 'ready') attemptAcceptance(project, orders, doc.order.tag);
}

function requireCleanBase(project: ProjectConfig): string {
  if (git(project.root, 'symbolic-ref', '-q', 'HEAD') !== baseRefOf(project)) throw new Error('Acceptance requires the base checkout on the base branch.');
  if (git(project.root, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Acceptance refuses a dirty base checkout.');
  return git(project.root, 'rev-parse', 'HEAD');
}

/** The approval boundary: retry stale inputs, then merge only the exact commits that passed. */
export function mergeAcceptance(project: ProjectConfig, orders: Orders, tag: string, findings = '', reviewer = orders.actor, override = false): { acceptFile: string; merge: string; accept: string } {
  if (override && findings.trim().length < 10) throw new Error('An override approval needs a note of at least 10 characters.');
  const release = lock(project, 'merge');
  if (!release) throw new Error('Another acceptance merge is running.');
  let journal: MergeJournal | undefined;
  const acceptFile = path.join(project.work_orders, `${tag}.accept.md`);
  const record = (next: MergeJournal) => { journal = next; writeJournal(project, next); };
  try {
    recoverJournal(project, orders);
    if (reviewer === 'producer') assertIndependentCheckPassed(project, orders, tag);
    assertNoOpenRun(orders, tag);
    const original = requireCleanBase(project);
    const trial = trialAcceptance(project, orders, tag, false, override);
    if (trial.status !== 'passed') throw new Error(`Acceptance trial ${trial.status}: ${trial.reason ?? ''}`);
    const current = inputs(project, orders, tag, override);
    if (requireCleanBase(project) !== trial.base || current.key !== trial.fingerprint) throw new Error('Acceptance inputs changed during the trial; retry approval.');
    if (reviewer === 'producer') assertIndependentCheckPassed(project, orders, tag);
    assertNoOpenRun(orders, tag);
    const config = current.accept;
    // Load the template before touching Git, so a missing template cannot leave a merge behind.
    const template = config.note_template ? readFileSync(config.note_template, 'utf8') : '# Acceptance: {tag} — {title}\n\nMerge: {merge_commit}\nReviewer: {reviewer}\n\n{step_results}\n\n{findings}\n';
    if (existsSync(acceptFile)) throw new Error('An acceptance note already exists; review it before merging.');
    const fill: Record<string, string> = { tag, title: current.doc.order.title, merge_commit: '', reviewer, findings, step_results: trial.steps.map(s => `- ${s.name}: ${s.status} (${s.duration_ms} ms)`).join('\n') };
    const expand = (text: string) => text.replace(/\{(\w+)\}/g, (_, key: string) => fill[key] ?? '');
    // From here every step is written down first, so a failure (or a process that dies) rolls back to `original`.
    record({ tag, at: new Date().toISOString(), original, branch: trial.branch });
    orders.record(tag, 'accept-merge-started', { original, branch: trial.branch, trial: trial.id });
    const conflicts = mergeWithRules(project, project.root, trial.branch, config);
    if (conflicts.length) throw new Error(`Unknown conflicts: ${conflicts.join(', ')}`);
    git(project.root, 'commit', '-m', expand(config.merge_message));
    const merge = git(project.root, 'rev-parse', 'HEAD'); fill.merge_commit = merge;
    record({ ...journal!, merge, note: acceptFile });
    writeFileSync(acceptFile, expand(template), { encoding: 'utf8', flag: 'wx' });
    for (const [index, command] of config.post_merge.entries()) {
      const result = runCommand(command.map(expand), project.root, 60, path.join(trial.log_dir!, `post-${index + 1}.log`), `post_merge ${index + 1}`);
      orders.record(tag, 'accept-post-merge', { merge, ...result });
      if (result.status === 'failed') throw new Error(`${result.name} failed: ${result.tail}`);
    }
    if (config.push) {
      const target = pushTarget(project), timeout = config.git_timeout_minutes ?? 2;
      const before = timedGit(timeout, project.root, 'ls-remote', target.remote, target.ref).split(/\s+/)[0] ?? '';
      record({ ...journal!, push: { ...target, before } });
      timedGit(timeout, project.root, 'push', target.remote, `${merge}:${target.ref}`);
      record({ ...journal!, push: { ...target, before, done: true } });
    }
    // The approval itself: library changes read from the merge, the merged record and the approve action, in one transaction.
    assertNoOpenRun(orders, tag);
    approveInTransaction(project, orders, () => {
      acceptDesignChanges(project, orders, tag, override, findings, { commit: merge, pinned: current.pins });
      orders.record(tag, 'accept-merged', { merge, trial: trial.id, acceptFile, reviewer, changed: trial.changed });
      orders.act(tag, 'approve', { note: findings, ...(override ? { override: true } : {}) });
    });
    unlinkSync(journalFile(project));
    return { acceptFile, merge, accept: 'Acceptance pipeline passed' };
  } catch (e) {
    const reason = e instanceof DesignAcceptanceError ? e.message : errorText(e);
    // The design step's own record was rolled back with the transaction: keep why it refused.
    if (e instanceof DesignAcceptanceError) orders.record(tag, 'accept-step', { name: 'design-changesets', status: 'failed', duration_ms: 0, reason });
    if (!journal) { orders.record(tag, 'accept-merge-failed', { reason, rollback: '' }); throw e instanceof DesignAcceptanceError ? e : new Error(reason); }
    const problems = rollbackMerge(project, orders, journal);
    if (!problems) unlinkSync(journalFile(project));
    const rollback = problems ? `; rollback needs attention: ${problems}` : '';
    orders.record(tag, 'accept-merge-failed', { reason, rollback, original: journal.original, ...(journal.merge ? { merge: journal.merge } : {}) });
    if (e instanceof DesignAcceptanceError && !problems) throw e;
    throw new Error(reason + rollback);
  } finally { release(); }
}

/**
 * Runs the approval's state changes (library changes, records, the approve action) in one store transaction, so a failure
 * leaves none of them. The design library shares the project's state store; an Orders on another store runs them in order.
 */
export function approveInTransaction(project: ProjectConfig, orders: Orders, change: () => void): void {
  if (project.design?.enabled && orders.store !== stateStore(project)) { change(); return; }
  orders.store.transaction(change);
}
