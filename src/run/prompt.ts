import { textConventions } from '../i18n.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withRoleRules } from '../roles/mount.ts';
import { fileURLToPath } from 'node:url';
import { fail } from '../i18n.ts';
import type { Lesson, OrderSkill } from '../api/types.ts';
import { lessonsSection } from '../lessons/lessons.ts';
import type { OrderDoc, Run } from '../orders/model.ts';

const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates');
export const readTemplate = (name: string): string => readFileSync(path.join(templates, name), 'utf8');

/** The work-order file of a tag: `<TAG>.md` or `<TAG>-<anything>.md` (any case) in the work-order folder. */
export function findOrderFile(workOrders: string, tag: string): string {
  const want = tag.toLowerCase();
  const names = existsSync(workOrders) ? readdirSync(workOrders) : [];
  const hit = names.filter(n => /\.md$/i.test(n)).filter(n => !/\.accept\.md$/i.test(n)).find(n => {
    const l = n.toLowerCase();
    return l === `${want}.md` || l.startsWith(`${want}-`) || l.startsWith(`${want}_`);
  });
  if (!hit) return fail('No work-order file for {tag} in {dir} (expected {tag}-<name>.md).', { tag, dir: workOrders });
  return path.join(workOrders, hit).replace(/\\/g, '/');
}

/** A note that is still waiting for a run that really works through it. */
export interface PendingNote { kind: 'rework' | 'answer' | 'monitor' | 'message'; text: string; seq: number; at: string; question?: string; bounce?: boolean }

export const MISSING_REPORT_REMINDER = 'The previous run ended without a report block; end this run with one.';
export const MONITOR_CONTINUATION = 'Use the monitor result to continue the order\'s remaining work, including its acceptance checks. A progress report alone does not finish the order.';

export interface PromptParts { roleRules?: string; orderFile: string; /** The skills put into the worktree for this order (name, what for, file): a list for engines that do not show them. */ skills?: readonly OrderSkill[]; /** Lessons that match the order's tags: id, title and rule go into the prompt. */ lessons?: readonly Lesson[]; rework?: string; /** What the monitor found (the worker handed a long job to it): the result, the end of the check's output and the worker's own note. */ monitor?: string; /** The answer to the worker's own question, with the question. */ answer?: { text: string; question?: string }; /** Every note still waiting, oldest first. When set, this replaces the single rework, monitor and answer sections. */ notes?: readonly PendingNote[]; missingReport?: boolean; recovery: boolean; /** A long lesson rule is cut to this many lines. */ lessonLines?: number }

/**
 * The prompt file a worker is pointed at: a one-line pointer to the order file (non-ASCII text in a command
 * line gets mangled on some systems, so the real instructions live in files), an optional rework note, an optional
 * recovery note, and the report footer.
 */
export function buildPrompt(parts: PromptParts): string {
  const out = [`Read the UTF-8 file ${parts.orderFile} in full and follow it exactly.`];
  const lessons = lessonsSection(parts.lessons ?? [], parts.lessonLines);
  if (lessons.length) out.push('', ...lessons);
  if (parts.skills?.length) out.push('', ...skillsSection(parts.skills));
  if (parts.notes?.length) out.push('', ...notesSection(parts.notes));
  else {
    if (parts.rework) out.push('', '## Rework requested by the reviewer', '', parts.rework.trim());
    if (parts.monitor) out.push('', '## Result of the monitor you asked for', '', parts.monitor.trim(), '', MONITOR_CONTINUATION);
    if (parts.answer) out.push('', '## Answer to your question', '', ...(parts.answer.question ? [`You asked: ${parts.answer.question}`, ''] : []), parts.answer.text.trim());
  }
  if (parts.missingReport) out.push('', MISSING_REPORT_REMINDER);
  if (parts.recovery) out.push('', readTemplate('recovery-note.md').trim());
  out.push('', readTemplate('report-footer.md').trim());
  return withRoleRules(out.join('\n') + '\n', parts.roleRules);
}

