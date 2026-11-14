import { existsSync, readFileSync, readSync, openSync, closeSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import type * as A from '../api/types.ts';
import { loadProject, type ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import path from 'node:path';
import { Orders } from '../orders/service.ts';
import { stateStore } from '../orders/backend.ts';
import { SqliteStore } from '../orders/sqlite-store.ts';
import { applyFinish, findFinishes } from '../run/finish.ts';
import { importTable } from '../table/import.ts';
import { classifyOrders } from '../routing/classify.ts';
import { executeTick } from '../tick/execute.ts';
import { formatReport } from '../tick/plan.ts';
import type { Board, ServerOptions } from '../web/server.ts';
import { loadWorkers, type WorkersFile } from '../workers/config.ts';
import { producerHeartbeat, producerPass } from '../producer/producer.ts';
import { directorMessages, updateDirectorMessage } from '../producer/conversation-state.ts';
import { producerSession, reconcileProducerSession, sessionEnabled, type ProducerSessionStatus } from '../producer/session.ts';
import { scheduledBrief } from '../producer/briefs.ts';
import { pollProducerWorks } from '../producer/work-sessions.ts';
import { scheduledRound } from '../producer/round.ts';
import { runMeasurements } from '../design/measure.ts';
import { runNightlyGates } from '../gates/runner.ts';
import { tick } from '../tick/gather.ts';
import { peerRunning, useFleetLock } from './fleet.ts';

export interface ServeOptions extends Omit<ServerOptions, 'loop' | 'workers'> {
  workers: WorkersFile;
  /** Minutes between ticks; 0 turns the loop off (the interface and the event trigger only wait). */
  everyMinutes: number;
  maxDispatch: number;
  print: (line: string) => void;
  /** How often the open runs are looked at to see whether a process ended. */
  watchMs?: number;
  /** After an end is noticed, a tick follows this soon (the order says: within a minute). */
  followUpMs?: number;
  /** How often the event logs, the dispatch tables and the configuration files are looked at (default 1000). */
  eventMs?: number;
  /** Triggers that come within this time of each other become one tick; a file must stay unchanged this long before it is read (default 3000). */
  debounceMs?: number;
  /** Read workers.yaml and the project files again when they change (default true). */
  reloadConfigs?: boolean;
  /** The other projects served with these, sharing the workers file: their open runs count against each worker's concurrency. */
  peerProjects?: ProjectConfig[];
  /** The serve's fleet lock (src/serve/fleet.ts), when each project runs in a thread of its own. */
  fleetLock?: SharedArrayBuffer;
}

/** Entries of the event log after which something may be dispatchable (or no longer blocked): a tick follows soon. */
const TRIGGERS = new Set(['order-added', 'order-updated', 'action-queue', 'action-release', 'action-rework', 'action-answer', 'action-approve', 'action-cancel', 'action-hold', 'report', 'run-end', 'question-answered']);
/** Who wrote the entry: the serve itself and the tick do not trigger another tick. */
const OWN_ACTORS = new Set(['serve', 'tick']);

export interface Serve {
  board: Board;
  server: Server;
  /** Runs one tick for every project now (the loop and the event trigger call this). */
  tickNow(source: 'schedule' | 'finish' | 'event' | 'start'): void;
  /** Looks at the event logs, the dispatch tables and the configuration files now (the timer does it every `eventMs`). */
  pollNow(): void;
  /** Records the end of runs whose process is gone, now; returns how many. */
  recordEnds(): number | Promise<number>;
  sessionControl(project: string, action: 'start' | 'stop'): Promise<ProducerSessionStatus>;
  stop(): void | Promise<void>;
}

/**
 * One foreground process: the board and interface, a tick loop, and an event trigger. When the process of a run the tool started ends,
 * its end is recorded at once and a tick follows within a minute, under the same caps and quota rules as any tick.
 * The state folders are locked while it runs, so a scheduled `alba tick` skips instead of doubling up.
 */
export function startCoordinator(options: ServeOptions, board: Board): Serve {
  useFleetLock(options.fleetLock);
  const state: { lastTickAt?: string; lastExitCode?: number } = {};
  const ordersFor = (p: ProjectConfig) => new Orders(stateStore(p), () => options.probes.now().toISOString(), 'serve');
  const sessions = new Map<string, ReturnType<typeof producerSession>>();
  const maintainSession = (manager: ReturnType<typeof producerSession>, startup: boolean) => {
    void manager.maintainWanted({ startup, now: options.probes.now() }).catch(e => options.print(t('producer session failed: {why}', { why: (e as Error).message.split('\n')[0] })));
  };
  for (const project of options.projects) {
    reconcileProducerSession(project);
    if (!sessionEnabled(project)) continue;
    const manager = producerSession(project, ordersFor(project), undefined, options.probes, options.workers.file);
    sessions.set(project.id, manager);
    maintainSession(manager, true);
  }
  const sessionControl: Serve['sessionControl'] = async (id, action) => {
    const project = options.projects.find(p => p.id === id);
    if (!project) throw new Error('No such project');
    const guest = producerSession(project, ordersFor(project), undefined, options.probes, options.workers.file);
    sessions.set(id, guest);
    const status = action === 'start' ? await guest.start('', true, true) : await guest.stop(true);
    board.invalidate();
    return status;
  };
  board.ctx.sessionControl = (project, action) => sessionControl(project.id, action);
  // Interrupted turns are visible errors after a restart; never replay a possibly executed proposal.
  for (const project of options.projects) for (const message of directorMessages(project).filter(m => m.status === 'running')) updateDirectorMessage(project, message.id, { status: 'error', error: 'Producer chat was interrupted; send a new message to retry.' });
  const chatTimer = setInterval(() => {
    for (const project of options.projects) {
      if (!directorMessages(project).some(m => m.status === 'queued')) continue;
      const guest = producerSession(project, ordersFor(project), undefined, options.probes, options.workers.file);
      sessions.set(project.id, guest);
      void guest.processChat().then(() => { board.invalidate();  }).catch(e => options.print(String(e)));
    }
  }, 250);
  chatTimer.unref();
  const briefPass = () => {
    for (const project of options.projects) {
      if (!project.producer.brief) continue;
      const guest = sessions.get(project.id);
      void scheduledBrief(project, ordersFor(project), { now: options.probes.now().toISOString(), rewrite: guest ? (text, language) => guest.rewriteBrief(text, language) : undefined })
        .then(brief => { if (brief) board.invalidate(); }).catch(e => options.print(`Producer brief failed: ${String(e)}`));
    }
  };
  const briefTimer = setInterval(briefPass, 30_000);
  briefTimer.unref();
  const lastSignature = new Map<string, string>();
  let followUp: NodeJS.Timeout | undefined;

  board.ctx.loop = () => ({ everyMinutes: options.everyMinutes, ...state });

  for (const project of options.projects) try { producerHeartbeat(project, options.probes.now()); } catch (e) { options.print(t('producer heartbeat failed: {why}', { why: (e as Error).message.split('\n')[0] })); }
  const producerTimer = setInterval(() => { for (const project of options.projects) try { producerHeartbeat(project, options.probes.now()); } catch { /* retry on the next interval */ } }, 60_000);
  producerTimer.unref();

  // A slow quota command is read at most once a minute whatever the number of ticks; memory is read fresh for every tick that may start something.
  const tickProbes = { ...board.ctx.slow, freeRamGb: () => options.probes.freeRamGb() };
  let workers = options.workers;
  // The projects that share the workers file with `project`: served in other threads, or the other projects of this coordinator.
  const peersOf = (project: ProjectConfig) => [...(options.peerProjects ?? []), ...options.projects.filter(p => p.id !== project.id)];
  const peers = (project: ProjectConfig) => () => peerRunning(peersOf(project), workers);
  const measuring = new Map<string, Promise<unknown>>();
  const measurePass = () => {
    for (const project of options.projects) {
      if (!project.design?.enabled || measuring.has(project.id)) continue;
      const orders = ordersFor(project);
      const pending = () => tick(project, orders, workers, tickProbes, { record: false, peers: peers(project)() }).report.moves.some(m => m.mode !== 'card');
      const job = runMeasurements(project, orders, { freeRamGb: () => options.probes.freeRamGb(), ordersFirst: pending })
        .then(results => { if (results.some(r => r.status === 'ok' || r.status === 'failed')) board.invalidate(); })
        .catch(e => options.print(`Design measurement failed: ${String(e)}`)).finally(() => measuring.delete(project.id));
      measuring.set(project.id, job);
    }
  };
  const measureTimer = setInterval(measurePass, 30_000);
  measureTimer.unref();
  const gating = new Map<string, Promise<unknown>>();
  const gatesPass = () => {
    for (const project of options.projects) {
      if (gating.has(project.id)) continue;
      const orders = ordersFor(project);
      const job = runNightlyGates(project, orders, { clock: () => options.probes.now(), freeRamGb: () => options.probes.freeRamGb() })
        .then(result => { if (result.run) board.invalidate(); })
        .catch(e => options.print(`Nightly gates failed: ${String(e)}`)).finally(() => gating.delete(project.id));
      gating.set(project.id, job);
    }
  };
  const gatesTimer = setInterval(gatesPass, 30_000);
  gatesTimer.unref();
  const roundPass = () => {
    for (const project of options.projects) try {
      reconcileProducerSession(project);
      // Detached work (a person's "draft again", work started before the session was turned off) is reconciled whether
      // or not a router session runs: its result, usage and time limit do not wait for one.
      if (project.producer.enabled) pollProducerWorks(project, options.probes);
      if (sessionEnabled(project)) sessions.set(project.id, producerSession(project, ordersFor(project), undefined, options.probes, options.workers.file));
      const session = sessions.get(project.id);
      if (session) {
        maintainSession(session, false);
        void session.onPass().catch(e => options.print(`Producer work reconciliation failed: ${String(e)}`));
      }
      const round = scheduledRound(project, ordersFor(project), { probes: options.probes, workers });
      if (!round) continue;
      board.invalidate();
      const guest = sessions.get(project.id);
      if (guest) void guest.onPass(round.cases).catch(e => options.print(`Producer round session failed: ${String(e)}`));
    } catch (e) { options.print(`Producer round failed: ${String(e)}`); }
  };
  const roundTimer = setInterval(roundPass, 30_000);
  roundTimer.unref();
  roundPass();

  let ticking = false;
  const tickNow = (source: 'schedule' | 'finish' | 'event' | 'start'): void => {
    if (ticking) return;
    ticking = true;
    try {
      const lines: string[] = [];
      for (const project of options.projects) {
        try {
          const session = sessions.get(project.id);
          if (session) session.project = project;
          if (!sessionEnabled(project) && session && !directorMessages(project).some(m => m.status === 'running')) { void session.stop(); sessions.delete(project.id); }
          reconcileProducerSession(project);
          if (sessionEnabled(project) && !sessions.has(project.id)) sessions.set(project.id, producerSession(project, ordersFor(project), undefined, options.probes, options.workers.file));
          const result = executeTick({ project, orders: ordersFor(project), workers, probes: tickProbes, peers: peers(project) }, { maxDispatch: options.maxDispatch });
          board.ctx.onReadings?.(project.id, result);
          const r = result.report;
          const open = producerPass(project, ordersFor(project), { tick: r, workers: result.workers, workersFile: workers, now: options.probes.now(), env: { workers, probes: options.probes } });
          const guest = sessions.get(project.id); if (guest) void guest.onPass(open).catch(e => options.print(t('producer session failed: {why}', { why: (e as Error).message.split('\n')[0] })));
          state.lastTickAt = r.at;
          state.lastExitCode = r.exitCode;
          // The HTTP worker bridge flushes durable events before forwarding a publication.
          // Foreground coordinators need the same ordering without waiting for filesystem watchers.
          board.hub.scan?.();
          board.hub.publish(project.id, 'tick.done', { project: project.id, at: r.at, source, real: true, exitCode: r.exitCode, done: r.done, problems: r.problems.length });
          const signature = JSON.stringify({ ...r, at: undefined });
          lines.push(`${options.projects.length > 1 || options.peerProjects?.length ? `[${project.id}] ` : ''}${signature === lastSignature.get(project.id) ? t('tick ({source}): nothing changed (exit {code})', { source, code: r.exitCode }) : formatReport(r, false)}`);
          lastSignature.set(project.id, signature);
        } catch (e) {
          lines.push(`[${project.id}] ${t('tick ({source}) failed: {why}', { source, why: (e as Error).message.split('\n')[0] })}`);
        }
      }
      briefPass();
      board.invalidate();
      for (const line of lines) options.print(line);
      measurePass();
      gatesPass();
    } finally { ticking = false; }
  };

  const recordEnds = (): number => {
    let n = 0;
    for (const project of options.projects) {
      const orders = ordersFor(project);
      for (const f of findFinishes(project, orders, options.probes, workers)) {
        applyFinish(orders, f, project);
        n++;
        options.print(t('{tag}: run {run} ended: {outcome} ({why})', { tag: f.tag, run: f.run, outcome: f.outcome, why: f.why }));
      }
    }
    if (n) board.invalidate();
    return n;
  };

  const notice = (project: string, kind: A.StreamEvents['serve.notice']['kind'], text: string) => {
    board.hub.publish(project, 'serve.notice', { project, at: options.probes.now().toISOString(), kind, text });
    options.print(text);
  };

  // Triggers from any process: the event logs are read from where they ended when serve started; a few seconds of triggers become one tick.
  const debounceMs = options.debounceMs ?? 3000;
  let eventTick: NodeJS.Timeout | undefined;
  const scheduleTick = () => {
    if (eventTick) return;
    eventTick = setTimeout(() => { eventTick = undefined; tickNow('event'); }, debounceMs);
    eventTick.unref();
  };
  const sizeOf = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
  const logMarks = new Map<string, number>(options.projects.map(p => { const store = stateStore(p); return [p.id, store instanceof SqliteStore ? store.lastEventId() : sizeOf(path.join(p.state_dir, 'events.jsonl'))]; }));
  const readNew = (file: string, from: number, to: number): string => {
    const fd = openSync(file, 'r');
    try { const b = Buffer.alloc(to - from); readSync(fd, b, 0, b.length, from); return b.toString('utf8'); } finally { closeSync(fd); }
  };
  const pollEvents = () => {
    for (const p of options.projects) {
      const store = stateStore(p);
      if (store instanceof SqliteStore) {
        const events = store.eventsAfter(logMarks.get(p.id) ?? 0);
        if (events.length) logMarks.set(p.id, events.at(-1)!.id);
        if (events.some(e => TRIGGERS.has(e.type) && !OWN_ACTORS.has(e.by ?? ''))) scheduleTick();
        continue;
      }
      const file = path.join(p.state_dir, 'events.jsonl');
      const size = sizeOf(file);
      let from = logMarks.get(p.id) ?? 0;
      if (size < from) from = 0;                                        // the log was replaced
      if (size === from) { logMarks.set(p.id, size); continue; }
      const text = readNew(file, from, size);
      const cut = text.lastIndexOf('\n');                              // a half-written last line is read next time
      if (cut < 0) continue;
      logMarks.set(p.id, from + Buffer.byteLength(text.slice(0, cut + 1)));
      for (const line of text.slice(0, cut).split('\n')) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line) as { type: string; by?: string }; if (TRIGGERS.has(e.type) && !OWN_ACTORS.has(e.by ?? '')) { scheduleTick(); break; } } catch { /* skip */ }
      }
    }
  };

  // Files that change by hand: the dispatch tables (imported when they have been quiet for a moment) and the configuration (reloaded when valid).
  const signatureOf = (file: string | undefined): string => { try { const s = statSync(file!); return `${s.mtimeMs}:${s.size}`; } catch { return ''; } };
  interface Watched { file: string; seen: string; pending?: { sig: string; since: number } }
  const watch = (file: string): Watched => ({ file, seen: signatureOf(file) });
  const quiet = (w: Watched): boolean => {
    const sig = signatureOf(w.file);
    if (sig === w.seen) { w.pending = undefined; return false; }
    if (!w.pending || w.pending.sig !== sig) { w.pending = { sig, since: Date.now() }; return false; }   // still changing
    if (Date.now() - w.pending.since < debounceMs) return false;
    w.seen = sig; w.pending = undefined;
    return true;
  };
  const tables = options.projects.filter(p => p.dispatch_table).map(p => ({ id: p.id, watched: watch(p.dispatch_table!.file) }));
  const configProblems = new Map<string, string>();
  board.ctx.extraProblems = project => [...configProblems.entries()].filter(([key]) => key === '*' || key === project || key.startsWith(`${project}:`)).map(([, text]) => ({ kind: 'config', text }));
  const workersWatch = options.reloadConfigs === false || !options.workers.file ? undefined : watch(options.workers.file);
  // the skill registry may live in a skills.yaml next to the workers file (it is read together with it)
  const skillsWatch = options.reloadConfigs === false || !options.workers.file ? undefined : watch(path.join(path.dirname(path.resolve(options.workers.file)), 'skills.yaml'));
  const projectWatches = options.reloadConfigs === false ? [] : options.projects.map((p, index) => ({ index, id: p.id, stateDir: p.state_dir, watched: watch(p.file) }));

  const pollFiles = () => {
    for (const tb of tables) {
      if (!quiet(tb.watched)) continue;
      const project = options.projects.find(p => p.id === tb.id)!;
      try {
        const r = importTable(ordersFor(project), project.dispatch_table!, readFileSync(project.dispatch_table!.file, 'utf8'));
        notice(project.id, 'table-imported', t('The dispatch table changed: imported (created {c}, updated {u}).', { c: r.created.length, u: r.updated.length }));
        scheduleTick();
        // what the new and changed orders are: the rules answer at once, the classifier worker (when the project has one) in the background
        const orders = ordersFor(project);
        const touched = new Set([...r.created, ...r.updated]);
        void classifyOrders({ project, orders, workers, probes: options.probes }, { tags: orders.all().filter(d => !d.order.routing || touched.has(d.order.tag)).map(d => d.order.tag), model: !!project.classifier?.worker })
          .then(done => { if (done.some(o => o.asked)) scheduleTick(); })
          .catch(e => options.print(t('classifying orders failed: {why}', { why: (e as Error).message.split('\n')[0] })));
      } catch (e) {
        notice(project.id, 'table-import-failed', t('The dispatch table changed but cannot be imported: {why}', { why: (e as Error).message.split('\n')[0] }));
      }
    }
    const workersChanged = workersWatch ? quiet(workersWatch) : false;
    const skillsChanged = skillsWatch ? quiet(skillsWatch) : false;
    if (workersWatch && (workersChanged || skillsChanged)) {
      const which = workersChanged ? path.basename(workersWatch.file) : 'skills.yaml';
      try {
        workers = loadWorkers(workersWatch.file);
        board.ctx.workers = workers;
        configProblems.delete('*');
        for (const p of options.projects) notice(p.id, 'config-reloaded', t('{file} changed: reloaded ({n} workers).', { file: which, n: workers.workers.length }));
        scheduleTick();
      } catch (e) {
        const why = (e as Error).message.split('\n')[0];
        configProblems.set('*', t('{file} changed but is not valid; the old one is still in use: {why}', { file: which, why }));
        for (const p of options.projects) notice(p.id, 'config-invalid', configProblems.get('*')!);
      }
    }
    for (const w of projectWatches) {
      if (!quiet(w.watched)) continue;
      const key = `${w.id}:file`;
      try {
        const next = loadProject(w.watched.file);
        if (next.id !== w.id) throw new Error(t('the project id changed ({a} to {b}); restart alba serve for that', { a: w.id, b: next.id }));
        if (next.state.backend !== options.projects[w.index].state.backend) throw new Error(t('State backend changed; restart alba serve for that.'));
        if (path.resolve(next.state_dir) !== path.resolve(w.stateDir)) throw new Error(t('state_dir changed; restart alba serve for that'));
        options.projects[w.index] = next;
        configProblems.delete(key);
        notice(w.id, 'config-reloaded', t('{file} changed: reloaded.', { file: path.basename(w.watched.file) }));
        scheduleTick();
      } catch (e) {
        const why = (e as Error).message.split('\n')[0];
        configProblems.set(key, t('{file} changed but is not valid; the old one is still in use: {why}', { file: path.basename(w.watched.file), why }));
        notice(w.id, 'config-invalid', configProblems.get(key)!);
      }
    }
  };
  const pollNow = () => {
    try { pollEvents(); } catch (e) { options.print(t('end check failed: {why}', { why: (e as Error).message.split('\n')[0] })); }
    try { pollFiles(); } catch (e) { options.print(t('end check failed: {why}', { why: (e as Error).message.split('\n')[0] })); }
  };
  const poller = setInterval(pollNow, options.eventMs ?? 1000);
  poller.unref();

  // The event trigger: a run's process is gone -> record the end now, tick soon.
  const watcher = setInterval(() => {
    let ended = 0;
    try { ended = recordEnds(); } catch (e) { options.print(t('end check failed: {why}', { why: (e as Error).message.split('\n')[0] })); }
    if (ended && !followUp) {
      followUp = setTimeout(() => { followUp = undefined; tickNow('finish'); }, options.followUpMs ?? 5000);
      followUp.unref();
    }
  }, options.watchMs ?? 5000);
  watcher.unref();

  let loop: NodeJS.Timeout | undefined;
  if (options.everyMinutes > 0) {
    board.server.once('listening', () => setTimeout(() => tickNow('start'), 1000).unref());
    loop = setInterval(() => tickNow('schedule'), options.everyMinutes * 60_000);
    loop.unref();
  }

  const stop = () => {
    clearInterval(watcher);
    clearInterval(poller);
    if (eventTick) clearTimeout(eventTick);
    if (loop) clearInterval(loop);
    if (followUp) clearTimeout(followUp);
    clearInterval(producerTimer);
    clearInterval(briefTimer);
    clearInterval(roundTimer);
    clearInterval(chatTimer);
    clearInterval(measureTimer);
    clearInterval(gatesTimer);
    const stoppedSessions = [...sessions.values()].map(session => session.stop());
    board.hub.stop();
    board.server.closeAllConnections();
    board.server.close();
    return Promise.allSettled([...stoppedSessions, ...measuring.values(), ...gating.values()]).then(() => {});
  };
  return { board, server: board.server, tickNow, pollNow, recordEnds, sessionControl, stop };
}
