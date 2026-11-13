import { describe, expect, it } from 'vitest';
import type { CleanItem, CleanPlan } from '@api';
import { summarizePlan } from './clean.ts';

const item = (action: CleanItem['action'], bytes?: number, links = 0): CleanItem => ({ kind: 'worktree', path: `/w/${action}${bytes}`, action, reason: 'r', targets: [], links, bytes });

describe('the clean plan', () => {
  it('adds up what would be freed, and leaves what is kept or skipped out of the sum', () => {
    const plan: CleanPlan = { project: 'p', at: '', errors: [], items: [item('remove', 100, 2), item('prune', 50), item('delete', undefined), item('keep', 999), item('skip', 999)] };
    const s = summarizePlan(plan);
    expect(s.removing.length).toBe(3);
    expect(s.leaving.map(i => i.action)).toEqual(['keep', 'skip']);
    expect(s.bytes).toBe(150);
    expect(s.unknown).toBe(1);
    expect(s.links).toBe(2);
  });
});
