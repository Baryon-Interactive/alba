import { parentPort, workerData } from 'node:worker_threads';
import { createServer } from 'node:http';
import { startCoordinator, type ServeOptions } from './coordinator.ts';
import { systemProbes } from '../tick/gather.ts';
import type { Board } from '../web/server.ts';
import { executeTick } from '../tick/execute.ts';
import { tick } from '../tick/gather.ts';
import { findFinishes } from '../run/finish.ts';
import { Orders } from '../orders/service.ts';
import { stateStore, closeStateStores } from '../orders/backend.ts';
import { currentLang, withLang } from '../i18n.ts';
import { cachedProbes } from '../web/snapshot.ts';
import { peerRunning } from './fleet.ts';

const port = parentPort!;
const options = workerData as ServeOptions;
// Worker argv names this file; session MCP children must still invoke the original CLI entry point.
if (workerData.entry) process.argv[1] = workerData.entry;
const probes = options.probesModule ? (await import(options.probesModule)).probes : systemProbes;
// A coordinator has no listener or second event hub: events and config updates are forwarded to HTTP.
const server = createServer();
let revision = 0;
const publish = (project: string, name: string, data: unknown) => { board.invalidate(); port.postMessage({ event: 'publish', project, name, data }); return 0; };
const board = {
  server, hub: { publish, stop() {} },
  ctx: { projects: options.projects, workers: options.workers, slow: cachedProbes(probes, 60_000), probes,
    onReadings: (project: string, result: unknown) => port.postMessage({ event: 'readings', project, result }),
  },
  invalidate() {
    port.postMessage({ event: 'state', revision: ++revision, projects: options.projects, workers: board.ctx.workers, loop: board.ctx.loop?.(), problems: Object.fromEntries(options.projects.map(p => [p.id, board.ctx.extraProblems?.(p.id) ?? []])) });
  },
} as unknown as Board;
const coordinator = startCoordinator({ ...options, probes, print: line => port.postMessage({ event: 'print', line }) }, board);
server.emit('listening');
let queue = Promise.resolve();
port.on('message', ({ id, method, args }) => {
  // Async model work must never permit concurrent dispatch decisions. All explicit jobs share this queue.
  queue = queue.then(async () => {
    try {
      let value: unknown;
      if (method === 'tick') coordinator.tickNow(args);
      else if (method === 'poll') coordinator.pollNow();
      else if (method === 'ends') value = coordinator.recordEnds();
      else if (method === 'sessionControl') value = await coordinator.sessionControl(args.project, args.action);
      else if (method === 'manualTick') {
        const project = options.projects.find(p => p.id === args.project);
        if (!project) throw new Error('No such project');
        const orders = new Orders(stateStore(project), undefined, 'serve');
        const peers = () => peerRunning(options.peerProjects ?? [], board.ctx.workers!);
        value = withLang(args.lang ?? currentLang(), () => args.real
          ? executeTick({ project, orders, workers: board.ctx.workers!, probes, peers }, { maxDispatch: args.maxDispatch })
          : tick(project, orders, board.ctx.workers!, board.ctx.slow, { record: false, finishes: findFinishes(project, orders, probes, board.ctx.workers).map(f => ({ tag: f.tag, run: f.run, outcome: f.outcome, why: f.why })) }));
        board.invalidate();
      } else if (method === 'stop') { await coordinator.stop(); closeStateStores(); }
      else throw new Error('Unknown serve worker operation');
      port.postMessage({ id, value });
    } catch (error) { port.postMessage({ id, error: (error as Error).message }); }
  });
});
