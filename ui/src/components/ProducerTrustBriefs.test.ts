import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { ProducerTrust, ProducerBriefHistory } from './ProducerTrustBriefs';
import { setLang } from '@/i18n';
import { fixtureBrief, trustSuggestionFixture } from '../../../test/fixtures/producer-trust-briefs';

afterEach(() => setLang('en'));
it('shows eleven of twelve as a raise suggestion, three cases as insufficient, and disagreement links', () => {
  setLang('en');
  const trust = trustSuggestionFixture();
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProducerTrust, { project: 'fixture', trust })));
  for (const text of ['92%', '12 decided cases', 'not enough cases', '3 decided cases', 'raise rule review from propose to auto', 'mode: auto', 'Last disagreements', '/orders/sample', 'agreement']) expect(html).toContain(text);
  expect(html).not.toContain('<button');
});
it('renders escaped brief text, immutable evidence and Chinese trust labels', () => {
  setLang('zh');
  const brief = fixtureBrief('zh'); brief.text += '\n<script>untrusted</script>';
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement('div', null, createElement(ProducerTrust, { project: 'fixture', trust: trustSuggestionFixture() }), createElement(ProducerBriefHistory, { briefs: [brief] }))));
  for (const text of [translated["Rule agreement"], translated["not enough cases"], translated["agreement.accepted"], translated["Brief evidence"], brief.text.split('\n').find(line => line.includes(': 1 '))!.split(' [')[0], 'F:brief.changes.merged', '&lt;script&gt;untrusted&lt;/script&gt;']) expect(html).toContain(text);
  expect(html).not.toContain('<script>');
});
