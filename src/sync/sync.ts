import { hasDeliveryChecks } from '../check/delivery.ts';
import { lintDelivery } from '../producer/delivery-lint.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { UserError, t } from '../i18n.ts';
import type { OrderDoc, Stage } from '../orders/model.ts';
import { parseReportBlock, type ReportInput } from '../orders/report.ts';
import { Orders } from '../orders/service.ts';
import { findWorktree } from '../tick/gather.ts';
import { baseRefOf, planWorktree } from '../run/worktree.ts';
import { systemGit, type GitProbe } from './git.ts';

export interface SyncChange { tag: string; what: string }
export interface SyncSkip { tag: string; file: string; why: string }
export interface SyncResult {
  changes: SyncChange[];
  /** Files that were looked at and left alone, with the reason. */
  skipped: SyncSkip[];
  /** Tags of files in the work-order folder that match no order. */
  unknown: string[];
}

export interface SyncOptions {
  dryRun?: boolean;
  /** Only these tags (any case), for a command that waits for one order. */
  only?: string[];
  /** Reads the git state of worktrees (replaced in tests). */
  git?: GitProbe;
  now?: () => Date;
  /**
   * A hook for a hint about an order whose run has no files yet (for example when the last message of the session that
   * works on it was written). Not used by the command line yet; the result would only be shown, never recorded.
   */
  sessionClue?: (doc: OrderDoc) => string | undefined;
}

/** Stages in which a delivery file can still be news. The table says "not started" or "waiting for a person" in the others. */
const OPEN_FOR_DELIVERY: readonly Stage[] = ['running', 'idle', 'awaiting-review', 'blocked', 'failed', 'dropped', 'held'];

const wanted = (options: SyncOptions, tag: string) => !options.only || options.only.some(o => o.toLowerCase() === tag.toLowerCase());

const mtime = (file: string): string => statSync(file).mtime.toISOString();

/** The first line that says something, without Markdown decoration, on one line. */
export function firstLine(text: string): string {
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s#>*\-]+/, '').replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();
    if (line && !/^-{3,}/.test(line)) return line.length > 200 ? `${line.slice(0, 197)}...` : line;
  }
  return '';
}

/** What a delivery file says: its report block, or a guessed "ready" with the first line when there is no block. */
export function readDelivery(text: string): { report: ReportInput; why?: string } {
  try {
    return { report: parseReportBlock(text) };
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    // No block at all: an older delivery written by hand, taken as ready. A block that is there but cannot be read is
    // not guessed: it may say failed or blocked, so it goes to a person as failed with the reason.
    if (/No report block found/.test(e.message)) return { report: { status: 'ready', summary: firstLine(text) || t('(empty file)'), evidence: [], commits: [], source: 'inferred' } };
    return { report: { status: 'failed', summary: t('the report block could not be read: {why}', { why: e.message.split('\n')[0]! }), evidence: [], commits: [], source: 'inferred' }, why: e.message };
  }
}

/** Files that say a person dispatched the order (the order file, a prompt file for it): a delivery older than these belongs to an earlier round. */
function dispatchedAt(project: ProjectConfig, tag: string, names: readonly string[]): string | undefined {
  const want = tag.toLowerCase();
  const times = names.filter(n => {
    const l = n.toLowerCase();
    if (/\.(last\.txt|accept\.md)$/.test(l)) return false;
    return l === `${want}.md` || l.startsWith(`${want}-`) || l.startsWith(`${want}_`);
  }).filter(n => /\.(md|txt)$/i.test(n)).map(n => mtime(path.join(project.work_orders, n)));
  return times.sort().at(-1);
}

/**
 * Records, from the files a work-order folder already holds, what happened outside the tool:
 *  - `<TAG>.last.txt`: the worker delivered. An imported run that ended (at the file's time) and a report: the block at the end of the file,
 *    or, with no block, "ready" with the first line as summary, marked `inferred`.
 *  - `<TAG>.accept.md`: the reviewer accepted it: an approve, so the order is merged. Only a ready delivery (awaiting review,
 *    no run open, the note newer than the report) is approved this way; a failed or blocked one needs a person's override.
 * Every fact carries the file's modification time. Nothing is recorded twice (a delivery counts as known when a report from the same
 * file at or after its time exists), and nothing is recorded for an order that a run started by this tool is still working on.
 */
