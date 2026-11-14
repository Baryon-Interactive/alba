import { usageAccounting } from '../workers/adapters/index.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProjectConfig } from '../config.ts';
import type { OrderDoc, Run } from '../orders/model.ts';
import type { WorkersFile, WorkerConfig } from '../workers/config.ts';
import type { Probes } from '../tick/gather.ts';
import type { QuotaReading } from '../workers/quota.ts';
import { readStateFile } from '../orders/state-files.ts';
import { stateStore } from '../orders/backend.ts';
import { SqliteStore } from '../orders/sqlite-store.ts';
import { liveRuns } from '../run/live.ts';
import { ownerOf } from './spend.ts';
import { parseUsage } from './usage.ts';
import { tokenUsage } from './fold.ts';
import { replaceUsageRuns, usageRows } from './store.ts';
import { fail, t } from '../i18n.ts';
import type { Pricing, UsageDashboard, UsageGroup, UsageReport, UsageRow, UsageSignal, UsageTotal } from './types.ts';

export const emptyTotal = (): UsageTotal => ({ tokens: 0, input: 0, cached: 0, cache_write: 0, output: 0, reasoning: 0, known: 0, unknown: 0, cache_unknown: 0, reasoning_unknown: 0, estimates: {} });
function add(total: UsageTotal, row: UsageRow): void {
  if (row.total_tokens === undefined) total.unknown++; else { total.known++; total.tokens += row.total_tokens; }
  if (row.cached_tokens === undefined || row.input_tokens === undefined) total.cache_unknown++;
  if (row.reasoning_tokens === undefined || row.output_tokens === undefined) total.reasoning_unknown++;
  total.input += (row.input_tokens ?? 0) + (!usageAccounting(row.source).inputIncludesCache ? (row.cached_tokens ?? 0) + (row.cache_write_tokens ?? 0) : 0); total.cached += row.cached_tokens ?? 0; total.cache_write += row.cache_write_tokens ?? 0;
  total.output += (row.output_tokens ?? 0) + (!usageAccounting(row.source).reasoningInOutput ? row.reasoning_tokens ?? 0 : 0); total.reasoning += row.reasoning_tokens ?? 0;
  if (row.estimate !== undefined && row.currency) total.estimates[row.currency] = (total.estimates[row.currency] ?? 0) + row.estimate;
}
export function sinceDate(value = '7d', now = new Date()): string {
  const m = /^(\d+)(h|d)$/.exec(value);
  const ms = m ? now.getTime() - Number(m[1]) * (m[2] === 'h' ? 3600000 : 86400000) : Date.parse(value);
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) fail('Invalid usage period: {value}', { value });
  return new Date(ms).toISOString();
}
export function usageReport(rows: readonly UsageRow[], by = 'day', since = '', top?: number): UsageReport {
  if (!['day', 'worker', 'project', 'order', 'kind'].includes(by)) fail('Invalid usage grouping: {value}', { value: by });
  if (top !== undefined && (!Number.isInteger(top) || top < 1)) fail('Invalid usage limit: {value}', { value: String(top) });
  const groups = new Map<string, UsageGroup>();
  for (const row of rows) {
    if (since && Date.parse(row.at) < Date.parse(since)) continue;
    const key = by === 'day' ? new Date(row.at).toISOString().slice(0, 10) : by === 'order' ? `${row.project}/${row.order}` : row[by as 'worker' | 'project' | 'kind'];
    let g = groups.get(key); if (!g) { g = { key, ...emptyTotal() }; groups.set(key, g); } add(g, row);
  }
  const sorted = [...groups.values()].sort(by === 'day' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
  const shown = top ? sorted.slice(0, top) : sorted;
  const sum = (list: UsageTotal[]) => list.reduce((out, r) => {
    for (const k of ['tokens', 'input', 'cached', 'cache_write', 'output', 'reasoning', 'known', 'unknown', 'cache_unknown', 'reasoning_unknown'] as const) out[k] += r[k];
    for (const [unit, cost] of Object.entries(r.estimates)) out.estimates[unit] = (out.estimates[unit] ?? 0) + cost;
    return out;
  }, emptyTotal());
  return { since, by, rows: shown, total: sum(shown), ...(shown.length < sorted.length ? { omitted: sum(sorted.slice(shown.length)) } : {}) };
}

export function estimate(row: UsageRow, price: Pricing | undefined): UsageRow {
  if (!price || row.input_tokens === undefined || row.output_tokens === undefined) return row;
  // Separately reported cache tokens are not part of the engine's ordinary input count.
  const inputIncludesCache = usageAccounting(row.source).inputIncludesCache;
  const cached = row.cached_tokens ?? 0;
  if (inputIncludesCache && cached > row.input_tokens) return row;
  // No cache-write rate is configured: retain tokens but do not invent that part of the bill.
  if ((row.cache_write_tokens ?? 0) > 0) return row;
  return { ...row, currency: price.currency, estimate: ((row.input_tokens - (inputIncludesCache ? cached : 0)) * price.input_per_mtok + cached * price.cached_input_per_mtok + (row.output_tokens + (!usageAccounting(row.source).reasoningInOutput ? row.reasoning_tokens ?? 0 : 0)) * price.output_per_mtok) / 1e6 };
}

export function pricingOf(workers: WorkersFile | undefined, worker: WorkerConfig | undefined, model: string): Pricing | undefined {
  return worker?.pricing ?? workers?.pricing?.[worker?.id ?? ''] ?? workers?.pricing?.[model];
}

/** Only totals are used from a named rollout. Session ids must be opaque ids, never paths. */
export function rolloutTotal(log: string, codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), range?: { started: string; ended?: string }): ReturnType<typeof tokenUsage> | undefined {
  const id = /session id:\s*([a-zA-Z0-9_-]{8,100})/i.exec(log)?.[1];
  if (!id) return;
  const root = path.join(codexHome, 'sessions');
  if (!existsSync(root)) return;
  const walk = (dir: string): string | undefined => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { const f = walk(path.join(dir, e.name)); if (f) return f; }
      else if (e.name.endsWith('.jsonl') && e.name.includes(id)) return path.join(dir, e.name);
    }
  };
  const file = walk(root); if (!file) return;
  let result: ReturnType<typeof tokenUsage> | undefined, baseline: ReturnType<typeof tokenUsage> | undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.type !== 'event_msg' || e.payload?.type !== 'token_count' || !e.payload.info?.total_token_usage) continue;
      if (range && (!e.timestamp || e.timestamp > (range.ended ?? new Date().toISOString()))) continue;
      const usage = tokenUsage(e.payload.info.total_token_usage, 'codex-rollout');
      if (range && e.timestamp < range.started) baseline = usage;
      else result = usage;
    } catch { /* unrelated or incomplete line */ }
  }
  if (result && baseline) for (const k of ['input_tokens', 'cached_tokens', 'output_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_tokens'] as const) if (result[k] !== undefined) {
    if ((result[k] ?? 0) < (baseline[k] ?? 0)) return; // counter reset: the split cannot be reconstructed safely
    result[k] = result[k]! - (baseline[k] ?? 0);
  }
  return result;
}

