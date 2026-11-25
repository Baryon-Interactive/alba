import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { loadProject } from '../../src/config.ts';
import { stateStore } from '../../src/orders/backend.ts';
import { Orders } from '../../src/orders/service.ts';
import { writeStateFile } from '../../src/orders/state-files.ts';
import type { ProducerCase } from '../../src/producer/producer.ts';
import type { Probes } from '../../src/tick/gather.ts';
import { validateWorkers } from '../../src/workers/config.ts';
import { tmpDir } from '../tmp.ts';

export const NOW = '2026-01-10T12:00:00.000Z';
export const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60000).toISOString();
export function producerReadFixture(backend: 'files' | 'sqlite' = 'files') {
  const parent = path.resolve('.state/producer-read-tests');
  mkdirSync(parent, { recursive: true });
  const root = tmpDir('fixture-', { parent: parent });
  mkdirSync(path.join(root, 'orders'));
  const file = path.join(root, 'alba.yaml');
  writeFileSync(file, stringify({ id: 'demo', name: 'Demo', root, work_orders: path.join(root, 'orders'), state_dir: path.join(root, 'state'), state: { backend },
    dispatch: { caps: { code: 3, art: 1 }, stall_minutes: 60, min_free_ram_gb: 4 },
    resources: { build: { slots: 1 } }, roles: { default: {} },
    producer: { enabled: true, rules: [{ id: 'remind', action: 'nudge', mode: 'auto', instruction: 'Remind a stalled run.' }], session: { enabled: false } },
  }));
  const project = loadProject(file);
  let at = ago(6000);
  const orders = new Orders(stateStore(project), () => at);
  const setTime = (minutes: number) => { at = ago(minutes); };
  orders.add({ tag: 'HOLD', kind: 'code', title: 'Held work' });
  orders.act('HOLD', 'hold');
  orders.add({ tag: 'BASE', kind: 'art', title: 'Dependency' });
  orders.add({ tag: 'NEEDS', kind: 'art', title: 'Waiting for dependency', needs: ['BASE'] });
  orders.act('NEEDS', 'queue');
  orders.add({ tag: 'CLOSED', kind: 'code', title: 'Merged delivery' });
  orders.report('CLOSED', { status: 'ready', summary: 'Delivered', evidence: [], commits: [] });
  orders.act('CLOSED', 'approve');
  setTime(180);
  const worktree = path.join(root, 'checkout');
  orders.add({ tag: 'SLOW', kind: 'code', title: 'Stalled run', worktree, uses: ['build'] });
  orders.runStart('SLOW', { worker: 'builder' });
  setTime(10);
  orders.add({ tag: 'RETRY', kind: 'code', title: 'New attempt' });
  orders.runStart('RETRY', { worker: 'builder' });
  orders.runEnd('RETRY', 'failed');
  orders.runStart('RETRY', { worker: 'builder' });
  const makeCase = (order: string, run: string, key: string, trigger: ProducerCase['trigger'] = 'failed'): ProducerCase => ({
    id: key, key, project: 'demo', trigger, status: 'open', revision: 1, openedAt: ago(180), updatedAt: ago(10), order, facts: { run }, card: { trigger, summary: 'Fixture case', pointers: [], untrusted: ['summary'] },
  });
  const cases = [makeCase('SLOW', 'r1', 'stall/SLOW', 'commit-reminder'), makeCase('CLOSED', 'r1', 'delivery/CLOSED/r1', 'delivery'), makeCase('RETRY', 'r1', 'failed/RETRY')];
  writeStateFile(project, '_producer-cases.json', JSON.stringify(cases));
  writeStateFile(project, '_leases.json', JSON.stringify({ leases: [{ resource: 'build', tag: 'SLOW', run: 'r1', since: ago(180), expires: ago(-300) }] }));
  const workers = validateWorkers({ workers: [{ id: 'builder', engine: 'codex-cli', concurrency: 4, launch: { program: 'unused-fixture-program', args: [] } }] }, path.join(root, 'workers.yaml'));
  const probes: Probes = {
    now: () => new Date(NOW), freeRamGb: () => 12, worktrees: () => [],
    gitActivity: tree => tree === worktree ? { lastCommitAt: ago(120), dirtyFiles: 0 } : {},
    fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined,
    runCommand: () => { throw new Error('Fixture must not execute commands'); },
    spawnDetached: () => { throw new Error('Fixture must not start a model'); },
  };
  return { project, orders, probes, workers, setTime, cases };
}
