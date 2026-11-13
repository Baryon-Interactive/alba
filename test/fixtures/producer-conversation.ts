/** Manual screenshot fixture: build the UI, then run this file with Node. Never starts a model or dispatches work. */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { validateProject } from '../../src/config.ts';
import { writeStateFile } from '../../src/orders/state-files.ts';
import type { ProducerSessionTurn } from '../../src/producer/session.ts';
import { createBoard } from '../../src/web/server.ts';
import { validateWorkers } from '../../src/workers/config.ts';
import type { Probes } from '../../src/tick/gather.ts';

const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, '.state', 'producer-conversation-fixture');
mkdirSync(path.join(dir, 'orders'), { recursive: true });
const project = validateProject({ id: 'conversation', name: 'Conversation fixture', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), state: { backend: 'files' }, producer: { enabled: true, session: { enabled: false }, rules: [{ id: 'delivery-review', instruction: 'Review new deliveries and record the next action.', action: 'note', mode: 'observe' }] } }, path.join(dir, 'alba.yaml'));
const turns: ProducerSessionTurn[] = [
  { number: 1, at: '2026-01-01T10:00:00Z', sent: { kind: 'cards', cards: [{ key: 'delivery/DEMO1/DEMO1-r1', trigger: 'delivery', revision: 2 }] }, answer: 'The delivery is ready for review. All verification gates passed; I recorded a review note for the person.', tools: [{ id: 'read-1', name: 'producer_read', input: '{"kind":"cases"}', result: '1 open delivery; verification passed' }, { id: 'act-1', name: 'producer_act', input: '{"kind":"note","case":"delivery/DEMO1/DEMO1-r1"}', result: 'would-do: review the delivery' }], usage: { input_tokens: 800, output_tokens: 120, total_tokens: 920 } },
  { number: 2, at: '2026-01-01T10:05:00Z', sent: { kind: 'cards', cards: [{ key: 'question/DEMO2', trigger: 'question', revision: 1 }, { key: 'blocked/DEMO3', trigger: 'blocked', revision: 3 }] }, answer: 'DEMO2 needs a choice of tileset. DEMO3 is waiting for that decision. I left both cases open for a person to answer.', tools: [{ id: 'read-2', name: 'producer_read', input: '{"kind":"orders"}', result: 'DEMO2: awaiting-user; DEMO3: blocked' }], usage: { input_tokens: 640, output_tokens: 95, total_tokens: 735 } },
  { number: 3, at: '2026-01-01T10:10:00Z', sent: { kind: 'handoff', note: 'Continue from durable notes: DEMO1 awaits review; DEMO2 needs a tileset choice.' }, answer: 'Handoff received. I will wait for a new report or stage change before sending another proposal.', tools: [{ id: 'notes-3', name: 'producer_notes', input: '{}', result: 'Durable notes read' }], usage: { input_tokens: 300, output_tokens: 60, total_tokens: 360 } },
];
writeStateFile(project, '_producer-session-turns.json', JSON.stringify(turns));
writeStateFile(project, '_producer-session.json', JSON.stringify({ state: 'stopped', model: 'fixture-engine', turns: 3, lastHeartbeat: '2026-01-01T10:10:00Z', usage: { input_tokens: 1740, output_tokens: 275, total_tokens: 2015 } }));
const noExternal = () => { throw new Error('The conversation fixture cannot run commands.'); };
const probes = { now: () => new Date('2026-01-01T10:11:00Z'), isAlive: () => false, tail: () => '', head: () => '', readText: () => undefined, fileTime: () => undefined, runCommand: noExternal, freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: noExternal } as unknown as Probes;
const board = createBoard({ projects: [project], workers: validateWorkers({ workers: [{ id: 'fixture-worker', engine: 'fixture', enabled: false }] }, 'fixture-workers.yaml'), port: 0, probes, uiDir: path.join(root, 'ui', 'dist') });
board.server.on('listening', () => console.log(`http://127.0.0.1:${(board.server.address() as { port: number }).port}/login?key=${board.ctx.token}&next=${encodeURIComponent('/p/conversation/producer')}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { board.hub.stop(); board.server.closeAllConnections(); board.server.close(); });
