import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Worker } from '@api';
import { WorkerQuota } from './CapacitySummary';
import { setLang } from '@/i18n';

it('colors quota windows by remaining capacity and displays time to reset', () => {
  vi.useFakeTimers();
  try {
    setLang('en');
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    for (const [usedPercent, color] of [[79, 'primary'], [80, 'warning'], [89, 'warning'], [90, 'destructive']] as const) {
      const worker = { id: 'demo', reasons: [], sharesQuotaWith: [], quota: { ok: true, windows: [{ name: 'daily', usedPercent, resetsAt: '2026-01-01T12:12:00Z' }] } } as unknown as Worker;
      const html = renderToStaticMarkup(createElement(WorkerQuota, { workers: [worker] }));
      expect(html).toContain('h-full bg-' + color);
      expect(html).toContain('Resets in 12 min');
    }
  } finally { vi.useRealTimers(); }
});
