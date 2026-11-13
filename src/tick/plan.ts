import type { Stage } from '../orders/model.ts';
import type { WorkerConfig } from '../workers/config.ts';
import { t } from '../i18n.ts';
import { local } from '../time.ts';
import { MAX_RESUMES, backoffMinutes } from '../run/transient.ts';
import type { ProgressView, WorkerKindHistory } from '../api/types.ts';
import { chooseWorker, type RolePolicy } from '../routing/choose.ts';
import type { ResourceConfig } from '../config.ts';
import type { LoopFinding } from '../run/loops.ts';
import { startBlocked, type Occupant, type StartWanted, type StoredLease } from '../resources/leases.ts';
import { capacityUsage } from './capacity.ts';

/** What the tick knows about one order. Built by `gather` from stored facts and probes. */
export interface TickOrder {
  pinnedWorker?: string;
  role?: RolePolicy;
  priority?: number;
  tag: string;
  stage: Stage;
  kind: string;                 // the order's kind, else what it was classified as ('' when neither)
  kindTags?: string[];          // extra tags that are kinds of the project's vocabulary
  heavy?: string;
  workerText?: string;          // free-text worker preference ("Codex", "an editor session")
  row: number;                  // order in the source table, used to break ties
  rework: boolean;              // reworked and no run started since
  answer?: boolean;             // the pending note came from a person's answer; it does not use the rework reserve
  monitorResume?: boolean;      // a monitor ended and no run started since: the same worker continues the same session, before new orders
  resumeWorker?: string;        // worker whose session is being resumed (capacity or `monitorResume`)
  uses?: string[];              // resources a run of this order holds a lease on
  editorPool?: string;          // the editor pool a run of this order takes a port of (editors: in alba.yaml)
  rotate?: { from: string; reason: string; allowPaid: boolean };   // the last run hit a limit and its worker is set to `on_limit: rotate`: hand the order to another worker
  resume: boolean;              // the last run ended badly (capacity, stalled, failed) and nothing has changed
  transientFailures?: number;   // transient service errors in a row that ended the latest runs
  lastRunEndedAt?: string;
  endedWithoutReport: boolean;  // the last run ended and no report followed
  runStartedAt?: string;        // start of the open run, when it is real (not imported)
  question?: string;
  spendCapUsd?: number;         // the order's own ceiling
  spentUsd?: number;            // what its runs cost so far (engine-reported, or estimated from the worker's price)
}

export interface OrderActivity {
  waitingLong?: boolean;
  worktree?: string;
  lastCommitAt?: string;
  dirtyFiles?: number;
  finalFileAt?: string;         // when <TAG>.last.txt was last written
  logAt?: string;               // when the run's log last grew
  openCommand?: string;         // a command the worker started that has not finished (read from its log)
  receiptAt?: string;           // when `<TAG>.progress.json` was last written (the worker's start receipt)
  progress?: ProgressView;      // what that file says: the worker's own list of steps
}

export interface WorkerState {
  config: WorkerConfig;
  available: boolean;
  reasons: string[];
  running: number;              // open runs attributed to this worker
  runsToday: number;
  startable?: boolean;          // false: no launch template, alba cannot start it
  spendTodayUsd?: number;       // cost of today's runs, read only for a worker that has a daily cap
  overCap?: boolean;            // the daily cap is reached
  roleHistory?: Record<string, { samples: number; rate?: number }>;
  history?: Record<string, WorkerKindHistory>;   // accepted vs sent back, by kind
}

