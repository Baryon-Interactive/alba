import { describe, expect, it } from 'vitest';
import { attentionPath, attentionProjects, OVERVIEW_CAPS, STAGE_ORDER } from './overview';
import type { AttentionGroup } from '@api';
import { STAGES } from '@api';

describe('Overview navigation', () => {
  it('preserves distinct projects and encoded order links', () => {
    const g: AttentionGroup = { kind: 'quota', problem: true, count: 1, items: [{ project: 'one', projects: ['one', 'two'], text: 'shared' }] };
    expect(attentionProjects(g)).toEqual(['one', 'two']);
    expect(attentionPath({ project: 'one space', tag: 'A/1', text: '' })).toBe('/p/one%20space/orders/A%2F1');
    expect(attentionPath({ project: 'one', tag: 'Q1', target: 'spend', text: '' })).toBe('/p/one/orders/Q1');
    expect(attentionPath({ project: 'one', target: 'picks', text: '' })).toBe('/p/one/picks');
  });
  it('provides a stage segment for every board stage and fixed dashboard caps', () => {
    expect(new Set(STAGE_ORDER)).toEqual(new Set(STAGES));
    expect(OVERVIEW_CAPS.live).toBe(8);
    expect(OVERVIEW_CAPS.merges).toBe(8);
    expect(OVERVIEW_CAPS.held).toBe(3);
  });
});
