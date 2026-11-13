import { describe, expect, it } from 'vitest';
import { draftKey, emptyDraft, hasDraft, loadDraft, saveDraft } from './drafts.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), size: () => m.size };
};

describe('review drafts', () => {
  const key = draftKey('p', 'T1');
  const c = { id: 'a', file: 'x.ts', line: 3, side: 'new' as const, text: 'rename this' };

  it('keeps unsent comments and remarks', () => {
    const s = memory();
    saveDraft(key, { general: 'too slow', comments: [c] }, s);
    expect(hasDraft(key, s)).toBe(true);
    expect(loadDraft(key, s)).toEqual({ general: 'too slow', comments: [c] });
  });

  it('leaves nothing behind once the rework is sent (the draft is emptied)', () => {
    const s = memory();
    saveDraft(key, { general: '', comments: [c] }, s);
    saveDraft(key, emptyDraft(), s);
    expect(s.size()).toBe(0);
    expect(hasDraft(key, s)).toBe(false);
  });

  it('treats whitespace-only remarks as no draft', () => {
    const s = memory();
    saveDraft(key, { general: '  \n', comments: [] }, s);
    expect(s.size()).toBe(0);
  });

  it('reads a damaged entry as an empty draft', () => {
    const s = memory();
    s.setItem(key, '{not json');
    expect(loadDraft(key, s)).toEqual(emptyDraft());
    s.setItem(key, JSON.stringify({ general: 5, comments: 'x' }));
    expect(loadDraft(key, s)).toEqual(emptyDraft());
  });

  it('keys drafts per project and order', () => {
    expect(draftKey('a', 'T1')).not.toBe(draftKey('b', 'T1'));
  });
});
