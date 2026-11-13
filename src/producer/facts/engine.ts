import { textConventions } from '../../i18n.ts';
import { resolveRole, type Roles } from '../../roles/config.ts';
import { roleResults, type RoleWorkerResult } from '../../roles/statistics.ts';
import { ACTION_KINDS, type Action, type OrderDoc, type OrderEvent, type Report, type Run } from '../../orders/model.ts';
import { inferStage } from '../../orders/stage.ts';
import type { UsageRow } from '../../usage/types.ts';
import type { ConstraintThresholds, ProjectConfig } from '../../config.ts';
import { endingCaseText } from '../../run/endpoint.ts';
import { buildRisks, findConstraint, type ConstraintAnalysis } from './constraints.ts';

export const STAGES = ['unqueued', 'queued', 'working', 'monitoring', 'acceptor', 'stopped', 'held', 'done'] as const;
export type FlowStage = typeof STAGES[number];
export type Window = '24h' | '7d';
export type Cause = 'environment' | 'tool' | 'capacity' | 'specification' | 'result' | 'unclassified';
/** Ordered, explicit rules. A status alone is never evidence of a cause. */
export const CAUSE_PATTERNS: { cause: Cause; pattern: RegExp }[] = [
  { cause: 'capacity', pattern: /quota|rate.?limit|at capacity|capacity error|usage (window|limit)|token cap/i },
  { cause: 'capacity', pattern: textConventions.engine_9 },
  { cause: 'environment', pattern: /build.*(fail|error)|packag.*(fail|error)|network|disk|out of memory|process kill|permission denied|missing .*dependenc|connection (reset|refused)|endpoint unreachable|environment/i },
  { cause: 'environment', pattern: textConventions.engine_10 },
  { cause: 'tool', pattern: /crash|no (structured )?report|without a report|empty report|report block.{0,12}empty|loop|tool (error|fail)|session (lost|missing)|worker exited/i },
  { cause: 'tool', pattern: textConventions.engine_11 },
  { cause: 'specification', pattern: /specification|clarif|decision|which option|requirements? (unclear|missing)|awaiting (answer|approval)|waiting for (?:an? )?(answer|approval|confirmation|click)|need.*(answer|confirmation)/i },
  { cause: 'specification', pattern: textConventions.engine_12 },
  { cause: 'result', pattern: /acceptance|criteria|test.*fail|incorrect|incomplete|does not (work|meet)|not met/i },
  { cause: 'result', pattern: textConventions.engine_13 },
];
export const classifyCause = (text: string): Cause => CAUSE_PATTERNS.find(r => r.pattern.test(text))?.cause ?? 'unclassified';
export interface Segment { from: string; to: string; stage: FlowStage; status?: string }
export interface Timeline { tag: string; kind: string; heavy?: string; segments: Segment[] }
export interface Fact { id: string; window: Window; value: number | string | null; unit: string; tags?: string[] }
export interface RoutingRow {
  worker: string; kind: string; orders: number; runs: number; comparable: boolean;
  yield: number | null; rework: number | null; tokens: number | null; hours: number | null; cause: Cause | null;
}
export interface FactsSnapshot {
  version: 1; at: string; facts: Fact[]; timelines: Timeline[];
  analysis?: ConstraintAnalysis;
  windows: Record<Window, {
    slots: { cap: string; limit: number; working: number; monitoring: number; idle: number; samples: number; current: { working: number; monitoring: number; idle: number } }[];
    causes: { cause: Cause; count: number }[];
    unclassified: { tag: string; at: string; summary: string }[];
    aging: { tag: string; kind: string; stage: FlowStage; hours: number; p85: number | null; ratio: number | null }[];
    cumulative: { at: string; stages: Record<FlowStage, number> }[];
    routing: RoutingRow[];
    roles?: RoleWorkerResult[];
  }>;
}
const ms = (at: string) => Date.parse(at);
const HOUR = 3_600_000, DAY = 24 * HOUR;
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * p;
  return sorted[Math.floor(pos)] + (sorted[Math.ceil(pos)] - sorted[Math.floor(pos)]) * (pos % 1);
}
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
const key = (s: string) => encodeURIComponent(s).replace(/\./g, '%2E');