function quotaShare(run: Run, source: string | undefined, history: readonly QuotaReading[], workers: WorkersFile | undefined, now: string): UsageRow['quota'] {
  if (!source) return;
  const readings = history.filter(q => q.ok && q.source === source).sort((a, b) => a.at.localeCompare(b.at));
  const before = readings.filter(q => q.at <= run.started).at(-1);
  const after = readings.filter(q => q.at >= run.started && q.at <= (run.ended ?? now)).at(-1);
  if (!before || !after || before === after) return;
  return before.windows.flatMap(w => {
    const end = after.windows.find(x => x.name === w.name && x.resetsAt === w.resetsAt);
    return end && end.usedPercent >= w.usedPercent ? [{ window: w.name, percent: end.usedPercent - w.usedPercent, shared: (workers?.workers.filter(x => x.quota === source).length ?? 0) > 1 }] : [];
  });
}

const stamps = new Map<string, string>();

/**
 * The quota history of a project, read once and then only what was added since (it grows by a reading per source per tick,
 * tens of thousands of rows, and every usage view parsed all of it again). Kept per state folder in this thread.
 */
const histories = new Map<string, { firstId: number; lastId: number; size: number; readings: QuotaReading[] }>();
export function quotaHistoryOf(project: ProjectConfig): readonly QuotaReading[] {
  const key = path.resolve(project.state_dir);
  const store = stateStore(project);
  if (store instanceof SqliteStore) {
    let cached = histories.get(key);
    // The history replaced as a whole (`writeStateFile`) starts at another first id: read it again from the start.
    const ends = store.db.prepare('SELECT COALESCE(MIN(id), 0) AS first, COALESCE(MAX(id), 0) AS last FROM quota_history').get() as { first: number; last: number };
    const first = Number(ends.first), last = Number(ends.last);
    if (!cached || last < cached.lastId || (cached.readings.length && first !== cached.firstId)) { cached = { firstId: first, lastId: 0, size: 0, readings: [] }; histories.set(key, cached); }
    if (!cached.readings.length) cached.firstId = first;
    while (cached.lastId < last) {
      const rows = store.quotaRowsAfter(cached.lastId, 5000);
      if (!rows.length) break;
      for (const r of rows) cached.readings.push(r.reading);
      cached.lastId = rows.at(-1)!.id;
    }
    return cached.readings;
  }
  const text = readStateFile(project, 'quota-history.jsonl') ?? '';
  const cached = histories.get(key);
  if (cached && cached.size === text.length) return cached.readings;
  const readings = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as QuotaReading);
  histories.set(key, { firstId: 0, lastId: 0, size: text.length, readings });
  return readings;
}
export function collectUsage(project: ProjectConfig, docs: readonly OrderDoc[], workers: WorkersFile | undefined, probes: Probes): { rows: UsageRow[]; signals: UsageSignal[] } {
  const signals: UsageSignal[] = [];
  const now = probes.now().toISOString();
  const stored = usageRows(project), byRun = new Map<string, UsageRow[]>();
  for (const r of stored) { const key = `${r.order}/${r.run}`, list = byRun.get(key) ?? []; list.push(r); byRun.set(key, list); }
  const replacements: { order: string; run: string; rows: UsageRow[] }[] = [];
  const history = quotaHistoryOf(project);
  const lastReading = history.at(-1)?.at;
  for (const doc of docs) for (const run of doc.runs) {
    if (run.imported) continue;
    const worker = ownerOf(workers?.workers ?? [], run.worker), kind = run.routing?.kind ?? doc.order.routing?.kind ?? doc.order.kind;
    const base = { project: project.id, order: doc.order.tag, run: run.id, worker: worker?.id ?? run.worker, engine: run.engine ?? worker?.engine ?? 'unknown', model: run.model ?? 'unknown', kind, rework: doc.actions.some(a => a.kind === 'rework' && a.seq < run.seq), resume: run.continuation === true || (run.attempt ?? 1) > 1 || !!run.resume_reason || !!run.rotated, open: !run.ended, subscription: worker?.cost === 'included', merged_at: doc.actions.find(a => a.kind === 'approve' && a.seq > run.seq)?.at, merged: doc.actions.some(a => a.kind === 'approve' && a.seq > run.seq) };
    const pricing = pricingOf(workers, worker, base.model);
    const key = `${project.state_dir}:${doc.order.tag}/${run.id}`;
    // A run's quota share stops changing once a reading after its end exists: later readings leave it alone.
    const quotaStamp = run.ended && lastReading && lastReading > run.ended ? 'settled' : lastReading;
    const stamp = JSON.stringify([probes.fileTime(run.events_file ?? run.log ?? ''), run.usage, run.ended, base, pricing, project.usage_warnings, quotaStamp]);
    const previous = byRun.get(`${doc.order.tag}/${run.id}`);
    const durable = run.ended && previous?.some(r => r.source !== 'unknown') && previous.every(r => !r.open);
    const signalRules = JSON.stringify(project.usage_warnings ?? {});
    if (!durable || previous?.[0].signal_rules !== signalRules) liveRuns.read(project, doc.order.tag, run, probes, doc.order.worktree);
    const fold = liveRuns.accounting(run);
    const runSignals = fold ? fold.signals(doc.order.tag, run.id, kind, project.usage_warnings) : previous?.[0].signals ?? [];
    signals.push(...runSignals);
    if (stamps.get(key) === stamp) continue;
    let rows: UsageRow[] = durable ? previous!.map(r => ({ ...r, ...base })) : (fold?.turns ?? []).map(turn => ({ ...base, ...turn.usage, turn: turn.turn, at: turn.at > now ? now : turn.at, raw: turn.raw }));
    if (!rows.length) {
      const log = run.log ? probes.readText(run.log) ?? '' : '';
      const usage = !run.events_file && /session id:/i.test(log) ? rolloutTotal(log, undefined, run) ?? parseUsage(log) : run.usage ?? parseUsage(log);
      rows = [{ ...base, ...usage, turn: 0, at: run.ended ?? run.started }];
    }
    const share = worker?.cost === 'included' ? quotaShare(run, worker.quota, history, workers, now) : undefined;
    rows = rows.map((row, i) => ({ ...(worker?.cost === 'paid' ? estimate(row, pricing) : row), ...(i === 0 ? { signals: runSignals, signal_rules: signalRules, ...(share?.length ? { quota: share } : {}) } : {}) }));
    if (JSON.stringify(rows) !== JSON.stringify(previous)) replacements.push({ order: doc.order.tag, run: run.id, rows });
    stamps.set(key, stamp);
  }
  replaceUsageRuns(project, replacements);
  return { rows: usageRows(project), signals };
}

