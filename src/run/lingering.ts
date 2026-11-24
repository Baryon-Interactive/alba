import { stopWarning } from './kill-tree.ts';
import { UserError, t } from '../i18n.ts';
import type { ProjectConfig } from '../config.ts';
import type { Run } from '../orders/model.ts';
import type { Probes } from '../tick/gather.ts';
import type { Orders } from '../orders/service.ts';
import { parseReportBlock, REPORT_END, type ReportInput } from '../orders/report.ts';
import { parseStreamLog } from '../workers/adapters/index.ts';
import { claudeContent, eventText } from '../workers/adapters/claude-protocol.ts';

/** How much text may follow the report block and still be "the end of the log": a token count, a closing line. */
const TRAILING_CHARS = 4000;

/** What the report footer shows as an example: a block with these words is the prompt printed back, not a report. */
const isTemplate = (r: ReportInput): boolean => r.summary.trim().toLowerCase() === 'one sentence' || r.evidence.includes('path/to/proof');

const END_MARKERS = [REPORT_END];

/**
 * Has the worker already handed in its report? Reads the end of a run's log (the text of the last message for engines that print JSON
 * events) and returns the last complete report block when it is the end of the log: nothing but a short trailer follows it, and it is not
 * the example block of the report footer echoed back with the prompt. A log that only mentions a block in the middle of other work gives nothing.
 */
export function deliveredReport(logTail: string, options: { cut?: boolean } = {}): ReportInput | undefined {
  const stream = parseStreamLog(logTail, options);
  const text = stream.events ? stream.finalText : logTail;
  if (!text.trim()) return undefined;
  let report: ReportInput;
  try { report = parseReportBlock(text); } catch (e) { if (e instanceof UserError) return undefined; throw e; }
  if (isTemplate(report)) return undefined;
  const lines = text.split(/\r?\n/);
  let last = -1;
  lines.forEach((l, i) => { if (END_MARKERS.includes(l.trim())) last = i; });
  if (last < 0 || lines.slice(last + 1).join('\n').length > TRAILING_CHARS) return undefined;
  return report;
}

/** Where a report that was not in the run's last message was found. */
export interface EarlierReport { report: ReportInput; text: string; where: 'earlier-message' | 'written-file'; file?: string }

/** A user turn that is a new instruction (not a tool result, not a notification the engine adds itself) starts what this run must answer. */
function isInstruction(event: Record<string, unknown>): boolean {
  const content = (event.message as { content?: unknown } | undefined)?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) && !content.some(c => c?.type === 'tool_result') ? content.filter(c => c?.type === 'text').map(c => String(c.text ?? '')).join('\n') : '';
  return !!text.trim() && !/^\s*<(task-notification|system-reminder|local-command)/.test(text);
}

/**
 * The newest valid report block a Claude run wrote before its last message. A background command that ends after the final
 * message makes `claude -p` start one more turn for its notification, and that turn's short remark becomes the last message.
 * Looks at the assistant messages (and results) after the run's last instruction, newest first; failing that, at a report
 * the worker saved with the Write tool to a `*.last.txt` file (some write it to a path of their own). Example blocks of the
 * report footer do not count.
 */
export function earlierReport(eventsText: string): EarlierReport | undefined {
  const messages: string[] = [], writes: { file: string; text: string }[] = [];
  for (const raw of eventsText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let event: Record<string, any>;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event !== 'object' || event === null) continue;
    if (event.type === 'user' && isInstruction(event)) { messages.length = 0; writes.length = 0; continue; }
    if (event.type === 'assistant') {
      const text = eventText(event);
      if (text?.includes('alba-report')) messages.push(text);
      for (const c of claudeContent(event)) {
        const input = c.input as { file_path?: unknown; content?: unknown } | undefined;
        if (c.type === 'tool_use' && c.name === 'Write' && typeof input?.content === 'string' && typeof input.file_path === 'string' && /\.last\.txt$/i.test(input.file_path) && input.content.includes('alba-report')) writes.push({ file: input.file_path, text: input.content });
      }
    }
    if (event.type === 'result' && event.is_error !== true) { const text = eventText(event); if (text?.includes('alba-report')) messages.push(text); }
  }
  const valid = (text: string): ReportInput | undefined => {
    try { const r = parseReportBlock(text); return isTemplate(r) ? undefined : r; } catch (e) { if (e instanceof UserError) return undefined; throw e; }
  };
  for (const text of messages.reverse()) { const report = valid(text); if (report) return { report, text, where: 'earlier-message' }; }
  for (const w of writes.reverse()) { const report = valid(w.text); if (report) return { report, text: w.text, where: 'written-file', file: w.file }; }
  return undefined;
}

/** The tail of the log that is read: enough for a final message printed as many small events. */
const TAIL_BYTES = 65536;

