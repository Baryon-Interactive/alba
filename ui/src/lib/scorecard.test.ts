import { describe, expect, it } from 'vitest';
import type { ScorecardRow } from '@api';
import { sortScorecardRows, toggleScorecardSort } from './scorecard.ts';

function makeRow(overrides: Partial<ScorecardRow> & { key: string; kind?: string }): ScorecardRow {
  const { key, kind = 'ue', ...rest } = overrides;
  return {
    key,
    kind,
    projects: ['demo'],
    runs: 4,
    accepted_first_pass: 2,
    accepted_after_rework: 1,
    accepts: 3,
    reworks: 1,
    failed: 0,
    cancelled: 0,
    other: 0,
    pending: 0,
    open: 0,
    first_attempts: 3,
    minutes: 60,
    tokens: 10000,
    tokens_unknown_runs: 0,
    cost: { usd: 30, sources: ['engine'], priced_runs: 4, included_runs: 0, unknown_runs: 0 },
    cost_per_accept: 10,
    minutes_per_accept: 20,
    first_pass_rate: 2 / 3,
    acceptance_rate: 0.75,
    ...rest,
  };
}

describe('scorecard sort helper', () => {
  const cheap = makeRow({ key: 'cheap-paid', cost: { usd: 36, sources: ['engine'], priced_runs: 4, included_runs: 0, unknown_runs: 0 }, cost_per_accept: 12, first_pass_rate: 0.8 });
  const dear = makeRow({ key: 'dear-paid', cost: { usd: 123, sources: ['engine'], priced_runs: 4, included_runs: 0, unknown_runs: 0 }, cost_per_accept: 41, first_pass_rate: 0.45 });
  const sub = makeRow({ key: 'sub-worker', cost: { sources: [], priced_runs: 0, included_runs: 4, unknown_runs: 0 }, cost_per_accept: undefined, first_pass_rate: 0.9 });
  const unk = makeRow({ key: 'unk-worker', cost: { sources: [], priced_runs: 1, included_runs: 0, unknown_runs: 3 }, cost_per_accept: undefined, first_pass_rate: undefined });

  it('sorts numeric columns ascending with included and unknown values last', () => {
    const sorted = sortScorecardRows([unk, dear, sub, cheap], { column: 'cost_per_accept', dir: 'asc' });
    expect(sorted.map(r => r.key)).toEqual(['cheap-paid', 'dear-paid', 'sub-worker', 'unk-worker']);
  });

  it('reverses numeric sort while still keeping included and unknown values last', () => {
    const first = { column: 'cost_per_accept' as const, dir: 'asc' as const };
    const reversed = toggleScorecardSort(first, 'cost_per_accept');
    expect(reversed).toEqual({ column: 'cost_per_accept', dir: 'desc' });

    const sorted = sortScorecardRows([cheap, unk, sub, dear], reversed);
    expect(sorted.map(r => r.key)).toEqual(['dear-paid', 'cheap-paid', 'sub-worker', 'unk-worker']);
  });

  it('sorts first-pass rate and keeps under-minimum rows (undefined rate) last in both directions', () => {
    const asc = sortScorecardRows([unk, sub, cheap, dear], { column: 'first_pass_rate', dir: 'asc' });
    expect(asc.map(r => r.key)).toEqual(['dear-paid', 'cheap-paid', 'sub-worker', 'unk-worker']);

    const desc = sortScorecardRows([unk, sub, cheap, dear], { column: 'first_pass_rate', dir: 'desc' });
    expect(desc.map(r => r.key)).toEqual(['sub-worker', 'cheap-paid', 'dear-paid', 'unk-worker']);
  });

  it('switches to ascending when clicking a different column header', () => {
    const next = toggleScorecardSort({ column: 'cost_per_accept', dir: 'desc' }, 'minutes');
    expect(next).toEqual({ column: 'minutes', dir: 'asc' });
  });
});
