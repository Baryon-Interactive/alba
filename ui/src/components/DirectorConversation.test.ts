import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProducerChatView } from '@api';
import { DirectorThread } from './DirectorConversation';
import { setLang } from '@/i18n';
import { MemoryRouter } from 'react-router';
import { ProducerCards } from './ProducerCards';

vi.mock('@/lib/api', () => ({ api: {} }));

const data: ProducerChatView = {
  messages: [{ id: 'chat', at: '', text: 'Repair the build first <script>', answer: 'Confirm the direction', status: 'done', warnings: ['Unknown fact id: F:missing'] }, { id: 'error', at: '', text: 'Retry', answer: '', status: 'error', error: 'Model timed out', warnings: [] }],
  direction: { version: 0, at: '', priorities: '', stop: '', constraints: '', notes: '' },
  directionProposals: [{ id: 'direction', messageId: 'chat', baseVersion: 0, status: 'proposed', direction: { priorities: 'Repair the build', stop: 'Visual changes', constraints: 'Preserve quota', notes: 'Discussed' } }],
  actions: [{ id: 'draft', messageId: 'chat', caseId: 'case', caseRevision: 1, idempotencyKey: '', kind: 'add-order', status: 'would-do', mode: 'observe', ruleId: 'default', policyHash: '', policyVersion: '', at: '', order: { tag: 'BUILD', title: 'Fix builds', kind: 'tooling', needs: ['BASE'], body: '## Acceptance\nClean build passes.' } }, { id: 'auto', messageId: 'chat', caseId: 'case', caseRevision: 1, idempotencyKey: '', kind: 'note', status: 'done', mode: 'auto', ruleId: 'notes', policyHash: '', policyVersion: '', at: '', result: 'Recorded note' }],
};
afterEach(() => setLang('en'));
it('renders escaped director text, errors, retry and folded citation warnings', () => {
  setLang('en');
  const html = renderToStaticMarkup(createElement(DirectorThread, { data }));
  expect(html).toContain('Repair the build first &lt;script&gt;'); expect(html).not.toContain('<script>');
  expect(html).toContain('Model timed out'); expect(html).toContain('Unknown fact id');
  expect(html).toContain('1 numbers without a fact id'); expect(html).not.toContain('<details open');
  expect(html).toContain('Retry'); expect(html).not.toContain('Clean build passes.');
});
it('renders compact Chinese proposal cards and disables decisions while submitting', () => {
  setLang('zh');
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProducerCards, { project: 'demo', data, busy: true })));
  expect(html).toContain(translated["Standing direction"]); expect(html).toContain('disabled');
  expect(html).toContain('Clean build passes.'); expect(html).toContain('BASE');
  expect(html.match(new RegExp('>' + translated['Accept'] + '<', 'g'))).toHaveLength(2); expect(html.match(new RegExp('>' + translated['Reject'] + '<', 'g'))).toHaveLength(2);
});
it.each(['A person acted on this order.', 'The order changed stage.', 'A newer run started.'])('removes decisions on superseded cards: %s', reason => {
  setLang('en');
  const superseded = { ...data, directionProposals: [], actions: [{ ...data.actions[0], status: 'superseded' as const, supersededReason: reason }] };
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProducerCards, { project: 'demo', data: superseded })));
  expect(html).toContain('opacity-60'); expect(html).toContain(reason);
  expect(html).not.toContain('>Accept<'); expect(html).not.toContain('checkbox');
});
