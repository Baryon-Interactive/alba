import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { SystemsList, ParamsTable, MilestoneBoard, SystemDetail } from './DesignPage';
import { ConflictView } from '@/components/DesignEdit';
import { seedDesign } from '@/mocks/design-data';
import { liveParams } from '@/lib/design';
import { setLang } from '@/i18n';

vi.mock('@/lib/queries', () => ({ useProjectId: () => 'demo', useDecisions: () => ({ data: { items: [] } }) }));
vi.mock('@/lib/api', () => ({ api: {}, ApiFailure: class extends Error {} }));
const data = seedDesign();
const render = (element: React.ReactNode, route = '/') => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(MemoryRouter, { initialEntries: [route] }, element)));
const edit = vi.fn();
afterEach(() => setLang('en'));
it('renders the systems list with counted bars, stale flags and navigation', () => {
  setLang('en');
  const html = render(createElement(SystemsList, { data, project: 'demo', stale: [{ system: 'GLD', orders: [], unknown_orders: ['DEMO1'] }], edit }));
  expect(html).toContain('Glider flight');
  expect(html).toContain('/p/demo/design/GLD');
  expect(html).toContain('Rules: 1 done, 1 partial, 1 none');
  expect(html).toContain('stale');
});
it('renders live out-of-range params with linked rule and formula references in both languages', () => {
  for (const [lang, flag] of [['en', 'Out of range'], ['zh', translated["Out of range"]]] as const) {
    setLang(lang);
    const html = render(createElement(ParamsTable, { rows: liveParams(data, 'GLD'), data, project: 'demo', edit }));
    expect(html).toContain('11.5');
    expect(html).toContain(flag);
    expect(html).toContain('?tab=formula#GLD-F01');
    expect(html).toContain('content/flight.json');
  }
});
it('renders a failing target and its measurement provenance and copy command', () => {
  setLang('en');
  const html = render(createElement(SystemDetail, { data, project: 'demo', code: 'GLD', stale: [], edit }), '/?tab=target');
  expect(html).toContain('failing');
  expect(html).toContain('92');
  expect(html).toContain('c3d4e5f');
  expect(html).toContain('Copy command');
  expect(html).toContain('/orders/AR1');
});
it('renders every milestone criterion with its state and overall passing count', () => {
  setLang('en');
  const html = render(createElement(MilestoneBoard, { data, project: 'demo', edit }));
  for (const text of ['1 / 4 criteria passing', 'passing', 'failing', 'unmeasured', 'manual']) expect(html).toContain(text);
  expect(html.indexOf('First flight')).toBeLessThan(html.indexOf('Open the trails'));
});
it('renders both versions of an edit conflict without dropping proposed fields', () => {
  setLang('en');
  const html = render(createElement(ConflictView, { before: { meaning: 'My proposed lift', version: 1 }, after: { meaning: 'Updated by another editor', version: 2 } }));
  for (const text of ['Your proposed version', 'Current saved version', 'My proposed lift', 'Updated by another editor', 'reload before saving']) expect(html).toContain(text);
});