/** Replay document facts at their recorded times. Events fill action gaps in imported documents.
 * Sequence breaks equal-time ties; run-end sorts after its start and before a later report. */
function recordedActions(doc: OrderDoc, events: readonly OrderEvent[]): Action[] {
  const actions = [...doc.actions];
  for (const e of events.filter(e => e.tag === doc.order.tag && e.type.startsWith('action-'))) {
    const kind = e.type.slice(7) as Action['kind'];
    if (!ACTION_KINDS.includes(kind)) continue;
    if (!actions.some(a => a.at === e.at && a.kind === kind)) actions.push({ seq: Math.max(0, ...actions.map(a => a.seq), ...doc.reports.map(r => r.seq), ...doc.runs.map(r => r.seq)) + 1, at: e.at, kind });
  }
  return actions;
}
export function timeline(doc: OrderDoc, events: readonly OrderEvent[], now: string): Timeline {
  const actions = recordedActions(doc, events);
  const changes = [
    ...actions.map(a => ({ at: a.at, seq: a.seq, action: a })),
    ...doc.reports.map(r => ({ at: r.at, seq: r.seq, report: r })),
    ...doc.runs.flatMap(r => [{ at: r.started, seq: r.seq, start: r }, ...(r.ended ? [{ at: r.ended, seq: r.seq + .5, end: r }] : [])]),
  ].sort((a, b) => ms(a.at) - ms(b.at) || a.seq - b.seq);
  const runs: Run[] = [], reports: Report[] = [], seenActions: Action[] = [];
  const segments: Segment[] = [];
  let from = doc.order.created, stage: FlowStage = 'unqueued', status: string | undefined;
  const push = (to: string) => { if (ms(to) > ms(from)) segments.push({ from, to, stage, ...(status ? { status } : {}) }); };
  for (const [index, c] of changes.entries()) {
    if (ms(c.at) > ms(now)) continue;
    // Imports can be backdated, and event-only actions have synthetic sequence numbers.
    // Infer on replay order, so an old supplemental queue cannot outrank a later approval.
    const seq = index + 1;
    if ('action' in c) seenActions.push({ ...c.action, seq });
    if ('report' in c) reports.push({ ...c.report, seq });
    if ('start' in c && c.start) runs.push({ ...c.start, seq, ended: undefined, outcome: undefined });
    if ('end' in c && c.end) { const ended = c.end; const r = runs.find(r => r.id === ended.id); if (r) Object.assign(r, { ended: ended.ended, outcome: ended.outcome }); }
    const s = inferStage(doc.order, runs, reports, seenActions, new Set()).stage;
    const next: FlowStage = s === 'draft' || s === 'planned' ? 'unqueued' : s === 'running' ? 'working' : s === 'awaiting-review' ? 'acceptor' : s === 'merged' || s === 'cancelled' ? 'done' : s === 'held' || s === 'monitoring' ? s : s === 'queued' || s === 'waiting-needs' ? 'queued' : 'stopped';
    const nextStatus = next === 'stopped' ? reports.at(-1)?.status ?? s : next === 'done' ? s : undefined;
    if (next !== stage || nextStatus !== status) { push(c.at); from = c.at; stage = next; status = nextStatus; }
  }
  push(now);
  // Keep the state at the snapshot boundary, even for an order created/changed exactly now.
  segments.push({ from: now, to: now, stage, ...(status ? { status } : {}) });
  return { tag: doc.order.tag, kind: doc.order.kind, ...(doc.order.heavy ? { heavy: doc.order.heavy } : {}), segments };
}
const atStage = (t: Timeline, at: number) => t.segments.find(s => ms(s.from) <= at && ms(s.to) > at)?.stage ?? (at === ms(t.segments.at(-1)!.from) ? t.segments.at(-1)!.stage : undefined);

