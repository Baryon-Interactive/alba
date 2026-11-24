import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { MonitorCriterion, MonitorResult, MonitorSpec, OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import type { Probes } from '../tick/gather.ts';
import { monitorObservation, staleMonitor } from './stale.ts';

/** How much of a check's output is kept and handed back. */
const TAIL_CHARS = 1500;

export interface MonitorPass {
  /** What the pass did, one line each (an order that was handed back to its worker, a check that failed to run). */
  done: string[];
  /** Orders whose monitor could not be checked at all (no way to run commands, for instance). */
  problems: { tag: string; text: string }[];
  /** The tags that were queued to be continued. */
  resolved: string[];
}

const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Is `target` the folder `root` or inside it? */
export function inside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0];
  return !same(first, '..');
}

/** The folder a check runs in, or why it may not: only the order's worktree, the project root and `dispatch.monitor_dirs` are allowed. */
export function checkFolder(project: ProjectConfig, doc: OrderDoc, spec: MonitorSpec): { cwd: string } | { refused: string } {
  const base = doc.order.worktree ?? project.root;
  const cwd = path.resolve(base, spec.cwd ?? '.');
  const roots = [doc.order.worktree, project.root, ...project.dispatch.monitor_dirs.map(d => path.resolve(path.dirname(project.file), d))].filter((x): x is string => !!x);
  if (!roots.some(r => inside(r, cwd))) return { refused: t('the folder {cwd} is not the order\'s worktree, the project folder or one of dispatch.monitor_dirs', { cwd: cwd.replace(/\\/g, '/') }) };
  return { cwd };
}

const tailOf = (text: string): string => {
  const clean = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trimEnd();
  return clean.length > TAIL_CHARS ? '…' + clean.slice(-TAIL_CHARS) : clean;
};

export interface CriterionContext {
  orders?: Orders;
  now?: Date;
  observations?: string[];
}

