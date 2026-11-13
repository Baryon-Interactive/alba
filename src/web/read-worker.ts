import { parentPort, workerData } from 'node:worker_threads';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from '../api/handler.ts';
import { systemProbes } from '../tick/gather.ts';
import { rowsOf } from './snapshot.ts';
import { activityScanner } from './activity.ts';
import { Orders } from '../orders/service.ts';
import { stateStore } from '../orders/backend.ts';
import { createBoard, type Board } from './server.ts';

const port = parentPort!;
const probes = workerData.probesModule ? (await import(workerData.probesModule)).probes : systemProbes;
const activity = activityScanner(probes);
let board: Board | undefined;
let signature = '', revision = -1;
let queue = Promise.resolve();
port.on('message', ({ id, method, args }) => {
  queue = queue.then(async () => {
    try {
      if (method === 'activity') { port.postMessage({ id, value: activity(args.projects) }); return; }
      const next = JSON.stringify([args.projects, args.workers]);
      if (!board || signature !== next) {
        board?.server.close();
        signature = next;
        board = createBoard({ ...args, port: 0, probes, background: false, listen: false, writeToken: args.token });
      }
      const ctx = board.ctx;
      if (revision !== args.revision) { revision = args.revision; board.invalidate(); }
      ctx.loop = () => args.loop;
      ctx.extraProblems = project => args.problems[project] ?? [];
      const cached = ctx.readings;
      // Reuse completed tick facts without running a second gather on aggregate request paths.
      ctx.readings = () => {
        const results = args.tickResults;
        if (!results || !Object.keys(results).length) return cached?.() ?? ctx.snapshot();
        const limits = ctx.projects.flatMap(config => config.dispatch.min_free_ram_gb === undefined ? [] : [config.dispatch.min_free_ram_gb]);
        return { at: new Date().toISOString(), workersFile: ctx.workers,
          freeRamGb: ctx.workers ? ctx.slow.freeRamGb() : undefined, minFreeRamGb: limits.length ? Math.max(...limits) : undefined,
          projects: ctx.projects.map(config => {
          const orders = new Orders(stateStore(config)), result = results[config.id];
          return { config, orders, rows: rowsOf(config, orders, result?.activity), tick: result?.report, quotas: result?.quotas, workers: result?.workers, history: result?.history };
        }) };
      };
      const req = { method: 'GET', headers: args.headers } as IncomingMessage;
      let status = 200, headers = {}, body: Buffer | undefined;
      const res = { req, headersSent: false,
        writeHead(code: number, value: Record<string, string>) { status = code; headers = value; },
        end(value?: Buffer | string) { body = value === undefined ? undefined : Buffer.from(value); },
      } as unknown as ServerResponse;
      try {
        const url = new URL(args.url);
        if (method === 'legacy') await board.renderLegacy(req, res, url, url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent));
        else await handleApi(ctx, req, res, url, args.port);
      } finally { ctx.readings = cached; }
      port.postMessage({ id, value: { status, headers, body } });
    } catch (error) { port.postMessage({ id, error: (error as Error).message }); }
  });
});
