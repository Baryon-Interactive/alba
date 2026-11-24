import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { SectionBoundary } from './common';
import { ProjectOverviewPage } from '../pages/ProjectOverviewPage';
import { setLang } from '@/i18n';

vi.mock('@/lib/queries', () => ({
  useProjectId: () => 'demo',
  useProjectOverview: () => ({ isError: true, error: new Error('Totals unavailable') }),
}));

it('renders unknown and the failed query error on the project overview', () => {
  setLang('en');
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProjectOverviewPage)));
  expect(html).toContain('unknown');
  expect(html).toContain('Totals unavailable');
  expect(html).not.toContain('>0<');
});

it('retries from a section error, invalidates cached data and restores the section', async () => {
  const child = createElement('p', null, 'Recovered');
  const boundary = new SectionBoundary({ title: 'Usage', children: child });
  const client = new QueryClient();
  client.setQueryData(['total'], 1);
  boundary.context = client;
  boundary.state = SectionBoundary.getDerivedStateFromError(new Error('Invalid row'));
  // Apply React state updates synchronously when exercising the boundary outside a DOM renderer.
  boundary.setState = vi.fn(update => { Object.assign(boundary.state, update); });
  const html = renderToStaticMarkup(boundary.render() as ReactElement);
  expect(html).toContain('Usage');
  expect(html).toContain('Invalid row');
  expect(html).toContain('Retry');
  await boundary.retry();
  expect(client.getQueryState(['total'])?.isInvalidated).toBe(true);
  expect(boundary.render()).toBe(child);
});
