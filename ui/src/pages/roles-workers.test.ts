import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLang } from '@/i18n';
import { RolesPage } from './RolesPage';
import { WorkersPage } from './WorkersPage';
import { RoleDetails, WorkerGroups } from '@/components/Roles';
import { testTranslations as translated } from '../test-translations';

vi.mock('@/lib/api', () => ({ api: {}, ApiFailure: class extends Error {} }));
vi.mock('@/lib/queries', () => ({
  useProjectId: () => 'demo',
  useRoles: () => ({ data: { roles: [{ id: 'visual', kinds: ['art'], requires: ['vision'], skills: ['drawing'], mcp: { image: {} }, rules: 'rules/visual.md', rulesText: 'Inspect silhouettes.', workers: { prefer: ['vision-worker', 'backup'], avoid: ['text-worker'] }, qualifying: ['vision-worker'], candidates: [{ worker: 'vision-worker', verdict: 'chosen', reason: 'role preference 1' }, { worker: 'text-worker', verdict: 'unfit', reason: 'missing capabilities: vision' }], results: [] }] } }),
  useWorkers: () => ({ data: { workers: [{ id: 'vision-worker', engine: 'codex-cli', model: 'example-model', route: 'local route', capabilities: ['vision', 'shell'], notes: 'Weekly quota reset', paid: false, cost: 'included', enabled: true, concurrency: 2, running: 0, runsToday: 0, spendTodayUsd: 0, available: true, reasons: [], aliases: [], sharesQuotaWith: [], sameModelAs: [], disabledWhen: [], hasLaunch: true, onLimit: 'wait' }], sources: [] } }),
  useCredits: () => ({ data: { items: [] } }),
  useResources: () => ({ data: { resources: [] } }),
  useReleaseLease: () => ({}),
  useProjects: () => ({ data: [] }),
  useUsage: () => ({}),
  useSetRole: () => ({}),
  useEditWorker: () => ({}),
  useNewWorker: () => ({}),
  useWorkerYaml: () => ({}),
  useRemoveWorker: () => ({}),
  useConfig: () => ({}),
  useEditConfig: () => ({}),
  useRoutingMigration: () => ({}),
  errorText: String,
}));

beforeAll(() => setLang('en'));
describe('worker and role pages', () => {
  it("renders routes (and an earlier role's skills, MCP servers and rules), eligibility reasons and results on Routing", () => {
    const html = renderToStaticMarkup(createElement(RolesPage));
    for (const text of ['Routing', 'Routes', 'visual', 'Kinds', 'Requires', 'vision', 'drawing', 'image', 'rules/visual.md', 'Inspect silhouettes.', 'Qualifying now', 'vision-worker', 'missing capabilities: vision', 'not enough runs']) expect(html).toContain(text);
    expect(html.indexOf('vision-worker')).toBeLessThan(html.indexOf('backup'));
  });
  it('renders supply on Workers without job definitions, profiles, fits or job yield', () => {
    const html = renderToStaticMarkup(createElement(WorkersPage));
    for (const text of ['Workers', 'codex-cli', 'example-model', 'local route', 'Capabilities', 'vision', 'Weekly quota reset', 'Running']) expect(html).toContain(text);
    for (const text of ['Role definitions', 'Prefer (in order)', 'Worker groups', 'Accepted without rework', 'Profile', 'Fits']) expect(html).not.toContain(text);
  });
  it('shows worker groups in order with "anyone else", and a route by its group in English and Chinese', () => {
    const groups = [{ name: 'main', list: ['codex', 'sonnet'], members: ['codex', 'sonnet'], routes: ['ue', 'default'], source: 'workers' as const }, { name: 'cheap', list: ['grok', '*'], members: ['grok', '*'], routes: [], source: 'project' as const }];
    const route = { id: 'ue', kinds: ['ue'], group: 'main', workers: { prefer: ['codex', 'sonnet'], only: ['codex', 'sonnet'], avoid: ['opus'] }, sources: {}, qualifying: ['codex'], candidates: [], results: [] };
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      const html = renderToStaticMarkup(createElement('div', null, createElement(WorkerGroups, { groups }), createElement(RoleDetails, { r: route })));
      const en = lang === 'en';
      expect(html).toContain(en ? 'Worker groups' : translated['Worker groups']);
      expect(html.indexOf('>codex<')).toBeLessThan(html.indexOf('>sonnet<'));
      expect(html).toContain(en ? 'anyone else' : translated['anyone else']);
      expect(html).toContain(en ? 'Used by ue, default' : translated['Used by {routes}'].replace('{routes}', 'ue, default'));
      expect(html).toContain(en ? 'No route uses it' : translated['No route uses it']);
      expect(html).toContain(en ? 'Worker group main, in order' : translated['Worker group {group}, in order'].replace('{group}', 'main'));
      expect(html).toContain('opus');
      expect(html).not.toContain(en ? 'Prefer (in order)' : translated['Prefer (in order)']);
    }
    setLang('en');
  });
});
