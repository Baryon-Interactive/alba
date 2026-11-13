import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProducerPage } from './ProducerPage';
import { ProducerAnalysis } from './ProducerAnalysis';
import { RoutingFacts } from '@/components/ProducerFacts';
import { producerFactsFixture } from '../../../test/fixtures/producer-facts';
import { useProducerWorkspace, useProducerAnalysis, useProducerInsights, useProducer, useProducerAction, useProducerPause } from '@/lib/queries';
import { setLang } from '@/i18n';
import { ProducerConstraints } from '@/components/ProducerConstraints';
import { FlowFacts } from '@/components/ProducerFacts';

vi.mock('@/lib/queries', () => ({ useProjectId: () => 'demo', useProducerLog: () => ({}), useProducerWorkspace: vi.fn(), useProducerAnalysis: vi.fn(), useProducerInsights: vi.fn(), useProducer: vi.fn(), useProducerAction: vi.fn(), useProducerPause: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: {} }));
const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProducerAnalysis, { project: 'demo' })));
beforeEach(() => { setLang('en'); vi.mocked(useProducer).mockReturnValue({ data: { cases: [] } } as unknown as ReturnType<typeof useProducer>); vi.mocked(useProducerInsights).mockReturnValue({ data: { project: 'demo', trust: [], briefs: [] } } as unknown as ReturnType<typeof useProducerInsights>); });
afterEach(() => setLang('en'));
it('renders stored fixture facts in section order and defers order-event reads', () => {
  vi.mocked(useProducerAnalysis).mockReturnValue({ data: { project: 'demo', snapshot: producerFactsFixture().snapshot } } as ReturnType<typeof useProducerAnalysis>);
  const html = render();
  const names = ['Constraint now', 'Goal', 'Flow', 'Rule agreement', 'Dispatch results', 'Brief history', 'Order events'];
  expect(names.map(n => html.indexOf(n))).toEqual(names.map(n => html.indexOf(n)).sort((a, b) => a - b));
  for (const text of ['Slot occupancy', 'Non-ready report causes', 'Cumulative flow', 'Open item age', 'unclassified', 'Fewer than five decided orders', '1008 samples']) expect(html).toContain(text);
  expect(html).not.toContain('<details open');
  expect(useProducer).toHaveBeenCalledWith('demo');
  expect(html).toContain('aria-label="Cumulative flow');
  expect(html).toContain('Risk register');
  expect(html).toContain('Standard responses');
  expect(html).toContain('F:constraint.queue.stopped.share.7d');
  expect(html).toContain('Evidence (');
  if (process.env.ALBA_FACTS_EVIDENCE === '1') {
    const dir = path.resolve('../.alba/producer-facts');
    mkdirSync(dir, { recursive: true });
    const assets = path.resolve('dist/assets');
    const css = readdirSync(assets).filter(f => f.endsWith('.css')).map(f => readFileSync(path.join(assets, f), 'utf8')).join('\n');
    const snapshot = producerFactsFixture().snapshot;
    writeFileSync(path.join(dir, 'page.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Producer facts fixture</title><style>${css}</style><body><main style="padding:32px">${html}</main></body></html>`);
    writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    writeFileSync(path.join(dir, 'fact-ids.txt'), snapshot.facts.map(f => f.id).join('\n') + '\n');
  }
});
it('renders the producer page, metrics, constraint and risks in Chinese', () => {
  setLang('zh');
  vi.mocked(useProducerAnalysis).mockReturnValue({ data: { project: 'demo', snapshot: producerFactsFixture().snapshot } } as ReturnType<typeof useProducerAnalysis>);
  const html = render();
  for (const text of [translated["Constraint now"], translated['Risk register ({count})'].split('{count}')[0].slice(0, -1), translated["Standard responses"], translated['Evidence ({count})'].split('{count}')[0].slice(0, -1), translated["Slot occupancy"], translated["Non-ready report causes"], translated["Cumulative flow"], translated['Open item age against kind p85'], translated["Dispatch results"], translated["Order events"], ...translated['First seen {first} · Last seen {last}'].replace('{first}', '').replace('{last}', '').split(' · ').map(s => s.trim()), translated['{count} samples'].replace('{count}', '1008'), translated['{cap} · cap {limit}'].split(' · ')[1].replace('{limit}', '').trim()]) expect(html).toContain(text);
  for (const text of ['Constraint now', 'Slot occupancy', 'Non-ready report causes', 'Cumulative flow', 'First seen', 'Standard responses', 'Comparisons are hidden']) expect(html).not.toContain(text);
  expect(html).toContain('F:constraint.queue.stopped.share.7d');
  expect(html).toContain('F:cause.environment.7d');
});
it('shows two candidates without a clear constraint and escapes failure text', () => {
  const snapshot = producerFactsFixture().snapshot;
  snapshot.analysis!.constraint.type = 'none';
  snapshot.analysis!.constraint.title = 'no clear constraint';
  snapshot.analysis!.constraint.candidates.push({ ...snapshot.analysis!.constraint.candidates[0], id: 'cause:environment', type: 'cause' });
  snapshot.analysis!.risks.push({ id: 'failure:test', type: 'failure', title: '<script>failure</script>', firstSeen: snapshot.at, lastSeen: snapshot.at, count: 2, factIds: ['F:cause.environment.7d'] });
  const html = renderToStaticMarkup(createElement(ProducerConstraints, { snapshot }));
  expect(html).toContain('no clear constraint');
  expect(html.match(/Candidate:/g)).toHaveLength(2);
  expect(html).toContain('&lt;script&gt;failure&lt;/script&gt;');
  expect(html).not.toContain('<script>');
});
it('hides zero or missing p85 ratios in older stored snapshots', () => {
  const snapshot = producerFactsFixture().snapshot;
  snapshot.windows['7d'].aging = [{ tag: 'C1', kind: '', stage: 'queued', hours: 100, p85: 0, ratio: 14600056.7 }];
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(FlowFacts, { snapshot, project: 'demo' })));
  expect(html).toContain('100h');
  expect(html).not.toContain('1,460');
  expect(html).toContain('<td>—</td>');
});
it('renders a pre-tick empty state and fetch errors', () => {
  vi.mocked(useProducerAnalysis).mockReturnValue({ data: { project: 'demo', snapshot: null } } as ReturnType<typeof useProducerAnalysis>);
  expect(render()).toContain('Facts will appear after the first tick.');
  vi.mocked(useProducerAnalysis).mockReturnValue({ isError: true, error: new Error('fixture failure') } as ReturnType<typeof useProducerAnalysis>);
  expect(render()).toContain('fixture failure');
});
it('shows project and order notes, low disk space and the applied clean plan without reading event history', () => {
  vi.mocked(useProducer).mockClear();
  const data: import('@api').ProducerFacts = { project: 'demo', snapshot: null,
    notes: { project: 'Project fixture facts', orders: [{ tag: 'DEMO', text: 'Order fixture facts' }] },
    drives: [{ path: '.', min_free_gb: 10, free_gb: 2, low: true }],
    lastClean: { project: 'demo', at: '2026-01-01T00:00:00Z', errors: [], items: [{ kind: 'log', pathClass: 'logs', path: 'state/runs/old.log', action: 'delete', reason: 'Old run log', targets: [], links: 0, bytes: 1024, result: 'deleted' }] },
  };
  vi.mocked(useProducerAnalysis).mockReturnValue({ data } as ReturnType<typeof useProducerAnalysis>);
  const html = render();
  for (const text of ['Project fixture facts', 'Order fixture facts', '2.0 GB free', 'minimum 10 GB', 'Last clean', 'state/runs/old.log', 'logs', 'deleted']) expect(html).toContain(text);
  expect(html).toContain('/p/demo/orders/DEMO');
  expect(useProducer).toHaveBeenCalledWith('demo');
});
it('opens activity when nothing is pending and defers all analysis reads', () => {
  vi.mocked(useProducerAnalysis).mockClear();
  vi.mocked(useProducerInsights).mockClear();
  vi.mocked(useProducerWorkspace).mockReturnValue({ data: undefined } as ReturnType<typeof useProducerWorkspace>);
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProducerPage)));
  expect(html).toContain('data-workspace="producer"'); expect(html).toContain('min-h-0');
  expect(html).toContain('aria-selected="true"'); expect(html).toContain('Analysis');
  expect(useProducerAnalysis).not.toHaveBeenCalled();
  expect(useProducerInsights).not.toHaveBeenCalled();
});
it('opens order events and closed cases when following a disagreement link', () => {
  vi.mocked(useProducerAnalysis).mockReturnValue({ data: { project: 'demo', snapshot: null } } as ReturnType<typeof useProducerAnalysis>);
  vi.mocked(useProducerAction).mockReturnValue({} as ReturnType<typeof useProducerAction>);
  vi.mocked(useProducerPause).mockReturnValue({} as ReturnType<typeof useProducerPause>);
  vi.mocked(useProducer).mockReturnValue({ data: { enabled: true, paused: false, policy: { rules: [], budgets: {} }, cases: [{ id: 'past-case', facts: {}, status: 'closed', trigger: 'delivery', updatedAt: '2026-01-03T00:00:00Z', card: { summary: 'Past disagreement', pointers: [], untrusted: [] } }], actions: [], wouldDo: [] } } as unknown as ReturnType<typeof useProducer>);
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/p/demo/producer#past-case'] }, createElement(ProducerAnalysis, { project: 'demo' })));
  expect(html).toContain('open=""');
  expect(html).toContain('id="past-case"');
  expect(html).toContain('Past disagreement');
});
it('shows comparisons only when the snapshot marks the sample sufficient', () => {
  const snapshot = producerFactsFixture().snapshot;
  snapshot.windows['7d'].routing[0].comparable = true;
  const html = renderToStaticMarkup(createElement(RoutingFacts, { snapshot }));
  expect(html).toContain('50%');
  expect(html).not.toContain('Fewer than five decided');
});