export function budgetWarnings(project: ProjectConfig, rows: readonly UsageRow[], now: Date): UsageDashboard['warnings'] {
  const budget = project.budget; if (!budget) return [];
  const warnings: UsageDashboard['warnings'] = [];
  const day = now.toISOString().slice(0, 10), today = usageReport(rows, 'day', day).total;
  if (budget.tokens_per_day !== undefined && today.tokens > budget.tokens_per_day) warnings.push({ kind: 'day-tokens', text: t('Usage budget: daily tokens {n} exceed {limit}', { n: today.tokens, limit: budget.tokens_per_day }) });
  for (const row of usageReport(rows, 'order').rows) if (budget.tokens_per_order !== undefined && row.tokens > budget.tokens_per_order) warnings.push({ kind: 'order-tokens', order: row.key.slice(project.id.length + 1), text: t('Usage budget: order tokens {n} exceed {limit}', { n: row.tokens, limit: budget.tokens_per_order }) });
  // cost_per_day uses the explicit currency; multiple currencies are never added together.
  if (budget.cost_per_day !== undefined) for (const [currency, cost] of Object.entries(today.estimates)) if (currency === (budget.currency ?? 'USD') && cost > budget.cost_per_day) warnings.push({ kind: 'day-cost', text: t('Usage budget: daily estimate {n} {currency} exceeds {limit}', { n: Number(cost.toFixed(6)), currency, limit: budget.cost_per_day }) });
  return warnings;
}

