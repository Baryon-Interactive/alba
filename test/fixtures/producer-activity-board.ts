import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { validateProject } from '../../src/config.ts';
import { FileStore } from '../../src/orders/store.ts';
import { Orders } from '../../src/orders/service.ts';
import { createBoard } from '../../src/web/server.ts';
import type { Probes } from '../../src/tick/gather.ts';
import { ACTIVITY_NOW, seedProducerActivity } from './producer-activity.ts';
import { tmpDir } from '../tmp.ts';

export async function activityBoard() {
  const parent = path.resolve('.alba/TASK54'); mkdirSync(parent, { recursive: true });
  const dir = tmpDir('fixture-', { parent: parent }), root = path.join(dir, 'project');
  mkdirSync(path.join(root, 'orders'), { recursive: true });
  const project = validateProject({ id: 'demo', name: 'Demo studio', root, work_orders: path.join(root, 'orders'), state_dir: path.join(dir, 'state'), state: { backend: 'files' },
    producer: { enabled: true, rules: [{ id: 'review', action: 'accept', instruction: 'Review the delivery against its stored acceptance evidence.', mode: 'auto' }], budgets: { turns_per_hour: 20, usage_per_day: 100000, review_runs_per_day: 10, draft_runs_per_day: 5 }, round: { enabled: true, every_minutes: 60 } },
  }, path.join(dir, 'alba.yaml'));
  const orders = new Orders(new FileStore(project.state_dir), () => ACTIVITY_NOW);
  const seeded = seedProducerActivity(project, orders);
  const probes = { now: () => new Date(ACTIVITY_NOW), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => { throw new Error('Fixture forbids model processes.'); } } as unknown as Probes;
  const board = createBoard({ projects: [project], probes, port: 0, uiDir: path.resolve('ui/dist'), hubCheckMs: 100000 });
  await new Promise<void>(resolve => board.server.once('listening', resolve));
  const address = board.server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return { ...seeded, project, orders, dir, base: `http://127.0.0.1:${address.port}`, close: () => { board.hub.stop(); board.server.closeAllConnections(); board.server.close(); } };
}
