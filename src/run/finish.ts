import { runProcessMatches } from './kill-tree.ts';
import { textSessionId } from '../workers/adapters/index.ts';
import { totalUsage } from '../usage/fold.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { UserError, t } from '../i18n.ts';
import type { Run, RunEnd, RunOutcome } from '../orders/model.ts';
import { probesTailReader, readRunEndReason } from './end-reason.ts';
import { saveWipSnapshot, type SaveWipOptions } from './wip.ts';
import { parseReportBlock, parseReportFile, staleReport, REPORT_BEGIN, REPORT_END, type ReportInput } from '../orders/report.ts';
import { REPORT_STATUSES } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { startedAtForCheck, type Probes } from '../tick/gather.ts';
import { trailingTransientFailures } from './launch.ts';
import { parseStreamLog, workerAdapter } from '../workers/adapters/index.ts';
import { parseUsage, type RunUsage } from '../usage/usage.ts';
import { MAX_RESUMES, isLimitError, isLostSessionError, isTransientError } from './transient.ts';
import { deliveredReport, earlierReport, type EarlierReport } from './lingering.ts';
import type { WorkersFile } from '../workers/config.ts';
import { eventErrors } from './transient.ts';
import { liveRuns, liveSummary, type LiveSummary } from './live.ts';
import { hasDeliveryChecks } from '../check/delivery.ts';
import { mergeBaseBeforeReview } from '../check/base-merge.ts';
import { lintDelivery } from '../producer/delivery-lint.ts';
import { outsideWorktree } from './worktree.ts';
import { designBounceNote, designChangeProblem } from '../design/worker.ts';
import { evidenceBounceNote, evidenceProblems } from '../review/evidence-check.ts';
import { verifyOrder } from '../verify/verify.ts';
import { intakeProducer } from '../producer/producer.ts';
import { MONITOR_CONTINUATION } from './prompt.ts';
import { classifyEndpoint, unreachableWhy } from './endpoint.ts';
import { fenceUntrusted } from './fence.ts';
import { requeueUndeliveredInbox } from './messages.ts';

