import type { OrderDoc } from '../orders/model.ts';
import type { UsageRow } from '../usage/types.ts';

export interface RoleWorkerResult {
  role: string; worker: string; runs: number; samples: number; accepted: number; reworked: number;
  acceptedShare: number | null; tokenSamples: number; wallSamples: number;
  medianTokens: number | null; medianWallHours: number | null; status: 'enough runs' | 'not enough runs';
}
const median = (values: number[]) => {
  if (values.length < 3) return null;
  const v = [...values].sort((a, b) => a - b);
  return (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2;
};

/** Attribute historical runs to their recorded role, never to today's edited kind mapping.
 * Each completed run gets the first review before the next run. Unknown token totals stay unknown. */
export function roleResults(docs: readonly OrderDoc[], usage: readonly UsageRow[] = [], since = '', until = new Date().toISOString()): RoleWorkerResult[] {
  const byRun = new Map<string, UsageRow[]>();
  for (const row of usage) if (row.at <= until) {
    const key = JSON.stringify([row.order, row.run]);
    const rows = byRun.get(key) ?? []; rows.push(row); byRun.set(key, rows);
  }
  const groups = new Map<string, { result: RoleWorkerResult; tokens: number[]; hours: number[] }>();
  for (const doc of docs) {
    const runs = [...doc.runs].sort((a, b) => a.seq - b.seq);
    const actions = [...doc.actions].sort((a, b) => a.seq - b.seq);
    runs.forEach((run, i) => {
      if (!run.role || run.imported || run.outcome !== 'completed' || !run.ended || run.ended < since || run.ended > until) return;
      const key = JSON.stringify([run.role, run.worker]);
      let group = groups.get(key);
      if (!group) {
        group = { result: { role: run.role, worker: run.worker, runs: 0, samples: 0, accepted: 0, reworked: 0, acceptedShare: null, tokenSamples: 0, wallSamples: 0, medianTokens: null, medianWallHours: null, status: 'not enough runs' }, tokens: [], hours: [] };
        groups.set(key, group);
      }
      const r = group.result; r.runs++;
      const verdict = actions.find(a => a.seq > run.seq && a.seq < (runs[i + 1]?.seq ?? Infinity) && a.at <= until && ['approve', 'rework', 'merged-elsewhere', 'done-by-lead'].includes(a.kind));
      if (verdict && (verdict.kind === 'approve' || verdict.kind === 'rework')) { r.samples++; if (verdict.kind === 'approve') r.accepted++; else r.reworked++; }
      const rows = byRun.get(JSON.stringify([doc.order.tag, run.id])) ?? [];
      const tokens = rows.length ? (rows.every(u => u.total_tokens !== undefined) ? rows.reduce((n, u) => n + u.total_tokens!, 0) : undefined) : run.usage?.total_tokens;
      if (tokens !== undefined && Number.isFinite(tokens) && tokens >= 0) group.tokens.push(tokens);
      const hours = (Date.parse(run.ended) - Date.parse(run.started)) / 3_600_000;
      if (Number.isFinite(hours) && hours >= 0) group.hours.push(hours);
    });
  }
  return [...groups.values()].map(({ result: r, tokens, hours }) => ({ ...r, acceptedShare: r.samples >= 3 ? r.accepted / r.samples : null, tokenSamples: tokens.length, wallSamples: hours.length, medianTokens: median(tokens), medianWallHours: median(hours), status: r.samples >= 3 ? 'enough runs' as const : 'not enough runs' as const })).sort((a, b) => a.role.localeCompare(b.role) || a.worker.localeCompare(b.worker));
}
