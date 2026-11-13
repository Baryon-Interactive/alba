import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { OrderSummary, ProjectOverview } from '@api';
import { ProjectOverviewPage } from './ProjectOverviewPage';
import { useProjectOverview } from '@/lib/queries';
import { setLang } from '@/i18n';
import { mockNightlyGates } from '@/mocks/nightly-data';

vi.mock('@/lib/queries', () => ({
  useProjectId: () => 'demo',
  useProjectOverview: vi.fn(),
  useResources: () => ({ data: { resources: [] } }),
  useProducer: () => ({}),
  useProducerLog: () => ({}),
}));

const items: ProjectOverview['live']['items'] = Array.from({ length: 6 }, (_, i) => ({
  project: 'demo', tag: `E${i}`, title: 'Engine build', kind: 'ue', stage: i < 2 ? 'running' : 'monitoring',
  why: '', needs: [], updated: '2026-11-01T12:00:00Z', actions: [], leases: [],
}));
const running: OrderSummary[] = items.slice(0, 2);
const fixture: ProjectOverview = {
  project: 'demo', name: 'Demo', at: '2026-11-01T12:00:00Z', total: 6, needsCount: 0,
  stages: { running: 2, monitoring: 4 }, running: { count: 2, items: running }, live: { count: 6, items },
  capacity: { ue: { used: 6, cap: 6, monitoring: 4 }, sim: { used: 0, cap: 2, monitoring: 0 } },
  needsYou: { count: 0, items: [] }, pendingQuotes: { count: 0, items: [] }, problems: { count: 0, items: [] },
  workers: { count: 0, items: [] }, attention: [], next: { moves: [], heldBack: [] }, nextUp: [], dependencies: [],
  throughput: { days: [], byKind: [] }, mergesPerDay: [], recent: { decisions: [], approvals: [] }, recentDecisions: [], recentApprovals: [],
  producer: { openCases: 0, wouldDoToday: 0, paused: false },
};

afterEach(() => setLang('en'));

it('renders API cap usage for two running and four monitoring orders in English and Chinese', () => {
  vi.mocked(useProjectOverview).mockReturnValue({ data: fixture } as ReturnType<typeof useProjectOverview>);
  for (const [lang, monitoring] of [['en', '4 monitoring'], ['zh', translated['{n} monitoring'].replace('{n}', '4')]] as const) {
    setLang(lang);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProjectOverviewPage)));
    expect(html).toContain('ue <strong class="tabular-nums">6/6</strong> (' + monitoring + ')');
    expect(html).toContain('sim <strong class="tabular-nums">0/2</strong>');
    expect(html).not.toContain('ue · 2');
  }
});

it('uses the API capacity values even when the live list is partial', () => {
  const partial: ProjectOverview = { ...fixture, live: { count: 6, items: running.map(r => ({ ...r, leases: [] })) } };
  vi.mocked(useProjectOverview).mockReturnValue({ data: partial } as ReturnType<typeof useProjectOverview>);
  setLang('en');
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProjectOverviewPage)));
  expect(html).toContain('ue <strong class="tabular-nums">6/6</strong> (4 monitoring)');
});

it('shows a failed nightly gate, passing gates and the commit in both languages', () => {
  vi.mocked(useProjectOverview).mockReturnValue({ data: { ...fixture, nightlyGates: mockNightlyGates() } } as ReturnType<typeof useProjectOverview>);
  for (const [lang, title, failed] of [['en', 'Nightly gates', 'Failed'], ['zh', translated["nightly-gates"], translated["Failed"]]] as const) {
    setLang(lang);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProjectOverviewPage)));
    expect(html).toContain(title); expect(html).toContain(failed); expect(html).toContain('reference-scenarios');
    expect(html).toContain('simulation-soak'); expect(html).toContain('b7e42ac913d5'); expect(html).toContain('01:00-06:00');
    expect(html).toContain('Reference scenario: expected 4a61e9, received 7b32c0.');
  }
});
