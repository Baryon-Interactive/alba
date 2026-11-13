import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProducerLog, ProducerWorkspace } from '@api';
import { ProducerActivityView, ProducerOverviewCard, ProducerNowPanel } from './ProducerActivity';
import { ProducerPage } from '@/pages/ProducerPage';
import { activityDay, activityRows, groupActivity, needsProducerDecision } from '@/lib/producer-activity';
import { useProducerLog, useProducerWorkspace } from '@/lib/queries';
import { setLang } from '@/i18n';

vi.mock('@/lib/queries', () => ({ useProjectId: () => 'demo', useProducerLog: vi.fn(), useProducerWorkspace: vi.fn() }));
vi.mock('@/components/DirectorConversation', () => ({ DirectorConversation: () => createElement('div', null, 'Conversation fixture') }));
const log: ProducerLog = {
  project: 'demo', at: '2026-06-18T01:00:00Z',
  now: { state: 'thinking', since: '2026-06-18T01:00:00Z', lastTurnAt: '2026-06-18T01:00:00Z', nextRoundAt: '2026-06-18T02:00:00Z', cases: [{ key: 'delivery/DEMO1', summary: 'Review synthetic delivery', order: 'DEMO1' }], budgets: [{ key: 'turns_per_hour', used: 3, limit: 10, resetsAt: '2026-06-18T02:00:00Z' }, { key: 'review_runs_per_day', resetsAt: '2026-06-19T00:00:00Z' }] },
  rows: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, at: `2026-06-${i < 4 ? '18' : '17'}T01:0${i}:00Z`, kind: i === 0 ? 'accept' : 'nudge', order: `DEMO${i + 1}`, mode: i === 1 ? 'proposed' : 'auto', status: i === 7 ? 'superseded' : i === 1 ? 'proposed' : i === 2 ? 'failed' : 'done', result: 'Synthetic result', note: '<script>claimed verification</script>\nFull second line', firstLine: '<script>claimed verification</script>', evidence: ['docs/synthetic.md'], claim: i === 0, autonomous: i !== 1 && i !== 7,
    rule: { id: 'review', instruction: 'Inspect stored evidence', policyVersion: 'synthetic-policy' }, ...(i === 0 ? { acceptance: { merge: 'a'.repeat(40), designStep: { status: 'passed', files: ['design/changes/synthetic.json'] } } } : {}),
  })),
};
function render(node: ReturnType<typeof createElement>, route = '/p/demo/producer') { return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [route] }, node)); }
beforeEach(() => { setLang('en'); vi.mocked(useProducerLog).mockReturnValue({ data: log } as ReturnType<typeof useProducerLog>); vi.mocked(useProducerWorkspace).mockReturnValue({ data: undefined } as ReturnType<typeof useProducerWorkspace>); });
afterEach(() => setLang('en'));
it('renders mixed statuses, local days, claim marker, complete notes, evidence, policy and acceptance details safely', () => {
  const html = render(createElement(ProducerActivityView, { log, project: 'demo' }));
  for (const text of ['Now', 'Thinking about', 'Timeline', 'Only things it did on its own', 'Show superseded', 'Full second line', 'docs/synthetic.md', 'Inspect stored evidence', 'synthetic-policy', 'Merge commit', 'Design change-set step', 'passed', 'a'.repeat(40)]) expect(html).toContain(text);
  expect(html).toContain('data-claim="true"');
  expect(html).toContain('/p/demo/orders/DEMO1');
  expect(html).toContain('aria-valuenow="3"');
  expect(html).toContain('Not recorded / No limit');
  expect(html).not.toContain('data-activity-id="a7"');
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  expect((html.match(/data-activity-day=/g) ?? []).length).toBe(2);
});
it('groups around local midnight and daylight saving changes using the requested calendar', () => {
  expect(activityDay('2026-06-18T00:30:00Z', 'America/Los_Angeles')).toBe('2026-06-17');
  expect(activityDay('2026-06-18T00:30:00Z', 'Asia/Shanghai')).toBe('2026-06-18');
  const rows = ['2026-03-08T10:00:00Z', '2026-03-08T09:59:00Z', '2026-03-08T07:59:00Z'].map(at => ({ ...log.rows[0], at }));
  expect(groupActivity(rows, 'America/Los_Angeles').map(g => [g.day, g.rows.length])).toEqual([['2026-03-08', 2], ['2026-03-07', 1]]);
});
it('filters independently and combines filters while keeping superseded hidden by default', () => {
  const filters = { kind: '', order: '', status: '', autonomous: false, superseded: false };
  expect(activityRows(log.rows, filters)).toHaveLength(7);
  expect(activityRows(log.rows, { ...filters, kind: 'accept' })).toHaveLength(1);
  expect(activityRows(log.rows, { ...filters, order: 'DEMO1' })).toHaveLength(1);
  expect(activityRows(log.rows, { ...filters, status: 'failed', autonomous: true })).toEqual([log.rows[2]]);
  expect(activityRows(log.rows, { ...filters, status: 'superseded' })).toEqual([log.rows[7]]);
  expect(activityRows(log.rows, { ...filters, superseded: true })).toHaveLength(8);
});
it('localizes activity, claim explanations and all Now states in Chinese', () => {
  setLang('zh');
  const html = render(createElement(ProducerActivityView, { log, project: 'demo' }));
  for (const text of [translated["Timeline"], translated["claim"], translated["Only things it did on its own"], translated["Next scheduled round"], translated["Full note"], translated["Merge commit"], translated["Design change-set step"], translated["Not recorded"], translated["Session wanted"], translated["Last automatic restart"]]) expect(html).toContain(text);
  expect(html).not.toContain('Thinking about');
  for (const [state, text] of [['paused', translated["paused"]], ['budget-exhausted', translated['Budget exhausted until {time}'].split(/\p{P}/u)[0]], ['idle', translated["Idle"]], ['stopped', translated['Idle · session stopped']], ['error', translated['Session error: {reason}'].split(/\p{P}/u)[0]]] as const) {
    expect(render(createElement(ProducerNowPanel, { project: 'demo', now: { ...log.now, state, until: log.at, reason: 'Paused by a person' } }))).toContain(text);
  }
});
it('overview card has the Now line and exactly five latest rows with an explicit Activity link', () => {
  const html = render(createElement(ProducerOverviewCard, { project: 'demo' }));
  expect(html).toContain('data-producer-now'); expect(html).toContain('data-session-wanted="no"'); expect(html).toContain('Last automatic restart'); expect(html).toContain('/p/demo/producer?tab=activity');
  for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`/p/demo/orders/DEMO${n}`);
  expect(html).not.toContain('/p/demo/orders/DEMO6');
});
it('shows daily usage and cache rates separately for each engine/model in both languages', () => {
  const usageDays = [
    { day: '2026-06-18', engine: 'codex', model: 'sample-router', requests: 2, uncachedInput: 4000, cacheRead: 16000, cacheWrite: 0, output: 1000, cacheHitRate: .8, costUsd: .01, unpricedTokens: 0 },
    { day: '2026-06-18', engine: 'claude', model: 'sample-reviewer', requests: 1, uncachedInput: 8000, cacheRead: 30000, cacheWrite: 2000, output: 2000, cacheHitRate: .75, costUsd: 0, unpricedTokens: 42000 },
  ];
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang);
    const html = render(createElement(ProducerNowPanel, { project: 'demo', now: { ...log.now, usageDays } }));
    for (const text of ['sample-router', 'sample-reviewer', '80.0%', '75.0%', '30,000', '$0.0100']) expect(html).toContain(text);
    expect(html).toContain(lang === 'en' ? 'Unpriced tokens' : translated["Unpriced tokens"]);
  }
});
it('defaults to Activity without decisions, Conversation with decisions, and respects explicit Activity links', () => {
  const selected = (route?: string) => render(createElement(ProducerPage), route).match(/aria-selected="true"[^>]*>([^<]+)/)?.[1];
  expect(selected()).toBe('Activity');
  const workspace = { actions: [{ status: 'proposed' }], questions: [], directionProposals: [] } as unknown as ProducerWorkspace;
  vi.mocked(useProducerWorkspace).mockReturnValue({ data: workspace } as ReturnType<typeof useProducerWorkspace>);
  expect(selected()).toBe('Conversation');
  expect(selected('/p/demo/producer?tab=activity')).toBe('Activity');
  expect(needsProducerDecision({ ...workspace, actions: [], questions: [{ id: 'question', at: log.at, order: 'DEMO1', text: 'Choose a direction' }] })).toBe(true);
});
