import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProducerWorkspace } from '@api';
import { ProducerMessage } from './ProducerMessage';
import { DirectorConversation } from './DirectorConversation';
import { setLang } from '@/i18n';

vi.mock('@/lib/api', () => ({ api: {} }));
afterEach(() => setLang('en'));
it('renders GFM, project tag links and fact hover values while leaving code alone', () => {
  const answer = '**Ready** DEMO7 F:queue.ready\n\n| state | count |\n|---|---|\n| ready | 4 |\n\n- next step\n\n`DEMO8`\n\n```ts\nconst n = 42;\n```';
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProducerMessage, { answer, project: 'demo', tagPattern: 'DEMO\\d+', facts: { 'F:queue.ready': '4 orders' } })));
  expect(html).toContain('<strong>Ready</strong>'); expect(html).toContain('<table>'); expect(html).toContain('<li>next step</li>');
  expect(html).toContain('href="/p/demo/orders/DEMO7"'); expect(html).toContain('title="4 orders"');
  expect(html).toContain('<code>DEMO8</code>'); expect(html).not.toContain('orders/DEMO8'); expect(html).toContain('language-ts');
});
it('folds narration and tool arguments/results above the answer and shows one live line', () => {
  setLang('en');
  const html = renderToStaticMarkup(createElement(ProducerMessage, { answer: 'Final answer', narration: ['Reading another page…'], running: true, tools: [{ id: 'tool', name: 'producer_read', input: '{"page":3}', result: '20 orders' }] }));
  expect(html).toContain('Steps (1 tool calls)'); expect(html).not.toContain('<details open');
  expect(html.indexOf('Reading another page')).toBeLessThan(html.indexOf('Final answer'));
  expect(html).toContain('role="status"'); expect(html).toContain('20 orders');
});
it.each([1600, 1280, 1000])('keeps independently scrolling panes and pinned composer at %i px', width => {
  setLang('en');
  const workspace: ProducerWorkspace = { project: 'demo', messages: [], actions: [], directionProposals: [], direction: { version: 0, at: '', priorities: '', stop: '', constraints: '', notes: '' }, enabled: true, paused: false, session: { state: 'running', active: false, turns: 3, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }, daily: { turns: 2, tokens: 20 }, rules: [], tagPattern: 'DEMO\\d+', constraint: null, facts: [], questions: [] };
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement('div', { style: { width } }, createElement(DirectorConversation, { project: 'demo', workspace, refresh: () => {}, analysis: () => {} }))));
  expect(html).toContain('producer-workspace min-h-0 flex-1'); expect(html).toContain('producer-rail min-h-0 overflow-y-auto');
  expect(html).toContain('min-h-0 flex-1 overflow-y-auto'); expect(html).toContain('shrink-0 border-t bg-card');
  expect(html).toContain('id="director-message"'); expect(html).toContain('Needs you'); expect(html).toContain('>idle<');
  expect(html.indexOf('id="director-message"')).toBeGreaterThan(html.indexOf('aria-label="Director conversation"'));
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  expect(css).toContain('.producer-workspace'); expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
  expect(css).toContain('@media (max-width: 1099px)');
  if (width < 1100) expect(css).toContain('grid-template-rows: minmax(0, 32%) minmax(0, 1fr)');
});
