import type { Worker } from '@api';
import { t } from '@/i18n';

/** Workers that draw on one subscription or balance come together: starting both at once spends the same quota. */
export interface WorkerGroup {
  /** The quota source the workers share; absent for the workers that have a source of their own (or none). */
  source?: string;
  workers: Worker[];
}

/** The groups of workers sharing a quota source (in the order of their first worker), then the others as one group. */
export function groupByQuota(workers: Worker[]): WorkerGroup[] {
  const shared = new Map<string, Worker[]>();
  const rest: Worker[] = [];
  for (const w of workers) {
    if (w.quotaSource && w.sharesQuotaWith.length > 0) (shared.get(w.quotaSource) ?? shared.set(w.quotaSource, []).get(w.quotaSource)!).push(w);
    else rest.push(w);
  }
  return [...[...shared].map(([source, list]) => ({ source, workers: list })), ...(rest.length ? [{ workers: rest }] : [])];
}

/** `same model` words of a worker: the other workers that run the same model behind another shell, if any. */
export const sameModelNote = (w: Worker): string | undefined => (w.modelFamily && w.sameModelAs.length ? t('{model}: same model, different shell as {others}', { model: w.modelFamily, others: w.sameModelAs.join(', ') }) : undefined);

// ------------------------------------------------------------------------------------------------------------------ the edit form

export interface DisabledRow { kind: 'window' | 'balance'; window: string; at: string; drop: string }

/** What the edit form holds: text as typed (numbers too), so that half-typed input is not lost. */
export interface WorkerForm {
  notes: string;
  capabilities: string;
  cost: 'included' | 'paid';
  concurrency: string;
  dailyRuns: string;
  enabled: boolean;
  aliases: string;
  dailyCapUsd: string;
  modelFamily: string;
  /** What to do when its usage window is used up or the service is at capacity: wait, or hand the order to another worker. */
  onLimit: 'wait' | 'rotate';
  /** With hand-over, a paid worker may take the order. */
  rotatePaid: boolean;
  disabledWhen: DisabledRow[];
}

export function formOf(w: Worker): WorkerForm {
  return {
    notes: w.notes ?? '',
    capabilities: w.capabilities.join(', '),
    cost: w.cost,
    concurrency: String(w.concurrency),
    dailyRuns: w.dailyRuns === undefined ? '' : String(w.dailyRuns),
    enabled: w.enabled,
    aliases: w.aliases.join(', '),
    dailyCapUsd: w.dailyCapUsd === undefined ? '' : String(w.dailyCapUsd),
    modelFamily: w.modelFamily ?? '',
    onLimit: w.onLimit === 'rotate' ? 'rotate' : 'wait',
    rotatePaid: w.rotatePaid === true,
    disabledWhen: w.disabledWhen.map(r => (r.balanceDrop !== undefined ? { kind: 'balance' as const, window: '', at: '', drop: String(r.balanceDrop) } : { kind: 'window' as const, window: r.window ?? '*', at: String(r.at ?? ''), drop: '' })),
  };
}

export interface FieldProblem { field?: string; message: string }

const whole = (text: string, min: number): number | undefined => (/^\d+$/.test(text.trim()) && Number(text) >= min ? Number(text) : undefined);
const amount = (text: string): number | undefined => (/^\d+(\.\d+)?$/.test(text.trim()) && Number(text) > 0 ? Number(text) : undefined);

/** The words of `aliases` as typed: separated by commas or lines. */
export const aliasList = (text: string): string[] => [...new Set(text.split(/[,,\n]/).map(s => s.trim()).filter(Boolean))];

/** Everything the form says, as the values the interface takes (`null` removes a key), or what is wrong with it. */
function valuesOf(f: WorkerForm): { values: Record<string, unknown>; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const values: Record<string, unknown> = {};
  values.notes = f.notes.trim() || null;
  values.capabilities = aliasList(f.capabilities);
  values.cost = f.cost;
  const concurrency = whole(f.concurrency, 1);
  if (concurrency === undefined) problems.push({ field: 'concurrency', message: t('A whole number, 1 or more.') }); else values.concurrency = concurrency;
  if (f.dailyRuns.trim()) {
    const n = whole(f.dailyRuns, 1);
    if (n === undefined) problems.push({ field: 'daily_runs', message: t('A whole number, 1 or more (or empty for no limit).') }); else values.daily_runs = n;
  } else values.daily_runs = null;
  values.enabled = f.enabled;
  values.aliases = aliasList(f.aliases).length ? aliasList(f.aliases) : null;
  if (f.dailyCapUsd.trim()) {
    const n = amount(f.dailyCapUsd);
    if (n === undefined) problems.push({ field: 'daily_cap_usd', message: t('An amount above 0 (or empty for no cap).') }); else values.daily_cap_usd = n;
  } else values.daily_cap_usd = null;
  values.model_family = f.modelFamily.trim() || null;
  values.on_limit = f.onLimit === 'rotate' ? 'rotate' : null;
  values.rotate_paid = f.rotatePaid ? true : null;
  const rules = f.disabledWhen.map((r, i) => {
    if (r.kind === 'balance') {
      const drop = amount(r.drop);
      if (drop === undefined) problems.push({ field: `disabled_when[${i}]`, message: t('The balance drop is an amount above 0.') });
      return { balance_drop: drop ?? 0 };
    }
    const at = amount(r.at);
    if (at === undefined || at > 100) problems.push({ field: `disabled_when[${i}]`, message: t('The percent is above 0 and at most 100.') });
    return { window_full: r.window.trim() || '*', at: at ?? 0 };
  });
  values.disabled_when = rules.length ? rules : null;
  return { values, problems };
}

/** The fields that differ from the form as it was opened, as the `set` of `PUT /api/workers/:id`; or the problems of the input. */
export function changesOf(initial: WorkerForm, now: WorkerForm): { ok: true; set: Record<string, unknown> } | { ok: false; problems: FieldProblem[] } {
  const next = valuesOf(now);
  if (next.problems.length) return { ok: false, problems: next.problems };
  const before = valuesOf(initial).values;
  const set = Object.fromEntries(Object.entries(next.values).filter(([key, v]) => JSON.stringify(v) !== JSON.stringify(before[key])));
  return { ok: true, set };
}

/** Problems the server named, by the form field they belong to (`fits.ue` belongs to `fits`, `disabled_when[0].at` to `disabled_when[0]`). */
export function problemsFor(details: FieldProblem[] | undefined, field: string): string[] {
  return (details ?? []).filter(d => d.field !== undefined && (d.field === field || d.field.startsWith(`${field}.`) || d.field.startsWith(`${field}[`))).map(d => d.message);
}

/** The server's problems that no field of the form shows. */
export const otherProblems = (details: FieldProblem[] | undefined, fields: string[]): string[] => (details ?? []).filter(d => !d.field || !fields.some(f => d.field === f || d.field!.startsWith(`${f}.`) || d.field!.startsWith(`${f}[`))).map(d => d.message);
