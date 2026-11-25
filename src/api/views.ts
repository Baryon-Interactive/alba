import { orderPhases } from '../orders/phases.ts';
import { attentionState } from './attention.ts';
import { attentionFor } from '../orders/attention-store.ts';
import { workerAdapter } from '../workers/adapters/index.ts';
import { computePortBase } from '../run/launch.ts';
import { effectiveSparse, worktreeSparseDirs } from '../run/worktree.ts';
import { SqliteStore } from '../orders/sqlite-store.ts';
import { producerNotes } from '../producer/notes.ts';
import { acceptanceCard } from '../review/acceptance.ts';
import { independentChecks } from '../review/independent.ts';
import { currentFirstPass } from '../review/first-pass.ts';
import { readOrders } from './read-orders.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ProjectConfig } from '../config.ts';
import type { OptionInput, StoredQuestion, OrderDoc, OrderEvent as StoredEvent, Report as StoredReport, Run as StoredRun, Stage } from '../orders/model.ts';
import { t } from '../i18n.ts';
import { actionProblem, type StageResult } from '../orders/stage.ts';
import { creditsOf, quoteList, toQuote } from '../credits/credits.ts';
import { lessonsForOrder } from '../lessons/lessons.ts';
import { referencedDecisions } from '../ledger/decisions.ts';
import { readInbox } from '../run/inbox.ts';
import { collectUsage, usageReport, budgetWarnings } from '../usage/accounting.ts';
import { liveRuns } from '../run/live.ts';
import { threadOf, unanswered } from '../run/messages.ts';
import { nudgeKey, readNudges } from '../run/nudge.ts';
import { findOrderFile, pendingNotes } from '../run/prompt.ts';
import { routingOf } from '../routing/classify.ts';
import { CAPABILITIES } from '../workers/config.ts';
import { effectiveKind, toRouting } from '../routing/route.ts';
import type { Probes } from '../tick/gather.ts';
import type { OrderActivity } from '../tick/plan.ts';
import { readActiveConsult, readRunConsults } from '../consult/config.ts';
import { orderSpend, spendToday, stateDirOfRun, usageOf } from '../usage/spend.ts';
import type { WorkersFile } from '../workers/config.ts';
import type { QuotaReading } from '../workers/quota.ts';
import { NEEDS_YOU, type ProjectView, type Snapshot } from '../web/snapshot.ts';
import { externalCallsOf } from '../library/usage.ts';
import { listPicks } from '../library/picks.ts';
import type * as A from './types.ts';

/** What the views need from the outside: the probes (is a process alive, file times) and the workers file. */
/** What most views need of a project: its configuration and its orders. A full `ProjectView` (with the tick's findings) has more, and the views use it when it is there. */
export type View = Pick<ProjectView, 'config' | 'orders'> & Partial<ProjectView>;

export interface ViewEnv { probes: Probes; workers?: WorkersFile; /** Aggregate reads use stored usage and cached activity, never process or log probes. */ cachedOnly?: boolean }

const FILE_LIMIT = 200_000;

export const toOptions = (options: readonly OptionInput[]): A.QuestionOption[] => options.map((o, i) => ({ key: String(i + 1), label: o.label, ...(o.note ? { note: o.note } : {}), images: o.images ?? [], recommended: i === 0 }));

export const toQuestion = (q: StoredQuestion): A.Question => ({
  id: q.id, text: q.text, options: toOptions(q.options), askedBy: q.by, at: q.at,
  ...(q.answered ? { answered: { choice: q.answered.choice.map(String), ...(q.answered.note ? { note: q.answered.note } : {}), by: q.answered.by, ...(q.answered.who ? { who: q.answered.who } : {}), at: q.answered.at } } : {}),
});

export const toReport = (r: StoredReport): A.Report => ({
  seq: r.seq, at: r.at, ...(r.run ? { run: r.run } : {}), status: r.status, summary: r.summary, ...(r.question ? { question: r.question } : {}),
  ...(r.options?.length ? { options: toOptions(r.options) } : {}), ...(r.waiting_for ? { waitingFor: r.waiting_for } : {}), ...(r.scope === 'project' ? { scope: 'project' as const } : {}), ...(r.skill_suggestions?.length ? { skillSuggestions: r.skill_suggestions } : {}), ...(r.design_changes?.length ? { designChanges: r.design_changes } : {}),
  ...(r.monitor ? { monitor: r.monitor } : {}), evidence: r.evidence, commits: r.commits, ...(r.from ? { from: r.from } : {}), ...(r.source ? { source: r.source } : {}), ...(r.imported ? { imported: true } : {}),
});

export const runKey = (tag: string, run: string) => `${tag}:${run}`;

/** Events with their position in the log (1-based), the id the stream uses. */
export function numberedEvents(events: readonly StoredEvent[]): A.OrderEvent[] {
  return events.map((e, i) => ({ id: i + 1, at: e.at, tag: e.tag, type: e.type, ...(e.by ? { by: e.by } : {}), ...(e.data ? { data: e.data } : {}) }));
}

