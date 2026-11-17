import type { Scorecard, ScorecardBy, ScorecardCostSource, ScorecardRow } from '../api/types.ts';
import { fail } from '../i18n.ts';
import type { OrderDoc, Run } from '../orders/model.ts';
import { brokenRun } from '../routing/breaker.ts';
import { MIN_SAMPLES } from '../routing/history.ts';
import type { WorkerConfig, WorkersFile } from '../workers/config.ts';
import { sinceDate } from './accounting.ts';
import { ownerOf } from './spend.ts';
import type { UsageRow } from './types.ts';
import { withCost, type RunUsage } from './usage.ts';

export type { Scorecard, ScorecardBy, ScorecardCostSource, ScorecardRow };
export type { ScorecardCost } from '../api/types.ts';

export const SCORECARD_GROUPINGS = ['worker', 'model', 'family'] as const;

export interface ScorecardInput {
  docs: readonly { project: string; doc: OrderDoc }[];
  rows: readonly UsageRow[];
  workers?: WorkersFile | readonly WorkerConfig[];
  since?: string;
  until?: string;
  kind?: string;
  by?: ScorecardBy;
}

const COST_SOURCE_ORDER: readonly ScorecardCostSource[] = ['engine', 'estimate', 'run-record'];

function workerListOf(workers: ScorecardInput['workers']): readonly WorkerConfig[] {
  if (!workers) return [];
  return Array.isArray(workers) ? workers : (workers as WorkersFile).workers;
}

function costOfRun(
  run: Run,
  runRows: readonly UsageRow[],
  worker: WorkerConfig | undefined,
): { kind: 'priced'; usd: number; source: ScorecardCostSource } | { kind: 'included' } | { kind: 'unknown' } {
  const engineCosts = runRows.map(r => r.cost_usd).filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c >= 0);
  if (engineCosts.length > 0) {
    // Usage rows hold each turn's own spend (the Claude fold keeps only the increment of its running total), so a run's cost is
    // their sum, as in spend.ts.
    return { kind: 'priced', usd: engineCosts.reduce((sum, c) => sum + c, 0), source: 'engine' };
  }
  if (runRows.length > 0 && runRows.every(r => typeof r.estimate === 'number' && Number.isFinite(r.estimate) && r.estimate >= 0 && (r.currency === undefined || r.currency === 'USD'))) {
    return { kind: 'priced', usd: runRows.reduce((sum, r) => sum + r.estimate!, 0), source: 'estimate' };
  }
  if (worker?.price) {
    const summed: RunUsage = { source: runRows[0]?.source ?? run.usage?.source ?? 'unknown' };
    if (runRows.length > 0) {
      if (runRows.every(r => typeof r.input_tokens === 'number' && typeof r.output_tokens === 'number')) {
        summed.input_tokens = runRows.reduce((s, r) => s + r.input_tokens!, 0);
        summed.output_tokens = runRows.reduce((s, r) => s + r.output_tokens!, 0);
      }
      if (runRows.every(r => typeof r.total_tokens === 'number')) {
        summed.total_tokens = runRows.reduce((s, r) => s + r.total_tokens!, 0);
      }
    } else if (run.usage) {
      if (typeof run.usage.input_tokens === 'number') summed.input_tokens = run.usage.input_tokens;
      if (typeof run.usage.output_tokens === 'number') summed.output_tokens = run.usage.output_tokens;
      if (typeof run.usage.total_tokens === 'number') summed.total_tokens = run.usage.total_tokens;
    }
    const priced = withCost(summed, worker.price);
    if (typeof priced.cost_usd === 'number' && Number.isFinite(priced.cost_usd)) {
      return { kind: 'priced', usd: priced.cost_usd, source: 'estimate' };
    }
  }
  if (runRows.length === 0 && typeof run.usage?.cost_usd === 'number' && Number.isFinite(run.usage.cost_usd) && run.usage.cost_usd >= 0) {
    return { kind: 'priced', usd: run.usage.cost_usd, source: 'run-record' };
  }
  if (worker ? worker.cost === 'included' : (runRows.length > 0 && runRows.every(r => r.subscription === true))) {
    return { kind: 'included' };
  }
  return { kind: 'unknown' };
}

interface Accumulator {
  key: string;
  kind: string;
  projects: Set<string>;
  runs: number;
  accepted_first_pass: number;
  accepted_after_rework: number;
  reworks: number;
  failed: number;
  cancelled: number;
  other: number;
  pending: number;
  open: number;
  first_attempts: number;
  ended_runs: number;
  minutes: number;
  tokens_sum: number;
  tokens_known_runs: number;
  tokens_unknown_runs: number;
  usd_sum: number;
  sources: Set<ScorecardCostSource>;
  priced_runs: number;
  included_runs: number;
  unknown_runs: number;
}

