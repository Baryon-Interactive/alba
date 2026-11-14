import { describe, expect, it } from 'vitest';
import { autoEdits, autoRows, kindEdits, pluginsBlock, settingsDraft, settingsEdits, toggleEdits, toggleLoses } from './plugins';

const values = {
  plugins: {
    enable: ['image-gateway', 'tripo-3d'],
    settings: { 'image-gateway': { base_url: 'http://127.0.0.1:3425', key_env: '' }, 'tripo-3d': { ceiling: 60 } },
    by_kind: { art: ['image-gateway'], model: ['tripo-3d', 'image-gateway'] },
    auto_approve: { images: { per_job: 2, per_day: 20 }, credits: 0 },
  },
};

describe('the plugins block of the project file', () => {
  it('reads what is written, and nothing when there is no block', () => {
    expect(pluginsBlock(values).enable).toEqual(['image-gateway', 'tripo-3d']);
    expect(pluginsBlock({})).toEqual({ enable: [], settings: {}, by_kind: {}, auto_approve: {} });
  });

  it('turns a tool on by adding it to enable, and off with its settings and kinds taken out in the same write', () => {
    const block = pluginsBlock(values);
    expect(toggleEdits(block, 'example-echo', true)).toEqual([{ path: ['plugins', 'enable'], value: ['image-gateway', 'tripo-3d', 'example-echo'] }]);
    expect(toggleEdits(block, 'image-gateway', true)).toEqual([]);
    expect(toggleEdits(block, 'image-gateway', false)).toEqual([
      { path: ['plugins', 'enable'], value: ['tripo-3d'] },
      { path: ['plugins', 'settings', 'image-gateway'] },
      { path: ['plugins', 'by_kind', 'art'] },
      { path: ['plugins', 'by_kind', 'model'], value: ['tripo-3d'] },
    ]);
    expect(toggleLoses(block, 'image-gateway')).toEqual({ settings: true, kinds: ['art', 'model'] });
    expect(toggleLoses(block, 'example-echo')).toEqual({ settings: false, kinds: [] });
  });

  it('writes a tool\'s settings whole, keeps how an unchanged value was written, keeps an empty value, and removes the mapping when all are defaults', () => {
    const written = { base_url: 'http://127.0.0.1:3425', key_env: '' };
    const names = ['base_url', 'model', 'key_env'];
    const draft = settingsDraft(written, names);
    expect(draft).toEqual({ base_url: 'http://127.0.0.1:3425', model: undefined, key_env: '' });
    expect(settingsEdits('image-gateway', written, draft)).toEqual([]);
    expect(settingsEdits('image-gateway', written, { ...draft, model: 'gpt-image-2' })).toEqual([{ path: ['plugins', 'settings', 'image-gateway'], value: { base_url: 'http://127.0.0.1:3425', model: 'gpt-image-2', key_env: '' } }]);
    expect(settingsEdits('image-gateway', written, { base_url: undefined, model: undefined, key_env: undefined })).toEqual([{ path: ['plugins', 'settings', 'image-gateway'] }]);
    expect(settingsEdits('example-echo', undefined, {})).toEqual([]);
    // a number stays a number while its text does not change
    expect(settingsEdits('tripo-3d', { ceiling: 60 }, { ceiling: '60', server: '/x/bootstrap.mjs' })).toEqual([{ path: ['plugins', 'settings', 'tripo-3d'], value: { ceiling: 60, server: '/x/bootstrap.mjs' } }]);
  });

  it('edits auto approvals: the short form for per_job alone, the mapping with limits, and refuses what the loader would', () => {
    const written = values.plugins.auto_approve;
    const rows = autoRows(written);
    expect(rows).toEqual([{ unit: 'images', per_job: '2', per_day: '20', per_project: '' }, { unit: 'credits', per_job: '0', per_day: '', per_project: '' }]);
    expect(autoEdits(written, rows)).toEqual({ edits: [], problems: [] });
    expect(autoEdits(written, [rows[0]!, { ...rows[1]!, per_job: '5' }]).edits).toEqual([{ path: ['plugins', 'auto_approve'], value: { images: { per_job: 2, per_day: 20 }, credits: 5 } }]);
    expect(autoEdits(written, [{ ...rows[0]!, per_project: '200' }]).edits).toEqual([{ path: ['plugins', 'auto_approve'], value: { images: { per_job: 2, per_day: 20, per_project: 200 } } }]);
    expect(autoEdits(written, []).edits).toEqual([{ path: ['plugins', 'auto_approve'] }]);
    expect(autoEdits(written, [{ unit: 'images', per_job: '', per_day: '3', per_project: '' }]).problems).toEqual([{ key: 'per_job', unit: 'images' }]);
    expect(autoEdits(written, [{ unit: 'images', per_job: '1', per_day: '-1', per_project: '' }]).problems).toEqual([{ key: 'limits', unit: 'images' }]);
    expect(autoEdits(written, [rows[0]!, rows[0]!]).problems).toEqual([{ key: 'twice', unit: 'images' }]);
  });

  it('edits the tools of each kind, and refuses a tool that is not on', () => {
    const written = { art: ['image-gateway'] };
    expect(kindEdits(written, [{ kind: 'art', tools: ['image-gateway'] }], ['image-gateway']).edits).toEqual([]);
    expect(kindEdits(written, [{ kind: 'art', tools: ['image-gateway'] }, { kind: 'model', tools: ['tripo-3d'] }], ['image-gateway', 'tripo-3d']).edits).toEqual([{ path: ['plugins', 'by_kind'], value: { art: ['image-gateway'], model: ['tripo-3d'] } }]);
    expect(kindEdits(written, [], ['image-gateway']).edits).toEqual([{ path: ['plugins', 'by_kind'] }]);
    expect(kindEdits(written, [{ kind: 'model', tools: ['tripo-3d'] }], ['image-gateway']).problems).toEqual([{ key: 'off', name: 'tripo-3d' }]);
    expect(kindEdits({}, [{ kind: '', tools: ['image-gateway'] }], ['image-gateway']).problems).toEqual([{ key: 'kind' }]);
  });
});