export function computeFacts(input: { orders: readonly OrderDoc[]; events: readonly OrderEvent[]; usage: readonly UsageRow[]; caps: Record<string, number>; now: string; constraints?: ConstraintThresholds; budget?: ProjectConfig['budget']; previous?: FactsSnapshot; roleDefinitions?: Roles; roleAvailability?: { id: string; qualifying: string[] }[] }): FactsSnapshot {
  const { events, usage, caps, now } = input, end = ms(now);
  const orders = input.orders.filter(d => ms(d.order.created) <= end).map(d => ({ ...d, actions: recordedActions(d, events) }));
  const timelines = orders.filter(d => ms(d.order.created) <= end).map(d => timeline(d, events, now));
  const facts: Fact[] = [];
  const windows = {} as FactsSnapshot['windows'];
  for (const window of ['24h', '7d'] as const) {
    const days = window === '24h' ? 1 : 7, start = end - days * DAY;
    const within = (at: string) => ms(at) >= start && ms(at) <= end;
    const add = (id: string, value: Fact['value'], unit: string, tags: string[] = []) => {
      const uniqueTags = [...new Set(tags)].sort();
      facts.push({ id: `F:${id}.${window}`, window, value, unit, ...(uniqueTags.length <= 20 ? { tags: uniqueTags } : {}) });
    };
    const mergedAt = (d: OrderDoc) => atStage(timelines.find(t => t.tag === d.order.tag)!, end) === 'done' && timelines.find(t => t.tag === d.order.tag)!.segments.at(-1)!.status === 'merged' ? [...d.actions].reverse().find(a => a.kind === 'approve' && ms(a.at) <= end)?.at : undefined;
    const completed = orders.filter(d => timelines.some(t => t.tag === d.order.tag) && mergedAt(d) && within(mergedAt(d)!));
    const age = (d: OrderDoc, to: string) => (ms(to) - ms(d.order.created)) / HOUR;
    const duration = (t: Timeline, stage?: FlowStage) => t.segments.filter(s => !stage || s.stage === stage).reduce((n, s) => n + Math.max(0, Math.min(end, ms(s.to)) - Math.max(start, ms(s.from))) / HOUR, 0);
    const failures = orders.flatMap(d => [
      ...d.reports.filter(r => within(r.at) && !['ready', 'monitoring', 'progress'].includes(r.status)).map(r => ({ tag: d.order.tag, worker: d.runs.find(run => run.id === r.run)?.worker, kind: d.order.kind, at: r.at, summary: [r.summary, r.question].filter(Boolean).join(' ') })),
      ...d.runs.filter(r => r.ended && within(r.ended) && !d.reports.some(p => p.run === r.id && ms(p.at) >= ms(r.started) && ms(p.at) <= end)).map(r => ({ tag: d.order.tag, worker: r.worker, kind: d.order.kind, at: r.ended!, summary: endingCaseText(r) })),
    ]).map(f => ({ ...f, cause: classifyCause(f.summary) }));
    const causes = (['environment', 'tool', 'capacity', 'specification', 'result', 'unclassified'] as const).map(cause => ({ cause, count: failures.filter(f => f.cause === cause).length }));
    for (const c of causes) add(`cause.${c.cause}`, c.count, 'reports', failures.filter(f => f.cause === c.cause).map(f => f.tag));
    const tokens = (d: OrderDoc, worker?: string, inWindow = false): number | null => {
      const values = d.runs.filter(r => ms(r.started) <= end && (!worker || r.worker === worker)).flatMap(r => {
        const rows = usage.filter(u => u.order === d.order.tag && u.run === r.id && ms(u.at) <= end);
        if (rows.length) return rows.filter(u => !inWindow || within(u.at)).flatMap(u => u.total_tokens === undefined ? [] : [u.total_tokens]);
        return r.usage?.total_tokens !== undefined && ms(r.ended ?? now) <= end && (!inWindow || within(r.ended ?? now)) ? [r.usage.total_tokens] : [];
      });
      return values.length ? values.reduce((a, b) => a + b, 0) : null;
    };
    const quality = (docs: OrderDoc[], prefix: string, worker?: string) => {
      const decided = docs.filter(d => d.actions.some(a => ['approve', 'rework'].includes(a.kind) && within(a.at) && (!worker || owner(d, a.seq) === worker)));
      const firstPass = decided.filter(d => {
        const decisions = d.actions.filter(a => ['approve', 'rework'].includes(a.kind) && ms(a.at) <= end && (!worker || owner(d, a.seq) === worker)).sort((a, b) => a.seq - b.seq);
        return decisions[0]?.kind === 'approve';
      });
      const reworks = decided.map(d => d.actions.filter(a => a.kind === 'rework' && ms(a.at) <= end && (!worker || owner(d, a.seq) === worker)).length);
      const yieldValue = decided.length ? firstPass.length / decided.length : null, rework = mean(reworks);
      add(`${prefix}.first_pass_yield`, yieldValue, 'ratio', decided.map(d => d.order.tag));
      add(`${prefix}.rework_mean`, rework, 'rounds/order', decided.map(d => d.order.tag));
      add(`${prefix}.rework_rounds`, reworks.reduce((a, b) => a + b, 0), 'rounds', decided.map(d => d.order.tag));
      return { yield: yieldValue, rework };
    };
    function owner(d: OrderDoc, seq: number) { return [...d.runs].filter(r => r.seq < seq).sort((a, b) => b.seq - a.seq)[0]?.worker; }
    const aging: FactsSnapshot['windows'][Window]['aging'] = [];
    for (const kind of [...new Set(timelines.map(t => t.kind))].sort()) {
      const docs = orders.filter(d => d.order.kind === kind && ms(d.order.created) <= end), ts = timelines.filter(t => t.kind === kind), done = completed.filter(d => d.order.kind === kind);
      const open = ts.filter(t => !['done', 'unqueued', 'held'].includes(atStage(t, end)!)), cycles = done.map(d => age(d, mergedAt(d)!));
      const prefix = `kind.${key(kind)}`;
      add(`${prefix}.wip`, open.length, 'orders', open.map(t => t.tag));
      const held = ts.filter(t => atStage(t, end) === 'held');
      add(`${prefix}.held`, held.length, 'orders', held.map(t => t.tag));
      add(`${prefix}.throughput`, done.length / days, 'orders/day', done.map(d => d.order.tag));
      for (const p of [50, 85, 95]) add(`${prefix}.cycle_p${p}`, percentile(cycles, p / 100), 'hours', done.map(d => d.order.tag));
      const total = ts.reduce((n, t) => n + duration(t) - duration(t, 'done') - duration(t, 'unqueued'), 0), working = ts.reduce((n, t) => n + duration(t, 'working'), 0);
      add(`${prefix}.efficiency`, total ? working / total : null, 'ratio', ts.map(t => t.tag));
      for (const stage of STAGES) add(`${prefix}.stage.${stage}`, ts.reduce((n, t) => n + duration(t, stage), 0), 'hours', ts.map(t => t.tag));
      quality(docs, prefix);
      const sampleP85 = kind.trim() ? percentile(cycles, .85) : null;
      const p85 = sampleP85 !== null && sampleP85 > 0 ? sampleP85 : null;
      for (const t of open) {
        const hours = age(docs.find(d => d.order.tag === t.tag)!, now), ratio = p85 && p85 > 0 ? hours / p85 : null;
        aging.push({ tag: t.tag, kind, stage: atStage(t, end)!, hours, p85, ratio });
        add(`order.${key(t.tag)}.age`, hours, 'hours', [t.tag]);
        add(`order.${key(t.tag)}.age_p85_ratio`, ratio, 'ratio', [t.tag]);
      }
      const latencies = docs.flatMap(d => d.reports.filter(r => r.status === 'ready' && ms(r.at) <= end).flatMap(r => {
        const decision = d.actions.filter(a => a.seq > r.seq && ['approve', 'rework', 'cancel'].includes(a.kind) && within(a.at)).sort((a, b) => a.seq - b.seq)[0];
        // A newer ready supersedes an earlier one: don't count a decision twice.
        return decision && !d.reports.some(n => n.status === 'ready' && n.seq > r.seq && n.seq < decision.seq) ? [(ms(decision.at) - ms(r.at)) / HOUR] : [];
      }));
      for (const p of [50, 90]) add(`${prefix}.acceptor_p${p}`, percentile(latencies, p / 100), 'hours', docs.map(d => d.order.tag));
      const costs = done.map(d => tokens(d)).filter((n): n is number => n !== null);
      add(`${prefix}.tokens_per_merged`, mean(costs), 'tokens/order', done.map(d => d.order.tag));
      add(`${prefix}.tokens_merged`, costs.reduce((a, b) => a + b, 0), 'tokens', done.map(d => d.order.tag));
      const notMerged = docs.filter(d => !mergedAt(d));
      add(`${prefix}.tokens_not_merged`, notMerged.reduce((n, d) => n + (tokens(d, undefined, true) ?? 0), 0), 'tokens', notMerged.map(d => d.order.tag));
      add(`${prefix}.tokens_unknown_orders`, docs.filter(d => tokens(d) === null).length, 'orders', docs.filter(d => tokens(d) === null).map(d => d.order.tag));
    }
    const slots = Object.entries(caps).sort(([a], [b]) => a.localeCompare(b)).map(([cap, limit]) => {
      const relevant = timelines.filter(t => t.kind === cap || t.heavy === cap);
      const sample = (at: number) => { const working = relevant.filter(t => atStage(t, at) === 'working').length, monitoring = relevant.filter(t => atStage(t, at) === 'monitoring').length; return { working, monitoring, idle: Math.max(0, limit - working - monitoring) }; };
      const samples = [];
      // UTC-aligned, left-closed samples: exactly 144 / 1008 observations per window.
      for (let at = Math.ceil(start / 600_000) * 600_000; at < end; at += 600_000) samples.push(sample(at));
      const current = sample(end);
      const row = { cap, limit, working: mean(samples.map(s => s.working)) ?? 0, monitoring: mean(samples.map(s => s.monitoring)) ?? 0, idle: mean(samples.map(s => s.idle)) ?? 0, samples: samples.length, current };
      for (const stage of ['working', 'monitoring', 'idle'] as const) { add(`slot.${key(cap)}.${stage}`, row[stage], 'slots', relevant.map(t => t.tag)); add(`slot.${key(cap)}.current.${stage}`, current[stage], 'slots', relevant.map(t => t.tag)); }
      add(`slot.${key(cap)}.cap`, limit, 'slots'); add(`slot.${key(cap)}.samples`, samples.length, 'samples');
      return row;
    });
    const cumulative = [];
    for (let at = start; at <= end; at += days * HOUR) {
      const stages = Object.fromEntries(STAGES.map(s => [s, 0])) as Record<FlowStage, number>;
      for (const t of timelines) { const stage = atStage(t, at); if (stage) stages[stage]++; }
      cumulative.push({ at: new Date(at).toISOString(), stages });
      for (const stage of STAGES) add(`cfd.${at}.${stage}`, stages[stage], 'orders');
    }
    const routing: RoutingRow[] = [];
    for (const kind of [...new Set(orders.map(d => d.order.kind))].sort()) for (const worker of [...new Set(orders.filter(d => d.order.kind === kind).flatMap(d => d.runs.map(r => r.worker)))].sort()) {
      const docs = orders.filter(d => d.order.kind === kind && (d.runs.some(r => r.worker === worker && within(r.started)) || d.actions.some(a => ['approve', 'rework'].includes(a.kind) && within(a.at) && owner(d, a.seq) === worker)));
      if (!docs.length) continue;
      const prefix = `routing.${key(worker)}.${key(kind)}`, q = quality(docs, prefix, worker);
      const done = completed.filter(d => d.order.kind === kind && owner(d, [...d.actions].reverse().find(a => a.kind === 'approve')!.seq) === worker);
      const runs = docs.reduce((n, d) => n + d.runs.filter(r => r.worker === worker && within(r.started)).length, 0);
      const tokenMedian = percentile(done.map(d => tokens(d, worker)).filter((n): n is number => n !== null), .5);
      const hours = percentile(done.map(d => d.runs.filter(r => r.worker === worker).reduce((n, r) => n + Math.max(0, ms(r.ended ?? now) - ms(r.started)) / HOUR, 0)), .5);
      const counts = causes.map(c => ({ cause: c.cause, count: failures.filter(f => f.kind === kind && f.worker === worker && f.cause === c.cause).length })).sort((a, b) => b.count - a.count);
      const cause = counts[0]?.count ? counts[0].cause : null;
      add(`${prefix}.orders`, docs.length, 'orders', docs.map(d => d.order.tag)); add(`${prefix}.runs`, runs, 'runs', docs.map(d => d.order.tag));
      add(`${prefix}.tokens_p50`, tokenMedian, 'tokens/order', done.map(d => d.order.tag)); add(`${prefix}.hours_p50`, hours, 'hours/order', done.map(d => d.order.tag)); add(`${prefix}.main_cause`, cause, 'cause', docs.map(d => d.order.tag));
      const decidedCount = docs.filter(d => d.actions.some(a => ['approve', 'rework'].includes(a.kind) && within(a.at) && owner(d, a.seq) === worker)).length;
      add(`${prefix}.decided_orders`, decidedCount, 'orders', docs.map(d => d.order.tag));
      routing.push({ worker, kind, orders: docs.length, runs, comparable: decidedCount >= 5, ...q, tokens: tokenMedian, hours, cause });
    }
    for (const [id] of Object.entries(input.roleDefinitions ?? {})) {
      const docs = orders.filter(d => resolveRole(input.roleDefinitions!, { ...d.order, kind: d.order.routing?.kind || d.order.kind }).id === id);
      const tags = new Set(docs.map(d => d.order.tag));
      const queuedHours = timelines.filter(t => tags.has(t.tag)).flatMap(t => t.segments.filter(s => s.stage === 'queued').map(s => Math.max(0, Math.min(end, ms(s.to)) - Math.max(start, ms(s.from))) / HOUR)).filter(h => h > 0);
      const availability = input.roleAvailability?.find(r => r.id === id);
      add(`role.${key(id)}.qualifying_workers`, availability ? availability.qualifying.length : null, 'workers');
      add(`role.${key(id)}.no_qualifying_worker`, availability ? Number(!availability.qualifying.length) : null, 'constraint');
      add(`role.${key(id)}.queue_hours`, queuedHours.reduce((a, b) => a + b, 0), 'hours', [...tags]);
      add(`role.${key(id)}.queue_wait_p50`, percentile(queuedHours, .5), 'hours', [...tags]);
    }
    const roles = roleResults(orders, usage, new Date(start).toISOString(), now);
    for (const r of roles) {
      const prefix = `role.${key(r.role)}.worker.${key(r.worker)}`;
      add(`${prefix}.samples`, r.samples, 'runs');
      add(`${prefix}.accepted`, r.accepted, 'runs');
      add(`${prefix}.first_pass_yield`, r.acceptedShare, 'ratio');
      add(`${prefix}.tokens_p50`, r.medianTokens, 'tokens/run');
      add(`${prefix}.hours_p50`, r.medianWallHours, 'hours/run');
      add(`${prefix}.assessment`, r.status, 'assessment');
    }
    windows[window] = { roles, slots, causes, unclassified: failures.filter(f => f.cause === 'unclassified').map(({ tag, at, summary }) => ({ tag, at, summary })), aging: aging.sort((a, b) => b.hours - a.hours), cumulative, routing };
  }
  const snapshot: FactsSnapshot = { version: 1, at: now, facts, timelines, windows };
  snapshot.analysis = { constraint: findConstraint(snapshot, input.constraints), risks: buildRisks(snapshot, orders, usage, input.budget, input.previous) };
  return snapshot;
}