export function livenessOf(alive: boolean | undefined, quietMinutes?: number): A.Liveness {
  if (alive === false) return 'gone';
  if ((quietMinutes ?? 0) < 10) return 'active';
  return alive === true ? 'quiet' : 'unverifiable';
}

function observeRun(run: StoredRun | undefined, env: ViewEnv, activity?: OrderActivity) {
  if (!run || run.ended) return {};
  const alive = run.pid && !run.host && !env.cachedOnly ? env.probes.isAlive(run.pid) : undefined;
  const times = [activity?.lastCommitAt, activity?.logAt, activity?.receiptAt, run.imported ? undefined : run.started];
  const latest = Math.max(...times.map(value => value ? Date.parse(value) : -Infinity).filter(Number.isFinite));
  const quietMinutes = Number.isFinite(latest) ? Math.max(0, Math.floor((env.probes.now().getTime() - latest) / 60_000)) : undefined;
  return { alive, quietMinutes, liveness: livenessOf(alive, quietMinutes) };
}

export function toRun(run: StoredRun, tag: string, env: ViewEnv, activity?: OrderActivity, dispatch?: ProjectConfig['dispatch'], stateDir?: string): A.Run {
  const port = dispatch && run.slot !== undefined ? computePortBase(dispatch, run.slot) : undefined;
  const observation = observeRun(run, env, activity);
  const consults = readRunConsults(stateDirOfRun(run, stateDir), tag, run.id);
  return {
    ...(liveRuns.peek(run) ? { live: liveRuns.peek(run) } : {}), ...(run.live_summary ? { liveSummary: run.live_summary } : {}),
    ...(run.phase ? { phase: run.phase, model: run.model, planFrom: run.plan_from } : {}),
    id: run.id, key: runKey(tag, run.id), seq: run.seq, worker: run.worker, ...(run.session ? { session: run.session } : {}), started: run.started,
    ...(run.ended ? { ended: run.ended } : {}), ...(run.outcome ? { outcome: run.outcome } : {}), ...(run.note ? { note: run.note } : {}),
    imported: !!run.imported, ...(run.pid ? { pid: run.pid } : {}), ...observation, ...(run.slot !== undefined ? { slot: run.slot } : {}), ...(port !== undefined ? { ports: { first: port, last: port + (dispatch?.port_block || 10) - 1 } } : {}), ...(run.attempt ? { attempt: run.attempt } : {}),
    hasLog: !!run.log && existsSync(run.log), usage: usageOf(run, env.workers?.workers ?? [], env.probes),
    ...(run.role ? { role: run.role, role_source: run.role_source, role_effort: run.role_effort, role_reasoning: run.role_reasoning, mcp_servers: run.mcp_servers, role_warnings: run.role_warnings } : {}),
    ...(run.routing ? { routing: run.routing } : {}), ...(run.skills ? { skills: run.skills } : {}),
    ...(run.monitor ? { monitor: true } : {}), ...(run.rotated ? { rotatedFrom: { worker: run.rotated.from, reason: run.rotated.reason, paid: run.rotated.paid === true, ...(run.rotated.text ? { text: run.rotated.text } : {}) } } : {}), ...(run.handoff_file ? { handoffFile: run.handoff_file } : {}), ...(run.limit ? { limit: run.limit } : {}), ...(run.end ? { end: run.end } : {}),
    ...(consults.length ? { consults } : {}),
  };
}

/** Which actions the stage allows now, and why the others are not available. */
export function actionsFor(stage: Stage, env: ViewEnv, waitingFor?: A.WaitingFor): { allowed: A.OrderAction[]; unavailable: Partial<Record<A.OrderAction, string>> } {
  const allowed: A.OrderAction[] = [];
  const unavailable: Partial<Record<A.OrderAction, string>> = {};
  for (const kind of ['queue', 'hold', 'release', 'cancel', 'approve', 'rework', 'answer'] as const) {
    // The board offers approval only for work that was handed in for review (the command line is more lenient for an order that is idle).
    const problem = kind === 'approve' && stage !== 'awaiting-review' ? t('only an order that is awaiting review can be approved here (this one is {stage})', { stage })
      : kind === 'answer' && stage === 'awaiting-user' && waitingFor === 'card' ? t('the order waits for a card to be clicked, not for an answer')
      : actionProblem(stage, kind);
    if (problem) unavailable[kind] = problem; else allowed.push(kind);
  }
  if ((stage === 'queued' || stage === 'held') && env.workers) allowed.push('run');
  else unavailable.run = env.workers ? `only a queued or held order can be started now (this one is ${stage})` : 'no workers file was given';
  if (stage === 'running') allowed.push('stop');
  else unavailable.stop = `only a running order can be stopped (this one is ${stage})`;
  return { allowed, unavailable };
}

