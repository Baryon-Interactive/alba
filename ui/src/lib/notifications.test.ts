import { expect, it } from 'vitest';
import { notificationTracker } from './notifications';

it('only delivers new unread points once and consumes suppressed points', () => {
  const check = notificationTracker(100);
  const orders = ['old', 'fresh', 'muted', 'open', 'read'].map(tag => ({
    project: 'demo', tag, unread: tag !== 'read', muted: tag === 'muted',
    attention: { at: new Date(tag === 'old' ? 100 : 110).toISOString(), reason: 'stage' as const, text: 'Ready' },
  }));
  expect(check('demo', [{ ...orders[1], tag: 'backlog' }])).toEqual([]);
  expect(check('demo', orders, 'open').map(o => o.tag)).toEqual(['fresh']);
  expect(check('demo', orders.map(o => ({ ...o, muted: false })))).toEqual([]);
  orders[1].attention.at = new Date(111).toISOString();
  expect(check('demo', orders)).toEqual([orders[1]]);
});
