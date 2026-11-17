import os from 'node:os';
import type * as A from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { stateStore } from '../orders/backend.ts';
import { Orders } from '../orders/service.ts';
import { machineDir } from '../resources/machine-store.ts';
import { workerTrip } from '../routing/breaker.ts';
import { endpointOf } from '../run/endpoint.ts';
import { openQuestions } from '../run/messages.ts';
import type { PreviousServeEnd } from '../serve/lock.ts';
import type { TickResult } from '../tick/gather.ts';
import { ownerOf } from '../usage/spend.ts';
import type { WorkersFile } from '../workers/config.ts';
import {
  formatFailureLine,
  inspectChannel,
  scrubSecrets,
  sendChannel,
  type ChannelSendOptions,
  type NotifyPayload,
  type SendResult,
} from './channels.ts';
import {
  effectiveChannelsFor,
  isInQuietHours,
  parseClockMinutes,
  type NotifyChannelConfig,
  type NotifyConfig,
  type TriggerConfig,
  type TriggerName,
} from './config.ts';
import {
  readNotifyState,
  updateNotifyState,
  type ConditionState,
  type NotifyStateFile,
} from './state.ts';

export type ChannelSender = (
  channelId: string,
  channel: NotifyChannelConfig,
  payload: NotifyPayload,
) => Promise<SendResult>;

export interface NotifierOptions {
  projects: ProjectConfig[];
  workers: WorkersFile;
  clock?: () => Date;
  print?: (line: string) => void;
  machineDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  host?: string;
  sender?: ChannelSender;
  sendOptions?: ChannelSendOptions;
  timerMs?: number;
  orderReader?: (project: ProjectConfig) => Orders;
}

interface ObservedCondition {
  key: string;
  trigger: TriggerName;
  originAt?: string;
  project?: string;
  tag?: string;
  worker?: string;
  instance?: string;
  buildMessage: (sinceIso: string, now: Date) => { title: string; text: string };
}

interface QueuedDelivery {
  to: string[];
  payload: NotifyPayload;
}