function spendOf(doc: OrderDoc, env: ViewEnv, stateDir?: string): A.OrderSpend | undefined {
  const credits = creditsOf(doc);
  const hasConsult = doc.runs.some(r => readRunConsults(stateDirOfRun(r, stateDir), doc.order.tag, r.id).some(c => c.outcome !== 'refused'));
  if (!hasConsult && !doc.runs.some(r => !r.imported && (r.ended || r.usage)) && doc.order.mandate?.spend_cap === undefined && !credits) return undefined;
  const spend = orderSpend(doc, env.workers?.workers ?? [], env.probes, env.cachedOnly, stateDir);
  return credits ? { ...spend, credits } : spend;
}

/** The monitor of an order that is in stage `monitoring`. */
export function monitorViewOf(doc: OrderDoc, stage: Stage): A.MonitorView | undefined {
  const m = doc.monitor;
  const spec = doc.reports.find(r => r.seq === m?.report_seq)?.monitor;
  if (stage !== 'monitoring' || !m || !spec) return undefined;
  return { spec, started: m.started, deadline: m.deadline, checks: m.checks, ...(m.last_at ? { lastCheckAt: m.last_at } : {}), ...(m.last_result ? { lastResult: m.last_result } : {}), ...(m.tail ? { tail: m.tail } : {}) };
}

function phaseSummary(project: ProjectConfig, doc: OrderDoc) {
  const phases = orderPhases(project, doc);
  return phases ? { phase: { id: phases.current.id, index: phases.index + 1, count: phases.list.length } } : {};
}

/** Every agent working on the order now: its open runs, the consult each is waiting on, its children's open runs and
 * their consults, a monitor job, and (detail only, it scans events) a running independent check. */
export function liveAgents(doc: OrderDoc, stage: Stage, stateDir: string | undefined, orders?: View['orders'], withChecks = false): A.LiveAgent[] {
  const agents: A.LiveAgent[] = [];
  const runsOf = (d: OrderDoc, kind: 'run' | 'child') => {
    for (const r of d.runs.filter(run => run.ended === undefined)) {
      agents.push({ kind, tag: d.order.tag, label: r.phase ?? r.role ?? (r.monitor ? 'monitor' : 'run'), worker: r.worker, ...(r.model ? { model: r.model } : {}), started: r.started, run: r.id });
      const consult = readActiveConsult(stateDirOfRun(r, stateDir), d.order.tag, r.id);
      if (consult) agents.push({ kind: 'consult', tag: d.order.tag, label: 'consult', worker: consult.consultant, model: consult.model, started: consult.at, run: r.id, question: consult.question });
    }
  };
  runsOf(doc, 'run');
  const monitor = monitorViewOf(doc, stage);
  if (monitor && !doc.runs.some(r => r.ended === undefined)) agents.push({ kind: 'monitor', tag: doc.order.tag, label: 'monitor', started: monitor.started });
  if (withChecks && orders) {
    try {
      const check = independentChecks(orders, doc.order.tag).findLast(c => c.status === 'running');
      if (check) agents.push({ kind: 'check', tag: doc.order.tag, label: 'verifier', worker: check.worker, started: check.started });
    } catch { /* display only */ }
  }
  for (const child of orders?.children(doc) ?? []) runsOf(child, 'child');
  return agents;
}

const agentCount = (agents: A.LiveAgent[]) => agents.length ? { agentsRunning: agents.length } : {};

function family(doc: OrderDoc, orders?: View['orders']) {
  const children = orders?.children(doc).map(child => {
    const run = child.runs.at(-1), o = child.order;
    return { tag: o.tag, title: o.title, stage: orders.stage(child).stage, worker: run?.worker ?? o.worker, model: run?.model ?? o.model };
  });
  return { ...(doc.order.parent ? { parent: doc.order.parent } : {}), ...(children?.length ? { children } : {}) };
}

