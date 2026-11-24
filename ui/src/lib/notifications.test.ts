import { expect, it } from 'vitest';
import { newNotifications } from './notifications';

it('only delivers new unread points once and consumes suppressed points', () => {
  const latest = new Map<string, string>();
  const orders = ['old', 'fresh', 'muted', 'open', 'read'].map(tag => ({
    project: 'demo', tag, unread: tag !== 'read', muted: tag === 'muted',
    attention: { at: new Date(tag === 'old' ? 100 : 110).toISOString(), reason: 'stage' as const, text: 'Ready' },
  }));
  expect(newNotifications(orders, latest, 100, 'open').map(o => o.tag)).toEqual(['fresh']);
  expect(newNotifications(orders.map(o => ({ ...o, muted: false })), latest, 100)).toEqual([]);
  orders[1].attention.at = new Date(111).toISOString();
  expect(newNotifications(orders, latest, 100)).toEqual([orders[1]]);
});
