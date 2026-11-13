import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import type { ProducerSession } from '@api';
import { ProducerConversation } from './ProducerConversation';
import { setLang } from '@/i18n';

const turns: ProducerSession['turns'] = [{
  number: 1, at: '2026-01-01T10:00:00Z',
  sent: { kind: 'cards', cards: [{ key: 'delivery/Q1', trigger: 'delivery', revision: 2 }] },
  answer: '<script>untrusted</script>',
  tools: [{ id: 'read', name: 'producer_read', input: '{"kind":"cases"}', result: 'One delivery' }, { id: 'act', name: 'producer_act', input: '{}', error: 'Gate refused' }],
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
}, {
  number: 2, at: '2026-01-01T10:05:00Z', sent: { kind: 'handoff', note: 'Continue from durable notes.' }, answer: 'Latest answer', tools: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
}];
afterEach(() => setLang('en'));

it('renders sent chips, escaped replies, tool results/errors and tokens in chronological order', () => {
  setLang('en');
  const html = renderToStaticMarkup(createElement(ProducerConversation, { turns }));
  expect(html).toContain('delivery/Q1');
  expect(html).toContain('delivery · r2');
  expect(html).toContain('&lt;script&gt;untrusted&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('producer_read');
  expect(html).toContain('One delivery');
  expect(html).toContain('Tool error: Gate refused');
  expect(html).toContain('120 tokens');
  expect(html.indexOf('Turn 1')).toBeLessThan(html.indexOf('Turn 2'));
  expect(html).toContain('Continue from durable notes.');
});

it('shows Chinese labels and the empty conversation state', () => {
  setLang('zh');
  const html = renderToStaticMarkup(createElement(ProducerConversation, { turns }));
  expect(html).toContain(translated["Session conversation"]);
  expect(html).toContain(translated['Turn {number}'].replace('{number}', '1'));
  expect(html).toContain(translated["Sent to session"]);
  expect(html).toContain(translated["Producer reply"]);
  expect(html).toContain(translated['{count} tokens'].replace('{count}', '120'));
  expect(renderToStaticMarkup(createElement(ProducerConversation))).toContain(translated["No session turns yet."]);
});
