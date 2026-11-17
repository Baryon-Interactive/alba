import { acquireLock, lockFile, writeServeExit, type LockRelease } from './lock.ts';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createBoard } from '../web/server.ts';
import { writeKeyFile } from '../web/auth.ts';
import { systemProbes } from '../tick/gather.ts';
import { startCoordinator, type ServeOptions, type Serve } from './coordinator.ts';
import { WorkerChannel } from './channel.ts';
import { currentLang, t } from '../i18n.ts';
import type { TickResult } from '../tick/gather.ts';
import type { ProjectConfig } from '../config.ts';
import type * as A from '../api/types.ts';
import { newFleetLock } from './fleet.ts';
import { createNotifier } from '../notify/notifier.ts';
import { scrubSecrets } from '../notify/channels.ts';
import { Orders } from '../orders/service.ts';
import { stateStore, closeStateStores } from '../orders/backend.ts';
import { closeMachineStores } from '../resources/machine-store.ts';
import { attachServeReload, type ReloadController } from './reload.ts';
export type { ServeOptions, Serve } from './coordinator.ts';

export interface StartedServe extends Serve {
  readonly startedAt: string;
  emitReloadDone(from: number, gapMs: number): void;
}

/** HTTP/SSE stay here; the persistent worker owns ticks, finish checks, file polling and the producer session. */
export function startServe(options: ServeOptions): StartedServe {
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
  if (!options.takeoverAttempt) {
    notifier.onServeStart({ startedAt, previous });
  }

  let listenedOnce = false;
  board.server.once('listening', () => {
    listenedOnce = true;
    if (options.takeoverAttempt) {
      notifier.onServeStart({ startedAt, previous });
    }
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

  const currentPort = (): number | undefined => {
    const addr = board.server.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  };

  const emitReloadNotice = (
    kind: 'reload-started' | 'reload-refused' | 'reload-failed' | 'reload-done',
    text: string,
    extra: { from?: number; to?: number; gapMs?: number } = {},
  ) => {
    const at = options.probes.now().toISOString();
    options.print(text);
    for (const p of options.projects) {
      try {
        new Orders(stateStore(p), () => at, 'serve').record('*', kind, { text, ...extra });
      } catch { /* best-effort durable event */ }
      board.hub.scan?.();
      const payload: A.StreamEvents['serve.notice'] = { project: p.id, at, kind, text, ...extra };
      board.hub.publish(p.id, 'serve.notice', payload);
      if (background) notifier.onNotice(payload);
    }
  };

  const emitReloadDone = (from: number, gapMs: number) => {
    const port = currentPort() ?? options.port;
    emitReloadNotice(
      'reload-done',
      t('Reloaded alba serve on port {port}: pid {from} -> pid {to} (gap {gap} ms).', {
        port,
        from,
        to: process.pid,
        gap: gapMs,
      }),
      { from, to: process.pid, gapMs },
    );
  };

  let reloadCtrl: ReloadController | undefined;

  if (!background) {
    let fgStopped = false;
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
    const origStop = coordinator.stop;
    coordinator.stop = () => {
      fgStopped = true;
      reloadCtrl?.close();
      recordExit('clean');
      notifier.stop();
      cleanupCrash();
      const out = origStop();
      unlock();
      return out;
    };
    board.server.once('error', err => {
      fgStopped = true;
      reloadCtrl?.close();
      if (!options.takeoverAttempt || listenedOnce) {
        recordExit('crashed', scrubSecrets(err.message).slice(0, 300));
      }
      notifier.stop();
      cleanupCrash();
      unlock();
    });
    if (options.reload !== false) {
      reloadCtrl = attachServeReload({
        startedAt,
        projects: options.projects,
        workers: options.workers,
        everyMinutes: options.everyMinutes,
        maxDispatch: options.maxDispatch,
        signIn: options.signIn === true,
        extraOrigins: options.extraOrigins ?? [],
        port: currentPort,
        isStopped: () => fgStopped,
        notice: emitReloadNotice,
        async drainAndRelease(drainSeconds: number): Promise<string> {
          fgStopped = true;
          reloadCtrl?.close();
          await coordinator.drain?.(drainSeconds * 1000);
          recordExit('clean', 'reload');
          notifier.stop();
          cleanupCrash();
          closeStateStores();
          closeMachineStores();
          unlock();
          const closedAt = new Date().toISOString();
          board.hub.stop();
          board.server.closeAllConnections();
          if (board.server.listening) {
            await new Promise<void>(resolve => board.server.close(() => resolve()));
          } else {
            board.server.close();
          }
          return closedAt;
        },
      }, options.reload ?? {});
      board.onReload = req => reloadCtrl!.trigger(req);
    }
    return Object.assign(coordinator, { startedAt, emitReloadDone });
  }

  const { probes, print, onWorkersReload, onProjectsReload, notifySender, notifyMachineDir, reload: reloadOpt, takeoverAttempt, onReload: _onReload, ...data } = options;
  void takeoverAttempt;
  void _onReload;
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
      void stop();
    });
    channel.worker.on('exit', code => {
      if (!stopped) {
        options.print(`serve worker of ${id} exited (${code})`);
        recordExit('crashed', `serve worker of ${id} exited (${code})`);
        void stop();
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

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    reloadCtrl?.close();
    if (!options.takeoverAttempt || listenedOnce) {
      recordExit('clean');
    }
    notifier.stop();
    cleanupCrash();
    board.hub.stop();
    board.server.closeAllConnections();
    const serverClosed = board.server.listening
      ? new Promise<void>(resolve => board.server.close(() => resolve()))
      : (board.server.close(), Promise.resolve());
    let closedAll = false;
    const closeAll = () => {
      if (closedAll) return Promise.resolve();
      closedAll = true;
      return Promise.allSettled([...channels.values()].map(c => c.close()))
        .then(() => serverClosed)
        .then(() => {
          closeStateStores();
          closeMachineStores();
          unlock();
        });
    };
    stopPromise = new Promise<void>(resolve => {
      const deadline = setTimeout(() => { void closeAll().finally(resolve); }, 30_000);
      deadline.unref();
      void Promise.allSettled([...channels.values()].map(c => c.call('stop', null))).finally(() => {
        clearTimeout(deadline);
        void closeAll().finally(resolve);
      });
    });
    return stopPromise;
  };

  const drainAndRelease = async (drainSeconds: number): Promise<string> => {
    stopped = true;
    reloadCtrl?.close();
    const timeoutMs = Math.max(0, drainSeconds * 1000);
    let backstop: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...channels.values()].map(c => c.call('drain', { timeoutMs }))),
      new Promise<void>(resolve => { backstop = setTimeout(resolve, timeoutMs + 5_000); backstop.unref(); }),
    ]).finally(() => { if (backstop) clearTimeout(backstop); });
    await Promise.allSettled([...channels.values()].map(c => c.close()));
    recordExit('clean', 'reload');
    notifier.stop();
    cleanupCrash();
    closeStateStores();
    closeMachineStores();
    unlock();
    const closedAt = new Date().toISOString();
    board.hub.stop();
    board.server.closeAllConnections();
    if (board.server.listening) {
      await new Promise<void>(resolve => board.server.close(() => resolve()));
    } else {
      board.server.close();
    }
    return closedAt;
  };

  if (reloadOpt !== false) {
    reloadCtrl = attachServeReload({
      startedAt,
      projects: options.projects,
      workers: options.workers,
      everyMinutes: options.everyMinutes,
      maxDispatch: options.maxDispatch,
      signIn: options.signIn === true,
      extraOrigins: options.extraOrigins ?? [],
      port: currentPort,
      isStopped: () => stopped,
      notice: emitReloadNotice,
      drainAndRelease,
    }, reloadOpt ?? {});
    board.onReload = req => reloadCtrl!.trigger(req);
  }

  board.server.once('error', err => {
    if (!options.takeoverAttempt || listenedOnce) {
      recordExit('crashed', scrubSecrets(err.message).slice(0, 300));
    }
    void stop();
  });
  const pollNow = () => { for (const c of channels.values()) void c.call('poll', null).catch(report); };
  const recordEnds = () => Promise.all([...channels.values()].map(c => c.call<number>('ends', null))).then(counts => counts.reduce((a, b) => a + b, 0));
  return { board, server: board.server, startedAt, tickNow, sessionControl, pollNow, recordEnds, stop, emitReloadDone };
}
