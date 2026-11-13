import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { validateProject } from '../../src/config.ts';
import { FileStore } from '../../src/orders/store.ts';
import { Orders } from '../../src/orders/service.ts';
import { writeStateFile } from '../../src/orders/state-files.ts';
import { createBoard } from '../../src/web/server.ts';
import { producerAct, createChatCase } from '../../src/producer/producer.ts';
import type { Probes } from '../../src/tick/gather.ts';
import type { DirectorMessage } from '../../src/producer/conversation-state.ts';
import { producerFactsFixture, NOW } from './producer-facts.ts';

/** Entirely local, no coordinator or model process. All state stays in the worktree. */
export async function workspaceFixture() {
  const parent = path.resolve('.alba/TASK45'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, 'fixture-'));
  const root = path.join(dir, 'project'); mkdirSync(path.join(root, 'orders'), { recursive: true });
  const project = validateProject({ id: 'demo', name: 'Demo studio', root, work_orders: path.join(root, 'orders'), state_dir: path.join(dir, 'state'), state: { backend: 'files' }, producer: { enabled: true, rules: [{ id: 'review', action: 'hold', instruction: 'Review proposed order changes', mode: 'propose' }], budgets: { usage_per_day: 100000 }, session: { enabled: false, model: 'fixture-model' } } }, path.join(dir, 'alba.yaml'));
  const orders = new Orders(new FileStore(project.state_dir), () => NOW);
  for (let i = 0; i < 160; i++) orders.add({ tag: `DEMO${i}`, title: `Fixture order ${i}`, kind: 'tooling' });
  const sample = createChatCase(project, 'fixture');
  writeStateFile(project, '_producer-cases.json', JSON.stringify(Array.from({ length: 160 }, (_, i) => ({ ...sample, id: `case${i}`, key: `delivery/DEMO${i}`, trigger: 'delivery', order: `DEMO${i}` }))));
  for (let i = 0; i < 6; i++) producerAct(project, orders, `case${i}`, 'hold', { target: `DEMO${i}`, note: i >= 4 ? 'This recommendation has been overtaken by a newer decision.' : 'Pause this order until its build dependency is ready.', now: new Date(Date.parse(NOW) + i * 1000) });
  orders.act('DEMO4', 'queue'); orders.runStart('DEMO5', { worker: 'fixture' });
  const snapshot = producerFactsFixture().snapshot;
  writeStateFile(project, '_producer-facts.json', JSON.stringify(snapshot));
  const fact = snapshot.facts.find(f => typeof f.value === 'number')!;
  const messages: DirectorMessage[] = Array.from({ length: 35 }, (_, i) => ({ id: `message${i}`, at: new Date(Date.parse(NOW) - (35 - i) * 60000).toISOString(), completedAt: new Date(Date.parse(NOW) - (35 - i) * 60000 + 1000).toISOString(), text: i === 34 ? 'What should we focus on next?' : `Review the current delivery plan, round ${i + 1}.`, status: 'done', warnings: [], answer: i === 34 ? `**Recommended next step:** stabilize the build pipeline before dispatching DEMO7.\n\n| Order | Next step |\n|---|---|\n| DEMO7 | Check the build dependency |\n\n- Keep the current concurrency cap.\n\nSnapshot: ${fact.value} [${fact.id}].\n\n\`pnpm run build\` remains the acceptance check.` : `**Round ${i + 1} complete.** Review DEMO7 against the stored facts.`, ...(i === 34 ? { tools: [{ id: 'read-orders', name: 'producer_read', input: '{"kind":"orders","page":3}', result: '20 order summaries read.' }, { id: 'read-facts', name: 'producer_read', input: '{"kind":"facts"}', result: 'Stored snapshot available.' }], narration: ['Reading orders and comparing the current constraint.'], warnings: ['Uncited number: A forecast of 12 hours needs evidence.'] } : {}) }));
  const saveMessages = () => writeStateFile(project, '_producer-chat.json', JSON.stringify(messages)); saveMessages();
  writeStateFile(project, '_producer-session.json', JSON.stringify({ state: 'stopped', active: false, model: 'fixture-model', turns: 12, lastTurnAt: NOW, usage: { total_tokens: 18400 } }));
  writeStateFile(project, '_producer-session-budget.json', JSON.stringify({ day: new Date().toISOString().slice(0, 10), dayTurns: 12, dayUsage: 18400, hour: new Date().toISOString().slice(0, 13), hourTurns: 2 }));
  const probes = { now: () => new Date(NOW), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => { throw new Error('No processes may be started by this fixture.'); } } as unknown as Probes;
  const board = createBoard({ projects: [project], probes, port: 0, uiDir: path.resolve('ui/dist'), hubCheckMs: 100000 });
  await new Promise<void>(resolve => board.server.once('listening', resolve));
  const address = board.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return { board, project, orders, messages, saveMessages, dir, base: `http://127.0.0.1:${address.port}`, close: () => { board.hub.stop(); board.server.closeAllConnections(); board.server.close(); } };
}
