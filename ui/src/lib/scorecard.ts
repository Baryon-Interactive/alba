import type { ScorecardRow } from '@api';

export type ScorecardColumn =
  | 'key'
  | 'kind'
  | 'runs'
  | 'accepted_first_pass'
  | 'accepted_after_rework'
  | 'reworks'
  | 'failed'
  | 'cancelled'
  | 'minutes'
  | 'cost'
  | 'cost_per_accept'
  | 'minutes_per_accept'
  | 'first_pass_rate';

export type SortDirection = 'asc' | 'desc';

export interface ScorecardSort {
  column: ScorecardColumn;
  dir: SortDirection;
}

export function toggleScorecardSort(current: ScorecardSort, column: ScorecardColumn): ScorecardSort {
  if (current.column === column) {
    return { column, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { column, dir: 'asc' };
}

function numericValue(row: ScorecardRow, column: ScorecardColumn): number | undefined {
  switch (column) {
    case 'runs': return row.runs;
    case 'accepted_first_pass': return row.accepted_first_pass;
    case 'accepted_after_rework': return row.accepted_after_rework;
    case 'reworks': return row.reworks;
    case 'failed': return row.failed;
    case 'cancelled': return row.cancelled;
    case 'minutes': return row.minutes;
    case 'cost': return row.cost.usd;
    case 'cost_per_accept': return row.cost_per_accept;
    case 'minutes_per_accept': return row.minutes_per_accept;
    case 'first_pass_rate': return row.first_pass_rate;
    default: return undefined;
  }
}

function textValue(row: ScorecardRow, column: 'key' | 'kind'): string | undefined {
  const v = row[column];
  return v && v !== 'unknown' ? v : undefined;
}

const isIncludedRow = (row: ScorecardRow): boolean => row.runs > 0 && row.cost.included_runs === row.runs;

function tieBreak(a: ScorecardRow, b: ScorecardRow, column: ScorecardColumn): number {
  if (column === 'cost' || column === 'cost_per_accept') {
    const incA = isIncludedRow(a), incB = isIncludedRow(b);
    if (incA !== incB) return incA ? -1 : 1;
  }
  return a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key);
}

/**
 * Pure sort for scorecard table rows. Unknown and included (absent) values always sort last,
 * even when the sort direction is reversed (`desc`).
 */
export function sortScorecardRows(rows: readonly ScorecardRow[], sort: ScorecardSort): ScorecardRow[] {
  const sign = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (sort.column === 'key' || sort.column === 'kind') {
      const ta = textValue(a, sort.column);
      const tb = textValue(b, sort.column);
      if (ta === undefined && tb === undefined) return tieBreak(a, b, sort.column);
      if (ta === undefined) return 1;
      if (tb === undefined) return -1;
      const cmp = ta.localeCompare(tb) * sign;
      return cmp !== 0 ? cmp : tieBreak(a, b, sort.column);
    }
    const na = numericValue(a, sort.column);
    const nb = numericValue(b, sort.column);
    if (na === undefined && nb === undefined) return tieBreak(a, b, sort.column);
    if (na === undefined) return 1;
    if (nb === undefined) return -1;
    const cmp = (na - nb) * sign;
    return cmp !== 0 ? cmp : tieBreak(a, b, sort.column);
  });
}
