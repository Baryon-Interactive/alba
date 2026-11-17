import { acquireLock, lockFile, writeServeExit, type LockRelease } from './lock.ts';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createBoard } from '../web/server.ts';
import { writeKeyFile } from '../web/auth.ts';
import { systemProbes } from '../tick/gather.ts';
import { startCoordinator, type ServeOptions, type Serve } from './coordinator.ts';
import { WorkerChannel } from './channel.ts';
import { currentLang } from '../i18n.ts';
import type { TickResult } from '../tick/gather.ts';
import type { ProjectConfig } from '../config.ts';
import type * as A from '../api/types.ts';
import { newFleetLock } from './fleet.ts';
import { createNotifier } from '../notify/notifier.ts';
import { scrubSecrets } from '../notify/channels.ts';
export type { ServeOptions, Serve } from './coordinator.ts';

/** HTTP/SSE stay here; the persistent worker owns ticks, finish checks, file polling and the producer session. */
export function startServe(options: ServeOptions): Serve {
  const startedAt = new Date().toISOString();
  const lockReleases: LockRelease[] = [];
  const releases: (() => void)[] = [];
  const unlock = () => { for (const release of releases.splice(0)) release(); };
  try {
    for (const project of options.projects) {
      const rel = acquireLock(project.state_dir, { pid: process.pid, started: startedAt });
      lockReleases.push(rel);
      releases.push(rel);
    }
  } catch (error) { unlock(); throw error; }

  let exitRecorded = false;
  const recordExit = (how: 'clean' | 'crashed', why?: string) => {
    if (exitRecorded) return;
    exitRecorded = true;
    const ended_at = new Date().toISOString();
    for (const project of options.projects) {
      writeServeExit(project.state_dir, { pid: process.pid, started: startedAt, ended_at, how, ...(why ? { why } : {}) });
    }
  };
  const onCrash = (err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err);
    const why = scrubSecrets(raw).slice(0, 300);
    recordExit('crashed', why || 'unexpected error');
  };
  process.on('uncaughtExceptionMonitor', onCrash);
  const cleanupCrash = () => { process.off('uncaughtExceptionMonitor', onCrash); };

  const background = options.probes === systemProbes || !!options.probesModule;
  let board: ReturnType<typeof createBoard>;
  try { board = createBoard({ ...options, background }); } catch (error) { cleanupCrash(); unlock(); throw error; }

  const notifier = createNotifier({
    projects: options.projects,
    workers: options.workers,
    clock: () => options.probes.now(),
    print: options.print,
    ...(options.notifySender ? { sender: options.notifySender } : {}),
    ...(options.notifyMachineDir ? { machineDir: options.notifyMachineDir } : {}),
  });
  const previousEnds = lockReleases.map(r => r.previous);
  const previous = previousEnds.find(p => p.how === 'crashed')
    ?? previousEnds.find(p => p.how === 'killed')
    ?? previousEnds.find(p => p.how === 'clean')
    ?? { how: 'none' as const };
  notifier.onServeStart({ startedAt, previous });

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
    const prevOnReadings = board.ctx.onReadings;
    board.ctx.onReadings = (projectId, result) => {
      prevOnReadings?.(projectId, result);
      notifier.onTick(projectId, result as TickResult);
    };
    const origPublish = board.hub.publish.bind(board.hub);
    board.hub.publish = ((project: string, name: keyof A.StreamEvents, data: A.StreamEvents[keyof A.StreamEvents]) => {
      const count = origPublish(project, name, data);
      if (name === 'serve.notice') notifier.onNotice(data as A.StreamEvents['serve.notice']);
      return count;
    }) as typeof board.hub.publish;
    const coordinator = startCoordinator({
      ...options,
      onWorkersReload: next => { options.onWorkersReload?.(next); notifier.setWorkers(next); },
      onProjectsReload: next => { options.onProjectsReload?.(next); notifier.setProjects(next); },
    }, board);
    const stop = coordinator.stop;
    coordinator.stop = () => {
      recordExit('clean');
      notifier.stop();
      cleanupCrash();
      const out = stop();
      unlock();
      return out;
    };
    board.server.once('error', err => {
      recordExit('crashed', scrubSecrets(err.message).slice(0, 300));
      notifier.stop();
      cleanupCrash();
      unlock();
    });
    return coordinator;
  }
  const { probes, print, onWorkersReload, onProjectsReload, notifySender, notifyMachineDir, ...data } = options;
  // One thread per project: its ticks, end checks, file polling and producer session. A slow step of one project (a provision
  // command, git, a quota command) no longer holds up the others. The projects share the workers file, so each counts the
  // others' open runs against a worker's concurrency and records a start under one lock (src/serve/fleet.ts).
  const fleetLock = newFleetLock();
  const channels = new Map<string, WorkerChannel>();
  const workerFile = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url);
  try {
    for (const project of options.projects) {
      channels.set(project.id, new WorkerChannel(workerFile, { ...data, projects: [project], peerProjects: options.projects.filter(p => p.id !== project.id), fleetLock, entry: process.argv[1] }));
    }
  } catch (error) { for (const c of channels.values()) void c.close(); notifier.stop(); cleanupCrash(); board.server.close(); unlock(); throw error; }
  let stopped = false;
  const tickPending = new Set<string>();
  const loops = new Map<string, ReturnType<NonNullable<typeof board.ctx.loop>>>();
  const problems = new Map<string, A.Problem[]>();
  board.ctx.loop = () => {
    const all = [...loops.values()];
    const latest = all.filter(l => l?.lastTickAt).sort((a, b) => (b?.lastTickAt ?? '').localeCompare(a?.lastTickAt ?? ''))[0];
    return { everyMinutes: options.everyMinutes, ...(latest ? { lastTickAt: latest.lastTickAt, lastExitCode: latest.lastExitCode } : {}) };
  };
  board.ctx.extraProblems = id => problems.get(id) ?? [];
  const report = (error: unknown) => { if (!stopped) options.print(`serve worker failed: ${(error as Error).message}`); };
  for (const [id, channel] of channels) {
    channel.worker.on('message', message => {
      if (stopped) return;
      if (message.event === 'readings') {
        (board.ctx.tickResults ??= {})[message.project] = message.result;
        board.ctx.tickRevision = (board.ctx.tickRevision ?? 0) + 1;
        board.invalidate();
        notifier.onTick(message.project, message.result as TickResult);
      }
      if (message.event === 'publish') {
        board.hub.scan();
        board.hub.publish(message.project, message.name, message.data);
        if (message.name === 'serve.notice') notifier.onNotice(message.data as A.StreamEvents['serve.notice']);
      }
      if (message.event === 'print') options.print(message.line);
      if (message.event === 'state') {
        for (const project of message.projects as ProjectConfig[]) {
          const at = options.projects.findIndex(p => p.id === project.id);
          if (at >= 0) options.projects[at] = project;
        }
        board.ctx.workers = message.workers;
        onProjectsReload?.(options.projects);
        onWorkersReload?.(message.workers);
        notifier.setProjects(options.projects);
        notifier.setWorkers(message.workers);
        loops.set(id, message.loop);
        problems.set(id, message.problems[id] ?? []);
        board.invalidate();
      }
    });
    channel.worker.on('error', error => {
      options.print(`serve worker of ${id} failed: ${error.message}`);
      recordExit('crashed', scrubSecrets(`serve worker of ${id} failed: ${error.message}`).slice(0, 300));
      stop();
    });
    channel.worker.on('exit', code => {
      if (!stopped) {
        options.print(`serve worker of ${id} exited (${code})`);
        recordExit('crashed', `serve worker of ${id} exited (${code})`);
        stop();
      }
    });
  }
  const channelOf = (id: string): WorkerChannel => {
    const channel = channels.get(id);
    if (!channel) throw new Error('No such project');
    return channel;
  };
  board.ctx.runTick = (project, real, maxDispatch) =>
    channelOf(project.id).call<TickResult>('manualTick', { project: project.id, real, maxDispatch, lang: currentLang() })
      .then(result => { if (real) notifier.onTick(project.id, result); return result; });
  const sessionControl: Serve['sessionControl'] = (project, action) => channelOf(project).call('sessionControl', { project, action });
  board.ctx.sessionControl = (project, action) => sessionControl(project.id, action);
  const tickNow: Serve['tickNow'] = source => {
    if (stopped) return;
    for (const [id, channel] of channels) {
      if (tickPending.has(id)) continue;
      tickPending.add(id);
      void channel.call('tick', source).catch(report).finally(() => { tickPending.delete(id); });
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    recordExit('clean');
    notifier.stop();
    cleanupCrash();
    board.hub.stop(); board.server.closeAllConnections(); board.server.close();
    // Give in-flight state writes and session shutdown time to finish before releasing the serve lock.
    const closeAll = () => Promise.allSettled([...channels.values()].map(c => c.close())).then(unlock);
    const deadline = setTimeout(() => { void closeAll(); }, 30_000).unref();
    void Promise.allSettled([...channels.values()].map(c => c.call('stop', null))).finally(() => { clearTimeout(deadline); void closeAll(); });
  };
  board.server.once('error', err => {
    recordExit('crashed', scrubSecrets(err.message).slice(0, 300));
    stop();
  });
  const pollNow = () => { for (const c of channels.values()) void c.call('poll', null).catch(report); };
  const recordEnds = () => Promise.all([...channels.values()].map(c => c.call<number>('ends', null))).then(counts => counts.reduce((a, b) => a + b, 0));
  return { board, server: board.server, tickNow, sessionControl, pollNow, recordEnds, stop };
}