export function summaryOf(project: ProjectConfig, doc: OrderDoc, stage: StageResult, env: ViewEnv, activity?: OrderActivity, report?: StoredReport, mark?: Parameters<typeof attentionState>[1], orders?: View['orders']): A.OrderSummary {
  const open = doc.runs.find(r => r.ended === undefined);
  const observation = observeRun(open, env, activity);
  const spend = spendOf(doc, env, project.state_dir);
  const o = doc.order;
  return {
    ...family(doc, orders), ...phaseSummary(project, doc), ...attentionState(doc, mark), ...agentCount(liveAgents(doc, stage.stage, project.state_dir, orders)),
    ...(open && liveRuns.peek(open) ? { live: liveRuns.peek(open) } : {}), ...(unanswered(doc).length ? { unanswered: unanswered(doc) } : {}),
    ...(o.next_worker ? { nextWorker: o.next_worker } : {}),
    ...(doc.actions.some(a => a.lint) ? { lintBounced: true } : {}),
    project: project.id, review: o.review ?? project.review, tag: o.tag, title: o.title, kind: effectiveKind(o), ...(o.heavy ? { heavy: o.heavy } : {}), stage: stage.stage, why: stage.why,
    ...(stage.waitingFor ? { waitingFor: stage.waitingFor } : {}), ...(o.worker ? { worker: o.worker } : {}), ...(o.tags?.length ? { tags: o.tags } : {}), ...(o.routing ? { routing: toRouting(o.routing) } : {}), needs: o.needs, updated: o.updated, ...(report ? { report: toReport(report) } : {}),
    ...(open ? { run: { id: open.id, key: runKey(o.tag, open.id), worker: open.worker, started: open.started, imported: !!open.imported, alive: observation.alive } } : {}),
    quietMinutes: observation.quietMinutes, liveness: observation.liveness,
    ...(activity?.openCommand ? { openCommand: activity.openCommand } : {}),
    ...(open && (liveRuns.peek(open)?.plan ?? activity?.progress) ? { progress: liveRuns.peek(open)?.plan ?? activity?.progress } : {}),
    ...(spend ? { spend } : {}), ...(o.uses?.length ? { uses: o.uses } : {}), ...(o.branch ? { branch: o.branch } : {}), ...(monitorViewOf(doc, stage.stage) ? { monitor: monitorViewOf(doc, stage.stage) } : {}), actions: actionsFor(stage.stage, env, stage.waitingFor).allowed,
  };
}

/** Every order of a project as its list line, sorted by tag. */
export function summaries(view: View, env: ViewEnv, listOnly = false): A.OrderSummary[] {
  const docs = view.orders.all();
  const merged = view.orders.mergedSet(docs);
  const marks = attentionFor(view.orders.store);
  return docs.map(doc => {
    const stage = view.orders.stage(doc, merged);
    const row = view.rows?.find(r => r.tag === doc.order.tag);
    const latest = [...doc.reports].sort((a, b) => b.seq - a.seq)[0];
    if (listOnly) {
      const o = doc.order, open = doc.runs.find(r => !r.ended);
      const monitor = monitorViewOf(doc, stage.stage);
      const observation = observeRun(open, env, row?.activity);
      const waitingQuestion = (stage.stage === 'awaiting-user' || stage.stage === 'blocked') && stage.waitingFor !== 'card' && latest?.question
        ? { text: latest.question, options: latest.options && toOptions(latest.options) } : undefined;
      return { ...family(doc, view.orders), ...phaseSummary(view.config, doc), ...agentCount(liveAgents(doc, stage.stage, view.config.state_dir, view.orders)), ...(waitingQuestion && { waitingQuestion }), ...attentionState(doc, marks(o.tag)), ...(unanswered(doc).length ? { unanswered: unanswered(doc) } : {}), ...(doc.actions.some(a => a.lint) ? { lintBounced: true } : {}), project: view.config.id, review: o.review ?? view.config.review, tag: o.tag, title: o.title, kind: effectiveKind(o), stage: stage.stage, why: stage.why, needs: o.needs, updated: o.updated,
        ...(o.next_worker ? { nextWorker: o.next_worker } : {}),
        ...(o.heavy ? { heavy: o.heavy } : {}), ...(o.tags?.length ? { tags: o.tags } : {}),
        quietMinutes: observation.quietMinutes, liveness: observation.liveness, ...(row?.activity?.openCommand ? { openCommand: row.activity.openCommand } : {}),
        ...(o.worker ? { worker: o.worker } : {}), ...(stage.waitingFor ? { waitingFor: stage.waitingFor } : {}), ...(o.branch ? { branch: o.branch } : {}), ...(o.uses?.length ? { uses: o.uses } : {}),
        ...(open ? { run: { id: open.id, key: runKey(o.tag, open.id), worker: open.worker, started: open.started, imported: !!open.imported, alive: observation.alive } } : {}),
        ...(open && row?.activity?.progress ? { progress: row.activity.progress } : {}),
        ...(monitor ? { monitor: { started: monitor.started, deadline: monitor.deadline, checks: monitor.checks, lastCheckAt: monitor.lastCheckAt, lastResult: monitor.lastResult } } : {}), actions: actionsFor(stage.stage, env, stage.waitingFor).allowed };
    }
    return summaryOf(view.config, doc, stage, env, row?.activity, NEEDS_YOU.includes(stage.stage) ? latest : undefined, marks(doc.order.tag), view.orders);
  }).sort((a, b) => (a.tag < b.tag ? -1 : 1));
}

