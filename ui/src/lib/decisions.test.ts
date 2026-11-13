import { describe, expect, it } from 'vitest';
import type { DecisionEntry } from '@api';
import { buildDecisionRequest, searchDecisions } from './decisions.ts';

const d = (number: number, text: string, source = 'default', sourceKind: DecisionEntry['sourceKind'] = 'default'): DecisionEntry => ({ id: `D${number}`, number, date: '2026-11-01', text, source, sourceKind });

describe('decision search', () => {
  const items = [d(1, 'Use pixel art'), d(2, 'Cap the run at 10 minutes', 'ten minutes is enough', 'quote'), d(3, 'Pixel fonts only', 'x', 'imported')];

  it('finds by any word in id, text or source, newest first', () => {
    expect(searchDecisions(items, 'pixel').map(x => x.id)).toEqual(['D3', 'D1']);
    expect(searchDecisions(items, 'ten minutes').map(x => x.id)).toEqual(['D2']);
    expect(searchDecisions(items, 'd2').map(x => x.id)).toEqual(['D2']);
  });

  it('can be narrowed to one section of the file', () => {
    const sections = [{ ...d(1, 'a'), topic: 'Phase 0' }, { ...d(2, 'b'), topic: 'Arena' }, d(3, 'c')];
    expect(searchDecisions(sections, '', '', 'Arena').map(x => x.id)).toEqual(['D2']);
    expect(searchDecisions(sections, '').length).toBe(3);
  });

  it('needs every word, and can filter by where the source came from', () => {
    expect(searchDecisions(items, 'pixel fonts').map(x => x.id)).toEqual(['D3']);
    expect(searchDecisions(items, '', 'quote').map(x => x.id)).toEqual(['D2']);
  });
});

describe('a new decision', () => {
  const form = { text: 'Ship on Friday', mode: 'quote' as const, source: '', id: '', date: '' };

  it('is refused without a source', () => {
    expect(buildDecisionRequest(form)).toEqual({ ok: false, missing: 'source' });
    expect(buildDecisionRequest({ ...form, source: '   ' })).toEqual({ ok: false, missing: 'source' });
  });

  it('is refused without words', () => {
    expect(buildDecisionRequest({ ...form, text: ' ', source: 'x' })).toEqual({ ok: false, missing: 'text' });
  });

  it('takes the user\'s words as the source', () => {
    expect(buildDecisionRequest({ ...form, source: 'let us ship Friday' })).toEqual({ ok: true, body: { text: 'Ship on Friday', source: 'let us ship Friday' } });
  });

  it('takes "default, not overruled" with no quote, and passes an id or date only when given', () => {
    expect(buildDecisionRequest({ ...form, mode: 'default', id: 'D50', date: '2026-11-02' })).toEqual({ ok: true, body: { text: 'Ship on Friday', id: 'D50', date: '2026-11-02', default: true } });
  });
});