export interface TickInput {
  now: Date;
  orders: TickOrder[];
  activity: Record<string, OrderActivity>;
  workers: WorkerState[];
  caps: Record<string, number>;
  reworkReserve: number;
  minFreeRamGb?: number;
  freeRamGb?: number;
  stallMinutes?: number;
  startReceiptMinutes?: number; // a run with no receipt and no commit this long after it began failed to start
  longCommandMinutes?: number;  // how long a worker may wait for one command before that counts as a problem
  alerts: string[];             // problems found while reading quota (unreadable, balance falling)
  finishes?: { tag: string; run: string; outcome: string; why: string }[];   // ended runs that are still to be recorded
  monitoring?: { tag: string; text: string }[];   // orders whose long job is watched by the monitor
  resources?: Record<string, ResourceConfig>;     // the project's shared resources
  leases?: StoredLease[];                         // held now by orders that still need them
  occupants?: Occupant[];                         // orders running or monitored, with their kinds
  loops?: Record<string, LoopFinding[]>;          // what the loop check found in the logs of running orders, by tag
  loopEvidence?: (f: LoopFinding) => string[];
  lingering?: Record<string, { status: string; summary: string; quietMinutes: number; ended?: boolean }>;   // running orders whose log already ends with their report block, by tag
  /** Workers whose last run ended unreachable and whose endpoint still refuses a connection. */
  endpointDown?: { worker: string; endpoint: string }[];
  /** Editor pools by machine: the ports there and the ones taken now (by order tag). */
  editorPorts?: Record<string, Record<string, { ports: number; taken: string[] }>>;
  /** The machine each worker's runs are on (its host, else the local machine). */
  workerMachines?: Record<string, string>;
}

/** Why a run on `machine` cannot have an editor of `pool` now, counting the ones planned in this pass, or undefined. */
function editorPortWhy(ports: NonNullable<TickInput['editorPorts']>, pool: string, machine: string, planned: number): string | undefined {
  const at = ports[pool]?.[machine];
  if (!at) return t('{pool} has no editor on {machine}', { pool, machine });
  return at.taken.length + planned >= at.ports ? t('every {pool} port on {machine} is taken ({list})', { pool, machine, list: [...at.taken, ...(planned ? [t('{n} planned in this pass', { n: planned })] : [])].join(', ') || '-' }) : undefined;
}

export type Move = { tag: string; mode: 'dispatch' | 'resume' | 'card'; worker: string; rework: boolean; /** Slots above a kind cap this start may use (the rework reserve); the start checks the cap again with it. */ capReserve?: number; rotated?: { from: string; reason: string }; why?: string; rejected?: { worker: string; reason: string }[] };
export interface Problem { /** : for `looping`, the command, the error and the count. */ evidence?: string[]; /** `lingering`: the engine's own end event is the last one in the log, so the process is stopped whatever `dispatch.on_lingering` says. */ ended?: boolean; kind: 'machine-down' | 'stalled' | 'maybe-finished' | 'no-report' | 'quota' | 'no-worker' | 'no-fit' | 'launch' | 'spend' | 'monitor' | 'looping' | 'start-failed' | 'lease-expired' | 'lingering' | 'commit-nudge' | 'usage-waste' | 'usage-budget' | 'producer'; tag?: string; text: string }

export interface TickReport {
  dispatched?: number;                              // successful real starts/resumes; absent on a preview
  at: string;
  needsUser: { stage: Stage; tags: string[] }[];   // what only a person can move
  problems: Problem[];
  moves: Move[];                                    // what the tick would do now
  heldBack: { tag: string; why: string }[];         // ready, but not now
  unavailable: { worker: string; reasons: string[] }[];
  notChecked: string[];                             // running orders with no worktree to look at
  waiting: { tag: string; text: string }[];         // running orders that look quiet only because a long command is still running
  monitoring: { tag: string; text: string }[];      // orders whose long job the monitor is watching (no worker, no quota)
  finishes: { tag: string; run: string; outcome: string; why: string }[];   // ended runs waiting to be recorded (dry run) 
  done: string[];                                   // what the tick actually did (real run)
  exitCode: 0 | 1 | 2;
}

const USER_STAGES: Stage[] = ['awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped'];

/** Does this free-text worker preference name the worker? Empty text names nobody in particular. */
export function mentions(text: string | undefined, worker: WorkerConfig): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  return [worker.id, ...worker.aliases].some(a => hay.includes(a.toLowerCase()));
}

const ago = (now: Date, iso: string): string => {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
  return minutes < 90 ? `${minutes} min` : minutes < 60 * 36 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
};

/** Shared by dispatch planning and the alternatives shown on producer cards. */
export const compareDispatchOrder = (a: TickOrder, b: TickOrder): number => Number(!!b.monitorResume) - Number(!!a.monitorResume) || Number(b.rework) - Number(a.rework) || (b.priority ?? 0) - (a.priority ?? 0) || a.row - b.row || a.tag.localeCompare(b.tag);