/** Runs of every order, newest first. `cursor` is "<started>|<key>" of the last run of the previous page. */
export function runList(view: View, env: ViewEnv, query: { since?: string; worker?: string; limit: number; cursor?: string }): A.RunList {
  const docs = view.orders.all();
  const merged = view.orders.mergedSet(docs);
  const rows: { started: string; key: string; doc: OrderDoc; run: StoredRun }[] = [];
  for (const doc of docs) for (const run of doc.runs) {
    if (query.since && run.started < query.since) continue;
    if (query.worker && run.worker !== query.worker) continue;
    rows.push({ started: run.started, key: runKey(doc.order.tag, run.id), doc, run });
  }
  rows.sort((a, b) => (a.started === b.started ? (a.key < b.key ? 1 : -1) : a.started < b.started ? 1 : -1));
  let from = 0;
  if (query.cursor) {
    const i = query.cursor.lastIndexOf('|');
    const started = query.cursor.slice(0, i), key = query.cursor.slice(i + 1);
    from = rows.findIndex(r => r.started < started || (r.started === started && r.key < key));
    if (from < 0) from = rows.length;
  }
  const page = rows.slice(from, from + query.limit);
  const last = page[page.length - 1];
  const items = page.map(r => ({ ...toRun(r.run, r.doc.order.tag, env, view.rows?.find(row => row.tag === r.doc.order.tag)?.activity, view.config.dispatch, view.config.state_dir), project: view.config.id, tag: r.doc.order.tag, title: r.doc.order.title, stage: view.orders.stage(r.doc, merged).stage }));
  return { project: view.config.id, count: items.length, items, ...(page.length === query.limit && from + query.limit < rows.length && last ? { next: `${last.started}|${last.key}` } : {}) };
}

export function countStages(items: readonly { stage: Stage }[]): Partial<Record<Stage, number>> {
  const out: Partial<Record<Stage, number>> = {};
  for (const i of items) out[i.stage] = (out[i.stage] ?? 0) + 1;
  return out;
}

export function projectInfo(view: View, env: ViewEnv): A.ProjectInfo {
  const docs = view.orders.all(), merged = view.orders.mergedSet(docs);
  const items = docs.map(d => ({ stage: view.orders.stage(d, merged).stage }));
  return {
    id: view.config.id, name: view.config.name, orderCount: items.length, hasWorkers: !!env.workers, workOrdersDir: view.config.work_orders,
    tableWriteBack: !!view.config.dispatch_table?.write_back, checks: !!(view.config.checks.protected_paths.length || view.config.checks.forbidden_tracked.length || view.config.checks.references),
    stages: countStages(items),
    design: { enabled: !!view.config.design?.enabled },
    ...(view.config.picks || view.config.art || view.config.credits || view.config.usage_ledgers?.length || env.workers?.usage_ledgers?.length
      ? { library: { picks: !!view.config.picks, art: !!view.config.art, credits: !!view.config.credits, usage: !!(view.config.usage_ledgers?.length || env.workers?.usage_ledgers?.length) } } : {}),
  };
}

const point = (q: QuotaReading): A.QuotaPoint => ({
  source: q.source, at: q.at, ok: q.ok, ...(q.error ? { error: q.error } : {}), ...(q.note ? { note: q.note } : {}), windows: q.windows.map(w => ({ name: w.name, usedPercent: w.usedPercent, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) })),
  ...(q.balance ? { balance: { raw: q.balance.raw, ...(q.balance.amount !== undefined ? { amount: q.balance.amount } : {}) } } : {}),
});
export const quotaPoint = point;

/** Workers as the board shows them, merged over the projects (a worker is shared; its counts add up). */
export function workerViews(snap: Snapshot, env: ViewEnv, only?: ProjectView): A.Worker[] {
  const views = only ? [only] : snap.projects;
  const merged = new Map<string, A.Worker>();
  const spent = new Map<string, number>();
  const now = env.probes.now();
  for (const v of views) for (const [id, usd] of spendToday(v.orders.all(), env.workers?.workers ?? [], env.probes, now, env.cachedOnly, v.config.state_dir)) spent.set(id, (spent.get(id) ?? 0) + usd);
  for (const v of views) for (const w of v.workers ?? []) {
    const have = merged.get(w.config.id);
    const reading = w.config.quota ? (v.quotas ?? []).find(q => q.source === w.config.quota) : undefined;
    const today = spent.get(w.config.id) ?? 0;
    const view: A.Worker = {
      id: w.config.id, engine: w.config.engine, ...(w.config.route ? { route: w.config.route } : {}), paid: w.config.paid, concurrency: w.config.concurrency,
      ...(w.config.daily_runs !== undefined ? { dailyRuns: w.config.daily_runs } : {}), capabilities: w.config.capabilities, extraCapabilities: w.config.capabilities.filter(c => !(CAPABILITIES as readonly string[]).includes(c)), notes: w.config.notes, model: w.config.model ?? w.config.launch?.model, maxTokensPerRun: w.config.max_tokens_per_run, cost: w.config.cost, enabled: w.config.enabled, cardOnly: w.config.card_only,
      canResume: workerAdapter(w.config.engine).nativeResume || !!w.config.launch?.session, available: (have?.available ?? true) && w.available, reasons: [...new Set([...(have?.reasons ?? []), ...w.reasons])], running: (have?.running ?? 0) + w.running, runsToday: (have?.runsToday ?? 0) + w.runsToday,
      ...(reading ? { quota: point(reading) } : {}), ...(w.config.price ? { price: w.config.price } : {}),
      ...(w.config.daily_cap_usd !== undefined ? { dailyCapUsd: w.config.daily_cap_usd } : {}), spendTodayUsd: Math.round(today * 1e6) / 1e6,
      overCap: w.config.daily_cap_usd !== undefined && today >= w.config.daily_cap_usd,
      aliases: w.config.aliases,
      ...(w.config.quota ? { quotaSource: w.config.quota } : {}),
      sharesQuotaWith: w.config.quota ? (env.workers?.workers ?? []).filter(o => o.id !== w.config.id && o.quota === w.config.quota).map(o => o.id) : [],
      ...(w.config.model_family ? { modelFamily: w.config.model_family } : {}),
      sameModelAs: w.config.model_family ? (env.workers?.workers ?? []).filter(o => o.id !== w.config.id && o.model_family === w.config.model_family).map(o => o.id) : [],
      disabledWhen: w.config.disabled_when.map(r => ('window_full' in r ? { window: r.window_full, at: r.at } : { balanceDrop: r.balance_drop })),
      hasLaunch: !!w.config.launch, onLimit: w.config.on_limit ?? 'wait', rotatePaid: w.config.rotate_paid === true,
      ...(w.config.host ? { host: w.config.host } : {}),
    };
    merged.set(w.config.id, view);
  }
  return [...merged.values()];
}

