import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConfigView, OrderDetail } from '@api';
import { setLang } from '@/i18n';
import { RolesPage } from './RolesPage';
import { ConfigPanelBody, DispatchSettings, JsonSettings, ResourceSettings, SkillSettings } from '@/components/ConfigSections';
import { WorkersPage } from './WorkersPage';
import { OrderDefinitionEdit, orderFieldChanges, formOfOrder } from '@/components/OrderEdit';
import { testTranslations as translated } from '../test-translations';

const idle = { mutate: () => undefined, reset: () => undefined, isPending: false, isError: false, error: null };
const state = vi.hoisted(() => ({ project: undefined as unknown, workers: undefined as unknown, migration: { files: [] as unknown[] } }));
vi.mock('@/lib/api', () => ({ api: {}, ApiFailure: class extends Error { status = 0; } }));
vi.mock('@/lib/queries', () => ({
  useProjectId: () => 'demo',
  useConfig: (_p: string, target: string) => ({ data: target === 'project' ? state.project : state.workers, isPending: false, isError: false }),
  useRoutingMigration: () => ({ data: state.migration }),
  useEditConfig: () => idle,
  useEditOrderFields: () => idle,
  useEditOrderBody: () => idle,
  useRemoveWorker: () => idle,
  useWorkers: () => ({ data: { workers: [{ id: 'codex', capabilities: ['vision'], engine: 'codex-cli', enabled: true, available: true, reasons: [], running: 0, concurrency: 1, runsToday: 0, spendTodayUsd: 0, aliases: [], sharesQuotaWith: [], sameModelAs: [], disabledWhen: [], hasLaunch: true, onLimit: 'wait', cost: 'included', paid: false }, { id: 'grok', capabilities: [], engine: 'x', enabled: true, available: true, reasons: [], running: 0, concurrency: 1, runsToday: 0, spendTodayUsd: 0, aliases: [], sharesQuotaWith: [], sameModelAs: [], disabledWhen: [], hasLaunch: true, onLimit: 'wait', cost: 'included', paid: false }], sources: [] } }),
  useOrders: () => ({ data: { items: [{ tag: 'A1' }, { tag: 'B2' }] } }),
  useResources: () => ({ data: { resources: [{ name: 'gpu', slots: 1, used: 0, leases: [], exclusive: false, blocks: [] }] } }),
  useSkills: () => ({ data: { skills: [{ name: 'drawing' }] } }),
  useCredits: () => ({ data: { items: [] } }),
  useReleaseLease: () => ({}),
  useProjects: () => ({ data: [] }),
  useUsage: () => ({}),
  useEditWorker: () => idle,
  useNewWorker: () => idle,
  useWorkerYaml: () => ({}),
  useQuotaHistory: () => ({}),
  errorText: String,
}));

const projectView = (values: Record<string, unknown>): ConfigView => ({ project: 'demo', target: 'project', file: 'alba.yaml', values, editable: [] });
const workersView = (values: Record<string, unknown>): ConfigView => ({ project: 'demo', target: 'workers', file: 'workers.yaml', values, editable: [] });
const tr = (lang: 'en' | 'zh', text: string, vars: Record<string, string> = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), lang === 'en' ? text : translated[text] ?? text);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

afterEach(() => { setLang('en'); state.project = undefined; state.workers = undefined; state.migration = { files: [] }; });

describe('the Routing page in edit mode', () => {
  it('edits the groups and routes of each file in English and Chinese: members in order, "anyone else", a group in use cannot be deleted', () => {
    state.project = projectView({ routing: { routes: { art: { kinds: ['art'], group: 'cheap', avoid: ['codex'] } } } });
    state.workers = workersView({ routing: { groups: { main: ['codex', 'grok', '*'], cheap: ['grok'], spare: ['codex'] }, routes: { ui: { kinds: ['ui'], requires: ['vision'], group: 'main', description: 'Screens' } }, default: 'main' } });
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      const html = renderToStaticMarkup(createElement(RolesPage, { editing: true }));
      for (const text of ['Project file', 'Workers file', 'Worker groups', 'Routes', 'Add a group', 'Add a route', 'Then anyone else', 'Default route: takes every kind no other route takes', 'Group of the orders no route takes', 'Done']) expect(html, text).toContain(esc(tr(lang, text)));
      expect(html.indexOf('>codex<')).toBeLessThan(html.indexOf('>grok<'));
      for (const value of ['alba.yaml', 'workers.yaml', 'Screens', 'vision']) expect(html).toContain(value);
      // main is used by ui (and the default group), cheap by a route of the project file: neither can be deleted; spare can
      expect(html).toMatch(new RegExp(`aria-label="${esc(tr(lang, 'Delete group {name}', { name: 'cheap' }))}"[^>]*disabled`));
      expect(html).toMatch(new RegExp(`aria-label="${esc(tr(lang, 'Delete group {name}', { name: 'main' }))}"[^>]*disabled`));
      expect(html).not.toMatch(new RegExp(`aria-label="${esc(tr(lang, 'Delete group {name}', { name: 'spare' }))}"[^>]*disabled`));
      expect(html).toContain(esc(tr(lang, 'Used by {routes}', { routes: 'art' })));
    }
  });

  it('offers to convert a file that still routes with roles', () => {
    state.project = projectView({ roles: { ui: { kinds: ['ui'] } } });
    state.migration = { files: [{ target: 'project', file: 'alba.yaml', routing: { routes: { ui: { kinds: ['ui'] } } }, yaml: 'routing:\n  routes: {}\n', notes: [] }] };
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      const html = renderToStaticMarkup(createElement(RolesPage, { editing: true }));
      expect(html).toContain(esc(tr(lang, 'Convert to routing')));
      expect(html).toContain(esc(tr(lang, 'This file still routes with roles. Convert them to worker groups and routes to edit them here.')));
      expect(html).not.toContain(esc(tr(lang, 'Add a group')));
    }
  });
});

