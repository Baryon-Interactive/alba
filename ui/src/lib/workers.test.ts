import { beforeAll, describe, expect, it } from 'vitest';
import type { Worker } from '@api';
import { setLang } from '@/i18n';
import { aliasList, changesOf, formOf, groupByQuota, problemsFor, sameModelNote } from './workers.ts';

const w = (id: string, over: Partial<Worker> = {}): Worker => ({
  id, engine: 'x', paid: false, concurrency: 2, capabilities: [], cost: 'included', enabled: true, cardOnly: false, canResume: true, available: true, reasons: [], running: 0, runsToday: 0,
  spendTodayUsd: 0, overCap: false, aliases: [], sharesQuotaWith: [], sameModelAs: [], disabledWhen: [], hasLaunch: true, onLimit: 'wait', rotatePaid: false, ...over,
});

beforeAll(() => setLang('en'));

describe('workers on one subscription', () => {
  it('puts workers with the same quota source together and the others after them', () => {
    const list = [w('a'), w('heavy', { quotaSource: 'grok', sharesQuotaWith: ['cli'] }), w('b', { quotaSource: 'solo' }), w('cli', { quotaSource: 'grok', sharesQuotaWith: ['heavy'] })];
    expect(groupByQuota(list).map(g => [g.source, g.workers.map(x => x.id)])).toEqual([['grok', ['heavy', 'cli']], [undefined, ['a', 'b']]]);
    expect(groupByQuota([w('a')]).map(g => g.source)).toEqual([undefined]);
    expect(groupByQuota([])).toEqual([]);
  });

  it('says same model, different shell only when another worker has the model', () => {
    expect(sameModelNote(w('a', { modelFamily: 'grok-4.7', sameModelAs: ['b'] }))).toBe('grok-4.7: same model, different shell as b');
    expect(sameModelNote(w('a', { modelFamily: 'grok-4.7' }))).toBeUndefined();
    expect(sameModelNote(w('a'))).toBeUndefined();
  });
});

describe('the worker edit form', () => {
  const worker = w('coder', { notes: 'Window resets weekly', capabilities: ['shell', 'edit'], concurrency: 2, aliases: ['Coder'], disabledWhen: [{ window: '7 days', at: 95 }] });

  it('reads a worker into the form and an untouched form changes nothing', () => {
    const f = formOf(worker);
    expect(f).toMatchObject({ notes: 'Window resets weekly', concurrency: '2', dailyRuns: '', aliases: 'Coder', enabled: true });
    expect(f.capabilities).toBe('shell, edit');
    expect(f.disabledWhen).toEqual([{ kind: 'window', window: '7 days', at: '95', drop: '' }]);
    expect(changesOf(f, formOf(worker))).toEqual({ ok: true, set: {} });
  });

  it('sends only what changed, with numbers as numbers and an emptied field as null', () => {
    const f = formOf(worker);
    const r = changesOf(f, { ...f, concurrency: '4', capabilities: 'shell, edit, git', notes: '', aliases: 'Coder, Cody', dailyRuns: '8', enabled: false });
    expect(r).toEqual({ ok: true, set: { concurrency: 4, capabilities: ['shell', 'edit', 'git'], notes: null, aliases: ['Coder', 'Cody'], daily_runs: 8, enabled: false } });
  });

  it('writes the rules that switch a worker off in the file\'s own words', () => {
    const f = formOf(worker);
    const r = changesOf(f, { ...f, disabledWhen: [{ kind: 'window', window: '7 days', at: '90', drop: '' }, { kind: 'balance', window: '', at: '', drop: '2.5' }] });
    expect(r).toEqual({ ok: true, set: { disabled_when: [{ window_full: '7 days', at: 90 }, { balance_drop: 2.5 }] } });
    expect(changesOf(f, { ...f, disabledWhen: [] })).toEqual({ ok: true, set: { disabled_when: null } });
  });

  it('refuses input that is not a number, a kind with no name or twice, and a percent above 100', () => {
    const f = formOf(worker);
    const bad = changesOf(f, { ...f, concurrency: 'many', dailyCapUsd: '-1', disabledWhen: [{ kind: 'window', window: '*', at: '120', drop: '' }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.map(p => p.field).sort()).toEqual(['concurrency', 'daily_cap_usd', 'disabled_when[0]']);
  });

  it('splits aliases on commas and lines and keeps each once', () => {
    expect(aliasList('Coder, Cody\n coder ,Coder,Kid')).toEqual(['Coder', 'Cody', 'coder', 'Kid']);
  });

  it('finds the server\'s problems of a field by its name', () => {
    const details = [{ field: 'capabilities', message: 'a' }, { field: 'concurrency', message: 'b' }, { field: 'disabled_when[0].at', message: 'c' }, { message: 'd' }];
    expect(problemsFor(details, 'capabilities')).toEqual(['a']);
    expect(problemsFor(details, 'disabled_when[0]')).toEqual(['c']);
    expect(problemsFor(undefined, 'capabilities')).toEqual([]);
  });
});