/** One pass of decisions. Pure: everything it needs is in the input. */
export function planTick(input: TickInput): TickReport {
  const { now, orders, activity, workers, caps } = input;
  const report: TickReport = { at: now.toISOString(), needsUser: [], problems: [], moves: [], heldBack: [], unavailable: [], notChecked: [], waiting: [], monitoring: input.monitoring ?? [], finishes: input.finishes ?? [], done: [], exitCode: 0 };

  for (const stage of USER_STAGES) {
    const tags = orders.filter(o => o.stage === stage).map(o => o.tag);
    if (tags.length) report.needsUser.push({ stage, tags });
  }
  for (const text of input.alerts) report.problems.push({ kind: 'quota', text });
  const endpointDown = input.endpointDown ?? [];
  for (const down of endpointDown) report.problems.push({ kind: 'launch', text: t('{worker}: endpoint unreachable', { worker: down.worker }) });
  const downOf = (id?: string) => endpointDown.find(d => d.worker === id);
  for (const l of input.leases ?? []) {
    if (now.getTime() <= Date.parse(l.expires)) continue;
    report.problems.push({ kind: 'lease-expired', tag: l.tag, text: t('{tag}: has held {resource} for {min} min, longer than its lease ({limit} min); release it if the run is gone.', { tag: l.tag, resource: l.resource, min: Math.round((now.getTime() - Date.parse(l.since)) / 60000), limit: Math.round((Date.parse(l.expires) - Date.parse(l.since)) / 60000) }) });
  }
  for (const w of workers) if (!w.available) report.unavailable.push({ worker: w.config.id, reasons: w.reasons });
  for (const w of workers.filter(x => x.overCap)) report.problems.push({ kind: 'spend', text: t('{worker}: the daily spend cap of ${cap} is reached (${spent} today); nothing more is started on it today.', { worker: w.config.id, cap: w.config.daily_cap_usd!, spent: Number((w.spendTodayUsd ?? 0).toFixed(2)) }) });
  for (const o of orders.filter(x => x.spendCapUsd !== undefined && (x.spentUsd ?? 0) >= x.spendCapUsd && ['running', 'queued'].includes(x.stage))) {
    report.problems.push({ kind: 'spend', tag: o.tag, text: t('{tag}: its runs cost ${spent}, which reaches its spend cap of ${cap}; {what}.', { tag: o.tag, spent: Number((o.spentUsd ?? 0).toFixed(2)), cap: o.spendCapUsd!, what: o.stage === 'running' ? t('the run is still going, look at it') : t('it is not started again') }) });
  }

  for (const [tag, list] of Object.entries(input.loops ?? {})) {
    if (!list.length) continue;
    report.problems.push({ kind: 'looping', tag, text: t('{tag}: the run is going round in circles: {what}', { tag, what: list.map(f => f.text).join('; ') }), evidence: list.flatMap(f => input.loopEvidence?.(f) ?? []) });
  }

  // Running orders: finished without saying so, or stalled.
  for (const o of orders.filter(x => x.stage === 'running')) {
    const a = activity[o.tag];
    if (a?.waitingLong && a.openCommand) {
      report.waiting.push({ tag: o.tag, text: t('{tag}: waiting for a command: {command}, {min} min', { tag: o.tag, command: a.openCommand.slice(0, 60), min: Math.max(0, Math.floor((now.getTime() - Date.parse(a.logAt ?? o.runStartedAt ?? now.toISOString())) / 60000)) }) });
      continue;
    }
    const newest = [a?.lastCommitAt, o.runStartedAt, a?.logAt].filter((x): x is string => !!x).sort().pop();
    const late = input.lingering?.[o.tag];
    if (late) {
      const words = { tag: o.tag, status: late.status, summary: late.summary.slice(0, 120), min: late.quietMinutes };
      report.problems.push(late.ended
        ? { kind: 'lingering', tag: o.tag, ended: true, text: t('{tag}: the worker ended its turn and handed in its report ({status}: {summary}) but its process is still there after {min} min; it is stopped and the report read.', words) }
        : { kind: 'lingering', tag: o.tag, text: t('{tag}: the run has already handed in its report ({status}: {summary}) but its process is still there; the log has been quiet for {min} min.', words) });
      continue;
    }
    if (a?.finalFileAt && (!newest || a.finalFileAt > newest)) {
      report.problems.push({ kind: 'maybe-finished', tag: o.tag, text: t('{tag}: the final report file was written {ago} ago but the run is still open; probably done, needs review.', { tag: o.tag, ago: ago(now, a.finalFileAt) }) });
      continue;
    }
    // No receipt and no commit since the run began, after the receipt time: it did not start properly (reported before the stall limit would be reached).
    if (input.startReceiptMinutes !== undefined && o.runStartedAt && now.getTime() - Date.parse(o.runStartedAt) > input.startReceiptMinutes * 60000
      && !(a?.receiptAt && Date.parse(a.receiptAt) >= Date.parse(o.runStartedAt)) && !(a?.lastCommitAt && Date.parse(a.lastCommitAt) >= Date.parse(o.runStartedAt))) {
      report.problems.push({ kind: 'start-failed', tag: o.tag, text: t('{tag}: the run began {ago} ago and has written no start receipt ({tag}.progress.json) and made no commit (limit {limit} min): it probably did not start properly.', { tag: o.tag, ago: ago(now, o.runStartedAt), limit: input.startReceiptMinutes }) });
      continue;
    }
    if (!a?.lastCommitAt) { if (!a?.worktree) report.notChecked.push(o.tag); continue; }
    if (input.stallMinutes !== undefined && newest && now.getTime() - Date.parse(newest) > input.stallMinutes * 60000) {
      const quietFor = Math.round((now.getTime() - Date.parse(newest)) / 60000);
      if (a.openCommand && quietFor <= (input.longCommandMinutes ?? 240)) {
        report.waiting.push({ tag: o.tag, text: t('{tag}: waiting for a command: {command}, {min} min', { tag: o.tag, command: a.openCommand.slice(0, 60), min: quietFor }) });
        continue;
      }
      const dirty = a.dirtyFiles ? t(', {n} uncommitted file(s)', { n: a.dirtyFiles }) : '';
      report.problems.push({ kind: 'stalled', tag: o.tag, text: t('{tag}: no commit for {ago} (limit {limit} min){dirty}.', { tag: o.tag, ago: ago(now, newest), limit: input.stallMinutes, dirty }) });
    }
  }
  for (const o of orders.filter(x => x.endedWithoutReport)) {
    report.problems.push({ kind: 'no-report', tag: o.tag, text: t('{tag}: the last run ended but no report was recorded.', { tag: o.tag }) });
  }

  // Resource use now, by kind and heavy class.
  const used: Record<string, number> = Object.fromEntries(Object.entries(capacityUsage(orders, caps)).map(([key, value]) => [key, value.used]));
  for (const lease of input.leases ?? []) if (lease.acceptance?.cap) used[lease.acceptance.cap] = (used[lease.acceptance.cap] ?? 0) + 1;
  const bump = (o: { kind: string; heavy?: string }) => { for (const k of new Set([o.kind, o.heavy])) if (k && k in caps) used[k] = (used[k] ?? 0) + 1; };
  const plannedFor: Record<string, number> = {};
  const plannedLeases: StartWanted[] = [];
  const plannedEditors: Record<string, number> = {};

  const candidates = orders.filter(o => o.stage === 'queued' && !(o.spendCapUsd !== undefined && (o.spentUsd ?? 0) >= o.spendCapUsd))
    .sort(compareDispatchOrder);
  const ramShort = input.freeRamGb !== undefined && input.minFreeRamGb !== undefined && input.freeRamGb < input.minFreeRamGb;

  for (const o of candidates) {
    // `on_limit: rotate`: the next qualifying supply for the same role, excluding exhausted supply and paid targets unless spending is allowed.
    let rotated: { from: string; reason: string } | undefined;
    let rotatedChoice: ReturnType<typeof chooseWorker> | undefined;
    if (o.rotate && !o.pinnedWorker) {
      const pool = workers.filter(w => w.config.id !== o.rotate!.from && (o.rotate!.allowPaid || w.config.cost !== 'paid'));
      const picked = pool.length ? chooseWorker({ role: o.role, kind: o.kind, tags: o.kindTags ?? [], planned: plannedFor }, pool) : undefined;
      if (picked?.outcome === 'chosen') { rotatedChoice = picked; rotated = { from: o.rotate.from, reason: o.rotate.reason }; }
      else if (picked?.outcome === 'none-available') {
        // A target fits but is not free (at its concurrency, or its window). Wait for it. Do not resume on the worker that ran out.
        report.heldBack.push({ tag: o.tag, why: t('waiting for a hand-over target ({why})', { why: picked.why }) });
        continue;
      }
    }
    if (!rotated && o.resume && o.resumeWorker) {
      const held = downOf(o.resumeWorker);
      if (held) { report.heldBack.push({ tag: o.tag, why: t('endpoint {endpoint} is down', { endpoint: held.endpoint }) }); continue; }
    }
    if (!rotated && o.resume && o.transientFailures && o.lastRunEndedAt) {
      const resumeConfig = o.resumeWorker ? workers.find(w => w.config.id === o.resumeWorker)?.config : undefined;
      const maxResumes = resumeConfig?.max_resumes ?? MAX_RESUMES;
      const wait = backoffMinutes(o.transientFailures, maxResumes, resumeConfig?.resume_backoff_minutes);
      const due = wait === undefined ? 0 : Date.parse(o.lastRunEndedAt) + wait * 60000;
      if (now.getTime() < due) {
        report.heldBack.push({ tag: o.tag, why: t('resume {k} of {n} in {min} min (backing off after a service error)', { k: o.transientFailures, n: maxResumes, min: Math.ceil((due - now.getTime()) / 60000) }) });
        continue;
      }
    }
    const choice = rotatedChoice ?? chooseWorker({ pinnedWorker: o.pinnedWorker, role: o.role, kind: o.kind, tags: o.kindTags ?? [], workerText: o.resume && o.resumeWorker || o.monitorResume && o.resumeWorker ? o.resumeWorker : o.workerText, planned: plannedFor }, workers);
    if (choice.outcome === 'nobody-fits') {
      report.problems.push({ kind: 'no-fit', tag: o.tag, text: t('{tag} is ready but no worker takes it: {why}', { tag: o.tag, why: choice.why }) });
      continue;
    }
    if (choice.outcome === 'none-available') {
      const takers = choice.candidates.filter(c => c.verdict !== 'unfit');
      const downs = takers.flatMap(c => { const held = downOf(c.worker); return held ? [held] : []; });
      if (takers.length > 0 && downs.length === takers.length) { report.heldBack.push({ tag: o.tag, why: t('endpoint {endpoint} is down', { endpoint: downs[0].endpoint }) }); continue; }
      if (choice.waiting === 'limit') report.heldBack.push({ tag: o.tag, why: t('every worker that takes it is at its concurrency or daily limit') });
      else report.problems.push({ kind: 'no-worker', tag: o.tag, text: t('{tag} is ready but nobody can take it ({why}).', { tag: o.tag, why: choice.candidates.filter(c => c.verdict !== 'unfit').map(c => c.worker + ': ' + c.reason).join(' | ') }) });
      continue;
    }
    const worker = workers.find(w => w.config.id === choice.chosen)!;
    const card = worker.config.card_only;
    const capReserve = o.answer ? 0 : (o.rework || o.monitorResume ? input.reworkReserve : 0);
    const over = [o.kind, o.heavy].find(k => k && k in caps && (used[k] ?? 0) >= caps[k] + capReserve);
    if (over) { report.heldBack.push({ tag: o.tag, why: t('cap for "{key}" is full ({used}/{cap})', { key: over, used: used[over] ?? 0, cap: caps[over] }) }); continue; }
    if (!card && ramShort) { report.heldBack.push({ tag: o.tag, why: t('free memory {free} GB is below {min} GB', { free: input.freeRamGb!.toFixed(1), min: input.minFreeRamGb! }) }); continue; }
    const leaseWhy = !card && input.resources && Object.keys(input.resources).length ? startBlocked(input.resources, input.leases ?? [], input.occupants ?? [], { tag: o.tag, kind: o.kind, uses: o.uses ?? [] }, plannedLeases) : undefined;
    if (leaseWhy) { report.heldBack.push({ tag: o.tag, why: leaseWhy }); continue; }
    // An editor needs a free port of its pool on the machine of the chosen worker (the pool's resource counts every machine's ports).
    const editorAt = !card && o.editorPool ? { pool: o.editorPool, machine: input.workerMachines?.[worker.config.id] ?? 'local' } : undefined;
    const editorKey = editorAt && `${editorAt.pool}@${editorAt.machine}`;
    const editorWhy = editorAt && input.editorPorts ? editorPortWhy(input.editorPorts, editorAt.pool, editorAt.machine, plannedEditors[editorKey!] ?? 0) : undefined;
    if (editorWhy) { report.heldBack.push({ tag: o.tag, why: editorWhy }); continue; }
    if (editorKey) plannedEditors[editorKey] = (plannedEditors[editorKey] ?? 0) + 1;
    if (!card) plannedLeases.push({ tag: o.tag, kind: o.kind, uses: o.uses ?? [] });
    bump(o);
    plannedFor[worker.config.id] = (plannedFor[worker.config.id] ?? 0) + 1;
    report.moves.push({ tag: o.tag, mode: card ? 'card' : o.resume || o.monitorResume ? 'resume' : 'dispatch', worker: worker.config.id, rework: o.rework, ...(capReserve ? { capReserve } : {}), ...(rotated ? { rotated } : {}), why: choice.why, rejected: choice.candidates.filter(c => c.worker !== choice.chosen).map(c => ({ worker: c.worker, reason: c.reason })) });
  }

  report.exitCode = report.problems.length ? 2 : report.moves.length || report.finishes.length ? 1 : 0;
  return report;
}

