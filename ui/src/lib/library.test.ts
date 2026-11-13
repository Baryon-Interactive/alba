import { describe, expect, it } from 'vitest';
import type { ArtRef, ArtSetting, PickSet, SpendQuote } from '@api';
import { canConfirm, choiceText, confirmationText, filterRefs, pickGroups, pickImages, spentPercent, tagsLeft, toggleChoice } from './library';

const set = (state: PickSet['state'], id = 'P', extra: Partial<PickSet> = {}): PickSet => ({
  id, title: id, question: 'q', multi: false, state, source: 'file', problems: [],
  options: [{ key: 'a', label: 'Round', images: [{ path: 'x/a1.png', exists: true }, { path: 'x/a2.png', exists: false }] }, { key: 'b', label: 'Square', images: [{ path: 'x/b1.png', exists: true }] }], ...extra,
});

describe('picks', () => {
  it('a single choice replaces, a second click on it clears; a multi choice toggles', () => {
    expect(toggleChoice([], 'a', false)).toEqual(['a']);
    expect(toggleChoice(['a'], 'b', false)).toEqual(['b']);
    expect(toggleChoice(['a'], 'a', false)).toEqual([]);
    expect(toggleChoice(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleChoice(['a', 'b'], 'a', true)).toEqual(['b']);
  });

  it('groups by state in the order of the page, and lists the pictures option by option', () => {
    const g = pickGroups([set('decided', 'D'), set('pending', 'P1'), set('chosen', 'C'), set('pending', 'P2')]);
    expect([g.pending.map(s => s.id), g.chosen.map(s => s.id), g.decided.map(s => s.id)]).toEqual([['P1', 'P2'], ['C'], ['D']]);
    expect(pickImages(set('pending')).map(i => [i.optionKey, i.path, i.exists])).toEqual([['a', 'x/a1.png', true], ['a', 'x/a2.png', false], ['b', 'x/b1.png', true]]);
  });

  it('words a choice with the labels, and keeps a key the set no longer has', () => {
    expect(choiceText(set('chosen'), ['a', 'b'])).toBe('a: Round, b: Square');
    expect(choiceText(set('chosen'), ['z'])).toBe('z: z');
  });
});

const ref = (id: string, tags: string[], extra: Partial<ArtRef> = {}): ArtRef => ({ id, image: `https://i.example.test/${id}.png`, title: id, tags, cached: false, problems: [], ...extra });

describe('reference board', () => {
  const refs = [ref('r1', ['harbor', 'dusk'], { learn: 'warm rim light' }), ref('r2', ['harbor']), ref('r3', ['market', 'dusk'], { work: 'Demo Work' })];
  it('several tags narrow: a card must carry all of them', () => {
    expect(filterRefs(refs, []).map(r => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(filterRefs(refs, ['harbor']).map(r => r.id)).toEqual(['r1', 'r2']);
    expect(filterRefs(refs, ['harbor', 'dusk']).map(r => r.id)).toEqual(['r1']);
    expect(filterRefs(refs, ['harbor', 'market'])).toEqual([]);
  });
  it('the text search looks at title, work, learn and tags', () => {
    expect(filterRefs(refs, [], 'rim').map(r => r.id)).toEqual(['r1']);
    expect(filterRefs(refs, [], 'DEMO').map(r => r.id)).toEqual(['r3']);
    expect(filterRefs(refs, ['dusk'], 'market').map(r => r.id)).toEqual(['r3']);
  });
  it('the tags still offered are those of the cards that remain', () => {
    expect(tagsLeft(refs, ['harbor'])).toEqual([{ tag: 'harbor', count: 2 }, { tag: 'dusk', count: 1 }]);
    expect(tagsLeft(refs, ['market'])).toEqual([{ tag: 'dusk', count: 1 }, { tag: 'market', count: 1 }]);
  });
});

const setting = (extra: Partial<ArtSetting>): ArtSetting => ({ id: 's', title: 's', status: 'text-draft', standard: true, text: 'a.md#s', refs: [], refCards: [], images: [], confirmed: false, problems: [], body: '## s', ...extra });

describe('settings', () => {
  it('the confirmation is said in a word', () => {
    expect(confirmationText(setting({ confirmed: true })).tone).toBe('success');
    expect(confirmationText(setting({ confirmation: { at: 'x', by: 'web', source: 'alba', textSha256: 'a', valid: false } })).tone).toBe('warning');
    expect(confirmationText(setting({})).tone).toBe('neutral');
  });
  it('only a draft with its text may be confirmed, whatever word the file uses for a draft', () => {
    expect(canConfirm(setting({}))).toBe(true);
    expect(canConfirm(setting({ status: 'concept', standard: false }))).toBe(true);
    expect(canConfirm(setting({ status: 'sheets' }))).toBe(false);
    expect(canConfirm(setting({ body: undefined }))).toBe(false);
    expect(canConfirm(setting({ confirmed: true }))).toBe(false);
  });
});

describe('spend', () => {
  const quote = (extra: Partial<SpendQuote>): SpendQuote => ({ id: 'Q', statusKnown: true, file: 'f', fingerprint: 'x', state: 'pending', entries: [], spent: 50, problems: [], ...extra });
  it('spent against the approved cap, and nothing when the approval is stale or missing', () => {
    expect(spentPercent(quote({ approval: { cap: 200, at: 'x', by: 'web', source: 'alba', stale: false } }))).toBe(25);
    expect(spentPercent(quote({ approval: { cap: 40, at: 'x', by: 'web', source: 'alba', stale: false } }))).toBe(100);
    expect(spentPercent(quote({ approval: { cap: 200, at: 'x', by: 'web', source: 'alba', stale: true } }))).toBe(0);
    expect(spentPercent(quote({}))).toBe(0);
  });
});