const oneLine = (text: string, max = 150): string => {
  const first = text.split(textConventions.prompt_15)[0] ?? text;
  return (first.length > max ? first.slice(0, max - 1) + '…' : first).replace(/\|/g, '/');
};

const NOTE_TITLE: Record<PendingNote['kind'], string> = {
  rework: 'Rework requested by the reviewer',
  monitor: 'Result of the monitor you asked for',
  answer: 'Answer to your question',
  message: 'Message',
};

/** One note, in the shape a single note has always had, with the time it was sent. */
function oneNote(n: PendingNote): string[] {
  const head = [`## ${NOTE_TITLE[n.kind]}`, ''];
  if (n.kind === 'answer' && n.question) head.push(`You asked: ${n.question}`, '');
  return [...head, n.text.trim(), ...(n.kind === 'monitor' ? ['', MONITOR_CONTINUATION] : []), '', `Sent ${n.at}.`];
}

/** Every note still waiting, oldest first. One note keeps its own heading; several share one section so none is dropped. */
export function notesSection(notes: readonly PendingNote[]): string[] {
  if (notes.length === 1) return oneNote(notes[0]);
  const out = ['## Notes still waiting', '', 'These were sent and no run has worked through them yet. Follow all of them, oldest first.', ''];
  for (const n of notes) {
    out.push(`### ${n.at} — ${n.kind}`, '');
    if (n.question) out.push(`You asked: ${n.question}`, '');
    out.push(n.text.trim(), ...(n.kind === 'monitor' ? ['', MONITOR_CONTINUATION] : []), '');
  }
  return out;
}

/** The skills of this order as a table: a worker whose engine does not list skills reads the file it needs. */
export function skillsSection(skills: readonly OrderSkill[]): string[] {
  if (!skills.length) return [];
  return [
    '## Skills for this order', '',
    'These skills were put into your working folder. If your tool lists them, use them from there; if it does not, read the SKILL.md of the ones that match your work before you start. Do not edit them: suggest a change in the report block (`skill_suggestions`).', '',
    '| Skill | What it is for | File |', '|---|---|---|',
    ...skills.map(s => `| ${s.name} | ${oneLine(s.description)} | ${s.path} |`),
  ];
}

/** Fills {placeholders} in a command template. An unknown placeholder is an error. */
export function expandArgs(args: readonly string[], values: Record<string, string>): string[] {
  return args.map(a => a.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in values)) fail('Unknown placeholder {{name}} in a launch template.', { name });
    return values[name];
  }));
}

/** The full argument list of a launch: `args` with the `{session_args}` entry replaced by the new-session or resume arguments. */
/** The entry of `launch.args` where the engine's own flags go (a wrapper script passes them on). */
export const ENGINE_FLAGS = '{engine_flags}';

export function launchArgs(launch: { args: readonly string[]; session?: { new: readonly string[]; resume: readonly string[] } }, values: Record<string, string>, resume: boolean): string[] {
  const spliced = launch.args.flatMap(a => (a === '{session_args}' ? (resume ? launch.session?.resume : launch.session?.new) ?? [] : [a]));
  // `{engine_flags}` stays as it is: the engine adapter puts its own flags there (and removes the entry when it has none).
  return spliced.map(a => a === ENGINE_FLAGS ? a : expandArgs([a], values)[0]);
}

/**
 * The prompt file of an order as the tool would write it for its next run: the pointer, every note that no run has
 * really followed yet (oldest first, each with its time), a recovery note when the tool has already run it, and the report footer.
 */
