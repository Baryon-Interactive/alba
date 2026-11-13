import { REPORT_STATUSES, type MonitorCriterion, type MonitorSpec, type OptionInput, type ReportStatus, type WaitingFor } from './model.ts';
import { fail } from '../i18n.ts';

/** The structured report a worker gives at the end of a round. */
export interface ReportInput {
  design_changes?: string[];
  revision?: string;
  /** Tool-supplied original delivery text; never accepted as a report JSON field. */
  delivery_text?: string;
  status: ReportStatus;
  summary: string;
  question?: string;
  /** 2 to 4 choices for the question, the recommended one first. */
  options?: OptionInput[];
  waiting_for?: WaitingFor;
  /** `project`: the question belongs to the project (candidates to pick from), not to this order alone; it is listed with the pick sets. */
  scope?: 'order' | 'project';
  evidence: string[];
  commits: string[];
  /** Changes the worker would like made to a shared skill (the path and why); nothing is changed for it. */
  skill_suggestions?: { path: string; reason: string }[];
  /** For status `monitoring`: the long job that was handed over and the cheap command that tells when it is over. */
  monitor?: MonitorSpec;
  /** Set by the tool, never read from a block: the report was guessed from free text. */
  source?: 'inferred' | 'inferred-git';
}

export const REPORT_BEGIN = '--- alba-report ---';
export const REPORT_END = '--- end ---';

/**
 * Validates a parsed JSON value as a report. Shape:
 *   { "status": "progress|waiting|ready|blocked|failed|dropped",
 *     "summary": "one sentence",
 *     "question": "at most one concrete question for a person (optional)",
 *     "options": ["a choice", {"label": "another", "note": "why", "images": ["path.png"]}]   (2 to 4, the recommended one first; needs a question),
 *     "waiting_for": "card|answer"   (optional; a card is clicked by a person in a session of their own),
 *     "scope": "project"   (optional; the question and its options are candidates for the whole project: they are listed with the pick sets),
 *     "evidence": ["paths"], "commits": ["abc1234"],
 *     "monitor": {"check": ["program", "arg"], "cwd": "optional", "done_when": {"exit_code": 0} | {"file_exists": "path"} | {"output_matches": "regex"},
 *                "fail_when": same shapes (optional), "deadline_minutes": 120, "note": "what to do next"}   (with status "monitoring", and only then) }
 */
