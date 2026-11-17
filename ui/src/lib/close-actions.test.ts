import { describe, expect, it } from 'vitest';
import { ORDER_ACTIONS, type OrderAction } from '@api';
import { actionExplain, actionLabel, visibleActions } from './stages.ts';

const all = [...ORDER_ACTIONS] as OrderAction[];

describe('close action visibility and labels', () => {
  it('includes close on failed and only on the six review/attention/idle stages', () => {
    expect(visibleActions('failed', all)).toContain('close');
    for (const stage of ['awaiting-review', 'awaiting-user', 'blocked', 'failed', 'dropped', 'idle'] as const) {
      expect(visibleActions(stage, all), stage).toContain('close');
    }
    for (const stage of ['running', 'monitoring', 'queued', 'waiting-needs', 'held', 'planned', 'draft', 'merged', 'cancelled'] as const) {
      expect(visibleActions(stage, all), stage).not.toContain('close');
    }
  });

  it('omits close when the server does not allow it and provides label and explanation', () => {
    expect(visibleActions('failed', ['rework', 'queue', 'cancel'])).not.toContain('close');
    expect(actionLabel('close')).toBe('Close');
    expect(actionExplain('close')).toMatch(/merged/i);
  });
});