export function syncOrders(project: ProjectConfig, orders: Orders, options: SyncOptions = {}): SyncResult {
  const result: SyncResult = { changes: [], skipped: [], unknown: [] };
  const dir = project.work_orders;
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const tags = new Map<string, { last?: string; accept?: string }>();
  for (const name of names) {
    const m = /^(.+)\.(last\.txt|accept\.md)$/i.exec(name);
    if (!m) continue;
    const entry = tags.get(m[1].toLowerCase()) ?? {};
    if (/^last/i.test(m[2])) entry.last = name; else entry.accept = name;
    tags.set(m[1].toLowerCase(), entry);
  }
  const at = (iso: string) => new Orders(orders.store, () => iso, 'sync');

  for (const [key, files] of [...tags].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!wanted(options, key)) continue;
    const tag = orders.resolveTag(key);
    if (!tag) { result.unknown.push(key); continue; }
    const doc = orders.get(tag);
    const stage = orders.stage(doc).stage;
    const skip = (file: string, why: string) => result.skipped.push({ tag, file, why });
    const change = (what: string) => result.changes.push({ tag, what });
    if (stage === 'cancelled' || stage === 'merged') continue;
    const lastTime = files.last ? mtime(path.join(dir, files.last)) : undefined;
    const acceptTime = files.accept ? mtime(path.join(dir, files.accept)) : undefined;
    // A person's own action through this tool is dated; an imported one is not, so it cannot be compared with a file.
    const lastAction = [...doc.actions].filter(a => !a.imported && (a.kind === 'queue' || a.kind === 'rework' || a.kind === 'answer')).sort((x, y) => y.seq - x.seq)[0];
    const sinceAction = (time: string) => !lastAction || Date.parse(time) >= Date.parse(lastAction.at);

    let delivered: string | undefined;
    if (files.last && lastTime) {
      const file = files.last;
      const known = doc.reports.some(r => r.from === file && Date.parse(r.at) >= Date.parse(lastTime));
      const toolRun = doc.runs.find(r => r.ended === undefined && !r.imported);
      const sent = dispatchedAt(project, tag, names);
      if (known) { /* already recorded */ }
      else if (toolRun) skip(file, t('run {run} started by this tool is still open; the tick records its end', { run: toolRun.id }));
      else if (!OPEN_FOR_DELIVERY.includes(stage)) skip(file, t('the order is {stage}; a delivery file from an earlier round is not taken as news', { stage }));
      else if (!sinceAction(lastTime)) skip(file, t('older than the last queue or rework action'));
      else if (sent && sent > lastTime) skip(file, t('older than the order file or prompt that sent it out; it belongs to an earlier round'));
      else {
        const text = readFileSync(path.join(dir, file), 'utf8');
        const { report, why } = readDelivery(text);
        if (why) result.skipped.push({ tag, file, why: t('the report block is not valid ({why}); recorded as inferred', { why }) });
        change(t('delivered at {time}: {status} ({how}) {summary}', { time: lastTime, status: report.status, how: report.source === 'inferred' ? t('inferred from the first line') : t('report block'), summary: report.summary }));
        delivered = report.status;
        if (!options.dryRun) {
          const when = at(lastTime);
          const open = doc.runs.find(r => r.ended === undefined);
          const lastFile = path.join(dir, file).replace(/\\/g, '/');
          if (!open) when.runStart(tag, { worker: doc.order.worker?.trim() || 'unknown', extra: { last_file: lastFile } }, true);
          // An imported run that was open since the table was read cannot have started after the delivery.
          else when.patchRun(tag, open.id, { last_file: lastFile, ...(open.started > lastTime ? { started: lastTime } : {}) });
          when.runEnd(tag, 'completed');
          when.report(tag, { ...report, ...(hasDeliveryChecks(project.checks) ? { delivery_text: text } : {}) }, file, true);
          lintDelivery(project, orders, tag);
        }
      }
    }

    if (files.accept && acceptTime) {
      const file = files.accept;
      // The stage after the delivery above was recorded (or would be, on a dry run).
      const latest = options.dryRun ? doc : orders.get(tag);
      const nowStage = options.dryRun && delivered ? (delivered === 'ready' ? 'awaiting-review' : delivered) : orders.stage(latest).stage;
      const current = [...latest.reports].sort((x, y) => y.seq - x.seq)[0];
      const openRun = latest.runs.find(r => r.ended === undefined);
      // Pipeline notes precede post-merge commands; only its successful merge action may approve.
      if (project.accept || project.design?.enabled || latest.reports.at(-1)?.design_changes?.length) skip(file, t('the acceptance pipeline owns approval; a note alone does not approve'));
      else if (!OPEN_FOR_DELIVERY.includes(stage)) skip(file, t('the order is {stage}; an acceptance file from an earlier round is not taken as news', { stage }));
      else if (lastTime && acceptTime < lastTime) skip(file, t('older than the delivery file; the delivery was not accepted yet'));
      else if (!sinceAction(acceptTime)) skip(file, t('older than the last queue or rework action'));
      // A note approves only a ready delivery: one that failed, was blocked or never delivered needs a person's override.
      else if (openRun) skip(file, t('run {run} is still open; a note does not approve while a worker runs', { run: openRun.id }));
      else if (nowStage !== 'awaiting-review') skip(file, t('the order is {stage}, not a ready delivery; a note alone does not approve it (approve with --override and a note)', { stage: nowStage }));
      else if (!delivered && current && Date.parse(acceptTime) < Date.parse(current.at)) skip(file, t('older than the latest report; the delivery was not accepted yet'));
      else {
        change(t('accepted at {time} ({file})', { time: acceptTime, file }));
        if (!options.dryRun) at(acceptTime).act(tag, 'approve', { imported: true, note: t('synced from {file}', { file }) });
      }
    }
    const clue = options.sessionClue?.(doc);
    if (clue && stage === 'running') change(t('session clue: {clue}', { clue }));
  }
  if (project.sync.git_signal) gitDeliveries(project, orders, options, result, at);
  return result;
}

