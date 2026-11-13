import { acquireLock, lockFile } from './lock.ts';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createBoard } from '../web/server.ts';
import { writeKeyFile } from '../web/auth.ts';
import { systemProbes } from '../tick/gather.ts';
import { startCoordinator, type ServeOptions, type Serve } from './coordinator.ts';
import { WorkerChannel } from './channel.ts';
import { currentLang } from '../i18n.ts';
import type { TickResult } from '../tick/gather.ts';
export type { ServeOptions, Serve } from './coordinator.ts';

/** HTTP/SSE stay here; the persistent worker owns ticks, finish checks, file polling and the producer session. */
export function startServe(options: ServeOptions): Serve {
  const releases: (() => void)[] = [];
  const unlock = () => { for (const release of releases.splice(0)) release(); };
  try { for (const project of options.projects) releases.push(acquireLock(project.state_dir, { pid: process.pid, started: new Date().toISOString() })); }
  catch (error) { unlock(); throw error; }
  const background = options.probes === systemProbes || !!options.probesModule;
  let board: ReturnType<typeof createBoard>;
  try { board = createBoard({ ...options, background }); } catch (error) { unlock(); throw error; }
  board.server.once('listening', () => {
    const address = board.server.address();
    if (!address || typeof address === 'string') return;
    // The console key, for programs of this account (alba producer session, scripts): a file only this account can read.
    try {
      const removeKey = writeKeyFile(address.port, board.ctx.token);
      releases.push(removeKey);
      process.once('exit', removeKey);
    } catch (error) {
      options.print(`console key file not written: ${(error as Error).message}`);
    }
    for (const project of options.projects) {
      const file = lockFile(project.state_dir);
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        const info = JSON.parse(readFileSync(file, 'utf8'));
        if (info.pid !== process.pid) continue;
        writeFileSync(temporary, JSON.stringify({ ...info, port: address.port }) + '\n');
        renameSync(temporary, file);
      } catch (error) {
        options.print(`serve lock port update failed (${project.id}): ${(error as Error).message}`);
      } finally {
        try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
      }
    }
  });
  if (!background) {
    const coordinator = startCoordinator(options, board);
    const stop = coordinator.stop;
    coordinator.stop = () => { stop(); unlock(); };
    board.server.once('error', unlock);
    return coordinator;
  }
  const { probes, print, ...data } = options;
  let channel: WorkerChannel;
  try { channel = new WorkerChannel(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url), { ...data, entry: process.argv[1] }); }
  catch (error) { board.server.close(); unlock(); throw error; }
  let stopped = false, tickPending = false;
  let loopState: ReturnType<NonNullable<typeof board.ctx.loop>> = { everyMinutes: options.everyMinutes };
  board.ctx.loop = () => loopState;
  channel.worker.on('message', message => {
    if (stopped) return;
    if (message.event === 'readings') (board.ctx.tickResults ??= {})[message.project] = message.result;
    if (message.event === 'publish') { board.hub.scan(); board.hub.publish(message.project, message.name, message.data); }
    if (message.event === 'print') options.print(message.line);
    if (message.event === 'state') {
      options.projects.splice(0, options.projects.length, ...message.projects);
      board.ctx.workers = message.workers;
      loopState = message.loop;
      board.ctx.extraProblems = id => message.problems[id] ?? [];
      board.invalidate();
    }
  });
  channel.worker.on('error', error => { options.print(`serve worker failed: ${error.message}`); stop(); });
  channel.worker.on('exit', code => { if (!stopped) { options.print(`serve worker exited (${code})`); stop(); } });
  const report = (error: unknown) => { if (!stopped) options.print(`serve worker failed: ${(error as Error).message}`); };
  board.ctx.runTick = (project, real, maxDispatch) => channel.call<TickResult>('manualTick', { project: project.id, real, maxDispatch, lang: currentLang() });
  const sessionControl: Serve['sessionControl'] = (project, action) => channel.call('sessionControl', { project, action });
  board.ctx.sessionControl = (project, action) => sessionControl(project.id, action);
  const tickNow: Serve['tickNow'] = source => {
    if (stopped || tickPending) return;
    tickPending = true;
    void channel.call('tick', source).catch(report).finally(() => { tickPending = false; });
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    board.hub.stop(); board.server.closeAllConnections(); board.server.close();
    // Give in-flight state writes and session shutdown time to finish before releasing the serve lock.
    const deadline = setTimeout(() => { void channel.close().finally(unlock); }, 30_000).unref();
    void channel.call('stop', null).catch(() => {}).finally(() => { clearTimeout(deadline); void channel.close().finally(unlock); });
  };
  board.server.once('error', stop);
  return { board, server: board.server, tickNow, sessionControl, pollNow: () => { void channel.call('poll', null).catch(report); }, recordEnds: () => channel.call<number>('ends', null), stop };
}
