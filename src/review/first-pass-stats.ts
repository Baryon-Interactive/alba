import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { routingOf } from '../routing/classify.ts';
import { disputeFirstPass, type FirstPassReview } from './first-pass.ts';

export { disputeFirstPass };

export const MIN_FIRST_PASS_CASES = 10;

export interface FirstPassStatsMetrics {
  verdicts: number;
  decided: number;
  agree: number;
  disagree: number;
  rate: number | null;
  enough: boolean;
  rate_label: string;
  unsure: number;
  applied: number;
  disputed: number;
  median_report_to_verdict_minutes: number | null;
  median_verdict_to_decision_minutes: number | null;
}

export interface FirstPassFamilyRow extends FirstPassStatsMetrics {
  model_family: string;
}

export interface FirstPassKindRow extends FirstPassStatsMetrics {
  kind: string;
}

export interface FirstPassFamilyKindRow extends FirstPassStatsMetrics {
  model_family: string;
  kind: string;
}

export interface FirstPassStats {
  project: string;
  days: number;
  at: string;
  min_cases: number;
  overall: FirstPassStatsMetrics;
  by_family: FirstPassFamilyRow[];
  by_kind: FirstPassKindRow[];
  by_family_and_kind: FirstPassFamilyKindRow[];
}

interface BucketAccumulator {
  verdicts: number;
  agree: number;
  disagree: number;
  unsure: number;
  applied: number;
  disputed: number;
  reportToVerdict: number[];
  verdictToDecision: number[];
}

const emptyBucket = (): BucketAccumulator => ({
  verdicts: 0,
  agree: 0,
  disagree: 0,
  unsure: 0,
  applied: 0,
  disputed: 0,
  reportToVerdict: [],
  verdictToDecision: [],
});

export function medianNumbers(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw * 100) / 100;
}

function finalizeBucket(b: BucketAccumulator): FirstPassStatsMetrics {
  const decided = b.agree + b.disagree;
  const enough = decided >= MIN_FIRST_PASS_CASES;
  const rate = enough ? b.agree / decided : null;
  const rate_label = enough ? `${Math.round((b.agree / decided) * 100)}%` : 'not enough cases';
  return {
    verdicts: b.verdicts,
    decided,
    agree: b.agree,
    disagree: b.disagree,
    rate,
    enough,
    rate_label,
    unsure: b.unsure,
    applied: b.applied,
    disputed: b.disputed,
    median_report_to_verdict_minutes: medianNumbers(b.reportToVerdict),
    median_verdict_to_decision_minutes: medianNumbers(b.verdictToDecision),
  };
}

const LEAD_DECISIONS = new Set(['approve', 'rework', 'cancel', 'drop']);

interface LeadDecision {
  kind: 'approve' | 'rework' | 'cancel' | 'drop';
  at: string;
  seq?: number;
}

function findLeadDecision(
  doc: OrderDoc | undefined,
  run: FirstPassReview,
  appliedActionSeqs: ReadonlySet<number>,
  isApplied: boolean,
  tagEvents: readonly { at: string; type: string; data?: Record<string, unknown> }[],
): { reportAt?: string; decision?: LeadDecision } {
  const sortedReports = doc ? [...doc.reports].sort((a, b) => a.seq - b.seq) : [];
  const report = sortedReports.find(r => r.seq === run.report);
  const nextReport = sortedReports.find(r => r.seq > run.report);

  let reportAt = report?.at;
  if (!reportAt) {
    const repEvents = tagEvents.filter(e => e.type === 'report');
    reportAt = repEvents.at(-1)?.at;
  }

  const candidates: LeadDecision[] = [];
  if (doc) {
    let skippedFallbackBounce = false;
    for (const action of [...doc.actions].sort((a, b) => a.seq - b.seq)) {
      if (action.seq <= run.report) continue;
      if (nextReport && action.seq >= nextReport.seq) continue;
      if (action.bounce) continue;
      if (appliedActionSeqs.has(action.seq)) continue;
      if (isApplied && !appliedActionSeqs.size && !skippedFallbackBounce && action.kind === 'rework' && action.note?.startsWith('First-pass review by ')) {
        skippedFallbackBounce = true;
        continue;
      }
      const kind = action.kind as string;
      if (LEAD_DECISIONS.has(kind)) {
        candidates.push({ kind: kind as LeadDecision['kind'], at: action.at, seq: action.seq });
      }
    }
  }

  const minAtMs = Date.parse(reportAt ?? run.started);
  const maxAtMs = nextReport ? Date.parse(nextReport.at) : Infinity;
  for (const e of tagEvents) {
    if (!e.type.startsWith('action-')) continue;
    const kind = e.type.slice(7);
    if (!LEAD_DECISIONS.has(kind)) continue;
    const atMs = Date.parse(e.at);
    if (!Number.isFinite(atMs) || atMs < minAtMs || atMs >= maxAtMs) continue;
    if (doc?.actions.some(a => a.kind === kind && a.at === e.at)) continue;
    if (isApplied && kind === 'rework' && typeof e.data?.note === 'string' && e.data.note.startsWith('First-pass review by ')) continue;
    candidates.push({ kind: kind as LeadDecision['kind'], at: e.at });
  }

  candidates.sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
    return Date.parse(a.at) - Date.parse(b.at);
  });

  return { reportAt, decision: candidates[0] };
}

