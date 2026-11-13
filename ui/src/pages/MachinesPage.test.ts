import { testTranslations as translated } from '../test-translations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { MachineView } from '../../../src/machines/probe';
import { MachinesPage } from './MachinesPage';
import { setLang } from '@/i18n';
import { CapabilitySummary } from '@/components/MachineCapabilities';

const query = vi.hoisted(() => ({ data: undefined as { machines: MachineView[] } | undefined, isError: false, error: undefined as unknown }));
const idle = { mutate: () => undefined, reset: () => undefined, isPending: false, isError: false };
const fleet = vi.hoisted(() => ({ workers: [] as { id: string; host?: string }[], running: [] as { tag: string; title: string; worker?: string }[] }));
vi.mock('@/lib/queries', () => ({ useProjectId: () => 'demo', useMachines: () => query,
  useWorkers: () => ({ data: { workers: fleet.workers } }), useOverview: () => ({ data: { running: { items: fleet.running } } }), useMachineChanges: () => ({ add: idle, remove: idle, check: idle, roles: idle, install: idle, cancelJob: idle }),
  useMachineGuide: () => ({ data: undefined }), useMachineInstallPlan: () => ({ data: undefined }), machineCalls: {}, errorText: String }));
const render = () => renderToStaticMarkup(createElement(MachinesPage));
afterEach(() => { setLang('en'); query.data = undefined; query.isError = false; fleet.workers = []; fleet.running = []; });
function machine(): MachineView {
  const latest = { id: 'build-box', at: new Date().toISOString(), reachable: true, free_mem_gb: 8, total_mem_gb: 32, load: 0.25, uptime_seconds: 7200,
    disks: [{ mount: 'system', free_gb: 20, total_gb: 100 }], services: [{ id: 'compile-agent', up: false }] };
  return { id: 'build-box', name: 'Build box', os: 'windows', connect: { ssh: 'build-box' }, hardware: { ram_gb: 32 }, roles: ['compile-helper'], slots: 2, min_free_mem_gb: 4,
    timing_allowed: false, services: [{ id: 'compile-agent', check: { process: 'compile-agent' }, start_hint: 'Open the compile helper.' }], latest, history: [latest] , capabilities: null, suggestions: { roles: [], missing: [] }, jobs: [] };
}
it('renders machine readings, history and service hints in English and Chinese', () => {
  query.data = { machines: [machine()] };
  for (const [lang, words] of [['en', ['Machines', 'Reachable', 'Down', 'Free memory over 24 hours', 'Start hint']], ['zh', [translated["Machine"], translated["Reachable"], translated["Down"], translated["Free memory over 24 hours"], translated["Start hint"]]]] as const) {
    setLang(lang);
    const html = render();
    for (const word of [...words, 'Build box', '8.0 GB', '32.0 GB', '25%', '20%', 'compile-agent', 'Open the compile helper.']) expect(html).toContain(word);
    expect(html).toContain('data-memory-history'); expect(html).toContain('<circle');
  }
});
it('shows unreachable, unprobed and empty registry states', () => {
  setLang('en');
  const m = machine(); m.latest!.reachable = false; m.latest!.error = 'SSH probe failed or timed out.';
  query.data = { machines: [m] }; expect(render()).toContain('Unreachable');
  m.latest = null; m.history = []; expect(render()).toContain('Not probed yet'); expect(render()).toContain('No memory readings yet.');
  query.data = { machines: [] }; { const html = render(); expect(html).toContain('No machines yet.'); expect(html).toContain('Add a machine'); }
});

it('draws the fleet: this computer, the machines around it and the runs out on them', () => {
  const local: MachineView = { ...machine(), id: 'studio-pc', name: 'Studio PC', connect: { local: true } };
  const off: MachineView = { ...machine(), id: 'art-mac', name: 'Art Mac', latest: { ...machine().latest!, id: 'art-mac', reachable: false } };
  query.data = { machines: [local, machine(), off] };
  fleet.workers = [{ id: 'codex' }, { id: 'remote-build', host: 'build-box' }];
  fleet.running = [{ tag: 'CK2', title: 'Cook the client', worker: 'remote-build' }, { tag: 'MV4', title: 'Wall jump', worker: 'codex' }];
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang);
    const html = render();
    expect(html).toContain(lang === 'en' ? 'Fleet' : translated['Fleet']);
    expect(html).toContain('href="#machine-build-box"');
    expect(html).toContain('id="machine-build-box"');
    expect(html).toContain('remote-build');
    expect(html).toContain('CK2');
    expect(html).toContain(lang === 'en' ? 'Unreachable' : translated['Unreachable']);
    expect(html).toContain('fleet-link-live');
    expect((html.match(/fleet-link-live/g) ?? []).length).toBe(1);
  }
});

it('renders generic capabilities without engine details, then selected module results and install actions', () => {
  const caps = { at: new Date().toISOString(), cpu: 'Sample CPU', gpus: [], tools: { node: '24.0' } };
  const plain = renderToStaticMarkup(createElement(CapabilitySummary, { caps, suggestions: { roles: [], missing: [] } }));
  expect(plain).toContain('Sample CPU');
  expect(plain).not.toMatch(/Unreal|Unity|Godot|UBA|MSVC|Windows SDK|compile-helper/);
  const selected = { ...caps, engines: { unreal: { versions: ['5.8'], features: { UBA: ['installed'] } } } };
  const suggestions = { roles: [{ role: 'compile-helper', reason: 'Available', key: 'The UBA agent that comes with Unreal Engine is installed.', vars: {} }], missing: [{ what: 'Windows SDK', for: 'package', item: 'windows-sdk' }] };
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang);
    const html = renderToStaticMarkup(createElement(CapabilitySummary, { caps: selected, suggestions, onInstall: () => undefined }));
    expect(html).toContain('unreal 5.8'); expect(html).toContain('UBA installed');
    expect(html).toContain(lang === 'en' ? 'Install…' : translated['Install…']);
  }
});
