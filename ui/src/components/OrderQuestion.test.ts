import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { OrderSummary } from '@api';
import { AnswerForm, OrderQuestion } from './OrderQuestion';
import { refreshWhilePeeking } from './RunPeek';
import { setLang } from '@/i18n';

const { act, choose } = vi.hoisted(() => ({ act: vi.fn(), choose: vi.fn() }));
vi.mock('@/lib/queries', () => ({ useAct: () => ({ mutateAsync: act }) }));
vi.mock('./OptionsPicker', () => ({ OptionsPicker: (props: { submit: (choice: number, note: string) => Promise<unknown> }) => { choose.mockImplementation(props.submit); return null; } }));

const order: OrderSummary = { project: 'demo', tag: 'T1', title: 'Colors', stage: 'awaiting-user', why: '', kind: '', updated: '', needs: [], actions: ['answer'],
  waitingQuestion: { text: 'Which palette?', options: [{ key: '1', label: 'Warm', images: [], recommended: true }] } };

it('shows the first unanswered text with its full title and opens the shared answer path', async () => {
  setLang('en');
  const o = { ...order, unanswered: [{ id: 'q1', at: '', kind: 'question' as const, text: 'Which size?' }] };
  const row = renderToStaticMarkup(createElement(OrderQuestion, { project: 'demo', o }));
  expect(row).toContain('title="Which size?"');
  expect(row).toContain('>Answer</button>');
  renderToStaticMarkup(createElement(AnswerForm, { project: 'demo', o: order }));
  await choose(1, 'Warm tones');
  expect(act).toHaveBeenCalledWith({ tag: 'T1', action: 'answer', choice: 1, text: 'Warm tones' });
});

it('refreshes an open Peek every five seconds and releases its timer on close', () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn();
    const close = refreshWhilePeeking(read);
    vi.advanceTimersByTime(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    close();
    vi.advanceTimersByTime(5_000);
    expect(read).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
