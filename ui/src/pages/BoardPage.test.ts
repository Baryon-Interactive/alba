import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { SplitOrders } from '@/components/SplitOrders';
import { setLang } from '@/i18n';
import type { OrderDetail, OrderSummary } from '@api';
import { BoardCard } from './BoardPage';

it('groups children in a collapsed board disclosure and links both directions on order pages', () => {
  const child = { tag: 'CACHE.1', title: 'Storage', stage: 'merged' as const, worker: 'reader', model: 'compact' };
  const children = [child, { ...child, tag: 'CACHE.2', stage: 'queued' as const }];
  const order: OrderSummary = { project: 'demo', tag: 'CACHE', title: 'Cache', stage: 'waiting-children', kind: 'feature', why: '', needs: [], updated: '', actions: [], children };
  const render = (element: React.ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, null, element)));
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang);
    try {
      const board = render(createElement(BoardCard, { project: 'demo', o: order }));
      expect(board).toMatch(/<details[^>]*><summary[^>]*>[^<]*1\/2/);
      expect(board).not.toContain('<details open');
      const page = (detail: Partial<OrderDetail>) => render(createElement(SplitOrders, { project: 'demo', detail: detail as OrderDetail }));
      expect(page({ children })).toContain('reader / compact');
      expect(page({ parent: 'CACHE' })).toContain('href="/p/demo/orders/CACHE"');
      const split = { report: 2, pending: true, subtasks: [{ key: 'store', kind: 'task', title: 'Storage', body: 'Sample acceptance' }] };
      expect(page({ order: { tag: 'CACHE' } as OrderDetail['order'], split })).toContain('Sample acceptance');
      expect(page({})).toBe('');
    } finally { setLang('en'); }
  }
});

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