/**
 * Pure scorecard over order documents, stored usage rows and worker configurations.
 * A run enters the window when `run.started` falls in `[since, until]`; its verdict may arrive later.
 * Verdict credit attributes each `approve` or `rework` action once to the latest run before it by `seq`
 * regardless of `run.outcome` (unlike `history.ts`, so an override approval after a failed run counts as accepted).
 */
export function scorecard(input: ScorecardInput): Scorecard {
  const by: ScorecardBy = input.by ?? 'worker';
  if (!(SCORECARD_GROUPINGS as readonly string[]).includes(by)) {
    fail('Invalid scorecard grouping: {value}', { value: String(by) });
  }
  let untilMs = Infinity;
  let untilIso = '';
  if (input.until) {
    untilMs = Date.parse(input.until);
    if (!Number.isFinite(untilMs)) fail('Invalid usage period: {value}', { value: input.until });
    untilIso = new Date(untilMs).toISOString();
  }
  let sinceMs = -Infinity;
  let sinceIso = '';
  if (input.since) {
    sinceIso = sinceDate(input.since, Number.isFinite(untilMs) ? new Date(untilMs) : new Date());
    sinceMs = Date.parse(sinceIso);
  }

  const workers = workerListOf(input.workers);
  const rowsByRun = new Map<string, UsageRow[]>();
  for (const row of input.rows) {
    const k = `${row.project}\0${row.order}\0${row.run}`;
    const list = rowsByRun.get(k);
    if (list) list.push(row);
    else rowsByRun.set(k, [row]);
  }

  const allProjects = new Set<string>();
  const groups = new Map<string, Accumulator>();

  for (const { project, doc } of input.docs) {
    allProjects.add(project);
    const sortedRuns = [...doc.runs].sort((a, b) => a.seq - b.seq);
    const sortedActions = [...doc.actions].sort((a, b) => a.seq - b.seq);

    // Each approve or rework counts once, for the latest run before it (by seq), whatever that run's outcome;
    // a run gets at most its first verdict.
    const verdicts = new Map<number, 'approve' | 'rework'>();
    for (const action of sortedActions) {
      if (action.kind !== 'approve' && action.kind !== 'rework') continue;
      let latest: Run | undefined;
      for (const r of sortedRuns) {
        if (r.seq < action.seq) latest = r;
        else break;
      }
      if (latest && !verdicts.has(latest.seq)) {
        verdicts.set(latest.seq, action.kind);
      }
    }

    for (const run of sortedRuns) {
      if (run.imported) continue;
      const startedMs = Date.parse(run.started);
      if (!Number.isFinite(startedMs) || startedMs < sinceMs || startedMs > untilMs) continue;

      const runKind = run.routing?.kind || doc.order.routing?.kind || doc.order.kind;
      if (input.kind && runKind !== input.kind) continue;

      const worker = ownerOf(workers, run.worker);
      const groupKey = by === 'worker'
        ? (worker?.id ?? run.worker)
        : by === 'family'
          ? (worker?.model_family ?? worker?.id ?? run.worker)
          : (run.model?.trim() || 'unknown');

      const mapKey = `${groupKey}\0${runKind}`;
      let acc = groups.get(mapKey);
      if (!acc) {
        acc = {
          key: groupKey, kind: runKind, projects: new Set(),
          runs: 0, accepted_first_pass: 0, accepted_after_rework: 0, reworks: 0,
          failed: 0, cancelled: 0, other: 0, pending: 0, open: 0, first_attempts: 0,
          ended_runs: 0, minutes: 0, tokens_sum: 0, tokens_known_runs: 0, tokens_unknown_runs: 0,
          usd_sum: 0, sources: new Set(), priced_runs: 0, included_runs: 0, unknown_runs: 0,
        };
        groups.set(mapKey, acc);
      }
      acc.projects.add(project);
      acc.runs++;

      const hadReworkBefore = sortedActions.some(a => a.kind === 'rework' && a.seq < run.seq);
      const verdict = verdicts.get(run.seq);
      let isFailedWithoutVerdict = false;

      if (verdict === 'approve') {
        if (hadReworkBefore) acc.accepted_after_rework++;
        else acc.accepted_first_pass++;
      } else if (verdict === 'rework') {
        acc.reworks++;
      } else if (run.ended === undefined) {
        acc.open++;
      } else if (brokenRun(run)) {
        acc.failed++;
        isFailedWithoutVerdict = true;
      } else if (run.outcome === 'cancelled') {
        acc.cancelled++;
      } else if (run.end?.kind === 'killed-by-alba' || (run.outcome !== undefined && run.outcome !== 'completed')) {
        acc.other++;
      } else {
        acc.pending++;
      }

      if (!hadReworkBefore && (verdict !== undefined || isFailedWithoutVerdict)) {
        acc.first_attempts++;
      }

      if (run.ended !== undefined) {
        const endedMs = Date.parse(run.ended);
        if (Number.isFinite(endedMs)) {
          acc.ended_runs++;
          acc.minutes += Math.max(0, (endedMs - startedMs) / 60000);
        }
      }

      const runRows = rowsByRun.get(`${project}\0${doc.order.tag}\0${run.id}`) ?? [];
      let runTokens: number | undefined;
      if (runRows.length > 0) {
        if (runRows.every(r => typeof r.total_tokens === 'number' && Number.isFinite(r.total_tokens))) {
          runTokens = runRows.reduce((s, r) => s + r.total_tokens!, 0);
        }
      } else if (typeof run.usage?.total_tokens === 'number' && Number.isFinite(run.usage.total_tokens)) {
        runTokens = run.usage.total_tokens;
      }
      if (runTokens !== undefined) {
        acc.tokens_known_runs++;
        acc.tokens_sum += runTokens;
      } else {
        acc.tokens_unknown_runs++;
      }

      const rc = costOfRun(run, runRows, worker);
      if (rc.kind === 'priced') {
        acc.priced_runs++;
        acc.usd_sum += rc.usd;
        acc.sources.add(rc.source);
      } else if (rc.kind === 'included') {
        acc.included_runs++;
      } else {
        acc.unknown_runs++;
      }
    }
  }

  const outRows: ScorecardRow[] = [...groups.values()].map(g => {
    const accepts = g.accepted_first_pass + g.accepted_after_rework;
    const verdictsCount = accepts + g.reworks;
    const acceptanceSamples = verdictsCount + g.failed;
    const allPriced = g.runs > 0 && g.priced_runs === g.runs;
    const usd = allPriced ? Math.round(g.usd_sum * 1e6) / 1e6 : undefined;
    const sources = COST_SOURCE_ORDER.filter(s => g.sources.has(s));

    const row: ScorecardRow = {
      key: g.key,
      kind: g.kind,
      projects: [...g.projects].sort(),
      runs: g.runs,
      accepted_first_pass: g.accepted_first_pass,
      accepted_after_rework: g.accepted_after_rework,
      accepts,
      reworks: g.reworks,
      failed: g.failed,
      cancelled: g.cancelled,
      other: g.other,
      pending: g.pending,
      open: g.open,
      first_attempts: g.first_attempts,
      minutes: g.minutes,
      ...(g.tokens_known_runs > 0 ? { tokens: g.tokens_sum } : {}),
      tokens_unknown_runs: g.tokens_unknown_runs,
      cost: {
        ...(usd !== undefined ? { usd } : {}),
        sources,
        priced_runs: g.priced_runs,
        included_runs: g.included_runs,
        unknown_runs: g.unknown_runs,
      },
      ...(usd !== undefined && accepts >= 1 ? { cost_per_accept: usd / accepts } : {}),
      ...(accepts >= 1 && g.ended_runs > 0 ? { minutes_per_accept: g.minutes / accepts } : {}),
      ...(g.first_attempts >= MIN_SAMPLES ? { first_pass_rate: g.accepted_first_pass / g.first_attempts } : {}),
      ...(acceptanceSamples >= MIN_SAMPLES ? { acceptance_rate: accepts / acceptanceSamples } : {}),
    };
    return row;
  });

  // Sort by kind, then cost per accept ascending (unknown/included last), then minutes per accept, then key.
  outRows.sort((a, b) => {
    const kc = a.kind.localeCompare(b.kind);
    if (kc !== 0) return kc;
    if (a.cost_per_accept !== undefined && b.cost_per_accept !== undefined) {
      if (a.cost_per_accept !== b.cost_per_accept) return a.cost_per_accept - b.cost_per_accept;
    } else if (a.cost_per_accept !== undefined) {
      return -1;
    } else if (b.cost_per_accept !== undefined) {
      return 1;
    }
    if (a.minutes_per_accept !== undefined && b.minutes_per_accept !== undefined) {
      if (a.minutes_per_accept !== b.minutes_per_accept) return a.minutes_per_accept - b.minutes_per_accept;
    } else if (a.minutes_per_accept !== undefined) {
      return -1;
    } else if (b.minutes_per_accept !== undefined) {
      return 1;
    }
    return a.key.localeCompare(b.key);
  });

  return {
    by,
    since: sinceIso,
    until: untilIso,
    ...(input.kind ? { kind: input.kind } : {}),
    projects: [...allProjects].sort(),
    rows: outRows,
  };
}
