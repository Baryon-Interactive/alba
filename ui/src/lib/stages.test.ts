import { describe, expect, it } from 'vitest';
import { ORDER_ACTIONS, STAGES, type OrderAction } from '@api';
import { visibleActions } from './stages.ts';

const all = [...ORDER_ACTIONS] as OrderAction[];

describe('buttons by stage', () => {
  it('shows approve only on an order that waits for review', () => {
    for (const stage of STAGES) {
      expect(visibleActions(stage, all).includes('approve'), stage).toBe(stage === 'awaiting-review');
    }
  });

  it('offers a running order hold and cancel, and nothing else', () => {
    expect(visibleActions('running', all)).toEqual(['stop', 'cancel']);
    expect(visibleActions('held', all)).toEqual(['run', 'release', 'cancel']);
  });

  it('gives a finished order no buttons', () => {
    expect(visibleActions('merged', all)).toEqual([]);
    expect(visibleActions('cancelled', all)).toEqual([]);
  });

  it('never shows an action the server did not allow', () => {
    expect(visibleActions('awaiting-review', ['rework', 'cancel'])).toEqual(['rework', 'cancel']);
    expect(visibleActions('awaiting-user', ['cancel'])).toEqual(['cancel']);
  });

  it('keeps answer for the order that waits for an answer: the server leaves it out for a card', () => {
    expect(visibleActions('awaiting-user', ['hold', 'cancel'])).not.toContain('answer');
    expect(visibleActions('awaiting-user', all)).toContain('answer');
  });
});