describe('the settings editors on their pages', () => {
  it('show dispatch, resources, skills and the JSON sections with the values of the file, in English and Chinese', () => {
    const own = projectView({ dispatch: { caps: { sim: 2 }, on_loop: 'stop', long_commands: ['cook'] }, resources: { gpu: { slots: 1, exclusive: true, note: 'one card' } }, skills: { always: ['review'], by_kind: { art: ['drawing'] }, max_per_order: 8 }, budget: { currency: 'EUR' } });
    const shared = workersView({ quota_sources: { grok: { command: ['grok', 'usage'] } } });
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      // what the Tick, Workers, Skills, Usage and Clean pages put above their content in edit mode
      const html = [
        createElement(ConfigPanelBody, { view: own }, createElement(DispatchSettings, { project: 'demo', values: own.values })),
        createElement(ConfigPanelBody, { view: own }, createElement(ResourceSettings, { project: 'demo', values: own.values })),
        createElement(ConfigPanelBody, { view: own }, createElement(SkillSettings, { project: 'demo', values: own.values })),
        createElement(JsonSettings, { project: 'demo', view: own, path: ['budget'], title: tr(lang, 'Budget'), description: '' }),
        createElement(JsonSettings, { project: 'demo', view: own, path: ['clean'], title: tr(lang, 'Clean'), description: '' }),
        createElement(ConfigPanelBody, { view: shared }, createElement(JsonSettings, { project: 'demo', view: shared, path: ['quota_sources'], title: tr(lang, 'Quota sources'), description: '' })),
      ].map(e => renderToStaticMarkup(e)).join('');
      for (const text of ['Dispatch', 'Caps by kind', 'When a run loops', 'Long commands', 'Resources', 'Exclusive', 'Skills', 'Every order', 'By kind', 'Budget', 'Clean', 'Quota sources', 'Add a cap', 'Add a resource', 'Save', 'Cancel']) expect(html, text).toContain(esc(tr(lang, text)));
      for (const value of ['value="sim"', 'value="2"', 'cook', 'value="gpu"', 'value="one card"', 'review', 'drawing', 'value="8"', '&quot;currency&quot;: &quot;EUR&quot;', 'grok', 'alba.yaml', 'workers.yaml']) expect(html, value).toContain(value);
      expect(html).toMatch(/<option value="stop" selected="">/);
      expect(html).toContain(esc(tr(lang, 'default {n}', { n: '240' })));
    }
  });
});

describe('the order definition in edit mode', () => {
  const order = { tag: 'A1', title: 'Make the menu', kind: 'ui', needs: ['B2'], tags: ['menu'], uses: ['gpu'], worker: 'codex', review: 'auto', priority: 3, created: '', updated: '' } as OrderDetail['order'];
  it('shows every field with its value, the worker pin with "none", and the review and check choices, in English and Chinese', () => {
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      const html = renderToStaticMarkup(createElement(OrderDefinitionEdit, { project: 'demo', order, onDone: () => undefined }));
      for (const text of ['Title', 'Kind', 'Priority', 'Worker', 'Needs', 'Tags', 'Skills', 'Uses', 'Tools', 'Heavy class', 'Condition', 'Review', 'a person reviews', 'automatic', 'Independent check', 'run it', 'skip it', 'None: the route chooses']) expect(html, text).toContain(esc(tr(lang, text)));
      for (const value of ['value="Make the menu"', 'value="3"', '<option value="codex" selected="">', 'B2', 'menu', 'gpu']) expect(html, value).toContain(value);
    }
  });
  it('sends only the fields that changed, and null to clear one', () => {
    const form = formOfOrder(order);
    expect(orderFieldChanges(order, form)).toEqual({ ok: true, fields: {} });
    expect(orderFieldChanges(order, { ...form, worker: '', priority: '', tags: ['menu', 'ui'], review: 'manual', check: 'none' })).toEqual({ ok: true, fields: { worker: null, priority: null, tags: ['menu', 'ui'], review: 'manual', check: 'none' } });
    expect(orderFieldChanges(order, { ...form, title: ' ' }).ok).toBe(false);
    expect(orderFieldChanges(order, { ...form, priority: '1.5' }).ok).toBe(false);
  });
});

describe('the Workers page', () => {
  it('offers to remove each worker', () => {
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      const html = renderToStaticMarkup(createElement(WorkersPage));
      expect(html).toContain(esc(tr(lang, 'Remove {id}', { id: 'codex' })));
      expect(html).toContain(esc(tr(lang, 'Remove from the workers file')));
    }
  });
});
