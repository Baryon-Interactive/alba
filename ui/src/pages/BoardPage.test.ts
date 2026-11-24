import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import type { OrderSummary } from '@api';
import { BoardCard } from './BoardPage';

it('marks only an unread board card and exposes its label to screen readers', () => {
  const order: OrderSummary = { project: 'demo', tag: 'T1', title: 'Example', stage: 'merged', kind: 'docs', why: '', needs: [], updated: '', actions: [] };
  for (const unread of [true, false, undefined]) {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(MemoryRouter, null, createElement(BoardCard, { project: 'demo', o: { ...order, unread } }))));
    expect(/<article class="[^"]*order-unread/.test(html)).toBe(unread === true);
    expect(html.includes('new-pill')).toBe(unread === true);
    expect(html.includes('class="sr-only">New</span>')).toBe(unread === true);
  }
});
