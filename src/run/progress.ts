import path from 'node:path';
import type { ProgressView } from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import type { Probes } from '../tick/gather.ts';

/** Where a worker writes its start receipt and step list: `<TAG>.progress.json` in the work-order folder. */
export const progressFile = (project: ProjectConfig, tag: string): string => path.join(project.work_orders, `${tag}.progress.json`);

const DONE = new Set(['done', 'complete', 'completed', 'finished']);
const DOING = new Set(['doing', 'in_progress', 'in-progress', 'running', 'active', 'current']);

/**
 * Reads the worker's step list: `{"plan":[{"step":"...","status":"done|doing|todo"}],"note":"..."}`. Lenient about the status words,
 * strict about the shape; a file that is not that (half-written, other JSON) gives nothing, though its mere existence still counts as the receipt.
 */
export function parseProgress(text: string, at: string): ProgressView | undefined {
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return undefined; }
  if (!raw || typeof raw !== 'object') return undefined;
  const plan = (raw as { plan?: unknown }).plan;
  if (!Array.isArray(plan)) return undefined;
  const steps = plan.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const { step, status } = item as { step?: unknown; status?: unknown };
    return typeof step === 'string' && step.trim() ? [{ step: step.trim().slice(0, 200), status: typeof status === 'string' ? status.trim().toLowerCase() : 'todo' }] : [];
  }).slice(0, 50);
  const note = (raw as { note?: unknown }).note;
  const current = steps.find(s => DOING.has(s.status)) ?? steps.find(s => !DONE.has(s.status));
  return { plan: steps, done: steps.filter(s => DONE.has(s.status)).length, total: steps.length, ...(current ? { current: current.step } : {}), ...(typeof note === 'string' && note.trim() ? { note: note.trim().slice(0, 500) } : {}), at };
}

/** The receipt of a running order: when its progress file was last written, and what it says. */
export function readReceipt(project: ProjectConfig, probes: Probes, tag: string, worktree?: string): { at: string; progress?: ProgressView } | undefined {
  const files = [progressFile(project, tag)];
  const relative = path.relative(project.root, project.work_orders);
  if (worktree && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
    files.push(path.join(worktree, relative, `${tag}.progress.json`));
  }
  const newest = files.flatMap(file => { const at = probes.fileTime(file); return at ? [{ file, at }] : []; })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (!newest) return undefined;
  const { file, at } = newest;
  const text = probes.readText(file);
  const progress = text === undefined ? undefined : parseProgress(text, at);
  return { at, ...(progress ? { progress } : {}) };
}
