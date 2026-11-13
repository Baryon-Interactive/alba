import { beforeAll, describe, expect, it } from 'vitest';
import { setLang } from '@/i18n';
import { costLabel, sumCost, totalsByUnit } from './spend.ts';

beforeAll(() => setLang('en'));

describe('cost display', () => {
  it('says unknown when nobody knows the cost, never $0.000', () => {
    expect(costLabel(undefined)).toEqual({ text: 'unknown', known: false, estimated: false });
    expect(costLabel(undefined).text).not.toContain('$');
  });

  it('keeps a real zero as a number', () => {
    expect(costLabel(0).text).toBe('$0.000');
    expect(costLabel(0).known).toBe(true);
  });

  it('marks an estimate and shows an engine-reported cost plain', () => {
    expect(costLabel(1.2, true)).toEqual({ text: '~$1.20', known: true, estimated: true });
    expect(costLabel(0.41, false).text).toBe('$0.410');
  });

  it('sums only the runs that have a cost; unknown when none has', () => {
    expect(sumCost([{}, {}]).known).toBe(false);
    const s = sumCost([{ cost_usd: 1 }, {}, { cost_usd: 0.5, cost_estimated: true }]);
    expect(s).toEqual({ text: '~$1.50', known: true, estimated: true });
  });
});

describe('quote totals', () => {
  const q = (unit: string, status: 'pending' | 'approved' | 'rejected', capRequested: number, cap?: number, spent = 0) =>
    ({ unit, status, capRequested, spent, approval: cap === undefined ? undefined : { cap, by: 'x', at: '' } });

  it('never adds credits to dollars', () => {
    const t = totalsByUnit([q('credits', 'approved', 100, 80, 30), q('usd', 'approved', 5, 5, 1), q('credits', 'pending', 50), q('credits', 'rejected', 999)]);
    expect(t).toEqual([{ unit: 'credits', approved: 80, spent: 30, pending: 50 }, { unit: 'usd', approved: 5, spent: 1, pending: 0 }]);
  });
});
