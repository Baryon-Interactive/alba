import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { OrderSkill } from '../api/types.ts';
import type { OrderDoc, Run } from '../orders/model.ts';
import type { Probes } from '../tick/gather.ts';
import { baseRefOf } from './worktree.ts';
import { fenceUntrusted } from './fence.ts';
import { findOrderFile, promptFor, type PromptLessons } from './prompt.ts';

const slash = (p: string) => p.replace(/\\/g, '/');

const gitText = (cwd: string, args: string[]): string => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

/** Why a run ended in words a worker understands. */
export const limitWords = (limit: Run['limit']): string => limit === 'quota' ? 'its usage window was used up' : limit === 'unreachable' ? 'its model endpoint was unreachable' : 'the model service was at capacity';

/** The sentence an event and the order detail show when an order is handed to another worker. */
export function handoffLine(from: string, to: string, why: string, paid: boolean): string {
  const because = /usage window/i.test(why) ? t('{who} ran out of its usage window', { who: from }) : t('{who} was at capacity', { who: from });
  return paid
    ? t('handed over from {from} to {to} because {because}; {to} is paid', { from, to, because })
    : t('handed over from {from} to {to} because {because}; {to} is included', { from, to, because });
}

export interface HandoffInput {
  project: ProjectConfig;
  doc: OrderDoc;
  /** The worker that had the order and the run it ran. */
  from: { worker: string; run?: Run };
  to: string;
  why: string;
  worktree: string;
  runId: string;
  probes: Probes;
  lessons: PromptLessons;
  skills: readonly OrderSkill[];
}

/**
 * The continuation file a worker is pointed at when an order is handed over because the worker before it ran out of quota or capacity:
 * why, the order file, what the branch holds so far, the last report, what was asked and answered, the end of the last log, and then
 * the usual prompt (order pointer, lessons, skills, how to report). The prompt of the run is only the path of this file.
 */
export function writeHandoff(input: HandoffInput): string {
  const { project, doc, worktree } = input;
  const tag = doc.order.tag;
  const out: string[] = [`# Continuation of ${tag}: ${doc.order.title}`, ''];
  out.push(`The worker before you (${input.from.worker}) could not go on because ${input.why}. You carry on from where it stopped, in the same worktree and on the same branch. Do not start over: read this file, look at what is already committed, and continue.`, '');
  out.push('## The order', '', `- Order file: ${findOrderFileSafe(project, tag)}`, `- Worktree: ${slash(worktree)}`, `- Branch: ${doc.order.branch ?? '(see git)'}`, '');
  const base = baseRefOf(project);
  const log = gitText(worktree, ['log', '--oneline', '-30', `${base}..HEAD`]);
  const status = gitText(worktree, ['status', '--short']);
  out.push('## What the branch holds so far', '', '```', log || '(no commits on the branch yet)', '```', '', 'Uncommitted changes:', '', '```', status || '(none)', '```', '');
  const last = [...doc.reports].sort((a, b) => b.seq - a.seq)[0];
  const lastReportText = last
    ? `- ${last.status}: ${last.summary}${last.question ? `\n- Question: ${last.question}` : ''}${last.commits.length ? `\n- Commits: ${last.commits.join(', ')}` : ''}`
    : undefined;
  out.push('## The last report', '', lastReportText ? fenceUntrusted('earlier run report', lastReportText) : '(the worker before you wrote none)', '');
  const asked = (doc.questions ?? []).filter(q => q.answered);
  const notes = doc.actions.filter(a => (a.kind === 'answer' || a.kind === 'rework' || a.kind === 'message' || a.kind === 'monitor') && a.note);
  if (asked.length || notes.length) {
    out.push('## Questions asked and answered, and what the reviewer said', '');
    for (const q of asked) out.push(`- Q: ${q.text} -> option ${q.answered!.choice.join(', ')}${q.answered!.note ? `: ${q.answered!.note}` : ''}`);
    for (const a of notes) {
      if (a.kind === 'monitor') out.push(`- Monitor result:\n${fenceUntrusted('monitor output', a.note!)}`);
      else out.push(`- ${a.kind === 'answer' ? 'Answer' : a.kind === 'message' ? 'Message' : 'Rework note'}: ${a.note}`);
    }
    out.push('');
  }
  const prev = input.from.run;
  if (prev?.log && existsSync(prev.log)) {
    const tail = input.probes.tail(prev.log, 6000).split(/\r?\n/).slice(-60).join('\n');
    out.push('## The end of the last log', '', fenceUntrusted('previous run log tail', tail.trim() || '(empty)'), '');
  }
  out.push('## The usual instructions', '', promptFor(project.work_orders, doc, input.lessons, input.skills, project.lessons?.max_rule_lines).trim(), '');
  const dir = path.join(project.state_dir, 'runs');
  mkdirSync(dir, { recursive: true });
  const file = slash(path.join(dir, `${tag}-${input.runId}.handoff.md`));
  writeFileSync(file, out.join('\n'), 'utf8');
  return file;
}

function findOrderFileSafe(project: ProjectConfig, tag: string): string {
  try { return findOrderFile(project.work_orders, tag); } catch { return '(no order file)'; }
}

/** What the prompt of a rotated run says: only where to read. */
export const handoffPrompt = (file: string): string => `Read the UTF-8 file ${file} in full and follow it exactly.\n`;