/** Pick sets waiting for a choice. A project whose pick files cannot be read has none to show here (the picks page says why). */
export function pendingPicksOf(view: ProjectView): NonNullable<A.Overview['pendingPicks']>['items'] {
  try {
    return listPicks(view.config, view.orders).sets.filter(s => s.state === 'pending').map(s => ({ id: s.id, title: s.title, ...(s.order ? { order: s.order } : {}), options: s.options.length }));
  } catch { return []; }
}

export function overview(view: ProjectView, snap: Snapshot, env: ViewEnv, extraProblems: readonly A.Problem[] = []): A.Overview {
  view = { ...view, orders: readOrders(view.orders) };
  snap = { ...snap, projects: snap.projects.map(v => v.config.id === view.config.id ? view : { ...v, orders: readOrders(v.orders) }) };
  const items = summaries(view, env);
  const needsYou = NEEDS_YOU.flatMap(stage => items.filter(i => i.stage === stage));
  const running = items.filter(i => i.run);
  const problems: A.Problem[] = [...extraProblems, ...(view.tick?.problems ?? []).map(p => ({ kind: p.kind, ...(p.tag ? { tag: p.tag } : {}), ...(p.evidence?.length ? { evidence: p.evidence } : {}), text: p.text }))];
  const workers = workerViews(snap, env, view);
  const pendingQuotes = quoteList(view.config.id, view.orders, 'pending');
  const pendingPicks = pendingPicksOf(view);
  const out: A.Overview = {
    project: view.config.id, name: view.config.name, at: snap.at,
    needsYou: { count: needsYou.length, items: needsYou },
    problems: { count: problems.length, items: problems },
    running: { count: running.length, items: running },
    pendingQuotes: { count: pendingQuotes.count, items: pendingQuotes.items },
    ...(pendingPicks.length ? { pendingPicks: { count: pendingPicks.length, items: pendingPicks } } : {}),
    workers: { count: workers.length, items: workers },
    stages: countStages(items),
    next: { moves: (view.tick?.moves ?? []).map(m => ({ tag: m.tag, mode: m.mode, worker: m.worker })), heldBack: view.tick?.heldBack ?? [] },
  };
  if (view.error) out.error = view.error;
  if (snap.freeRamGb !== undefined || snap.minFreeRamGb !== undefined) out.machine = { ...(snap.freeRamGb !== undefined ? { freeRamGb: Number(snap.freeRamGb.toFixed(1)) } : {}), ...(snap.minFreeRamGb !== undefined ? { minFreeRamGb: snap.minFreeRamGb } : {}) };
  return out;
}

/** The last `check` event of an order as a result. */
export function lastCheck(events: readonly A.OrderEvent[], delivery = false): A.CheckResult | undefined {
  const e = [...events].reverse().find(x => x.type === 'check' && (!delivery || x.data?.delivery === true));
  if (!e) return undefined;
  const d = (e.data ?? {}) as { ok?: boolean; base?: string; worktree?: string; general?: A.CheckItem[]; lint?: A.CheckItem[]; report?: number; delivery?: boolean; results?: string[]; refs?: { same: number; other: A.CheckRef[] } };
  return { tag: e.tag, at: e.at, ok: !!d.ok, base: d.base ?? '', worktree: d.worktree ?? '', general: d.general ?? [], ...(d.lint ? { lint: d.lint } : {}), ...(d.report !== undefined ? { report: d.report } : {}), ...(d.delivery ? { delivery: true } : {}), ...(d.results ? { results: d.results } : {}), ...(d.refs ? { refs: d.refs } : {}) };
}