function headOf(worktree: string): string | undefined {
  if (!existsSync(worktree)) return undefined;
  try { return execFileSync('git', ['--no-optional-locks', '-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; }
  catch { return undefined; }
}

/** What to record for a run whose process has gone away. */
export interface Finish {
  stale?: NonNullable<ReturnType<typeof staleReport>>[];
  live_summary?: LiveSummary;
  tag: string;
  run: string;
  outcome: RunOutcome;
  report?: ReportInput;
  from?: string;
  /** The engine's own session id, read from the end of the log, so that the run can be continued. */
  session?: string;
  /** The final message of an engine that has no file for it, to be saved where the order expects it. */
  writeLast?: { file: string; text: string };
  /** Tokens and cost read from the log; absent when there is no log to read. */
  usage?: RunUsage;
  /** For outcome `capacity`: what ran out, or `unreachable` when the worker's endpoint accepted no connection. */
  limit?: Run['limit'];
  lost_session?: boolean;
  missing_report?: boolean;
  /** The report was not in the last message: taken from an earlier message of the run, or from a file the worker wrote with the Write tool. */
  report_from?: { where: 'earlier-message' | 'written-file'; file?: string };
  /** A malformed or missing report was sent back once for repair instead of failing the delivery. */
  bounce?: { error?: string; final_message?: boolean; prompt: string };
  end?: RunEnd;
  why: string;
}

/** Enough for a final message that arrives as many small text events. */
const TAIL_BYTES = 65536;

function bouncePrompt(error: string | undefined, finalMessage: boolean): string {
  const reason = error
    ? `The report block is invalid:\n${fenceUntrusted('report validation error', error)}`
    : (finalMessage ? 'No report block was found in the final agent message.' : 'No report block was found.');
  const shape = JSON.stringify({ status: 'ready', summary: 'one sentence', question: '', evidence: [], commits: [] });
  return [reason, '', 'Print exactly this report block, using the field names shown:', REPORT_BEGIN, shape, REPORT_END, '', `Allowed status values: ${REPORT_STATUSES.join(', ')}.`, 'Allowed field names: run, status, summary, question, options, waiting_for, scope, evidence, commits, skill_suggestions, monitor, revision.', '', 'Do not redo the work: check `git log` and print only the report block.'].join('\n');
}

/**
 * Finds runs that the tool started and whose process is gone, and decides what happened:
 *  - a report block (in the final-message file or a <TAG>.report.json written after the run began): completed + that report;
 *  - no report, and the engine refused a command it may not run (it stops the whole run): failed, with a blocked report that names the command;
 *  - no report and the log ends with a transient service error: outcome "capacity", to be resumed (after the worker's resume limit in a row: failed);
 *  - anything else: failed, with a failed report, and a person decides.
 * Pure reading; `applyFinish` writes.
 */
/**
 * Is the run's process still running? A live pid counts only when it is the same process: Windows reuses pids quickly,
 * and a worker that exited must not look alive because another program got its number. An unreadable start time counts as alive.
 */
function stillOurs(run: { pid?: number; process_started_at?: string; started: string }, probes: Probes): boolean {
  if (!probes.isAlive(run.pid!)) return false;
  if (!probes.processStartedAt) return true;
  const actual = startedAtForCheck(probes, run.pid!);
  // Without a recorded creation time, a process created outside the run's launch window has only reused the pid.
  return !actual || runProcessMatches(actual, run.process_started_at, run.started);
}

/**
 * How long a run Alba opened may stay without a process: the run is recorded just before its process is spawned and the pid
 * right after, so a run still without one this long after its start lost its process to a failed start (or a crash in between).
 */
export const LAUNCH_GRACE_MINUTES = 10;

export function findFinishes(project: ProjectConfig, orders: Orders, probes: Probes, workers?: WorkersFile): Finish[] {
  const out: Finish[] = [];
  for (const doc of orders.all()) {
    const run = doc.runs.find(r => r.ended === undefined);
    // A run Alba started (it wrote the run's prompt file) that never got a pid: ended after the grace period instead of staying open forever.
    // A run a person opened by hand (`alba orders run-start`, for a card) has no prompt file and stays open until they end it.
    if (run && !run.pid && !run.imported && run.prompt_file && probes.now().getTime() - Date.parse(run.started) > LAUNCH_GRACE_MINUTES * 60000) {
      const why = t('no process was recorded for the run within {min} min of its start', { min: LAUNCH_GRACE_MINUTES });
      out.push({ tag: doc.order.tag, run: run.id, outcome: 'failed', missing_report: true, report: { status: 'failed', summary: t('the worker process was never recorded as started'), evidence: run.log ? [run.log] : [], commits: [] }, end: { kind: 'vanished', detail: 'no process was recorded for the run', why }, why });
      continue;
    }
    if (!run?.pid || run.imported || stillOurs(run, probes)) continue;
    const stale: NonNullable<Finish['stale']> = [];
    const accepts = (candidate: ReportInput, source: string, time?: string) => {
      const rejected = staleReport(doc, run, candidate, source, time);
      if (rejected && !stale.some(r => r.file === source && r.namedRun === rejected.namedRun)) stale.push(rejected);
      return !rejected;
    };
    const sources = [run.last_file, path.join(project.work_orders, `${doc.order.tag}.report.json`).replace(/\\/g, '/')].filter((f): f is string => !!f);
    const stderr = run.log ? probes.tail(run.log, TAIL_BYTES) : '';
    const eventTail = run.events_file ? probes.tail(run.events_file, TAIL_BYTES) : '';
    const tail = eventTail || stderr;
    const summary = run.events_file ? liveSummary(liveRuns.read(project, doc.order.tag, run, probes, doc.order.worktree)) : undefined;
    if (summary && doc.order.worktree) try {
      const files = execFileSync('git', ['diff', '--name-only', doc.order.base_ref ?? project.dispatch.base_ref ?? 'HEAD', '--'], { cwd: doc.order.worktree, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean);
      summary.files_changed = [...new Set([...summary.files_changed, ...files])];
    } catch { /* file-change events remain available */ }
    // Engines that print JSON events say how they ended; the session id lets the next run continue the conversation.
    const stream = parseStreamLog(tail, { cut: Buffer.byteLength(tail) >= TAIL_BYTES });
    // Codex prints `session id: <uuid>` in its header; Grok's end event has `sessionId`. The id lets a later run continue the conversation.
    const eventHead = run.events_file ? probes.head?.(run.events_file, 65536) ?? probes.readText(run.events_file)?.slice(0, 65536) ?? '' : '';
    const found = stream.sessionId ?? parseStreamLog(eventHead).sessionId ?? textSessionId(run.log ? probes.head?.(run.log, 4096) ?? probes.readText(run.log)?.slice(0, 4096) ?? '' : '');
    const session = found && found !== run.session ? found : undefined;
    const usage = totalUsage(liveRuns.accounting(run)?.turns ?? []) ?? (summary?.turns ? { source: 'codex-log' as const, total_tokens: summary.input_tokens + summary.output_tokens, input_tokens: summary.input_tokens, cached_tokens: summary.cached_input_tokens, output_tokens: summary.output_tokens, turns: summary.turns } : run.log ? parseUsage(/step[-_]finish/.test(tail) ? probes.readText(run.events_file ?? run.log) ?? tail : tail, { cut: Buffer.byteLength(tail) >= TAIL_BYTES && !/step[-_]finish/.test(tail) }) : undefined);
    const worker = workers?.workers.find(w => w.id === run.worker);
    const priorEvents = orders.store.events({ tag: doc.order.tag });
    let readReport = false;
    let cachedReason: ReturnType<typeof readRunEndReason> | undefined;
    const endReason = (reportStatus?: string, hasFinalOrBroken?: boolean) => cachedReason ??= readRunEndReason({
      run: { ...run, ...(session ? { session } : {}) },
      worker,
      albaEvents: priorEvents,
      hasReport: readReport,
      reportStatus,
      hasFinalOrBrokenReport: hasFinalOrBroken,
      usageTotal: usage?.total_tokens,
      codexHome: worker?.launch?.env?.CODEX_HOME,
      now: typeof probes.now === 'function' ? probes.now() : new Date(), // some callers pass partial probes
      reader: probesTailReader(probes),
    });
    // A conversation the service no longer has (Codex `no rollout found`, Claude `No conversation found`): whatever this ending
    // turns into (a capacity resume, a report repair, a failure), the next run starts a new session instead of the same error.
    const lostSession = isLostSessionError(stderr) || isLostSessionError(eventTail);
    const push = (f: Omit<Finish, 'tag' | 'run' | 'session' | 'usage'>, hasFinalOrBroken = false) => {
      const end = f.end ?? { ...endReason(f.report?.status, hasFinalOrBroken), why: f.why };
      out.push({ tag: doc.order.tag, run: run.id, ...(stale.length ? { stale } : {}), live_summary: summary, ...(!readReport ? { missing_report: true } : {}), ...(session ? { session } : {}), ...(usage ? { usage } : {}), ...(lostSession && !readReport ? { lost_session: true } : {}), ...f, end });
    };
    const failed = (summary: string, why: string, question?: string, status: 'failed' | 'blocked' = 'failed') =>
      push({ outcome: 'failed', report: { status, summary, ...(question ? { question } : {}), evidence: run.log ? [run.log] : [], commits: [] }, why });

    let report: ReportInput | undefined, from: string | undefined, broken: string | undefined, writeLast: Finish['writeLast'];
    const boundReport = (candidate: ReportInput, source: string, text: string, modified?: string) => {
      if (!accepts(candidate, source, modified)) return undefined;
      if (hasDeliveryChecks(project.checks)) candidate.delivery_text = text;
      return candidate;
    };
    for (const file of sources) {
      const time = probes.fileTime(file);
      const text = time ? probes.readText(file) : undefined;
      if (text === undefined) continue;
      try {
        report = boundReport(parseReportFile(file, text), file, text, time);
        if (report) {
          from = path.basename(file);
          break;
        }
      } catch (e) {
        if (time && Date.parse(time) >= Date.parse(run.started) && e instanceof UserError && !/No report block found/.test(e.message)) broken = e.message;
      }
    }
    if (!report && stream.finalText.trim() && run.last_file) {
      try {
        report = boundReport(parseReportBlock(stream.finalText), run.events_file ?? run.log ?? 'final message', stream.finalText);
        if (report) {
          from = path.basename(run.last_file);
          writeLast = { file: run.last_file, text: stream.finalText.trim() + '\n' };
        }
      } catch (e) { if (e instanceof UserError && !/No report block found/.test(e.message)) broken = e.message; }
    }
    let earlier: EarlierReport | undefined;
    if (!report && !broken && run.events_file) {
      // The last message has no block, but an earlier one of this run has (a background command ended after the final message
      // and the engine answered its notification), or the worker saved its report to a file with the Write tool.
      earlier = earlierReport(probes.readText(run.events_file) ?? '');
      if (earlier) report = boundReport(earlier.report, earlier.file ?? run.events_file, earlier.text);
      if (!report) earlier = undefined;
      if (earlier) {
        if (run.last_file) { from = path.basename(run.last_file); writeLast = { file: run.last_file, text: earlier.text.trim() + '\n' }; } else from = path.basename(run.events_file);
      }
    }
    let fromLog = false;
    if (!report && !broken && run.log) {
      // No final-message file (a process stopped before it wrote one): the block the worker printed at the end of its log is its report.
      const printed = deliveredReport(tail, { cut: Buffer.byteLength(tail) >= TAIL_BYTES });
      if (printed) report = boundReport(printed, run.events_file ?? run.log, stream.finalText || tail);
      if (report) { from = path.basename(run.log); fromLog = true; }
    }
    if (report) { readReport = true; push({ outcome: 'completed', report, from, ...(writeLast ? { writeLast } : {}), ...(earlier ? { report_from: { where: earlier.where, ...(earlier.file ? { file: earlier.file } : {}) } } : {}), why: earlier?.where === 'earlier-message' ? t('process ended, report block read from an earlier message (the last message had none)') : earlier ? t('process ended, report block read from a file the worker wrote ({file})', { file: earlier.file ?? '' }) : fromLog ? t('process ended, report block read from the log') : t('process ended, report block read') }); continue; }
    const lastBounce = [...priorEvents].map((e, i) => ({ e, i })).reverse().find(x => x.e.type === 'report-bounced');
    const hadUnfollowedBounce = !!lastBounce && !priorEvents.slice(lastBounce.i + 1).some(e => e.type === 'report' || (e.type === 'run-end' && e.data?.outcome === 'cancelled'));
    if (!hadUnfollowedBounce && (broken || stream.finalText.trim())) {
      push({ outcome: 'completed', bounce: { ...(broken ? { error: broken } : {}), ...(stream.finalText.trim() ? { final_message: true } : {}), prompt: bouncePrompt(broken, !!stream.finalText.trim()) }, why: broken ? t('the report block is invalid; it will be sent back once for repair') : t('no report block in the final message; it will be sent back once for repair') }, true);
      continue;
    }
    // A remote host that refused to start the worker (its checkout is unusable, e.g. LFS files left as pointers) says why in the log.
    const dispatchStop = /Remote dispatch failed: (.+)/.exec(stderr)?.[1]?.trim();
    if (dispatchStop) { failed(t('the remote dispatch failed before the worker started: {why}', { why: dispatchStop }), t('remote dispatch failed')); continue; }
    // The run's editor (editors: in alba.yaml) did not come up: the worker was never started.
    const editorStop = /\[alba editor\] the run does not start: (.+)/.exec(`${stderr}\n${tail}`)?.[1]?.trim();
    if (editorStop) { failed(t('the run\'s editor did not start, so the worker was not started: {why}', { why: editorStop }), t('editor did not start')); continue; }
    if (stream.blockedCommand) {
      // The engine refuses a command it may not run and stops the whole run there; nothing is loosened by the tool.
      failed(t('the run stopped at something it is not allowed to do: {command}', { command: stream.blockedCommand }), t('permission required, the run was stopped by the engine'),
        t('Allow "{command}" for this worker (add a rule to its launch template), or change the order so it is not needed?', { command: stream.blockedCommand }), 'blocked');
      continue;
    }
    if (stream.stopReason === 'max_turn_requests') { failed(t('the run used up its turn limit without a report block'), t('stopped at the turn limit')); continue; }
    const detected = endReason(undefined, Boolean(broken || stream.finalText.trim()));
    if (detected.kind === 'output-limit') {
      failed(t('the worker stopped at the output token limit: {detail}', { detail: detected.detail }), detected.detail);
      continue;
    }
    if (detected.kind === 'context-limit') {
      failed(t('the worker stopped at the context limit: {detail}', { detail: detected.detail }), detected.detail);
      continue;
    }
    const verdict = classifyEndpoint({ events: eventTail || stderr, log: stderr, cut: Buffer.byteLength(eventTail || stderr) >= TAIL_BYTES, usageTotal: usage?.total_tokens, worker });
    // Only actual failed runs count. A tick held by the background probe creates no run.
    if (verdict.kind === 'unreachable') {
      const maxResumes = worker?.max_resumes ?? MAX_RESUMES;
      if (trailingTransientFailures(doc.runs, run.worker) + 1 > maxResumes) failed(t('gave up after {n} automatic resumes: the service kept failing', { n: maxResumes }), t('transient errors, no resumes left'));
      else push({ outcome: 'capacity', limit: 'unreachable', why: unreachableWhy(verdict.endpoint) });
      continue;
    }
    const endText = [stderr, eventErrors(eventTail), stream.events ? stream.errors.slice(-5).join('\n') : tail].join('\n');
    // What the engine itself says stopped it (agy: signed out, region block, unknown model, quota): a reason of its own, not "no report block".
    const engine = worker?.engine ?? run.engine;
    const stop = engine ? workerAdapter(engine).failure?.(endText, worker) : undefined;
    if (stop?.limit && worker?.on_limit === 'rotate') { push({ outcome: 'capacity', limit: 'quota', why: t('the usage window or balance is used up; the order will be handed to another worker') }); continue; }
    if (stop?.retry) {
      const maxResumes = worker?.max_resumes ?? MAX_RESUMES;
      const failures = trailingTransientFailures(doc.runs, run.worker) + 1;
      if (failures <= maxResumes) { push({ outcome: 'capacity', limit: 'capacity', why: t('{why}; resume {k} of {n} will follow', { why: stop.why, k: failures, n: maxResumes }) }); continue; }
    }
    if (stop) { failed(stop.summary, stop.why, stop.question, 'blocked'); continue; }
    // A worker set to `on_limit: rotate` that ran out of its usage window: the order is handed over like a capacity error (without it that is a failure a person looks at).
    if (worker?.on_limit === 'rotate' && !isTransientError(endText) && (isLimitError(endText) || detected.kind === 'quota')) {
      push({ outcome: 'capacity', limit: 'quota', why: t('the usage window or balance is used up; the order will be handed to another worker') });
      continue;
    }
    if (verdict.kind === 'capacity' || isTransientError(endText)) {
      const maxResumes = worker?.max_resumes ?? MAX_RESUMES;
      const failures = trailingTransientFailures(doc.runs, run.worker) + 1;
      if (failures > maxResumes) failed(t('gave up after {n} automatic resumes: the service kept failing', { n: maxResumes }), t('transient errors, no resumes left'));
      else push({ outcome: 'capacity', limit: 'capacity', ...(isLostSessionError(endText) ? { lost_session: true } : {}), why: t('process ended with a transient service error; resume {k} of {n} will follow', { k: failures, n: maxResumes }) });
      continue;
    }
    failed(t('the worker process ended without a report block'), t('process ended, no report block, no transient error in the log'));
  }
  return out;
}


export function applyFinish(orders: Orders, f: Finish, project?: ProjectConfig, wipOptions?: Pick<SaveWipOptions, 'maxFileBytes' | 'maxTotalBytes' | 'runGit'>): void {
  const before = orders.get(f.tag);
  const storedRun = before.runs.find(r => r.id === f.run);
  if (!storedRun || storedRun.ended !== undefined) return;
  for (const stale of f.stale ?? []) orders.record(f.tag, 'stale-report', stale);
  const worktree = before.order.worktree ?? storedRun?.cwd;
  const baseEnd: RunEnd = f.end ?? (f.report && !f.missing_report
    ? { kind: 'report', detail: `report block read (${f.report.status})`, why: f.why }
    : { kind: f.outcome === 'completed' ? 'exit-0-no-report' : 'nonzero-exit', detail: f.why || f.outcome, why: f.why });
  const wip = baseEnd.kind !== 'report'
    ? saveWipSnapshot(worktree, { tag: before.order.tag, runId: f.run, kind: baseEnd.kind, ...wipOptions })
    : {};
  const end: RunEnd = { ...baseEnd, ...wip };
  f.end = end;
  if (f.live_summary) orders.patchRun(f.tag, f.run, { live_summary: f.live_summary });
  if (f.missing_report) orders.patchRun(f.tag, f.run, { missing_report: true });
  if (f.report_from) { orders.patchRun(f.tag, f.run, { report_from: f.report_from.where }); orders.record(f.tag, 'report-from-earlier', { run: f.run, ...f.report_from }); }
  if (f.session || f.usage || f.limit || f.lost_session) orders.patchRun(f.tag, f.run, { ...(f.session ? { session: f.session } : {}), ...(f.usage ? { usage: f.usage } : {}), ...(f.limit ? { limit: f.limit } : {}), ...(f.lost_session ? { lost_session: true } : {}) });
  orders.runEnd(f.tag, f.outcome, end);
  try {
  if (f.writeLast) writeFileSync(f.writeLast.file, f.writeLast.text, 'utf8');
  if (f.bounce) {
    orders.record(f.tag, 'report-bounced', { run: f.run, ...(f.bounce.error ? { error: f.bounce.error } : {}), ...(f.bounce.final_message ? { final_message: true } : {}) });
    orders.act(f.tag, 'message', { note: f.bounce.prompt, force: true, bounce: true });
    return;
  }
  if (f.report) {
    const lastFile = orders.get(f.tag).runs.find(r => r.id === f.run)?.last_file;
    const deliveryText = f.report.delivery_text ?? f.writeLast?.text ?? (lastFile && !f.stale?.some(r => r.file === lastFile) && existsSync(lastFile) ? readFileSync(lastFile, 'utf8') : undefined);
    // The run has ended, so the branch HEAD now is the revision it delivered. A report that leaves the field out gets it from git
    // instead of a bounce for one line (`revision_is_head` still catches a revision that is not HEAD).
    if (!f.report.revision && worktree) {
      const head = headOf(worktree);
      if (head) f.report = { ...f.report, revision: head };
    }
    orders.report(f.tag, { ...f.report, ...(project && hasDeliveryChecks(project.checks) && deliveryText !== undefined ? { delivery_text: deliveryText } : {}) }, f.from ?? 'tick');
    if (f.report.status === 'progress') {
      const doc = orders.get(f.tag);
      const run = doc.runs.find(r => r.id === f.run);
      if (run?.monitor && doc.monitor?.resolved) {
        // A fresh instruction sent during this run already queues more work on the person's terms.
        if (doc.actions.some(a => a.seq > run.seq && !a.bounce && ['queue', 'rework', 'answer', 'message'].includes(a.kind))) return;
        const progressRuns = doc.runs.filter(r => r.monitor && r.seq > doc.monitor!.report_seq && r.outcome === 'completed' && doc.reports.some(report => report.run === r.id && report.status === 'progress'));
        if (progressRuns.length === 1) {
          orders.record(f.tag, 'monitor-progress-retry', { run: f.run });
          orders.act(f.tag, 'monitor', { force: true, note: `The monitor follow-up ended with progress only. This is the one automatic continuation. ${MONITOR_CONTINUATION}` });
        } else {
          orders.record(f.tag, 'monitor-progress-exhausted', { run: f.run });
          orders.report(f.tag, { status: 'failed', summary: 'The monitor follow-up failed to finish the remaining work after one automatic continuation; producer review is required.', evidence: f.report.evidence, commits: f.report.commits, source: 'inferred' }, 'monitor-continuation');
          if (project) intakeProducer(project, orders, { verify: false });
        }
      }
    }
    // A run that worked in the main checkout instead of its worktree: its delivery is not what the branch holds; a person sorts it out.
    const run = orders.get(f.tag).runs.find(r => r.id === f.run);
    const outside = project && run ? outsideWorktree(project, run) : undefined;
    // The main checkout changes for other reasons too (the lead commits there, edits a file): only a commit the run itself reports is
    // proof that it worked there; anything else is recorded as a warning for the review.
    const own = outside ? outside.commits.filter(c => f.report!.commits.some(r => r.length >= 7 && (c.startsWith(r.slice(0, 9)) || r.startsWith(c.split(' ')[0]!)))) : [];
    // Without a reported commit, only a sign that points at this run is worth a review warning: an uncommitted main-checkout file
    // the run also changed, or a main commit that names the order. The lead's own commits on main during the run are not.
    const runFiles = new Set((run?.live_summary?.files_changed ?? f.live_summary?.files_changed ?? []).map(x => x.replace(/\\/g, '/')));
    const tagWord = new RegExp(`\\b${f.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const pointsHere = !!outside && (outside.files.some(x => runFiles.has(x.replace(/\\/g, '/'))) || outside.commits.some(c => tagWord.test(c.slice(10))));
    if (outside && (own.length || pointsHere)) {
      orders.record(f.tag, own.length ? 'outside-worktree' : 'accept-warning', { name: 'outside-worktree', run: f.run, ...outside, reported: own });
      if (own.length && (f.report.status === 'ready' || f.report.status === 'progress')) {
        const what = [outside.commits.length ? `${outside.commits.length} commit(s) on the base branch (${outside.commits.slice(0, 5).join('; ')})` : '', outside.files.length ? `${outside.files.length} changed file(s) (${outside.files.slice(0, 8).join(', ')})` : ''].filter(Boolean).join(' and ');
        orders.report(f.tag, { status: 'blocked', summary: `The run changed the main checkout ${project!.root} instead of its worktree: ${what}. Move that work to the order's branch and restore the main checkout, then send it back. The worker said: ${f.report.summary}`, evidence: f.report.evidence, commits: f.report.commits, source: 'inferred' }, 'outside-worktree');
        return;
      }
    }
    if (f.report.status === 'ready' && project) {
      // Change sets that acceptance would refuse go back to the worker once, while its session is still there, instead of an override at approval.
      // Each kind goes back once after the last person's action; a second delivery with the same problem goes to review with a warning.
      const bounceOnce = (type: string, name: string, data: Record<string, unknown>, note: string): boolean => {
        const lastPerson = Math.max(-1, ...orders.get(f.tag).actions.filter(a => !a.bounce).map(a => a.seq));
        const bounced = orders.store.events({ tag: f.tag }).some(e => e.type === type && Number(e.data?.after_action ?? -1) === lastPerson);
        orders.record(f.tag, bounced ? 'accept-warning' : type, { name, ...data, after_action: lastPerson, run: f.run });
        if (!bounced) orders.act(f.tag, 'message', { note, force: true, bounce: true });
        return !bounced;
      };
      const problem = designChangeProblem(project, orders, f.tag);
      if (problem && bounceOnce('design-bounced', 'design-changesets', { files: problem.files, reason: problem.reason }, designBounceNote(problem))) return;
      // Evidence pictures that are copies of one file, or one flat colour: the worker described what it did not look at.
      const pictures = evidenceProblems(project, orders.get(f.tag));
      if (pictures && bounceOnce('evidence-bounced', 'evidence-images', { ...pictures }, evidenceBounceNote(pictures))) return;
      mergeBaseBeforeReview(project, orders, f.tag, run);
      lintDelivery(project, orders, f.tag);
      if (orders.stage(orders.get(f.tag)).stage === 'awaiting-review') verifyOrder(project, orders, f.tag);
    }
  }
  } finally {
    requeueUndeliveredInbox(orders, f.tag, storedRun);
  }
}