/** Short text for people: what they must do first, then problems, then what the tick would do. Healthy things take no line. */
export function formatReport(r: TickReport, dryRun: boolean): string {
  const out: string[] = [t('alba tick{mode}  {at}  exit {code}', { mode: dryRun ? ' (dry run)' : '', at: local(r.at), code: r.exitCode })];
  const section = (title: string, lines: string[]) => { if (lines.length) out.push('', title, ...lines.map(l => `  ${l}`)); };
  const label: Record<string, string> = {
    'awaiting-user': t('waiting for your answer or click'), 'awaiting-review': t('waiting for review'),
    blocked: t('blocked, needs a decision'), failed: t('failed'), dropped: t('dropped by the worker'),
  };
  section(t('DONE'), r.done);
  section(t('NEEDS YOU'), r.needsUser.map(n => `${label[n.stage]}: ${n.tags.join(', ')}`));
  section(t('PROBLEMS'), r.problems.map(p => p.text));
  section(t('WAITING FOR A COMMAND (not a problem)'), r.waiting.map(w => w.text));
  section(t('MONITORING (no worker needed)'), r.monitoring.map(w => w.text));
  section(t('WOULD DO'), [...r.finishes.map(f => t('record the end of run {run} of {tag}: {outcome} ({why})', f)), ...r.moves.map(m => {
    const verb = m.mode === 'card' ? t('offer a card to start') : m.rotated ? t('hand over (from {from}: {reason})', m.rotated) : m.mode === 'resume' ? t('resume') : t('start');
    return `${verb} ${m.tag} ${m.mode === 'card' ? t('in') : t('with')} ${m.worker}${m.rework ? t(' (rework)') : ''}`;
  })]);
  section(t('HELD BACK'), r.heldBack.map(h => `${h.tag}: ${h.why}`));
  const side: string[] = [];
  if (r.unavailable.length) side.push(t('workers not available: {list}', { list: r.unavailable.map(u => `${u.worker} (${u.reasons.join('; ')})`).join(' | ') }));
  if (r.notChecked.length) side.push(t('running without a worktree to check: {tags}', { tags: r.notChecked.join(', ') }));
  section(t('NOTES'), side);
  if (out.length === 1) out.push(t('Nothing to do.'));
  return out.join('\n');
}
