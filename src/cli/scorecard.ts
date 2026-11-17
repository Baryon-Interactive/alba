import { loadProject } from '../config.ts';
import { fail, t } from '../i18n.ts';
import { stateStore } from '../orders/backend.ts';
import { Orders } from '../orders/service.ts';
import { MIN_SAMPLES } from '../routing/history.ts';
import { systemProbes } from '../tick/gather.ts';
import { collectUsage, sinceDate } from '../usage/accounting.ts';
import { scorecard, type Scorecard, type ScorecardBy, type ScorecardRow } from '../usage/scorecard.ts';
import { usageRows } from '../usage/store.ts';
import { loadWorkers, type WorkerConfig } from '../workers/config.ts';
import { table } from './format.ts';

export interface ScorecardCliValues {
  workers?: string;
  kind?: string;
  since?: string;
  by?: string;
  json?: boolean;
  days?: string;
}

const formatUsd = (n: number): string => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function formatScorecardCost(row: ScorecardRow): string {
  if (row.cost.usd !== undefined) return formatUsd(row.cost.usd);
  if (row.cost.included_runs === row.runs && row.runs > 0) return t('included');
  if (row.cost.priced_runs > 0) {
    return t('unknown ({priced} of {runs} runs priced)', { priced: row.cost.priced_runs, runs: row.runs });
  }
  return t('unknown');
}

export function formatScorecardCostPerAccept(row: ScorecardRow): string {
  if (row.cost_per_accept !== undefined) return formatUsd(row.cost_per_accept);
  if (row.cost.included_runs === row.runs && row.runs > 0) return t('included');
  if (row.cost.usd === undefined) return t('unknown');
  return '-';
}

export function formatScorecard(sc: Scorecard): string {
  const keyHeader = sc.by === 'model' ? 'MODEL' : sc.by === 'family' ? 'FAMILY' : 'WORKER';
  const header = [
    keyHeader, 'KIND', 'RUNS', '1ST-PASS', 'AFTER-RW', 'REWORK',
    'FAILED', 'CANCELLED', 'MIN', 'COST', '$/ACCEPT', 'MIN/ACCEPT', 'FIRST-PASS',
  ];
  const rows = sc.rows.map(r => [
    r.key,
    r.kind,
    String(r.runs),
    String(r.accepted_first_pass),
    String(r.accepted_after_rework),
    String(r.reworks),
    String(r.failed),
    String(r.cancelled),
    String(Math.round(r.minutes)),
    formatScorecardCost(r),
    formatScorecardCostPerAccept(r),
    r.minutes_per_accept !== undefined ? String(Math.round(r.minutes_per_accept)) : '-',
    r.first_pass_rate !== undefined ? `${Math.round(r.first_pass_rate * 100)}%` : `n<${MIN_SAMPLES}`,
  ]);
  return table(header, rows);
}

export function runUsageScorecard(files: string[], values: ScorecardCliValues, extraPositionals: string[] = []): string {
  if (extraPositionals.length > 0 || values.days !== undefined) {
    fail('Usage: alba usage scorecard [--project f ...] [--kind k] [--since 14d] [--by worker|model|family] [--json]');
  }
  const now = new Date();
  const seenWorkers = new Set<string>();
  const workers: WorkerConfig[] = [];
  const allDocs: { project: string; doc: ReturnType<Orders['all']>[number] }[] = [];
  const allRows = files.flatMap(file => {
    const project = loadProject(file);
    const docs = new Orders(stateStore(project)).all();
    for (const doc of docs) allDocs.push({ project: project.id, doc });
    const workersPath = values.workers ?? process.env.ALBA_WORKERS ?? project.workers;
    const workersFile = workersPath ? loadWorkers(workersPath) : undefined;
    for (const w of workersFile?.workers ?? []) {
      if (!seenWorkers.has(w.id)) {
        seenWorkers.add(w.id);
        workers.push(w);
      }
    }
    const stored = usageRows(project);
    const indexed = new Map(stored.map(r => [`${r.order}/${r.run}`, r]));
    const refresh = docs.some(doc => doc.runs.some(run => {
      if (run.imported) return false;
      const row = indexed.get(`${doc.order.tag}/${run.id}`);
      return !run.ended || !row || row.source === 'unknown' || row.open || row.merged !== doc.actions.some(a => a.kind === 'approve' && a.seq > run.seq);
    }));
    return refresh ? collectUsage(project, docs, workersFile, systemProbes).rows : stored;
  });

  const since = sinceDate(values.since ?? '14d', now);
  const result = scorecard({
    docs: allDocs,
    rows: allRows,
    workers,
    since,
    until: now.toISOString(),
    kind: values.kind,
    by: (values.by ?? 'worker') as ScorecardBy,
  });
  return values.json ? JSON.stringify(result, null, 2) : formatScorecard(result);
}