export function computeFirstPassStats(
  project: ProjectConfig,
  orders: Orders,
  options: { days?: number; now?: Date } = {},
): FirstPassStats {
  const days = options.days ?? 30;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const cutoffMs = nowMs - days * 86_400_000;

  const docs = orders.all();
  const docByTag = new Map<string, OrderDoc>(docs.map(d => [d.order.tag, d]));
  const allEvents = orders.store.events({});

  const eventsByTag = new Map<string, typeof allEvents>();
  const latestRunsById = new Map<string, FirstPassReview>();
  const appliedRunIds = new Set<string>();
  const appliedActionSeqsByTag = new Map<string, Set<number>>();
  const disputedRunIds = new Set<string>();

  for (const event of allEvents) {
    let list = eventsByTag.get(event.tag);
    if (!list) { list = []; eventsByTag.set(event.tag, list); }
    list.push(event);

    if (event.type === 'first-pass' && event.data && typeof event.data.id === 'string') {
      latestRunsById.set(event.data.id, event.data as unknown as FirstPassReview);
    } else if (event.type === 'first-pass-applied' && event.data) {
      if (typeof event.data.id === 'string') appliedRunIds.add(event.data.id);
      const seq = Number(event.data.action);
      if (Number.isFinite(seq)) {
        let seqs = appliedActionSeqsByTag.get(event.tag);
        if (!seqs) { seqs = new Set<number>(); appliedActionSeqsByTag.set(event.tag, seqs); }
        seqs.add(seq);
      }
    } else if (event.type === 'first-pass-disputed' && event.data && typeof event.data.id === 'string') {
      disputedRunIds.add(event.data.id);
    }
  }

  // Latest completed review per (tag, report) within the window.
  const perReport = new Map<string, FirstPassReview>();
  for (const run of latestRunsById.values()) {
    if (run.status !== 'done' || !run.verdict) continue;
    const stamp = Date.parse(run.ended ?? run.started);
    if (!Number.isFinite(stamp) || stamp < cutoffMs || stamp > nowMs) continue;
    perReport.set(`${run.tag}\0${run.report}`, run);
  }

  const overallAcc = emptyBucket();
  const familyAcc = new Map<string, BucketAccumulator>();
  const kindAcc = new Map<string, BucketAccumulator>();
  const pairAcc = new Map<string, { model_family: string; kind: string; acc: BucketAccumulator }>();

  const getAcc = <K>(map: Map<K, BucketAccumulator>, key: K): BucketAccumulator => {
    let acc = map.get(key);
    if (!acc) { acc = emptyBucket(); map.set(key, acc); }
    return acc;
  };

  for (const run of perReport.values()) {
    const doc = docByTag.get(run.tag);
    const kind = (doc ? (routingOf(project, doc).kind || doc.order.kind) : '') || 'unclassified';
    const family = run.model_family?.trim() || 'unknown';
    const pairKey = `${family}\0${kind}`;
    let pair = pairAcc.get(pairKey);
    if (!pair) { pair = { model_family: family, kind, acc: emptyBucket() }; pairAcc.set(pairKey, pair); }

    const targets = [overallAcc, getAcc(familyAcc, family), getAcc(kindAcc, kind), pair.acc];
    const isApplied = run.applied === true || appliedRunIds.has(run.id);
    const isDisputed = disputedRunIds.has(run.id);
    const tagEvents = eventsByTag.get(run.tag) ?? [];
    const appliedSeqs = appliedActionSeqsByTag.get(run.tag) ?? new Set<number>();
    const { reportAt, decision } = findLeadDecision(doc, run, appliedSeqs, isApplied, tagEvents);

    const endedMs = run.ended ? Date.parse(run.ended) : NaN;
    const reportMs = reportAt ? Date.parse(reportAt) : NaN;
    const reportToVerdictMin = Number.isFinite(endedMs) && Number.isFinite(reportMs) && endedMs >= reportMs
      ? (endedMs - reportMs) / 60_000
      : undefined;

    const decisionMs = decision ? Date.parse(decision.at) : NaN;
    const verdictToDecisionMin = Number.isFinite(decisionMs) && Number.isFinite(endedMs) && decisionMs >= endedMs
      ? (decisionMs - endedMs) / 60_000
      : undefined;

    const v = run.verdict!.verdict;
    const isUnsure = v === 'unsure';
    let outcome: 'agree' | 'disagree' | 'pending' = 'pending';
    if (!isUnsure && decision) {
      const agreed = (v === 'pass' && decision.kind === 'approve') || (v === 'send-back' && decision.kind === 'rework');
      outcome = agreed ? 'agree' : 'disagree';
    }

    for (const b of targets) {
      b.verdicts += 1;
      if (isApplied) b.applied += 1;
      if (isDisputed) b.disputed += 1;
      if (isUnsure) b.unsure += 1;
      else if (outcome === 'agree') b.agree += 1;
      else if (outcome === 'disagree') b.disagree += 1;
      if (reportToVerdictMin !== undefined) b.reportToVerdict.push(reportToVerdictMin);
      if (verdictToDecisionMin !== undefined) b.verdictToDecision.push(verdictToDecisionMin);
    }
  }

  const by_family: FirstPassFamilyRow[] = [...familyAcc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([model_family, acc]) => ({ model_family, ...finalizeBucket(acc) }));

  const by_kind: FirstPassKindRow[] = [...kindAcc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, acc]) => ({ kind, ...finalizeBucket(acc) }));

  const by_family_and_kind: FirstPassFamilyKindRow[] = [...pairAcc.values()]
    .sort((a, b) => a.model_family.localeCompare(b.model_family) || a.kind.localeCompare(b.kind))
    .map(({ model_family, kind, acc }) => ({ model_family, kind, ...finalizeBucket(acc) }));

  return {
    project: project.id,
    days,
    at: now.toISOString(),
    min_cases: MIN_FIRST_PASS_CASES,
    overall: finalizeBucket(overallAcc),
    by_family,
    by_kind,
    by_family_and_kind,
  };
}

