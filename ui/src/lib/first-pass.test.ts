import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { OrderDetail } from '@api';
import { AcceptanceCard } from '../components/AcceptanceCard';
import { keys } from './keys';
import { setLang } from '@/i18n';

vi.mock('@/lib/api', () => ({
  api: {},
  ApiFailure: Error,
  fileUrl: (_project: string, file: string) => `/evidence/${encodeURIComponent(file)}`,
}));

const cardFixture = (): NonNullable<OrderDetail['acceptance']> => ({
  tag: 'T1',
  title: 'Night scene lighting',
  href: '/p/demo/orders/T1#acceptance',
  lint: [{ name: 'report_required', ok: true, detail: 'Report present' }],
  changed: ['src/lighting.ts'],
  images: [],
  pipelineRequired: false,
});

const bounceFixture = (): NonNullable<OrderDetail['firstPass']> => ({
  id: 'fp-1',
  tag: 'T1',
  report: 1,
  fingerprint: 'fp-hash',
  commit: '0123456789abcdef0123456789abcdef01234567',
  worker: 'claude-reviewer',
  model_family: 'claude',
  delivering_worker: 'codex-builder',
  delivering_family: 'gpt',
  status: 'done',
  started: '2026-06-01T10:00:00Z',
  ended: '2026-06-01T10:02:00Z',
  applied: true,
  reason: 'Night shot still renders the main menu.',
  verdict: {
    verdict: 'send-back',
    confident: true,
    items: [
      { item: 'Night scene opens directly', verdict: 'fail', evidence: 'night.png shows the main menu title instead of the night scene.' },
    ],
    note: 'Load the night map when -Time=22 is passed instead of staying on the main menu.',
    summary: 'Night shot still renders the main menu.',
  },
});

function renderCard(firstPass?: OrderDetail['firstPass']): string {
  const client = new QueryClient();
  if (firstPass) {
    client.setQueryData(keys.order('demo', 'T1'), { firstPass } as Partial<OrderDetail>);
  }
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AcceptanceCard, { project: 'demo', card: cardFixture(), canApprove: true }),
    ),
  );
}

afterEach(() => setLang('en'));

it('renders first-pass verdict, reviewer, model family, items, note, applied state and Wrong send-back button on AcceptanceCard', () => {
  setLang('en');
  const html = renderCard(bounceFixture());
  for (const text of [
    'First-pass review',
    'send-back',
    'confident',
    'reviewed by claude-reviewer (claude)',
    'Sent back automatically',
    'Night scene opens directly',
    'night.png shows the main menu title instead of the night scene.',
    'Load the night map when -Time=22 is passed instead of staying on the main menu.',
    'Wrong send-back',
  ]) {
    expect(html).toContain(text);
  }
});

it('renders not_applied reason and hides Wrong send-back once disputed or not applied', () => {
  setLang('en');
  const unapplied = bounceFixture();
  delete unapplied.applied;
  unapplied.not_applied = 'review is manual';
  const unappliedHtml = renderCard(unapplied);
  expect(unappliedHtml).toContain('Not sent back: review is manual');
  expect(unappliedHtml).not.toContain('Wrong send-back');

  const disputed = {
    ...bounceFixture(),
    disputed: { at: '2026-06-01T10:05:00Z', note: 'The menu overlay is expected in this test mode.' },
  };
  const disputedHtml = renderCard(disputed);
  expect(disputedHtml).toContain('Marked wrong');
  expect(disputedHtml).toContain('The menu overlay is expected in this test mode.');
  expect(disputedHtml).not.toContain('Wrong send-back');
});

it('renders Chinese translations on the review card', () => {
  setLang('zh');
  const html = renderCard(bounceFixture());
  for (const key of ['First-pass review', 'send-back', 'Sent back automatically', 'Wrong send-back'] as const) {
    expect(html).toContain(translated[key]);
  }
});