/**
 * A delivery read off git, for work that was done by a session that left no file. All of these must hold:
 * the worktree has no uncommitted files, its branch is ahead of the base, the last commit's subject matches `sync.git_subject`
 * (default: the word "report"), and that commit is older than `stall_minutes` (the worker is not just between two commits).
 * It is recorded as `ready`, source `inferred-git`, with the subject as summary and the commits ahead as commits.
 * An order that a run started by this tool is working on is left to the tick.
 */
function gitDeliveries(project: ProjectConfig, orders: Orders, options: SyncOptions, result: SyncResult, at: (iso: string) => Orders): void {
  const git = options.git ?? systemGit;
  const now = (options.now ?? (() => new Date()))();
  const subject = new RegExp(project.sync.git_subject, 'i');
  const quiet = (project.dispatch.stall_minutes ?? 60) * 60000;
  const delivered = new Set(result.changes.filter(c => /^delivered|^accepted/.test(c.what)).map(c => c.tag));
  const list = git.worktrees(project.root);
  for (const doc of orders.all()) {
    const tag = doc.order.tag;
    const stage = orders.stage(doc).stage;
    if (!['running', 'idle'].includes(stage) || delivered.has(tag) || !wanted(options, tag)) continue;
    const skip = (why: string) => result.skipped.push({ tag, file: 'git', why });
    const toolRun = doc.runs.find(r => r.ended === undefined && !r.imported);
    if (toolRun) { skip(t('run {run} started by this tool is still open; the tick records its end', { run: toolRun.id })); continue; }
    const worktree = doc.order.worktree ?? findWorktree(tag, list);
    if (!worktree) { skip(t('no worktree found')); continue; }
    let base: string;
    try { base = planWorktree(project, doc.order).baseRef; } catch { base = baseRefOf(project); }
    const facts = git.facts(worktree, base);
    if (!facts) { skip(t('git could not be read in {path}', { path: worktree })); continue; }
    const from = `git:${facts.ahead.at(-1) ?? 'none'}`;
    if (doc.reports.some(r => r.from === from)) continue;
    const why = facts.dirty ? t('{n} uncommitted file(s)', { n: facts.dirty })
      : !facts.ahead.length ? t('not ahead of {base}', { base: base.replace('refs/heads/', '') })
      : !subject.test(facts.lastSubject) ? t('the last commit does not say "report": {subject}', { subject: facts.lastSubject.slice(0, 60) })
      : now.getTime() - Date.parse(facts.lastAt) < quiet ? t('the last commit is newer than {min} min', { min: project.dispatch.stall_minutes ?? 60 })
      : undefined;
    if (why) { skip(why); continue; }
    result.changes.push({ tag, what: t('delivered at {time}: ready (inferred from git, {n} commit(s) ahead) {summary}', { time: facts.lastAt, n: facts.ahead.length, summary: facts.lastSubject }) });
    if (options.dryRun) continue;
    const when = at(facts.lastAt);
    const open = doc.runs.find(r => r.ended === undefined);
    if (!open) when.runStart(tag, { worker: doc.order.worker?.trim() || 'unknown' }, true);
    else if (open.started > facts.lastAt) when.patchRun(tag, open.id, { started: facts.lastAt });
    when.runEnd(tag, 'completed');
    when.report(tag, { status: 'ready', summary: facts.lastSubject.slice(0, 200), evidence: [], commits: facts.ahead, source: 'inferred-git' }, from, true);
    lintDelivery(project, orders, tag);
  }
}