/**
 * How long a run whose engine has ended its turn (see `StreamLog.ended`) and handed in its report may keep its process before it is
 * stopped. `codex exec` sometimes stays after its last event (an MCP server that does not let go), and then nothing else ends the run.
 */
export const ENDED_GRACE_MINUTES = 2;

/** The report block at the end of a run's log (its events file when it has one), with the text it came in and that file; alive or not. */
export function reportInRunLog(probes: Probes, run: Run): { report: ReportInput; text: string; file: string } | undefined {
  const file = run.events_file ?? run.log;
  if (!file || run.imported) return undefined;
  const tail = probes.tail(file, TAIL_BYTES);
  if (!tail) return undefined;
  const cut = Buffer.byteLength(tail) >= TAIL_BYTES;
  const report = deliveredReport(tail, { cut });
  if (!report) return undefined;
  const stream = parseStreamLog(tail, { cut });
  return { report, text: stream.events ? stream.finalText : tail, file };
}

/** A run that has handed in its report while its process is still alive. `ended`: the engine's own end event is the last one in the log; `quietMinutes`: since the log last changed. */
export interface HandedIn { status: string; summary: string; quietMinutes: number; ended: boolean }

/** Has this open run of ours, whose process is alive, already handed in its report at the end of its log? Whatever the time. */
export function handedIn(probes: Probes, run: Run): HandedIn | undefined {
  if (!run.pid || run.imported || !run.log || run.ended !== undefined || !probes.isAlive(run.pid)) return undefined;
  const file = run.events_file ?? run.log;
  const at = probes.fileTime(file);
  if (!at) return undefined;
  const tail = probes.tail(file, TAIL_BYTES);
  const cut = Buffer.byteLength(tail) >= TAIL_BYTES;
  const report = deliveredReport(tail, { cut });
  // A block naming another run (a predecessor's report echoed into this log) is not this run's delivery: never stop the run for it.
  if (!report || namesAnotherRun(report, run.id)) return undefined;
  return { status: report.status, summary: report.summary, quietMinutes: (probes.now().getTime() - Date.parse(at)) / 60000, ended: parseStreamLog(tail, { cut }).ended === true };
}

/** The report names a run (`r2` or `TAG/r2`) and it is not `runId`. A report without a run id names none. */
function namesAnotherRun(report: ReportInput, runId: string): boolean {
  return !!report.run && report.run !== runId && !report.run.endsWith(`/${runId}`);
}

/**
 * A run of ours whose process is alive, whose log already ends with its report block, and whose log has been quiet for
 * `dispatch.lingering_minutes`: it has delivered, and only its process is still there. When the engine's end event is the last
 * one (`ended`), `ENDED_GRACE_MINUTES` is enough, and the tick stops the process whatever `dispatch.on_lingering` says.
 */
export function lingeringOf(project: ProjectConfig, probes: Probes, run: Run): HandedIn | undefined {
  const late = handedIn(probes, run);
  if (!late) return undefined;
  const wait = late.ended ? Math.min(ENDED_GRACE_MINUTES, project.dispatch.lingering_minutes) : project.dispatch.lingering_minutes;
  return late.quietMinutes >= wait ? { ...late, quietMinutes: Math.round(late.quietMinutes) } : undefined;
}

/**
 * `dispatch.on_lingering: stop`: ends the process tree of this run: the recorded process (often a wrapper: the capture process, the
 * editor helper), the worker under it and what the worker left running, except the job its delivered report hands to the monitor
 * (`monitor.pid`) and what is under that. The run is not closed here: the next look at the finished runs reads its report like any other end.
 */
export function stopLingeringRun(orders: Orders, probes: Probes, tag: string): string {
  const run = orders.get(tag).runs.find(r => r.ended === undefined);
  if (!run) return t('{tag}: no open run to stop', { tag });
  const file = run.events_file ?? run.log;
  const tail = file ? probes.tail(file, TAIL_BYTES) : '';
  const handed = tail ? deliveredReport(tail, { cut: Buffer.byteLength(tail) >= TAIL_BYTES })?.monitor?.pid : undefined;
  const result = run.pid && !run.imported ? probes.stopTree?.(run.pid, run.process_started_at, { launchedAt: run.started, ...(handed ? { spare: [handed] } : {}) }) : undefined;
  const warning = result && stopWarning(result);
  if (!run.pid || !result?.stopped.includes(run.pid)) return warning ?? t('Refusing to stop process {pid} of {tag}: it is not the process this run started.', { pid: run.pid ?? 0, tag });
  orders.record(tag, 'lingering-stopped', { run: run.id, pid: run.pid, stopped: result.stopped, left_running: result.leftRunning, ...(result.problem && { problem: result.problem }) });
  return t('{tag}: stopped the process of run {run} (its report was already in the log)', { tag, run: run.id }) + (warning ? ' ' + warning : '');
}