/** Does one condition hold for what the check just did? */
export function holds(
  c: MonitorCriterion,
  ran: { code: number | null; output: string; timedOut: boolean },
  cwd: string,
  probes: Probes,
  ctx?: CriterionContext,
): boolean {
  if ('exit_code' in c) return !ran.timedOut && ran.code === c.exit_code;
  if ('file_exists' in c) return probes.fileTime(path.resolve(cwd, c.file_exists)) !== undefined;
  if ('output_matches' in c) {
    try { return new RegExp(c.output_matches, 'u').test(ran.output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')); } catch { return false; }
  }
  if ('order_stage' in c) {
    const orders = ctx?.orders;
    if (!orders) {
      ctx?.observations?.push(`order_stage: cannot inspect order "${c.order_stage.tag}"`);
      return false;
    }
    const resolved = orders.resolveTag(c.order_stage.tag);
    if (!resolved) {
      ctx?.observations?.push(`order_stage: unknown order "${c.order_stage.tag}"`);
      return false;
    }
    const stage = orders.stage(orders.get(resolved)).stage;
    ctx?.observations?.push(`order_stage: ${resolved} is ${stage}`);
    return c.order_stage.stage.includes(stage);
  }
  const nowMs = (ctx?.now ?? probes.now()).getTime();
  const targetMs = Date.parse(c.after);
  return Number.isFinite(targetMs) && nowMs >= targetMs;
}

/** What the worker is told when it is continued (always English: it is read by the worker, not by a person). */
export function monitorNote(spec: MonitorSpec, result: Exclude<MonitorResult, 'waiting'>, tail: string, checks: number, exitedPid?: number): string {
  const verdict = result === 'done' ? 'The monitor says the job is over: the condition you gave for success was met.'
    : result === 'failed' && exitedPid !== undefined ? `The monitor says the job ended without success: its process (pid ${exitedPid}) is gone and neither condition you gave was met.`
    : result === 'failed' ? 'The monitor says the job failed: the condition you gave for failure was met.'
    : result === 'deadline' ? `The monitor gave up waiting: the ${spec.deadline_minutes} minutes you allowed are over and neither condition was met.`
    : 'The monitor could not run your check command, so it handed the order back.';
  const checkLine = spec.check?.length
    ? `Check command: ${spec.check.join(' ')} (${checks} checks made)`
    : `Condition monitor (${checks} checks made)`;
  return [
    verdict, '',
    checkLine,
    '', 'End of the output of the last check:', '```', tail || '(no output)', '```',
    ...(spec.note ? ['', `Your own note when you handed it over: ${spec.note}`] : []),
  ].join('\n');
}

/**
 * One pass over the orders in stage `monitoring`: the check command is run once for each (with a timeout, in a folder that is allowed);
 * when the success or failure condition holds, or the deadline has passed, the order is queued again for the same worker to continue.
 * A job whose process (`monitor.pid`) has ended, or whose pid now belongs to another process, is checked once more: its conditions
 * decide, and when neither holds it ended without success (`failed`). It does not touch workers, quota or the day's run count.
 */
export function runMonitors(project: ProjectConfig, orders: Orders, probes: Probes, skip: ReadonlySet<string> = new Set()): MonitorPass {
  const pass: MonitorPass = { done: [], problems: [], resolved: [] };
  const nowDate = probes.now();
  const now = nowDate.getTime();
  for (const doc of orders.all()) {
    if (orders.stage(doc).stage !== 'monitoring' || skip.has(doc.order.tag)) continue;
    const tag = doc.order.tag;
    const state = doc.monitor;
    const spec = doc.reports.find(r => r.seq === state?.report_seq)?.monitor;
    if (!state || !spec) { pass.problems.push({ tag, text: t('{tag}: the report that handed over the monitor has no monitor to run.', { tag }) }); continue; }
    const stale = staleMonitor(project, doc, probes);
    const exitedPid = stale && 'pid' in stale.evidence ? Number(stale.evidence.pid) : undefined;
    const hasCheck = Array.isArray(spec.check) && spec.check.length > 0;
    let cwd = doc.order.worktree ?? project.root;
    let ran: { code: number | null; output: string; timedOut: boolean; error?: string } = { code: null, output: '', timedOut: false };
    if (hasCheck) {
      const folder = checkFolder(project, doc, spec);
      if ('refused' in folder) {
        orders.monitorResolved(tag, 'refused', folder.refused, monitorNote(spec, 'refused', folder.refused, state.checks));
        pass.resolved.push(tag);
        pass.done.push(t('{tag}: the monitor was not run ({why}); the order goes back to its worker', { tag, why: folder.refused }));
        continue;
      }
      if (!probes.runCheck) { pass.problems.push({ tag, text: t('{tag}: this tool cannot run check commands here, so its monitor is not checked.', { tag }) }); continue; }
      cwd = folder.cwd;
      ran = probes.runCheck(spec.check!, cwd, project.dispatch.monitor_timeout_seconds);
    }
    const observations: string[] = [];
    const ctx: CriterionContext = { orders, now: nowDate, observations };
    const doneHolds = !ran.error && holds(spec.done_when, ran, cwd, probes, ctx);
    const failHolds = !ran.error && !doneHolds && !!spec.fail_when && holds(spec.fail_when, ran, cwd, probes, ctx);
    const rawOut = ran.error
      ? `${t('could not run the check command')}: ${ran.error}`
      : ran.timedOut
        ? `${ran.output}\n${t('(the check command was stopped after {s} s)', { s: project.dispatch.monitor_timeout_seconds })}`
        : ran.output;
    const combinedOutput = observations.length ? [rawOut, ...observations].filter(Boolean).join('\n') : rawOut;
    const tail = tailOf(combinedOutput);
    const result: MonitorResult = ran.error ? 'refused' : doneHolds ? 'done' : failHolds ? 'failed' : exitedPid !== undefined ? 'failed' : now >= Date.parse(state.deadline) ? 'deadline' : 'waiting';
    orders.monitorChecked(tag, { result, tail, observation: monitorObservation(spec, cwd, combinedOutput, probes, [ran.code, ran.error, ran.timedOut]) });
    if (result === 'waiting') continue;
    const checks = orders.get(tag).monitor?.checks ?? state.checks + 1;
    const ended = result === 'failed' && exitedPid !== undefined && !failHolds ? exitedPid : undefined;
    orders.monitorResolved(tag, result, tail, monitorNote(spec, result, tail, checks, ended));
    pass.resolved.push(tag);
    pass.done.push(ended !== undefined ? t('{tag}: the monitored job (pid {pid}) has ended without meeting its condition; the order goes back to its worker', { tag, pid: ended }) : t('{tag}: the monitor ended ({result}); the order goes back to its worker', { tag, result }));
  }
  return pass;
}

/** For the report: one line for each order that is being monitored. */
export function monitoringLines(orders: Orders, now: Date): { tag: string; text: string }[] {
  const out: { tag: string; text: string }[] = [];
  for (const doc of orders.all()) {
    if (orders.stage(doc).stage !== 'monitoring' || !doc.monitor) continue;
    const m = doc.monitor;
    const left = Math.round((Date.parse(m.deadline) - now.getTime()) / 60000);
    out.push({ tag: doc.order.tag, text: t('{tag}: monitoring, {n} checks, last: {last}; deadline in {min} min', { tag: doc.order.tag, n: m.checks, last: m.last_result ?? t('not checked yet'), min: Math.max(0, left) }) });
  }
  return out;
}