const STALL_PROBLEM_KINDS = new Set(['stalled', 'looping', 'start-failed', 'lingering', 'silent-end']);
const DAY_MS = 24 * 3600 * 1000;

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatDurationMs(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (hours < 48) return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

const formatAge = (now: Date, sinceIso: string): string => {
  const parsed = Date.parse(sinceIso);
  if (!Number.isFinite(parsed)) return '0s';
  return formatDurationMs(now.getTime() - parsed);
};

function clampNotFuture(iso: string | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > now.getTime() ? now.toISOString() : new Date(parsed).toISOString();
}

function currentReportOf(doc: ReturnType<Orders['all']>[number]) {
  let lastReset = 0;
  for (const a of [...doc.actions].sort((x, y) => x.seq - y.seq)) {
    if (a.kind === 'message' && a.queued) continue;
    if (a.kind === 'queue' || a.kind === 'answer' || a.kind === 'rework' || a.kind === 'monitor' || a.kind === 'message') {
      lastReset = a.seq;
    }
  }
  const lastStart = doc.runs.reduce((n, r) => Math.max(n, r.seq), 0);
  const cutoff = Math.max(lastReset, lastStart);
  return [...doc.reports].filter(r => r.seq > cutoff).sort((x, y) => y.seq - x.seq)[0];
}

export class Notifier {
  private projects: ProjectConfig[];
  private workers: WorkersFile;
  private readonly clock: () => Date;
  private readonly print: (line: string) => void;
  private readonly dir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly host: string;
  private readonly sender: ChannelSender;
  private readonly timerMs: number;
  private readonly orderReader: (project: ProjectConfig) => Orders;
  private timer?: NodeJS.Timeout;
  private warnedUnconfigured = false;
  private readonly lastTicks = new Map<string, TickResult>();
  private readonly seenStallStopRuns = new Map<string, string>();
  private readonly pendingDeliveries = new Set<Promise<void>>();

  constructor(options: NotifierOptions) {
    this.projects = [...options.projects];
    this.workers = options.workers;
    this.clock = options.clock ?? (() => new Date());
    this.print = options.print ?? (line => process.stderr.write(`${line}\n`));
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.dir = options.machineDir ?? machineDir(this.env);
    this.host = options.host ?? os.hostname();
    this.timerMs = options.timerMs ?? 60_000;
    this.orderReader = options.orderReader ?? (project => new Orders(stateStore(project)));
    const sendOpts = options.sendOptions;
    this.sender = options.sender ?? ((_id, channel, payload) =>
      sendChannel(channel, payload, { env: this.env, platform: this.platform, ...sendOpts }));
    this.syncTimer();
  }

  private get config(): NotifyConfig | undefined {
    return this.workers.notify;
  }

  setProjects(projects: ProjectConfig[]): void {
    this.projects = [...projects];
  }

  setWorkers(workers: WorkersFile): void {
    const hadNotify = Boolean(this.workers.notify);
    this.workers = workers;
    if (!hadNotify && workers.notify) {
      this.warnUnconfiguredOnce();
    }
    this.syncTimer();
  }

  private syncTimer(): void {
    if (!this.config || this.timerMs <= 0) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        try { this.step(); } catch (err) { this.print(`notify check failed: ${scrubSecrets((err as Error).message)}`); }
      }, this.timerMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async flush(): Promise<void> {
    while (this.pendingDeliveries.size > 0) {
      await Promise.allSettled([...this.pendingDeliveries]);
    }
  }

  private warnUnconfiguredOnce(): void {
    const cfg = this.config;
    if (!cfg || this.warnedUnconfigured) return;
    this.warnedUnconfigured = true;
    for (const [id, ch] of Object.entries(cfg.channels)) {
      const info = inspectChannel(id, ch, this.env, this.platform);
      if (info.status === 'not configured') {
        this.print(`notify: channel "${id}" is not configured (${info.reason})`);
      } else if (info.status === 'not available') {
        this.print(`notify: channel "${id}" is not available (${info.reason})`);
      }
    }
  }

  private triggerMatchesProject(cfg: TriggerConfig, projectId?: string): boolean {
    if (!cfg.projects || !cfg.projects.length) return true;
    if (projectId !== undefined) return cfg.projects.includes(projectId);
    return this.projects.some(p => cfg.projects!.includes(p.id));
  }

  /** Called once when `alba serve` starts, reporting how the previous serve ended. */
  onServeStart(input: { startedAt: string; previous: PreviousServeEnd }): void {
    const cfg = this.config;
    if (!cfg) return;
    this.warnUnconfiguredOnce();
    const now = this.clock();
    const nowIso = now.toISOString();
    const deliveries: QueuedDelivery[] = [];

    updateNotifyState(this.dir, now, state => {
      if (input.previous.how !== 'none') {
        state.restarts.push({ at: nowIso, how: input.previous.how, pid: input.previous.pid });
      }
      if (input.previous.how === 'clean') {
        const existing = state.conditions['serve-crashed'];
        if (existing && !existing.cleared_at) existing.cleared_at = nowIso;
      } else if (input.previous.how === 'crashed' || input.previous.how === 'killed') {
        const prev = input.previous;
        const instance = `${prev.pid}:${prev.started}`;
        const existing = state.conditions['serve-crashed'];
        if (!existing || existing.cleared_at !== undefined || existing.instance !== instance) {
          if (existing && !existing.cleared_at && existing.instance !== instance) {
            existing.cleared_at = nowIso;
          }
          const originAt = prev.how === 'crashed' ? (clampNotFuture(prev.ended_at, now) ?? nowIso) : nowIso;
          const startedMs = Date.parse(prev.started);
          const uptimeText = prev.how === 'crashed' && Number.isFinite(startedMs) && Number.isFinite(Date.parse(prev.ended_at))
            ? formatDurationMs(Math.max(0, Date.parse(prev.ended_at) - startedMs))
            : Number.isFinite(startedMs)
              ? `up to ${formatDurationMs(Math.max(0, now.getTime() - startedMs))} (ended without a word)`
              : 'unknown';
          const detail = prev.how === 'crashed'
            ? `crashed${prev.why ? `: ${scrubSecrets(prev.why)}` : ''}`
            : 'ended without a word';
          const obs: ObservedCondition = {
            key: 'serve-crashed',
            trigger: 'serve-crashed',
            originAt,
            instance,
            buildMessage: () => ({
              title: `alba serve ${prev.how === 'crashed' ? 'crashed' : 'ended without a word'} (pid ${prev.pid})`,
              text: `Previous alba serve (pid ${prev.pid}, started ${prev.started}, uptime ${uptimeText}) ${detail}.`,
            }),
          };
          this.applyObserved(state, cfg, obs, now, deliveries);
        }
      }
      this.processScheduleInState(state, cfg, now, deliveries);
    });

    this.dispatchDeliveries(deliveries);
  }

  /** Called on every `serve.notice` publication (e.g. immediate `silent-end` from the 5 s process check). */
  onNotice(notice: A.StreamEvents['serve.notice']): void {
    const cfg = this.config;
    if (!cfg) return;
    if (notice.kind !== 'silent-end' || !notice.tag) return;
    if (!this.triggerMatchesProject(cfg.triggers['run-stalled'], notice.project)) return;

    const now = this.clock();
    const project = this.projects.find(p => p.id === notice.project);
    const continueNote = this.stallContinueStatus(project, notice.tag, []);
    const key = `run-stalled:${notice.project}:${notice.tag}:silent-end`;
    const deliveries: QueuedDelivery[] = [];

    updateNotifyState(this.dir, now, state => {
      this.applyObserved(state, cfg, {
        key,
        trigger: 'run-stalled',
        originAt: clampNotFuture(notice.at, now),
        project: notice.project,
        tag: notice.tag,
        buildMessage: () => ({
          title: `[${notice.project}] ${notice.tag} silent-end`,
          text: `[${notice.project}] ${scrubSecrets(notice.text)} (${continueNote})`,
        }),
      }, now, deliveries);
      this.processScheduleInState(state, cfg, now, deliveries);
    });

    this.dispatchDeliveries(deliveries);
  }

  /** Called when a project finishes a tick in foreground or background mode. */
  onTick(projectId: string, result: TickResult): void {
    this.lastTicks.set(projectId, result);
    const cfg = this.config;
    if (!cfg) return;
    const now = this.clock();
    const nowIso = now.toISOString();
    const project = this.projects.find(p => p.id === projectId);
    const storeSnapshot = this.readProjectOrders(project);
    const deliveries: QueuedDelivery[] = [];

    updateNotifyState(this.dir, now, state => {
      // 1. quota-unreadable (shared per worker, not per project)
      if (this.triggerMatchesProject(cfg.triggers['quota-unreadable'], projectId)) {
        const workerConfigs = this.workers.workers.length ? this.workers.workers : result.workers.map(w => w.config);
        const activeWorkerIds = new Set<string>();
        for (const w of workerConfigs) {
          activeWorkerIds.add(w.id);
          const qKey = `quota-unreadable:${w.id}`;
          if (!w.enabled || !w.quota) {
            this.clearKey(state, qKey, nowIso);
            continue;
          }
          const reading = result.quotas.find(q => q.source === w.quota);
          if (!reading || !reading.ok) {
            const errorText = scrubSecrets(reading?.error ?? 'no reading');
            this.applyObserved(state, cfg, {
              key: qKey,
              trigger: 'quota-unreadable',
              worker: w.id,
              buildMessage: (sinceIso, curNow) => ({
                title: `Quota unreadable: ${w.id}`,
                text: `Worker ${w.id} quota (${w.quota}) unreadable for ${formatAge(curNow, sinceIso)}: ${errorText}`,
              }),
            }, now, deliveries);
          } else {
            this.clearKey(state, qKey, nowIso);
          }
        }
        for (const key of Object.keys(state.conditions)) {
          if (key.startsWith('quota-unreadable:')) {
            const wId = key.slice('quota-unreadable:'.length);
            if (!activeWorkerIds.has(wId)) this.clearKey(state, key, nowIso);
          }
        }
      }

      // 2. run-stalled per project+tag+kind
      const activeStallKeys = new Set<string>();
      if (this.triggerMatchesProject(cfg.triggers['run-stalled'], projectId)) {
        for (const p of result.report.problems) {
          if (!STALL_PROBLEM_KINDS.has(p.kind) || !p.tag) continue;
          const key = `run-stalled:${projectId}:${p.tag}:${p.kind}`;
          activeStallKeys.add(key);
          const continueNote = this.stallContinueStatus(project, p.tag, result.report.done, storeSnapshot);
          this.applyObserved(state, cfg, {
            key,
            trigger: 'run-stalled',
            project: projectId,
            tag: p.tag,
            buildMessage: () => ({
              title: `[${projectId}] ${p.tag} ${p.kind}`,
              text: `[${projectId}] ${scrubSecrets(p.text)} (${continueNote})`,
            }),
          }, now, deliveries);
        }
        // Also catch runs stopped by `dispatch.on_stall: continue` inside `executeTick` before the final gather pass.
        if (storeSnapshot && result.report.done.length > 0) {
          for (const doc of storeSnapshot.docs) {
            const tag = doc.order.tag;
            const key = `run-stalled:${projectId}:${tag}:stalled`;
            if (activeStallKeys.has(key)) continue;
            const events = storeSnapshot.orders.store.events({ tag });
            const latestStallStop = [...events].reverse().find(e => e.type === 'stall-stopped');
            const runId = typeof latestStallStop?.data?.run === 'string' ? latestStallStop.data.run : undefined;
            const markerKey = `${projectId}:${tag}`;
            const doneMatched = result.report.done.some(line => line.startsWith(`${tag}:`) && line.includes('(stalled'));
            if (latestStallStop && runId && (doneMatched || this.seenStallStopRuns.get(markerKey) !== runId)) {
              if (doneMatched) {
                this.seenStallStopRuns.set(markerKey, runId);
                activeStallKeys.add(key);
                const continued = latestStallStop.data?.continued === true;
                const continueNote = continued
                  ? 'on_stall: continue already acted (queued one continuation)'
                  : 'on_stall: continue already acted once; stopped for a person';
                this.applyObserved(state, cfg, {
                  key,
                  trigger: 'run-stalled',
                  project: projectId,
                  tag,
                  buildMessage: () => ({
                    title: `[${projectId}] ${tag} stalled`,
                    text: `[${projectId}] ${tag}: run ${runId} stalled (${continueNote})`,
                  }),
                }, now, deliveries);
              } else if (!this.seenStallStopRuns.has(markerKey)) {
                this.seenStallStopRuns.set(markerKey, runId);
              }
            }
          }
        }
      }
      const stallPrefix = `run-stalled:${projectId}:`;
      for (const key of Object.keys(state.conditions)) {
        if (key.startsWith(stallPrefix) && !activeStallKeys.has(key)) {
          this.clearKey(state, key, nowIso);
        }
      }

      // 3. machine-down per machine or endpoint
      const projectMachineTargets = new Map<string, { text: string; worker?: string }>();
      if (this.triggerMatchesProject(cfg.triggers['machine-down'], projectId)) {
        const grouped = new Map<string, { parts: string[]; worker?: string }>();
        for (const p of result.report.problems) {
          if (p.kind === 'machine-down') {
            const machineId = p.evidence?.[0]
              ?? /^machine\s+([^\s:]+):/i.exec(p.text)?.[1]
              ?? /^([^\s:]+):/.exec(p.text)?.[1]
              ?? 'machines';
            const key = `machine-down:${machineId}`;
            const entry = grouped.get(key) ?? { parts: [] };
            entry.parts.push(scrubSecrets(p.text));
            grouped.set(key, entry);
          } else if (p.kind === 'launch' && /endpoint unreachable/i.test(p.text)) {
            const workerId = /^([^:\uff1a]+)[:\uff1a]/.exec(p.text)?.[1]?.trim();
            const workerCfg = result.workers.find(w => w.config.id === workerId)?.config
              ?? this.workers.workers.find(w => w.id === workerId);
            const ep = endpointOf(workerCfg);
            const target = ep ? `endpoint:${ep.label}` : `endpoint:${workerId ?? 'unknown'}`;
            const key = `machine-down:${target}`;
            const entry = grouped.get(key) ?? { parts: [], ...(workerId ? { worker: workerId } : {}) };
            entry.parts.push(scrubSecrets(p.text));
            grouped.set(key, entry);
          }
        }
        for (const [key, value] of grouped) {
          projectMachineTargets.set(key, { text: value.parts.join('; '), ...(value.worker ? { worker: value.worker } : {}) });
        }
      }
      for (const [key, item] of projectMachineTargets) {
        const cur = state.conditions[key];
        const projects = cur && !cur.cleared_at
          ? [...new Set([...(cur.projects ?? []), projectId])]
          : [projectId];
        const targetLabel = key.slice('machine-down:'.length);
        this.applyObserved(state, cfg, {
          key,
          trigger: 'machine-down',
          ...(item.worker ? { worker: item.worker } : {}),
          buildMessage: (sinceIso, curNow) => ({
            title: `Machine down: ${targetLabel}`,
            text: `${item.text} (for ${formatAge(curNow, sinceIso)})`,
          }),
        }, now, deliveries);
        state.conditions[key].projects = projects;
      }
      for (const [key, entry] of Object.entries(state.conditions)) {
        if (!key.startsWith('machine-down:') || entry.cleared_at || projectMachineTargets.has(key)) continue;
        if (entry.projects?.length) {
          entry.projects = entry.projects.filter(id => id !== projectId);
          if (entry.projects.length === 0) this.clearKey(state, key, nowIso);
        } else {
          this.clearKey(state, key, nowIso);
        }
      }

      // 4. Waiting & breaker triggers for this project (also evaluated on the 60 s timer)
      this.evaluateProjectStoreInState(state, cfg, projectId, project, storeSnapshot, result, now, deliveries);

      // 5. Quiet hours release & daily digest
      this.processScheduleInState(state, cfg, now, deliveries);
    });

    this.dispatchDeliveries(deliveries);
  }

  /** Periodic 60 s read-only check of order stages, breaker pauses, quiet hours end and daily digest. */
  step(): void {
    const cfg = this.config;
    if (!cfg) return;
    const now = this.clock();
    const snapshots = this.projects.map(project => ({
      project,
      store: this.readProjectOrders(project),
      lastTick: this.lastTicks.get(project.id),
    }));
    const deliveries: QueuedDelivery[] = [];

    updateNotifyState(this.dir, now, state => {
      for (const item of snapshots) {
        this.evaluateProjectStoreInState(state, cfg, item.project.id, item.project, item.store, item.lastTick, now, deliveries);
      }
      this.processScheduleInState(state, cfg, now, deliveries);
    });

    this.dispatchDeliveries(deliveries);
  }

  private readProjectOrders(project: ProjectConfig | undefined): { orders: Orders; docs: ReturnType<Orders['all']>; merged: Set<string> } | undefined {
    if (!project) return undefined;
    try {
      const orders = this.orderReader(project);
      const docs = orders.all();
      const merged = orders.mergedSet(docs);
      return { orders, docs, merged };
    } catch {
      return undefined;
    }
  }

  private stallContinueStatus(
    project: ProjectConfig | undefined,
    tag: string,
    doneLines: readonly string[],
    snapshot?: { orders: Orders; docs: ReturnType<Orders['all']> },
  ): string {
    if (doneLines.some(l => l.startsWith(`${tag}:`) && l.includes('stalled again'))) {
      return 'on_stall: continue already acted once; stopped for a person';
    }
    if (doneLines.some(l => l.startsWith(`${tag}:`) && l.includes('queued one continuation'))) {
      return 'on_stall: continue already acted (queued one continuation)';
    }
    const snap = snapshot ?? this.readProjectOrders(project);
    if (snap) {
      const doc = snap.docs.find(d => d.order.tag.toLowerCase() === tag.toLowerCase());
      if (doc) {
        const lastPerson = Math.max(-1, ...doc.actions.filter(a => !a.bounce).map(a => a.seq));
        const stallEvents = snap.orders.store.events({ tag: doc.order.tag })
          .filter(e => e.type === 'stall-stopped' && Number(e.data?.after_action ?? -1) === lastPerson);
        if (stallEvents.some(e => e.data?.continued === false)) {
          return 'on_stall: continue already acted once; stopped for a person';
        }
        if (stallEvents.some(e => e.data?.continued === true)) {
          return 'on_stall: continue already acted (queued one continuation)';
        }
      }
    }
    return project?.dispatch.on_stall === 'continue'
      ? 'on_stall: continue has not acted'
      : 'on_stall: continue has not acted (on_stall: report)';
  }

  private evaluateProjectStoreInState(
    state: NotifyStateFile,
    cfg: NotifyConfig,
    projectId: string,
    _project: ProjectConfig | undefined,
    snapshot: { orders: Orders; docs: ReturnType<Orders['all']>; merged: Set<string> } | undefined,
    lastTick: TickResult | undefined,
    now: Date,
    deliveries: QueuedDelivery[],
  ): void {
    const nowIso = now.toISOString();
    const docs = snapshot?.docs ?? [];
    const docTagSet = new Set(docs.map(d => d.order.tag.toLowerCase()));

    // review-waiting
    const activeReviews = new Set<string>();
    if (this.triggerMatchesProject(cfg.triggers['review-waiting'], projectId)) {
      if (snapshot) {
        for (const doc of docs) {
          if (snapshot.orders.stage(doc, snapshot.merged).stage !== 'awaiting-review') continue;
          const tag = doc.order.tag;
          const key = `review-waiting:${projectId}:${tag}`;
          activeReviews.add(key);
          const current = currentReportOf(doc);
          const originAt = clampNotFuture(current?.at ?? doc.order.updated, now);
          const summary = current?.summary ? `: ${scrubSecrets(current.summary)}` : '';
          this.applyObserved(state, cfg, {
            key,
            trigger: 'review-waiting',
            originAt,
            project: projectId,
            tag,
            buildMessage: (sinceIso, curNow) => ({
              title: `[${projectId}] ${tag} awaiting review`,
              text: `[${projectId}] ${tag} has been awaiting review for ${formatAge(curNow, sinceIso)}${summary}`,
            }),
          }, now, deliveries);
        }
      }
      const tickReviews = lastTick?.report.needsUser.find(n => n.stage === 'awaiting-review')?.tags ?? [];
      for (const tag of tickReviews) {
        if (docTagSet.has(tag.toLowerCase())) continue;
        const key = `review-waiting:${projectId}:${tag}`;
        activeReviews.add(key);
        this.applyObserved(state, cfg, {
          key,
          trigger: 'review-waiting',
          project: projectId,
          tag,
          buildMessage: (sinceIso, curNow) => ({
            title: `[${projectId}] ${tag} awaiting review`,
            text: `[${projectId}] ${tag} has been awaiting review for ${formatAge(curNow, sinceIso)}`,
          }),
        }, now, deliveries);
      }
    }
    const reviewPrefix = `review-waiting:${projectId}:`;
    for (const key of Object.keys(state.conditions)) {
      if (key.startsWith(reviewPrefix) && !activeReviews.has(key)) this.clearKey(state, key, nowIso);
    }

    // question-waiting
    const activeQuestions = new Set<string>();
    if (this.triggerMatchesProject(cfg.triggers['question-waiting'], projectId)) {
      if (snapshot) {
        for (const doc of docs) {
          if (snapshot.orders.stage(doc, snapshot.merged).stage !== 'awaiting-user') continue;
          const tag = doc.order.tag;
          const key = `question-waiting:${projectId}:${tag}`;
          activeQuestions.add(key);
          const openQ = openQuestions(doc)[0];
          const current = currentReportOf(doc);
          const originAt = clampNotFuture(openQ?.received ?? openQ?.at ?? current?.at ?? doc.order.updated, now);
          const qText = openQ?.text ?? current?.question ?? current?.summary;
          const suffix = qText ? `: ${scrubSecrets(qText)}` : '';
          this.applyObserved(state, cfg, {
            key,
            trigger: 'question-waiting',
            originAt,
            project: projectId,
            tag,
            buildMessage: (sinceIso, curNow) => ({
              title: `[${projectId}] ${tag} waiting for answer`,
              text: `[${projectId}] ${tag} has been waiting for an answer for ${formatAge(curNow, sinceIso)}${suffix}`,
            }),
          }, now, deliveries);
        }
      }
      const tickQuestions = lastTick?.report.needsUser.find(n => n.stage === 'awaiting-user')?.tags ?? [];
      for (const tag of tickQuestions) {
        if (docTagSet.has(tag.toLowerCase())) continue;
        const key = `question-waiting:${projectId}:${tag}`;
        activeQuestions.add(key);
        this.applyObserved(state, cfg, {
          key,
          trigger: 'question-waiting',
          project: projectId,
          tag,
          buildMessage: (sinceIso, curNow) => ({
            title: `[${projectId}] ${tag} waiting for answer`,
            text: `[${projectId}] ${tag} has been waiting for an answer for ${formatAge(curNow, sinceIso)}`,
          }),
        }, now, deliveries);
      }
    }
    const questionPrefix = `question-waiting:${projectId}:`;
    for (const key of Object.keys(state.conditions)) {
      if (key.startsWith(questionPrefix) && !activeQuestions.has(key)) this.clearKey(state, key, nowIso);
    }

    // worker-paused (calls workerTrip directly on runs, never parsing reason text)
    const activePaused = new Set<string>();
    if (this.triggerMatchesProject(cfg.triggers['worker-paused'], projectId) && snapshot) {
      const workerConfigs = this.workers.workers.length ? this.workers.workers : (lastTick?.workers.map(w => w.config) ?? []);
      for (const w of workerConfigs) {
        if (!w.enabled) continue;
        const ownRuns = docs.flatMap(d => d.runs).filter(r => ownerOf(workerConfigs, r.worker)?.id === w.id);
        const trip = workerTrip(ownRuns, w, now);
        if (!trip) continue;
        const key = `worker-paused:${projectId}:${w.id}`;
        activePaused.add(key);
        const originAt = clampNotFuture(trip.since, now);
        this.applyObserved(state, cfg, {
          key,
          trigger: 'worker-paused',
          originAt,
          project: projectId,
          worker: w.id,
          buildMessage: () => ({
            title: `[${projectId}] worker ${w.id} paused`,
            text: `[${projectId}] worker ${w.id} paused until ${trip.until} after ${trip.failures} failed runs without a report`,
          }),
        }, now, deliveries);
      }
    }
    const pausedPrefix = `worker-paused:${projectId}:`;
    for (const key of Object.keys(state.conditions)) {
      if (key.startsWith(pausedPrefix) && !activePaused.has(key)) this.clearKey(state, key, nowIso);
    }
  }

  private clearKey(state: NotifyStateFile, key: string, nowIso: string): void {
    const existing = state.conditions[key];
    if (existing && existing.cleared_at === undefined) {
      existing.cleared_at = nowIso;
    }
  }

  private applyObserved(
    state: NotifyStateFile,
    cfg: NotifyConfig,
    obs: ObservedCondition,
    now: Date,
    deliveries: QueuedDelivery[],
  ): void {
    const nowIso = now.toISOString();
    const existing = state.conditions[obs.key];
    const reopenedByNewOrigin = Boolean(
      existing
      && existing.cleared_at === undefined
      && existing.notified_at
      && obs.originAt
      && Date.parse(obs.originAt) > Date.parse(existing.notified_at),
    );

    let entry: ConditionState;
    if (!existing || existing.cleared_at !== undefined || reopenedByNewOrigin) {
      entry = {
        first_seen: obs.originAt ?? nowIso,
        trigger: obs.trigger,
        ...(obs.project ? { project: obs.project } : {}),
        ...(obs.tag ? { tag: obs.tag } : {}),
        ...(obs.worker ? { worker: obs.worker } : {}),
        ...(obs.instance ? { instance: obs.instance } : {}),
      };
      state.conditions[obs.key] = entry;
    } else {
      entry = existing;
      if (obs.project) entry.project = obs.project;
      if (obs.tag) entry.tag = obs.tag;
      if (obs.worker) entry.worker = obs.worker;
      if (obs.instance) entry.instance = obs.instance;
    }

    const { title, text } = obs.buildMessage(entry.first_seen, now);
    entry.title = title;
    entry.text = text;

    const trigCfg = cfg.triggers[obs.trigger];
    if (trigCfg.off || entry.notified_at) return;

    const elapsedMs = now.getTime() - Date.parse(entry.first_seen);
    if (elapsedMs < trigCfg.after_minutes * 60_000) return;

    entry.notified_at = nowIso;
    const channels = effectiveChannelsFor(cfg, obs.trigger);
    if (!channels.length) return;

    const payload: NotifyPayload = {
      source: 'alba',
      host: this.host,
      trigger: obs.trigger,
      key: obs.key,
      ...(entry.project ? { project: entry.project } : {}),
      ...(entry.tag ? { tag: entry.tag } : {}),
      ...(entry.worker ? { worker: entry.worker } : {}),
      title,
      text,
      since: entry.first_seen,
      at: nowIso,
      cleared: false,
    };

    const quiet = cfg.quiet_hours;
    if (quiet && isInQuietHours(now, quiet) && !quiet.except.includes(obs.trigger)) {
      state.held.push({ to: channels, payload });
    } else {
      deliveries.push({ to: channels, payload });
    }
  }

  private processScheduleInState(
    state: NotifyStateFile,
    cfg: NotifyConfig,
    now: Date,
    deliveries: QueuedDelivery[],
  ): void {
    const nowIso = now.toISOString();

    // 1. Release held notifications as one summary per channel when quiet hours end
    if (!isInQuietHours(now, cfg.quiet_hours) && state.held.length > 0) {
      const heldItems = state.held.splice(0);
      const byChannel = new Map<string, NotifyPayload[]>();
      for (const item of heldItems) {
        for (const ch of item.to) {
          const list = byChannel.get(ch) ?? [];
          list.push(item.payload);
          byChannel.set(ch, list);
        }
      }
      for (const [ch, payloads] of byChannel) {
        const lines = payloads.map(p => {
          const cleared = state.conditions[p.key]?.cleared_at ? ' (cleared)' : '';
          return `- ${p.text}${cleared}`;
        });
        deliveries.push({
          to: [ch],
          payload: {
            source: 'alba',
            host: this.host,
            trigger: 'quiet-summary',
            key: `quiet-summary:${nowIso}`,
            title: `Alba quiet hours summary (${payloads.length})`,
            text: `Held during quiet hours (${payloads.length}):\n${lines.join('\n')}`,
            since: payloads[0]!.since,
            at: nowIso,
            cleared: false,
          },
        });
      }
    }

    // 2. Daily digest once per local calendar day at `digest.at`
    if (cfg.digest) {
      const todayKey = localDateKey(now);
      if (state.last_digest_date !== todayKey) {
        const atMinutes = parseClockMinutes(cfg.digest.at);
        const curMinutes = now.getHours() * 60 + now.getMinutes();
        if (curMinutes < atMinutes) {
          state.digest_armed_date = todayKey;
        } else if (curMinutes < atMinutes + 60 || state.digest_armed_date === todayKey) {
          state.last_digest_date = todayKey;
          deliveries.push({
            to: cfg.digest.to,
            payload: this.buildDigestPayload(state, now),
          });
        }
      }
    }
  }

  private buildDigestPayload(state: NotifyStateFile, now: Date): NotifyPayload {
    const nowIso = now.toISOString();
    const reviewItems: string[] = [];
    const questionItems: string[] = [];

    for (const project of this.projects) {
      const snap = this.readProjectOrders(project);
      if (!snap) continue;
      for (const doc of snap.docs) {
        const stage = snap.orders.stage(doc, snap.merged).stage;
        if (stage === 'awaiting-review') {
          const cur = currentReportOf(doc);
          const since = cur?.at ?? doc.order.updated;
          reviewItems.push(`${project.id}:${doc.order.tag} (${formatAge(now, since)})`);
        } else if (stage === 'awaiting-user') {
          const openQ = openQuestions(doc)[0];
          const cur = currentReportOf(doc);
          const since = openQ?.received ?? openQ?.at ?? cur?.at ?? doc.order.updated;
          questionItems.push(`${project.id}:${doc.order.tag} (${formatAge(now, since)})`);
        }
      }
    }

    const openConditions = Object.entries(state.conditions)
      .filter(([, c]) => c.cleared_at === undefined)
      .map(([key, c]) => `${key} (${formatAge(now, c.first_seen)})`);

    const unavailableByWorker = new Map<string, Set<string>>();
    for (const tick of this.lastTicks.values()) {
      for (const u of tick.report.unavailable) {
        const reasons = unavailableByWorker.get(u.worker) ?? new Set<string>();
        for (const r of u.reasons) reasons.add(scrubSecrets(r));
        unavailableByWorker.set(u.worker, reasons);
      }
    }
    for (const w of this.workers.workers) {
      if (!w.enabled && !unavailableByWorker.has(w.id)) {
        unavailableByWorker.set(w.id, new Set(['turned off in the workers file']));
      }
    }
    const unavailableLines = [...unavailableByWorker.entries()]
      .map(([worker, reasons]) => `${worker}: ${[...reasons].join('; ')}`);

    const restarts24h = state.restarts.filter(r => now.getTime() - Date.parse(r.at) <= DAY_MS);
    const crashed24h = restarts24h.filter(r => r.how !== 'clean').length;
    const restartLine = crashed24h > 0
      ? `${restarts24h.length} (${crashed24h} abnormal)`
      : `${restarts24h.length}`;

    const sections = [
      `Alba daily digest (${localDateKey(now)})`,
      `Waiting for review: ${reviewItems.length ? reviewItems.join(', ') : 'none'}`,
      `Questions waiting: ${questionItems.length ? questionItems.join(', ') : 'none'}`,
      `Open conditions: ${openConditions.length ? openConditions.join(', ') : 'none'}`,
      `Workers unavailable: ${unavailableLines.length ? unavailableLines.join(', ') : 'none'}`,
      `Serve restarts (last 24h): ${restartLine}`,
    ];

    return {
      source: 'alba',
      host: this.host,
      trigger: 'digest',
      key: `digest:${localDateKey(now)}`,
      title: `Alba daily digest (${localDateKey(now)})`,
      text: sections.join('\n'),
      since: new Date(now.getTime() - DAY_MS).toISOString(),
      at: nowIso,
      cleared: false,
    };
  }

  private dispatchDeliveries(deliveries: QueuedDelivery[]): void {
    const cfg = this.config;
    if (!cfg || !deliveries.length) return;
    for (const item of deliveries) {
      for (const chId of item.to) {
        const ch = cfg.channels[chId];
        if (!ch) continue;
        const job = Promise.resolve()
          .then(() => this.sender(chId, ch, item.payload))
          .then(result => {
            if (!result.ok && !result.notConfigured && !result.notAvailable) {
              this.print(formatFailureLine(chId, result));
            }
          })
          .catch(err => {
            const msg = scrubSecrets(err instanceof Error ? err.message : String(err));
            this.print(`notify (${chId}): ${msg}`);
          })
          .finally(() => {
            this.pendingDeliveries.delete(job);
          });
        this.pendingDeliveries.add(job);
      }
    }
  }

  readState(): NotifyStateFile {
    return readNotifyState(this.dir);
  }
}

export function createNotifier(options: NotifierOptions): Notifier {
  return new Notifier(options);
}
