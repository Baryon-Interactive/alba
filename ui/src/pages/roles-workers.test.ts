import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLang } from '@/i18n';
import { RolesPage } from './RolesPage';
import { WorkersPage } from './WorkersPage';

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
  errorText: String,
}));

beforeAll(() => setLang('en'));
describe('worker and role pages', () => {
  it('renders job definitions, viewable rules, eligibility reasons and results on Roles', () => {
    const html = renderToStaticMarkup(createElement(RolesPage));
    for (const text of ['Roles', 'visual', 'Kinds', 'Requires', 'vision', 'drawing', 'image', 'rules/visual.md', 'Inspect silhouettes.', 'Qualifying now', 'vision-worker', 'missing capabilities: vision', 'not enough runs']) expect(html).toContain(text);
    expect(html.indexOf('vision-worker')).toBeLessThan(html.indexOf('backup'));
  });
  it('renders supply on Workers without job definitions, profiles, fits or job yield', () => {
    const html = renderToStaticMarkup(createElement(WorkersPage));
    for (const text of ['Workers', 'codex-cli', 'example-model', 'local route', 'Capabilities', 'vision', 'Weekly quota reset', 'Running']) expect(html).toContain(text);
    for (const text of ['Role definitions', 'Prefer (in order)', 'Accepted without rework', 'Profile', 'Fits']) expect(html).not.toContain(text);
  });
});
