import { describe, expect, it } from 'vitest';
import { setLang } from '@/i18n';
import { zh } from '@/i18n/zh';
import { messageStateLabel, messageStateTone, sayDeliveryHint } from './MessageBox';

describe('message state labels and delivery hints', () => {
  it('formats sent, delivered via hook/steer/turn, read, and answered states with time in English', () => {
    setLang('en');
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'sent' })).toMatch(/^Sent \(/);
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'delivered', delivered_at: '2026-01-02T00:01:05Z', via: 'hook' })).toMatch(/^Delivered via hook \(/);
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'delivered', delivered_at: '2026-01-02T00:01:05Z', via: 'steer' })).toMatch(/^Delivered via steer \(/);
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'delivered', delivered_at: '2026-01-02T00:01:05Z', via: 'turn' })).toMatch(/^Delivered via turn \(/);
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'read', seen: '2026-01-02T00:02:00Z' })).toMatch(/^Read \(/);
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'answered', seen: '2026-01-02T00:03:00Z' })).toMatch(/^Answered \(/);
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z' })).toBeUndefined();

    expect(messageStateTone('sent')).toBe('outline');
    expect(messageStateTone('delivered')).toBe('primary');
    expect(messageStateTone('read')).toBe('primary');
    expect(messageStateTone('answered')).toBe('success');
  });

  it('describes live, steer, and file delivery hints in English and Chinese', () => {
    setLang('en');
    expect(sayDeliveryHint('live')).toContain('live');
    expect(sayDeliveryHint('steer')).toContain('steer');
    expect(sayDeliveryHint('file')).toContain('file');

    setLang('zh');
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'delivered', via: 'hook' })).toBe(zh['Delivered via hook']);
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'delivered', via: 'steer' })).toBe(zh['Delivered via steer']);
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'delivered', via: 'turn' })).toBe(zh['Delivered via turn']);
    expect(messageStateLabel({ at: '2026-01-02T00:01:00Z', delivery: 'delivered', delivered_at: '2026-01-02T00:01:05Z', via: 'hook' })).not.toContain('Delivered via hook');
    expect(sayDeliveryHint('live')).toBe(zh['Delivery: live — delivered on the next tool or model call.']);
    expect(sayDeliveryHint('steer')).toBe(zh['Delivery: steer — sent directly into the running Codex turn.']);
    expect(sayDeliveryHint('file')).toBe(zh['Delivery: file — the open run reads the inbox after each commit, long command, or every 15 minutes.']);
    // Every new string has a Chinese catalog entry
    for (const key of [
      'Sent ({when})',
      'Delivered via hook ({when})',
      'Delivered via steer ({when})',
      'Delivered via turn ({when})',
      'Read ({when})',
      'Answered ({when})',
      'Delivery: live — delivered on the next tool or model call.',
      'Delivery: steer — sent directly into the running Codex turn.',
      'Delivery: file — the open run reads the inbox after each commit, long command, or every 15 minutes.',
    ]) {
      expect(zh[key]).toBeTruthy();
    }
    setLang('en');
  });
});