export function validateReport(value: unknown): ReportInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('A report must be a JSON object.');
  const v = value as Record<string, unknown>;
  const known = ['design_changes', 'status', 'summary', 'question', 'options', 'waiting_for', 'evidence', 'commits', 'skill_suggestions', 'monitor', 'scope', 'revision'];
  const extra = Object.keys(v).filter(k => !known.includes(k));
  if (extra.length) fail('Unknown report field(s): {fields}. Allowed: {allowed}.', { fields: extra.join(', '), allowed: known.join(', ') });
  if (typeof v.status !== 'string' || !(REPORT_STATUSES as readonly string[]).includes(v.status)) {
    fail('Report "status" must be one of: {allowed}.', { allowed: REPORT_STATUSES.join(', ') });
  }
  if (typeof v.summary !== 'string' || !v.summary.trim()) fail('Report "summary" must be a non-empty one-line string.');
  if (v.summary.includes('\n')) fail('Report "summary" must be a single line.');
  if (v.question !== undefined && typeof v.question !== 'string') fail('Report "question" must be a string (one question only), empty or left out when there is none.');
  if (v.design_changes !== undefined && (!Array.isArray(v.design_changes) || v.design_changes.some(p => typeof p !== 'string' || !/^\.alba\/design\/changes\/[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(p)) || new Set(v.design_changes).size !== v.design_changes.length)) fail('Report design_changes must list unique .alba/design/changes/*.json files.');
  if (v.revision !== undefined && (typeof v.revision !== 'string' || !/^[0-9a-f]{7,40}$/i.test(v.revision))) fail('Report "revision" must be a git commit hash (7 to 40 hexadecimal characters).');
  const list = (key: 'evidence' | 'commits'): string[] => {
    const x = v[key];
    if (x === undefined) return [];
    if (!Array.isArray(x) || x.some(i => typeof i !== 'string' || !i.trim())) fail('Report "{key}" must be a list of non-empty strings.', { key });
    return (x as string[]).map(i => i.trim());
  };
  const designChanges = v.design_changes as string[] | undefined;
  const status = v.status as ReportStatus;
  const question = typeof v.question === 'string' && v.question.trim() ? v.question.trim() : undefined;
  if (question && !['waiting', 'blocked'].includes(status)) fail('A "question" only makes sense with status "waiting" or "blocked", not "{status}".', { status });
  let options: OptionInput[] | undefined;
  if (v.options !== undefined) {
    if (!question) fail('Report "options" only make sense together with a "question".');
    options = normalizeOptions(v.options);
  }
  if (v.waiting_for !== undefined && v.waiting_for !== 'card' && v.waiting_for !== 'answer') fail('Report "waiting_for" must be "card" or "answer".');
  if (v.waiting_for !== undefined && status !== 'waiting') fail('Report "waiting_for" only makes sense with status "waiting", not "{status}".', { status });
  if (v.scope !== undefined && v.scope !== 'order' && v.scope !== 'project') fail('Report "scope" must be "order" or "project".');
  if (v.scope === 'project' && !(question && options)) fail('A report with scope "project" needs a "question" and "options": it is a set of candidates to pick from.');
  let suggestions: { path: string; reason: string }[] | undefined;
  if (v.skill_suggestions !== undefined) {
    const s = v.skill_suggestions;
    if (!Array.isArray(s) || s.some(x => typeof x !== 'object' || x === null || typeof (x as Record<string, unknown>).path !== 'string' || !(x as { path: string }).path.trim() || typeof (x as Record<string, unknown>).reason !== 'string')) fail('Report "skill_suggestions" must be a list of {"path": "...", "reason": "..."}.');
    suggestions = (s as { path: string; reason: string }[]).map(x => ({ path: x.path.trim(), reason: x.reason.trim() }));
  }
  let monitor: MonitorSpec | undefined;
  if (status === 'monitoring') monitor = validateMonitor(v.monitor);
  else if (v.monitor !== undefined) fail('Report "monitor" only makes sense with status "monitoring", not "{status}".', { status });
  const evidence = list('evidence');
  const commits = list('commits');
  return { status, summary: v.summary.trim(), ...(designChanges?.length ? { design_changes: designChanges } : {}), ...(typeof v.revision === 'string' ? { revision: v.revision } : {}), ...(monitor ? { monitor } : {}), ...(question ? { question } : {}), ...(options ? { options } : {}), ...(v.waiting_for ? { waiting_for: v.waiting_for as WaitingFor } : {}), ...(v.scope === 'project' ? { scope: 'project' as const } : {}), evidence, commits, ...(suggestions?.length ? { skill_suggestions: suggestions } : {}) };
}

const CRITERIA = ['exit_code', 'file_exists', 'output_matches'] as const;

/** One condition of a monitor: an object with exactly one of exit_code (a whole number), file_exists (a path) or output_matches (a regular expression). */
export function validateCriterion(value: unknown, at: string): MonitorCriterion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('Report "{at}" must be an object with one of: {keys}.', { at, keys: CRITERIA.join(', ') });
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1 || !(CRITERIA as readonly string[]).includes(entries[0][0])) fail('Report "{at}" must have exactly one of: {keys}.', { at, keys: CRITERIA.join(', ') });
  const [key, v] = entries[0];
  if (key === 'exit_code') {
    if (typeof v !== 'number' || !Number.isInteger(v)) fail('Report "{at}.exit_code" must be a whole number.', { at });
    return { exit_code: v };
  }
  if (typeof v !== 'string' || !v.trim()) fail('Report "{at}.{key}" must be a non-empty string.', { at, key });
  if (key === 'output_matches') { try { new RegExp(v, 'u'); } catch (e) { fail('Report "{at}.output_matches" is not a valid regular expression: {error}', { at, error: (e as Error).message }); } return { output_matches: v }; }
  return { file_exists: v.trim() };
}