/** The last deterministic acceptance-gate result recorded for an order. */
export function lastVerify(events: readonly A.OrderEvent[]): A.VerifyResult | undefined {
  const e = [...events].reverse().find(x => x.type === 'order-verified');
  if (!e) return undefined;
  const d = (e.data ?? {}) as { run?: string; ok?: boolean; results?: A.VerifyItem[] };
  return { tag: e.tag, at: e.at, ...(d.run ? { run: d.run } : {}), results: Array.isArray(d.results) ? d.results : [], ok: d.ok === true, exitCode: d.ok === true ? 0 : 1 };
}

export function detail(view: View, tag: string, env: ViewEnv): A.OrderDetail {
  const doc = view.orders.get(tag);
  const merged = view.orders.mergedSet();
  const stage = view.orders.stage(doc, merged);
  const events = view.orders.store instanceof SqliteStore ? view.orders.store.eventRows({ tag: doc.order.tag }) : numberedEvents(view.orders.store.events()).filter(e => e.tag.toLowerCase() === doc.order.tag.toLowerCase());
  const row = view.rows?.find(r => r.tag === doc.order.tag);
  const o = doc.order;
  const actions = actionsFor(stage.stage, env, stage.waitingFor);
  let file: A.OrderDetail['file'];
  try {
    const path = findOrderFile(view.config.work_orders, o.tag);
    const size = statSync(path).size;
    file = { path, markdown: readFileSync(path, 'utf8').slice(0, FILE_LIMIT), truncated: size > FILE_LIMIT };
  } catch { /* an order without a file */ }
  const spend = spendOf(doc, env, view.config.state_dir);
  const routingNow = routingOf(view.config, doc);
  const check = lastCheck(events);
  const deliveryLint = lastCheck(events, true);
  const verify = lastVerify(events);
  const worktree = o.worktree ?? row?.activity?.worktree;
  const sparseWorktree = worktree && existsSync(worktree) ? worktreeSparseDirs(worktree) : effectiveSparse(view.config, o);
  const external = externalCallsOf(view.config, env.workers, worktree);
  const notes = pendingNotes(doc).map(n => ({ kind: n.kind, text: n.text, at: n.at, ...(n.question ? { question: n.question } : {}) }));
  const open = doc.runs.find(r => r.ended === undefined);
  for (const run of doc.runs) liveRuns.read(view.config, o.tag, run, env.probes, worktree);
  const ledger = collectUsage(view.config, view.orders.all(), env.workers, env.probes);
  const usage = ledger.rows.filter(r => r.order === o.tag);
  const total = usageReport(usage).total;
  const warnings = budgetWarnings(view.config, ledger.rows, env.probes.now()).filter(w => !w.order || w.order === o.tag);
  const signals = ledger.signals.filter(s => s.order === o.tag);
  const accounting = { rows: usage, signals, total, warnings, reworkShare: total.tokens ? usage.filter(r => r.rework).reduce((n,r) => n + (r.total_tokens ?? 0), 0) / total.tokens : 0, resumeShare: total.tokens ? usage.filter(r => r.resume).reduce((n,r) => n + (r.total_tokens ?? 0), 0) / total.tokens : 0 };
  const live = open ? liveRuns.peek(open) : undefined;
  const messages = worktree ? readInbox(worktree, live?.inbox_opened_at) : [];
  const nudge = open ? readNudges(view.config)[nudgeKey(o.tag, open.id)] : undefined;
  const firstPass = currentFirstPass(view.orders, doc);
  const phases = orderPhases(view.config, doc);
  const proposal = doc.reports.findLast(r => r.subtasks);
  const splitDecision = proposal && doc.actions.find(a => a.seq > proposal.seq && (a.kind === 'rework' || a.kind === 'accept-split'));
  const pending = !!proposal && proposal === doc.reports.at(-1) && stage.waitingFor === 'card' && !splitDecision;
  return {
    ...family(doc, view.orders),
    ...(() => { const agents = liveAgents(doc, stage.stage, view.config.state_dir, view.orders, true); return agents.length ? { agents } : {}; })(),
    ...(proposal?.subtasks ? { split: { report: proposal.seq, subtasks: proposal.subtasks, pending, decision: splitDecision } } : {}),
    ...attentionState(doc, attentionFor(view.orders.store)(o.tag)),
    ...(phases ? { phases: phases.list.map((p, i): A.OrderPhase => {
      const latest = phases.runsOf(p).at(-1);
      const finished = latest?.outcome === 'completed' && doc.reports.findLast(r => r.run === latest.id)?.status === 'ready';
      const runs = doc.runs.filter(r => r.phase === p.id).map(({ id, worker, model }) => ({ id, worker, model }));
      return { id: p.id, role: p.role, mode: p.mode, state: i > phases.index ? 'next' : i < phases.index || finished ? 'done' : 'current',
        runs, worker: latest?.worker, model: latest?.model, plan: phases.planOf(p)?.text };
    }) } : {}),
    producerNotes: { project: producerNotes(view.config), order: producerNotes(view.config, o.tag) },
    ...(doc.reroutes?.length ? { reroutes: doc.reroutes.slice(-10).map(r => ({ id: r.id, at: r.at, from: r.from, to: r.to, note: r.note, brief: doc.runs.find(run => run.reroute === r.id)?.previous_attempts ?? r.brief })) } : {}),
    project: view.config.id,
    order: {
      ...(o.phases ? { phases: o.phases } : {}),
      ...(o.next_worker ? { nextWorker: o.next_worker } : {}),
      ...(o.planned ? { planned: true } : {}), ...(o.intent ? { intent: o.intent } : {}), ...(o.role ? { role: o.role } : {}),
      review: o.review ?? view.config.review, tag: o.tag, title: o.title, kind: effectiveKind({ kind: o.kind, routing: routingNow }), ...(o.uses?.length ? { uses: o.uses } : {}), ...(o.heavy ? { heavy: o.heavy } : {}), needs: o.needs, ...(o.condition ? { condition: o.condition } : {}),
      ...(o.role ? { role: o.role } : {}), ...(o.worker ? { worker: o.worker } : {}), ...(o.tags?.length ? { tags: o.tags } : {}), ...(o.skills?.length ? { skills: o.skills } : {}), ...(o.tools?.length ? { tools: o.tools } : {}), ...(o.priority !== undefined ? { priority: o.priority } : {}), ...(o.check ? { check: o.check } : {}), routing: toRouting(routingNow), ...(o.mandate ? { mandate: o.mandate } : {}), ...(o.branch ? { branch: o.branch } : {}),
      ...(o.base_ref ? { base_ref: o.base_ref } : {}), ...(o.worktree ? { worktree: o.worktree } : {}), ...(o.sparse !== undefined ? { sparse: o.sparse } : {}), ...(o.scheduled ? { source: o.scheduled.source, planned_at: o.scheduled.planned_at } : {}), created: o.created, updated: o.updated,
    },
    stage: stage.stage, why: stage.why, ...(stage.waitingFor ? { waitingFor: stage.waitingFor } : {}),
    needsStatus: o.needs.map(n => { try { return { tag: n, stage: view.orders.stage(view.orders.get(n), merged).stage }; } catch { return { tag: n }; } }),
    actions: pending ? [...actions.allowed, 'accept-split'] : actions.allowed, unavailable: actions.unavailable,
    runs: doc.runs.map(r => toRun(r, o.tag, env, row?.activity, view.config.dispatch, view.config.state_dir)), reports: doc.reports.map(r => ({ ...toReport(r), ...(r.plan ? { plan: r.plan } : {}) })),
    referencedDecisions: referencedDecisions(view.config, doc, file?.markdown), questions: (doc.questions ?? []).map(toQuestion), quotes: (doc.quotes ?? []).map(q => toQuote(view.config.id, o.tag, q)), lessons: lessonsForOrder(view.config, doc),
    decisions: doc.actions.map(a => ({ seq: a.seq, at: a.at, kind: a.kind, ...(a.note ? { note: a.note } : {}), ...(a.choice !== undefined ? { choice: a.choice } : {}), ...(a.imported ? { imported: true } : {}), ...(a.override ? { override: true } : {}) })),
    ...(check ? { lastCheck: check } : {}), ...(deliveryLint ? { deliveryLint } : {}), ...(verify ? { verify } : {}), ...(spend ? { spend } : {}),
    acceptance: acceptanceCard(view.config, view.orders, o.tag) ?? (firstPass ? { tag: o.tag, title: o.title, href: `/p/${encodeURIComponent(view.config.id)}/orders/${encodeURIComponent(o.tag)}#acceptance`, pipelineRequired: false, lint: [], changed: [], images: [] } : undefined),
    firstPass,
    ...(monitorViewOf(doc, stage.stage) ? { monitor: monitorViewOf(doc, stage.stage) } : {}), ...(row?.activity?.progress && doc.runs.some(r => r.ended === undefined) ? { progress: row.activity.progress } : {}),
    ...(external.length ? { externalCalls: external } : {}),
    accounting, pendingNotes: notes, messages, thread: [...threadOf(doc, live), ...events.filter(e => e.type === 'usage-budget').map((e,i) => ({ id: `usage-budget-event-${i}`, at: e.at, kind: e.type, text: String(e.data?.text ?? '') })), ...warnings.filter(w => !events.some(e => e.type === 'usage-budget' && e.data?.text === w.text)).map((w,i) => ({ id: `usage-budget-${i}`, at: env.probes.now().toISOString(), kind: 'usage-budget', text: w.text }))].sort((a,b) => a.at.localeCompare(b.at)), ...(nudge ? { commitNudge: nudge } : {}),
    events: events.slice(-200), eventsTotal: events.length, ...(file ? { file } : {}),
    ...(worktree ? { worktree } : {}),
    ...(sparseWorktree?.length ? { sparseWorktree } : {}),
  };
}
