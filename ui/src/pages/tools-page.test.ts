import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { PluginsView, PluginView } from '@api';
import { setLang } from '@/i18n';
import { ToolsBody } from './ToolsPage';
import { testTranslations as translated } from '../test-translations';

const idle = { mutate: () => undefined, reset: () => undefined, isPending: false, isError: false, error: null };
vi.mock('@/lib/api', () => ({ api: {}, ApiFailure: class extends Error { status = 0; } }));
vi.mock('@/lib/queries', () => ({
  useProjectId: () => 'demo',
  useEditConfig: () => idle,
  usePluginDoctor: () => idle,
  usePlugins: () => ({}),
  useConfig: () => ({}),
  errorText: String,
}));

const tool = (id: string, patch: Partial<PluginView>): PluginView => ({
  id, version: '1.0.0', description: `${id} does things`, origin: 'built-in', enabled: false, folder: `/alba/plugins/${id}`, settings: [], servers: [], resources: [], operations: [], kinds: [], problems: [], ...patch,
});
const view: PluginsView = {
  project: 'demo', file: '/studio/alba.yaml', enable: ['image-gateway', 'tripo-3d'], by_kind: { art: ['image-gateway'] }, units: ['credits', 'images'], problems: [], jobCount: 41,
  tools: [
    tool('example-echo', { servers: [{ name: 'echo', command: 'node', args: ['/alba/plugins/example-echo/server.mjs'], tools: ['echo'], workers: true, env: [] }] }),
    tool('image-gateway', {
      enabled: true, kinds: ['art'],
      settings: [{ name: 'base_url', description: 'The endpoint.', default: 'https://api.openai.com', value: 'http://127.0.0.1:3425' }, { name: 'model', description: 'The model.', default: 'gpt-image-1' }],
      servers: [{ name: 'image', command: 'node', args: ['server.mjs', '--base-url', 'http://127.0.0.1:3425'], tools: ['image_generate'], workers: true, env: [{ name: 'IMAGE_KEY', set: false }] }],
      operations: [{ name: 'generate', description: 'Pictures.', input: {}, timeout_minutes: 15, paid: { unit: 'images', priced_by_tool: true } }],
    }),
    tool('tripo-3d', {
      enabled: true, resources: [{ name: 'tripo-wallet', slots: 1 }],
      servers: [{ name: 'tripo-ops', command: 'node', args: ['ops.mjs'], workers: false, env: [{ name: 'TRIPO_HOME', set: true }] }],
    }),
  ],
  auto_approve: [{ unit: 'images', per_job: 2, per_day: 20, today: 3, ever: 7 }],
  jobs: [
    { id: 'J41', tool: 'tripo-3d', version: '1.0.0', operation: 'generate-model', status: 'waiting-quote', by: 'web', order: 'ART-12', quote: { unit: 'credits', amount: 60, id: 'C3', unpriced: true }, created: '2026-11-14T09:00:00.000Z' },
    { id: 'J40', tool: 'image-gateway', version: '1.0.0', operation: 'generate', status: 'done', by: 'producer', order: 'ART-11', quote: { unit: 'images', amount: 2, id: 'C2', auto: true }, spent: 2, files: ['/state/tool-jobs/J40/crate.png'], created: '2026-11-14T08:00:00.000Z' },
    { id: 'J39', tool: 'image-gateway', version: '1.0.0', operation: 'generate', status: 'failed', by: 'web', spent: 1, spentUnknown: true, error: 'timed out', created: '2026-11-13T08:00:00.000Z' },
  ],
};
const values = { plugins: { enable: ['image-gateway', 'tripo-3d'], settings: { 'image-gateway': { base_url: 'http://127.0.0.1:3425' } }, by_kind: { art: ['image-gateway'] }, auto_approve: { images: { per_job: 2, per_day: 20 } } } };

const tr = (lang: 'en' | 'zh', text: string, vars: Record<string, string | number> = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), lang === 'en' ? text : translated[text] ?? text);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ToolsBody, { project: 'demo', view, values })));

afterEach(() => setLang('en'));

describe('the Tools page', () => {
  it('shows each plugin with its state, settings, servers, variables, operations, the by-kind and auto-approve editors and the jobs, in English and Chinese', () => {
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      const html = render();
      for (const text of ['Plugins', 'On', 'Off', 'built in', 'Settings', 'MCP servers', 'for operations only', 'Operations Alba runs', 'Used by kinds', 'Turn on', 'Turn off', 'Check', 'Check the tools that are on',
        'Tools by kind', 'Approved by Alba', 'One job', 'A day', 'Tool jobs', 'Price quote', 'waiting for a quote', 'failed', 'by Alba', 'unpriced', '(at most)', 'Save', 'Cancel']) expect(html, `${lang}: ${text}`).toContain(esc(tr(lang, text)));
      expect(html).toContain(esc(tr(lang, '{name} is missing', { name: 'IMAGE_KEY' })));
      expect(html).toContain(esc(tr(lang, '{name} is set', { name: 'TRIPO_HOME' })));
      expect(html).toContain(esc(tr(lang, 'paid in {unit}', { unit: 'images' })));
      expect(html).toContain(esc(tr(lang, '{name}, {n} at a time', { name: 'tripo-wallet', n: 1 })));
      expect(html).toContain(esc(tr(lang, '{today} today, {ever} in all', { today: 3, ever: 7 })));
      expect(html).toContain(esc(tr(lang, 'The newest {n} of {count}; alba tools jobs lists them all.', { n: 3, count: 41 })));
      expect(html).toContain(esc(tr(lang, 'default: {value}', { value: 'gpt-image-1' })));
      for (const value of ['value="http://127.0.0.1:3425"', 'image_generate', '/studio/alba.yaml', 'value="art"', 'value="images"', 'value="2"', 'value="20"', 'J41', 'J40', 'J39', 'ART-12', 'crate.png', 'timed out', 'generate-model']) expect(html, value).toContain(value);
      // the order: built-in plugins as the server sent them; a disabled one offers to turn it on, enabled ones to turn them off
      expect(html.indexOf('data-tool="example-echo"')).toBeLessThan(html.indexOf('data-tool="image-gateway"'));
      expect(html.indexOf('data-job="J41"')).toBeLessThan(html.indexOf('data-job="J39"'));
    }
  });

  it('offers to add a line for each paid unit that has none', () => {
    const html = render();
    expect(html).toContain(esc(tr('en', 'Add {unit}', { unit: 'credits' })));
    expect(html).not.toContain(esc(tr('en', 'Add {unit}', { unit: 'images' })));
  });
});
