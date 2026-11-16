import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { EndKind, OrderDetail } from '@api';
import { RunPage } from './RunPage';
import { useOrder } from '@/lib/queries';

vi.mock('@/lib/queries', () => ({
  useProjectId: () => 'demo',
  useOrder: vi.fn(),
}));
vi.mock('@/components/LogViewer', () => ({
  LogViewer: () => createElement('div', null, 'log-viewer'),
}));
vi.mock('@/components/MessageBox', () => ({
  MessageBox: () => createElement('div', null, 'message-box'),
}));

function makeDetail(kind: EndKind, detail: string, wipRef?: string): OrderDetail {
  return {
    project: 'demo',
    tag: 'ORD1',
    stage: kind === 'report' ? 'awaiting-review' : 'failed',
    why: detail,
    order: { tag: 'ORD1', title: 'Test order', kind: 'sim', needs: [], created: '2026-11-16T00:00:00Z', updated: '2026-11-16T00:05:00Z' },
    runs: [{
      id: 'r1',
      key: 'ORD1:r1',
      seq: 1,
      worker: 'codex-a',
      started: '2026-11-16T00:00:00Z',
      ended: '2026-11-16T00:05:00Z',
      outcome: kind === 'report' ? 'completed' : 'failed',
      imported: false,
      hasLog: false,
      usage: { source: 'unknown' },
      end: {
        kind,
        detail,
        why: detail,
        ...(wipRef ? { wip_ref: wipRef, wip_files: 3 } : {}),
      },
    }],
    reports: [],
    actions: { allowed: [], unavailable: {} },
    actionHistory: [],
    pendingNotes: [],
    leases: [],
    questions: [],
    quotes: [],
    events: [],
  } as unknown as OrderDetail;
}

function renderRun(): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/p/demo/orders/ORD1/runs/r1'] },
      createElement(Routes, null, createElement(Route, { path: '/p/:project/orders/:tag/runs/:runId', element: createElement(RunPage) })),
    ),
  );
}

it('shows a silent-end banner with detail and WIP ref for all four silent kinds', () => {
  const silentKinds: EndKind[] = ['stream-cut-mid-turn', 'vanished', 'output-limit', 'context-limit'];
  for (const kind of silentKinds) {
    vi.mocked(useOrder).mockReturnValue({
      isError: false,
      data: makeDetail(kind, `stopped with ${kind}`, 'refs/alba/wip/ORD1-r1'),
    } as ReturnType<typeof useOrder>);
    const html = renderRun();
    expect(html).toContain('role="alert"');
    expect(html).toContain('Silent end');
    expect(html).toContain(kind);
    expect(html).toContain(`stopped with ${kind}`);
    expect(html).toContain('refs/alba/wip/ORD1-r1');
    expect(html).toContain('git show --stat refs/alba/wip/ORD1-r1');
  }
});

it('does not show the silent-end banner for report or nonzero-exit runs', () => {
  for (const kind of ['report', 'nonzero-exit'] as EndKind[]) {
    vi.mocked(useOrder).mockReturnValue({
      isError: false,
      data: makeDetail(kind, `ended as ${kind}`),
    } as ReturnType<typeof useOrder>);
    const html = renderRun();
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('Silent end');
  }
});