function padRow(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const fmt = (cols: readonly string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

const fmtMin = (v: number | null) => (v === null ? '-' : `${v.toFixed(1)}m`);
const fmtRate = (m: FirstPassStatsMetrics) => (m.enough ? `${(m.rate! * 100).toFixed(1)}%` : t('not enough cases'));

export function formatFirstPassStats(stats: FirstPassStats): string {
  const lines: string[] = [
    t('First-pass review statistics ({days} days): {verdicts} verdicts, {decided} decided, rate: {rate}', {
      days: stats.days,
      verdicts: stats.overall.verdicts,
      decided: stats.overall.decided,
      rate: fmtRate(stats.overall),
    }),
  ];
  if (!stats.by_family_and_kind.length) {
    lines.push(t('No completed first-pass reviews in window.'));
    return lines.join('\n');
  }
  const headers = ['FAMILY', 'KIND', 'VERDICTS', 'DECIDED', 'AGREE', 'DISAGREE', 'RATE', 'UNSURE', 'APPLIED', 'DISPUTED', 'RPT->VERDICT', 'VERDICT->DEC'];
  const rows = stats.by_family_and_kind.map(r => [
    r.model_family,
    r.kind,
    String(r.verdicts),
    String(r.decided),
    String(r.agree),
    String(r.disagree),
    fmtRate(r),
    String(r.unsure),
    String(r.applied),
    String(r.disputed),
    fmtMin(r.median_report_to_verdict_minutes),
    fmtMin(r.median_verdict_to_decision_minutes),
  ]);
  lines.push('', padRow(headers, rows));
  return lines.join('\n');
}
