import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExternalUsage, OrderExternalCalls, UsageLedgerView } from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import type { WorkersFile } from '../workers/config.ts';
import type { UsageLedgerConfig } from './config.ts';

export interface Call { time: number; day: string; model: string; ok: boolean; cwd?: string; out?: string }

const pad = (n: number): string => String(n).padStart(2, '0');
export const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * A time as a ledger writes it: `2026-10-30 18:53:53` (no zone: the machine's local time, or UTC when the ledger says so), an ISO time with a zone,
 * or a number of seconds or milliseconds since 1970. Undefined for anything else.
 */
export function parseTime(value: unknown, zone: 'local' | 'utc' = 'local'): Date | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value > 1e11 ? value : value * 1000);
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  const plain = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?$/.exec(v);
  if (plain) {
    const [y, mo, d, h, mi, s = '0', frac = '0'] = plain.slice(1);
    const ms = Number(frac.padEnd(3, '0').slice(0, 3));
    const args = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms] as const;
    const date = zone === 'utc' ? new Date(Date.UTC(...args)) : new Date(...args);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return parseTime(`${v} 00:00:00`, zone);
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) return undefined;
  const date = new Date(v);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const norm = (p: string): string => (p.includes('\\') || /^[A-Za-z]:/.test(p) ? path.win32.normalize(p) : path.resolve(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Is `file` the folder `root` or below it? Case does not matter (a ledger may spell a drive letter differently). */
export function under(root: string, file: string | undefined): boolean {
  if (!file || typeof file !== 'string') return false;
  const r = norm(root);
  const f = path.isAbsolute(file) || path.win32.isAbsolute(file) ? norm(file) : norm(path.join(root, file));
  return f === r || f.startsWith(`${r}/`);
}

export interface ReadLedger { view: UsageLedgerView; calls: Call[] }

/** Reads one ledger (nothing is changed or kept): the calls that belong under one of `roots`, and counts of what was read. The prompt text of a line is never looked at. */
export function readLedger(ledger: UsageLedgerConfig, roots: string[]): ReadLedger {
  const view: UsageLedgerView = { id: ledger.id, file: ledger.file, ok: true, calls: 0, lines: 0, unreadable: 0 };
  const calls: Call[] = [];
  if (!existsSync(ledger.file)) return { view: { ...view, ok: false, problem: t('the file is not there') }, calls };
  let text: string;
  try { text = readFileSync(ledger.file, 'utf8'); } catch (e) { return { view: { ...view, ok: false, problem: (e as Error).message }, calls }; }
  const f = ledger.fields;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    view.lines++;
    let v: Record<string, unknown>;
    try { const x = JSON.parse(line); if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(); v = x; } catch { view.unreadable++; continue; }
    const at = parseTime(v[f.time], ledger.timezone);
    const cwd = f.cwd && typeof v[f.cwd] === 'string' ? (v[f.cwd] as string) : undefined;
    const out = f.out && typeof v[f.out] === 'string' ? (v[f.out] as string) : undefined;
    if (!at) { view.unreadable++; continue; }
    if (!roots.some(r => under(r, cwd) || under(r, out))) continue;
    const status = String(v[f.status] ?? '').toLowerCase();
    const call: Call = { time: at.getTime(), day: localDay(at), model: typeof v[f.model] === 'string' && (v[f.model] as string).trim() ? (v[f.model] as string).trim() : t('(no model)'), ok: ledger.ok_values.includes(status), ...(cwd ? { cwd } : {}), ...(out ? { out } : {}) };
    calls.push(call);
  }
  view.calls = calls.length;
  if (calls.length) {
    const times = calls.map(c => c.time);
    view.first = new Date(Math.min(...times)).toISOString();
    view.last = new Date(Math.max(...times)).toISOString();
  }
  return { view, calls };
}

/** The ledgers of the project file and of the workers file (the project's wins on the same id). */
export function ledgersOf(project: ProjectConfig, workers?: WorkersFile): UsageLedgerConfig[] {
  const own = project.usage_ledgers ?? [];
  return [...own, ...(workers?.usage_ledgers ?? []).filter(l => !own.some(o => o.id === l.id))];
}

/** Where a call counts as the project's: its root, and the worktrees of its orders (they may live elsewhere). */
export const projectRoots = (project: ProjectConfig, orders: Orders): string[] => {
  const roots = new Set<string>([project.root]);
  for (const doc of orders.all()) if (doc.order.worktree) roots.add(doc.order.worktree);
  return [...roots];
};

/** Calls other tools recorded for the project, by day and model, the last `days` local days (today included). */
export function usageView(project: ProjectConfig, orders: Orders, ledgers: UsageLedgerConfig[], now: Date, days = 7): ExternalUsage {
  const out: ExternalUsage = { project: project.id, enabled: ledgers.length > 0, days, ledgers: [], byDay: [], byModel: [], total: { ok: 0, failed: 0 } };
  if (!ledgers.length) return out;
  const roots = projectRoots(project, orders);
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const byDay = new Map<string, { day: string; model: string; ledger: string; ok: number; failed: number }>();
  const byModel = new Map<string, { model: string; ledger: string; ok: number; failed: number }>();
  for (const ledger of ledgers) {
    const { view, calls } = readLedger(ledger, roots);
    out.ledgers.push(view);
    for (const c of calls) {
      if (c.time < first.getTime() || c.time > now.getTime() + 86400000) continue;
      const d = byDay.get(`${c.day}|${ledger.id}|${c.model}`) ?? { day: c.day, model: c.model, ledger: ledger.id, ok: 0, failed: 0 };
      const m = byModel.get(`${ledger.id}|${c.model}`) ?? { model: c.model, ledger: ledger.id, ok: 0, failed: 0 };
      for (const x of [d, m]) c.ok ? x.ok++ : x.failed++;
      byDay.set(`${c.day}|${ledger.id}|${c.model}`, d);
      byModel.set(`${ledger.id}|${c.model}`, m);
      c.ok ? out.total.ok++ : out.total.failed++;
    }
  }
  out.byDay = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day) || a.ledger.localeCompare(b.ledger) || (b.ok + b.failed) - (a.ok + a.failed));
  out.byModel = [...byModel.values()].sort((a, b) => b.ok + b.failed - (a.ok + a.failed) || a.model.localeCompare(b.model));
  return out;
}

/** Calls made from inside an order's worktree, by ledger (all of the ledger's time, not only the last days). */
export function orderExternalCalls(ledgers: UsageLedgerConfig[], worktree: string | undefined): OrderExternalCalls[] {
  if (!worktree || !ledgers.length) return [];
  const out: OrderExternalCalls[] = [];
  for (const ledger of ledgers) {
    const { calls } = readLedger(ledger, [worktree]);
    if (!calls.length) continue;
    out.push({ ledger: ledger.id, ok: calls.filter(c => c.ok).length, failed: calls.filter(c => !c.ok).length });
  }
  return out;
}

/** For the detail of an order: the calls other tools made from its worktree. Never fails the page. */
export function externalCallsOf(project: ProjectConfig, workers: WorkersFile | undefined, worktree: string | undefined): OrderExternalCalls[] {
  try { return orderExternalCalls(ledgersOf(project, workers), worktree); } catch { return []; }
}