export function usageDashboard(rows: UsageRow[], signals: UsageSignal[], warnings: UsageDashboard['warnings'], since: string, now = new Date(), roles: import('../roles/statistics.ts').RoleWorkerResult[] = []): UsageDashboard {
  const selected = rows.filter(r => Date.parse(r.at) >= Date.parse(since) && Date.parse(r.at) <= now.getTime());
  const mergedKeys = new Set(rows.filter(r => r.merged && Date.parse(r.merged_at ?? r.at) >= Date.parse(since) && Date.parse(r.merged_at ?? r.at) <= now.getTime()).map(r => `${r.project}/${r.order}`));
  const mergedRows = rows.filter(r => mergedKeys.has(`${r.project}/${r.order}`));
  const merged = usageReport(mergedRows, 'order').rows.filter(r => r.known && !r.unknown).map(r => r.tokens).sort((a,b) => a - b);
  const runGroups = new Map<string, UsageRow>();
  for (const r of selected.filter(r => r.open)) { const k = `${r.project}/${r.order}/${r.run}`, old = runGroups.get(k); runGroups.set(k, { ...r, total_tokens: (old?.total_tokens ?? 0) + (r.total_tokens ?? 0), estimate: old?.estimate === undefined && r.estimate === undefined ? undefined : (old?.estimate ?? 0) + (r.estimate ?? 0) }); }
  const dayMap = new Map<string, Record<string, number>>();
  for (let time = Date.parse(since); time <= now.getTime(); time += 86400000) dayMap.set(new Date(time).toISOString().slice(0,10), {});
  for (const r of selected) { const day = r.at.slice(0,10), p = dayMap.get(day) ?? {}; p[r.project] = (p[r.project] ?? 0) + (r.total_tokens ?? 0); dayMap.set(day, p); }
  const mergedKinds = usageReport(mergedRows, 'kind');
  for (const k of mergedKinds.rows) {
    const count = new Set(mergedRows.filter(r => r.kind === k.key).map(r => `${r.project}/${r.order}`)).size;
    k.merged_orders = count;
    k.merged_pricing_complete = mergedRows.filter(r => r.kind === k.key).every(r => r.estimate !== undefined);
  }
  const comparable = new Set([...runGroups.values()].filter(r => r.estimate !== undefined).map(r => r.currency)).size <= 1;
  return { roles, todayProjects: usageReport(selected, 'project', now.toISOString().slice(0, 10)), days: [...dayMap].sort(([a],[b]) => a.localeCompare(b)).map(([day, projects]) => ({ day, projects })), today: usageReport(selected, 'worker', now.toISOString().slice(0, 10)), week: usageReport(selected, 'worker', sinceDate('7d', now)), workers: usageReport(selected, 'worker'), projects: usageReport(selected, 'project'), daily: usageReport(selected, 'day'), orders: usageReport(selected, 'order', '', 10), kinds: usageReport(selected, 'kind'), mergedKinds, ...(merged.length ? { median: (merged[Math.floor((merged.length - 1) / 2)] + merged[Math.floor(merged.length / 2)]) / 2, p90: merged[Math.ceil(merged.length * .9) - 1] } : {}), open: [...runGroups.values()].sort((a, b) => (comparable ? (b.estimate ?? 0) - (a.estimate ?? 0) : 0) || (b.total_tokens ?? 0) - (a.total_tokens ?? 0)).slice(0, 5), signals, warnings };
}
