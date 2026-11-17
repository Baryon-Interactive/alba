import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { OrderDetail } from '@api';
import { AcceptanceCard } from './AcceptanceCard';
import { setLang } from '@/i18n';

vi.mock('@/lib/api', () => ({ api: {}, ApiFailure: Error, fileUrl: (_project: string, file: string) => `/evidence/${encodeURIComponent(file)}` }));

const fixture = (): NonNullable<OrderDetail['acceptance']> => ({
  tag: 'DEMO', title: 'Sample feature', href: '/p/sample/orders/DEMO#acceptance',
  lint: [{ name: 'report_required', ok: true, detail: 'Report present' }], changed: ['src/feature.ts'], images: ['proof/screen.png'],
  trial: { id: 'trial', fingerprint: 'inputs', report: 1, base: 'base', branch: 'delivery', at: '2026-01-01T00:00:00Z', status: 'passed', changed: ['src/feature.ts'], conflicts: [], steps: [{ name: 'tests', status: 'passed', duration_ms: 50, code: 0, tail: '<script>untrusted output</script>' }] },
});
const html = (card: ReturnType<typeof fixture>, canApprove = true) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AcceptanceCard, { project: 'sample', card, canApprove })));
afterEach(() => setLang('en'));

it('renders lint, step output, paths and evidence thumbnails with full-size controls', () => {
  setLang('en');
  const out = html(fixture());
  for (const text of ['report_required: PASS', 'tests', '50', 'src/feature.ts', 'screen.png', 'Open at 100%', 'Accept and merge', '&lt;script&gt;untrusted output&lt;/script&gt;']) expect(out).toContain(text);
  expect(out).not.toContain('<script>');
  expect(out).not.toContain('disabled=""');
});

it('disables acceptance after a failed trial or failed lint, and keeps producer cards read-only', () => {
  const card = fixture(); card.trial!.status = 'failed'; card.trial!.reason = 'Unknown conflicts: shared.ts';
  expect(html(card)).toContain('Unknown conflicts: shared.ts');
  expect(html(card)).toContain('disabled=""');
  card.trial!.status = 'passed'; card.lint[0].ok = false;
  expect(html(card)).toContain('disabled=""');
  expect(html(fixture(), false)).not.toContain('Accept and merge');
});

it('uses Chinese acceptance controls', () => {
  setLang('zh');
  const out = html(fixture());
  for (const text of [translated["Acceptance review"], translated["Changed paths"], translated["Accept and merge"]]) expect(out).toContain(text);
});

it('renders Alba captures before worker pictures with sheet, shot badges, gates and revision', () => {
  setLang('en');
  const card = fixture();
  card.capture = {
    recipe: 'battle',
    manifest: '/state/capture/manifest.json',
    sheet: '/state/capture/sheet.png',
    revision: 'abcdef1234567890abcdef1234567890abcdef12',
    status: 'passed',
    shots: [
      { name: 'menu', file: '/state/capture/menu.png', status: 'ok', width: 320, height: 180 },
      { name: 'day', file: '/state/capture/day.png', status: 'failed', reason: 'exited with code 3 before writing the picture' },
    ],
    gates: [{ name: 'identical', status: 'pass', detail: 'Distinct shots: menu.' }],
  };
  const out = html(card);
  for (const text of ['sheet.png', 'battle', 'abcdef123456', 'menu', '320x180', 'exited with code 3 before writing the picture', 'identical: PASS', 'screen.png']) {
    expect(out).toContain(text);
  }
  expect(out.indexOf('sheet.png')).toBeLessThan(out.indexOf('screen.png'));
  expect(out.indexOf('Alba')).toBeLessThan(out.indexOf('Worker'));

  setLang('zh');
  const zhOut = html(card);
  expect(zhOut).toContain(translated["Alba's captures"]);
  expect(zhOut).toContain(translated["Worker's pictures (secondary)"]);
  expect(zhOut.indexOf(translated["Alba's captures"])).toBeLessThan(zhOut.indexOf(translated["Worker's pictures (secondary)"]));
});