export function promptFor(workOrders: string, doc: OrderDoc, lessons: readonly Lesson[] = [], skills: readonly OrderSkill[] = [], lessonLines?: number): string {
  const notes = pendingNotes(doc);
  const previous = [...doc.runs].filter(r => r.ended !== undefined).sort((a, b) => b.seq - a.seq)[0];
  const missingReport = previous?.missing_report && !notes.some(n => n.bounce) && notes.some(n => n.seq > previous.seq);
  return buildPrompt({
    orderFile: findOrderFile(workOrders, doc.order.tag), lessons, skills, lessonLines, ...(notes.length ? { notes } : {}), missingReport, recovery: doc.runs.some(r => !r.imported),
  });
}

const NOTE_KINDS = new Set(['queue', 'rework', 'answer', 'monitor', 'message']);

/**
 * A run followed the notes that were already written when it started. That is a run that ended
 * `completed` with a real report block (a monitoring report counts), or that a person stopped (`cancelled`).
 * A transient ending (`capacity`) and a run that failed to start do not count.
 */
export function runFollowedNotes(doc: OrderDoc, run: Run): boolean {
  if (!run.ended) return false;
  if (run.outcome === 'cancelled') return true;
  if (run.outcome !== 'completed') return false;
  return doc.reports.some(r => r.run === run.id && r.source !== 'inferred' && r.source !== 'inferred-git' && !(run.monitor && r.status === 'progress'));
}

/** Every rework note, answer, monitor result or message that no later run has really followed. Oldest first. */
export function pendingNotes(doc: OrderDoc): PendingNote[] {
  const pending = doc.actions.filter(a => NOTE_KINDS.has(a.kind) && a.note && !doc.runs.some(r => r.seq > a.seq && runFollowedNotes(doc, r)));
  return pending.map(a => {
    const asked = a.kind === 'answer' ? [...doc.reports].filter(r => r.seq < a.seq && r.question).sort((x, y) => y.seq - x.seq)[0] : undefined;
    // Compare sequence numbers, not wall-clock times: a note can arrive while the failed run is still open,
    // or after the repair was queued. In both cases it takes precedence over report-only instructions.
    const failedRun = a.bounce ? [...doc.runs].filter(r => r.seq < a.seq).sort((x, y) => y.seq - x.seq)[0] : undefined;
    const continueWork = a.bounce && pending.some(n => !n.bounce && (n.kind === 'monitor' || n.seq > (failedRun?.seq ?? 0)));
    return { kind: (a.kind === 'queue' ? 'message' : a.kind) as PendingNote['kind'], text: continueWork ? MISSING_REPORT_REMINDER : a.note!, seq: a.seq, at: a.at, ...(a.bounce ? { bounce: true } : {}), ...(asked?.question ? { question: asked.question } : {}) };
  });
}

/** The latest note that no run has really followed yet. */
export function pendingNote(doc: OrderDoc): PendingNote | undefined {
  const all = pendingNotes(doc);
  return all[all.length - 1];
}

/** A monitor result is input to the remaining work, not a request for a status-only reply. */
export function monitorPrompt(text: string): string {
  return ['The long job you handed to the monitor is over (or its time ran out).', MONITOR_CONTINUATION, '', text.trim(), '', readTemplate('report-footer.md').trim()].join('\n') + '\n';
}

/** What a continued session is told: only the answer (the conversation already holds the order), and how to finish. */
export function answerPrompt(answer: { text: string; question?: string; at?: string }): string {
  return ['The person has answered your question. Carry on from where you stopped; you do not need to read the order again.', '', ...(answer.question ? [`You asked: ${answer.question}`, ''] : []), 'Answer:', '', answer.text.trim(), ...(answer.at ? ['', `Sent ${answer.at}.`] : []), '', readTemplate('report-footer.md').trim()].join('\n') + '\n';
}

/** What a continued session is told when a person stopped the run to send a message. Every note still waiting is included. */
export function messagePrompt(notes: readonly PendingNote[]): string {
  return ['The person stopped the run to send you a message. Carry on from where you stopped; you do not need to read the order again.', '', ...notesSection(notes), '', readTemplate('report-footer.md').trim()].join('\n') + '\n';
}