/** The `monitor` of a `monitoring` report. */
export function validateMonitor(value: unknown): MonitorSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('A report with status "monitoring" needs a "monitor": {"check": [program, args...], "done_when": {...}, "deadline_minutes": n}.');
  const m = value as Record<string, unknown>;
  const known = ['check', 'cwd', 'done_when', 'fail_when', 'deadline_minutes', 'note', 'pid'];
  const extra = Object.keys(m).filter(k => !known.includes(k));
  if (extra.length) fail('Unknown monitor field(s): {fields}. Allowed: {allowed}.', { fields: extra.join(', '), allowed: known.join(', ') });
  if (!Array.isArray(m.check) || !m.check.length || m.check.some(x => typeof x !== 'string' || !x)) fail('Report "monitor.check" must be a list: the program, then its arguments (no shell is used).');
  if (m.cwd !== undefined && (typeof m.cwd !== 'string' || !m.cwd.trim())) fail('Report "monitor.cwd" must be a folder.');
  if (typeof m.deadline_minutes !== 'number' || !Number.isFinite(m.deadline_minutes) || m.deadline_minutes < 1 || m.deadline_minutes > 10080) fail('Report "monitor.deadline_minutes" must be a number from 1 to 10080 (a week).');
  if (m.note !== undefined && typeof m.note !== 'string') fail('Report "monitor.note" must be text.');
  if (m.pid !== undefined && (!Number.isInteger(m.pid) || Number(m.pid) <= 0)) fail('Report "monitor.pid" must be a positive integer.');
  if (m.done_when === undefined) fail('Report "monitor.done_when" is required: when is the job over?');
  return {
    check: m.check as string[], ...(m.pid !== undefined ? { pid: Number(m.pid) } : {}), ...(typeof m.cwd === 'string' ? { cwd: m.cwd.trim() } : {}), done_when: validateCriterion(m.done_when, 'monitor.done_when'),
    ...(m.fail_when !== undefined ? { fail_when: validateCriterion(m.fail_when, 'monitor.fail_when') } : {}), deadline_minutes: m.deadline_minutes, ...(typeof m.note === 'string' && m.note.trim() ? { note: m.note.trim() } : {}),
  };
}

/** 2 to 4 options, each a string or {label, note?, images?}; the first is the recommended one. */
export function normalizeOptions(value: unknown): OptionInput[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) fail('A question with options needs 2 to 4 options, the recommended one first.');
  return value.map((o, i): OptionInput => {
    if (typeof o === 'string') {
      if (!o.trim()) fail('Option {n} has no label.', { n: i + 1 });
      return { label: o.trim() };
    }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) fail('Option {n} must be a text or an object with a "label".', { n: i + 1 });
    const r = o as Record<string, unknown>;
    const extra = Object.keys(r).filter(k => !['label', 'note', 'images'].includes(k));
    if (extra.length) fail('Option {n} has unknown field(s): {fields}. Allowed: label, note, images.', { n: i + 1, fields: extra.join(', ') });
    if (typeof r.label !== 'string' || !r.label.trim()) fail('Option {n} has no label.', { n: i + 1 });
    if (r.note !== undefined && typeof r.note !== 'string') fail('Option {n}: "note" must be text.', { n: i + 1 });
    if (r.images !== undefined && (!Array.isArray(r.images) || r.images.some(x => typeof x !== 'string' || !x.trim()))) fail('Option {n}: "images" must be a list of file paths.', { n: i + 1 });
    return { label: r.label.trim(), ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note.trim() } : {}), ...(Array.isArray(r.images) && r.images.length ? { images: (r.images as string[]).map(x => x.trim()) } : {}) };
  });
}

/** Parses a standalone report.json. */
export function parseReportJson(text: string): ReportInput {
  let value: unknown;
  try { value = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { fail('The report is not valid JSON: {error}', { error: (e as Error).message }); }
  return validateReport(value);
}

/**
 * Reads the report from the end of a free-text file such as `<TAG>.last.txt`. The block is
 *   --- alba-report ---
 *   { ...json... }
 *   --- end ---
 * on lines of their own.
 * If there are several blocks the last one wins.
 */
export function parseReportBlock(text: string): ReportInput {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim().replace(/^---\s*alba-report\s*---$/, REPORT_BEGIN).replace(/^---\s*end\s*---$/, REPORT_END));
  const end = lines.lastIndexOf(REPORT_END);
  let begin = -1;
  if (end < 0) fail('No report block found. End the file with {begin}, a JSON object, then {end} (each on its own line).', { begin: REPORT_BEGIN, end: REPORT_END });
  for (let i = end - 1; i >= 0; i--) if (lines[i] === REPORT_BEGIN) { begin = i; break; }
  if (begin < 0) fail('Found {end} without a matching {begin}.', { end: REPORT_END, begin: REPORT_BEGIN });
  return parseReportJson(lines.slice(begin + 1, end).join('\n'));
}

/** `.json` files are plain reports; anything else is searched for the fixed block. */
export function parseReportFile(fileName: string, text: string): ReportInput {
  return /\.json$/i.test(fileName) ? parseReportJson(text) : parseReportBlock(text);
}
