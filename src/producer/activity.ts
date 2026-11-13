import type { ProjectConfig } from '../config.ts';
import { gatesState } from '../gates/state.ts';
import type { Orders } from '../orders/service.ts';
import type { ProducerAction, ProducerActionStatus, ProducerCase } from './producer.ts';
import type { ProducerSessionStatus, ProducerSessionTurn } from './session.ts';
import { sessionRetryAt } from './session.ts';
import { producerPolicy, proposalValidity } from './producer.ts';
import { readStateFile } from '../orders/state-files.ts';
import { verificationClaim } from './activity-format.ts';
import { independentChecks, reviewRunsToday, type IndependentCheck } from '../review/independent.ts';
import { producerWorks, type ProducerWork } from './work-sessions.ts';
import { producerUsage, type DailyModelUsage } from './session-usage.ts';

export interface ProducerLogRow {
  reroute?: { from: string; to: string };
  id: string; at: string; kind: string; status: ProducerActionStatus; mode: string;
  order?: string; case?: string; result?: string; note: string; firstLine: string; evidence: string[];
  claim: boolean; autonomous: boolean; rule?: { id: string; instruction?: string; policyVersion: string };
  acceptance?: { merge?: string; designStep?: { status: string; reason?: string; files?: string[] }; independent?: IndependentCheck };
  work?: { id: string; worker: string; durationMs: number; tokens: number; status: ProducerWork['status'] };
  children?: ProducerLogRow[];
}
export interface ProducerNow {
  state: 'idle' | 'thinking' | 'paused' | 'budget-exhausted' | 'disabled' | 'stopped' | 'starting' | 'error' | 'recovering';
  reason?: string; since?: string; until?: string; lastTurnAt?: string; nextRoundAt?: string;
  retryAt?: string;
  /** True only after `producer session start`, until `producer session stop`. */
  wanted?: boolean;
  lastRestartedAt?: string;
  cases: { key: string; order?: string; summary: string }[];
  budgets: { key: string; used?: number; limit?: number; resetsAt: string }[];
  usage?: { uncachedInput: number; cacheRead: number; cacheWrite: number; output: number; cacheHitRate: number; costUsd: number; unpricedTokens: number };
  usageDays?: DailyModelUsage[];
}
export interface ProducerLog { project: string; at: string; now: ProducerNow; rows: ProducerLogRow[] }
export interface ProducerLogFilter { since?: string; kind?: string; order?: string; status?: string; autonomous?: boolean; superseded?: boolean }

// The activity digest reads durable records without reconciliation or mutation.
function stored<T>(project: ProjectConfig, name: string, fallback: T): T {
  const text = readStateFile(project, name);
  return text === undefined ? fallback : JSON.parse(text) as T;
}

function acceptanceDetails(orders: Orders, action: ProducerAction, tag?: string): ProducerLogRow['acceptance'] {
  if (action.kind !== 'accept' || !tag) return;
  // Bound by the execution window and order: a later approval must never be attributed to an older action.
  const start = Date.parse(action.ranAt ?? ''), end = Date.parse(action.completedAt ?? action.ranAt ?? '');
  const events = orders.store.events({ tag }).filter(e => Date.parse(e.at) >= start && Date.parse(e.at) <= end);
  const merge = events.findLast(e => e.type === 'accept-merged')?.data?.merge;
  const step = events.findLast(e => e.type === 'accept-step' && e.data?.name === 'design-changesets')?.data;
  const independent = independentChecks(orders, tag).find(r => r.id === action.independentCheck);
  return {
    ...(independent ? { independent } : {}),
    ...(typeof merge === 'string' ? { merge } : {}),
    ...(step ? { designStep: { status: String(step.status), ...(typeof step.reason === 'string' ? { reason: step.reason } : {}), ...(Array.isArray(step.files) ? { files: step.files as string[] } : {}) } } : {}),
  };
}

/** Reads durable records only; no intake, probes, model calls, reconciliation or scheduling. */
export function producerLog(project: ProjectConfig, orders: Orders, filter: ProducerLogFilter = {}, now = new Date()): ProducerLog {
  if (filter.since && !Number.isFinite(Date.parse(filter.since))) throw new Error('"since" must be an ISO time.');
  const state = { cases: stored<ProducerCase[]>(project, '_producer-cases.json', []), actions: stored<ProducerAction[]>(project, '_producer-actions.json', []), paused: stored(project, '_producer-paused.json', false) };
  const cases = new Map(state.cases.map(c => [c.id, c])), policy = producerPolicy(project);
  const rows: ProducerLogRow[] = state.actions.map(a => proposalValidity(orders, a, cases.get(a.caseId))).map(action => {
    const c = cases.get(action.caseId), order = action.target ?? action.order?.tag ?? c?.order;
    const note = action.note ?? action.reason ?? '';
    return { id: action.id, at: action.completedAt ?? action.ranAt ?? action.decision?.at ?? action.at, kind: action.kind, status: action.status,
      mode: action.mode === 'propose' ? 'proposed' : action.mode, order, case: c?.key,
      result: action.refusal ?? action.supersededReason ?? action.rejectionReason ?? action.result,
      ...(action.kind === 'reroute' && action.status === 'done' && action.worker && action.fromWorker ? { reroute: { from: action.fromWorker, to: action.worker } } : {}),
      note, firstLine: note.split(/\r?\n/)[0], evidence: action.evidence ?? [], claim: verificationClaim(action.kind, note),
      autonomous: action.mode === 'auto' && !action.decision && ['done', 'failed'].includes(action.status),
      rule: { id: action.ruleId, instruction: action.policyHash === policy.hash ? policy.rules.find(r => r.id === action.ruleId)?.instruction : undefined, policyVersion: action.policyVersion },
      acceptance: acceptanceDetails(orders, action, order),
    };
  });
  if (project.gates?.nightly.length) for (const run of gatesState(project).runs) {
    const note = `${run.commit.slice(0, 12)} · ${run.results.filter(g => g.status === 'passed').length}/${run.names.length}`;
    rows.push({ id: `nightly-${run.id}`, at: run.ended ?? run.started, kind: 'nightly-gates', status: ['failed', 'error', 'abandoned'].includes(run.status) ? 'failed' : run.ended ? 'done' : 'proposed', mode: 'system',
      note, firstLine: note, result: run.reason, evidence: run.results.map(g => g.log), claim: false, autonomous: false,
      children: run.results.map(g => ({ id: `${run.id}-${g.gate}`, at: g.ended, kind: 'nightly-gate', status: g.status === 'passed' ? 'done' : 'failed', mode: 'system',
        note: g.gate, firstLine: g.gate, result: g.reason ?? (g.value === undefined ? `exit ${g.exit}` : String(g.value)), evidence: [g.log], claim: false, autonomous: false })) });
  }
  for (const [index, event] of orders.store.events().entries()) if (event.type === 'nightly-notice') {
    const note = String(event.data?.text ?? '');
    rows.push({ id: `nightly-notice-${index}`, at: event.at, kind: 'nightly-notice', status: 'done', mode: 'system', note, firstLine: note, evidence: [], claim: false, autonomous: false });
  }
  const eventKinds = new Set(['pause', 'resume', 'budget-exhausted', 'session-start', 'session-stop', 'session-error', 'session-turn-timeout']);
  eventKinds.add('budget-warning');
  const audit = readStateFile(project, 'producer-audit.jsonl') ?? '';
  audit.split(/\r?\n/).filter(Boolean).forEach((line, index) => {
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { return; } // tolerate an interrupted final JSONL write
    if (!eventKinds.has(String(e.kind)) || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at))) return;
    const note = typeof e.reason === 'string' ? e.reason : '';
    rows.push({ id: `audit-${index}`, at: e.at, kind: String(e.kind), status: 'done', mode: 'system', note, firstLine: note.split(/\r?\n/)[0], evidence: [], claim: false, autonomous: false });
  });
  const workGroups = new Map<string, ProducerLogRow>();
  for (const work of producerWorks(project)) {
    const c = cases.get(work.caseId);
    let parent = workGroups.get(work.caseId);
    if (!parent) {
      parent = { id: `case-${work.caseId}`, at: work.started, kind: 'case', status: 'done', mode: 'system', order: work.order, case: work.case, note: c?.card.summary ?? work.case, firstLine: c?.card.summary ?? work.case, evidence: [], claim: false, autonomous: false, children: [] };
      workGroups.set(work.caseId, parent); rows.push(parent);
    }
    parent.at = work.ended ?? work.started;
    parent.children!.push({ id: work.id, at: work.ended ?? work.started, kind: `${work.kind}-session`, status: work.status === 'running' ? 'proposed' : work.status, mode: 'system', order: work.order, case: work.case,
      result: work.result?.summary ?? work.reason, note: work.result?.finding ?? work.reason ?? '', firstLine: '', evidence: [work.prompt, work.log], claim: false, autonomous: false,
      work: { id: work.id, worker: work.worker, durationMs: Math.max(0, Date.parse(work.ended ?? now.toISOString()) - Date.parse(work.started)), tokens: work.usage.total_tokens, status: work.status } });
  }
  const matches = (r: ProducerLogRow) => (!filter.since || Date.parse(r.at) >= Date.parse(filter.since)) && (!filter.kind || r.kind === filter.kind) && (!filter.order || r.order === filter.order) && (!filter.status || r.status === filter.status) && (!filter.autonomous || r.autonomous) && (filter.superseded || filter.status === 'superseded' || r.status !== 'superseded');
  const filtered = rows.filter(r => matches(r) || r.children?.some(matches));
  filtered.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
  return { project: project.id, at: now.toISOString(), now: producerNow(project, orders, state.paused, state.cases, now), rows: filtered };
}

function producerNow(project: ProjectConfig, orders: Orders, paused: boolean, cases: ProducerCase[], now: Date): ProducerNow {
  const status = stored<ProducerSessionStatus>(project, '_producer-session.json', { state: project.producer.enabled ? 'stopped' : 'disabled', turns: 0, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
  const neverStarted = !readStateFile(project, '_producer-session.json');
  const turns = stored<ProducerSessionTurn[]>(project, '_producer-session-turns.json', []);
  const current = status.active && status.currentTurn !== undefined ? turns.find(t => t.number === status.currentTurn) : undefined;
  const active = (current?.sent.cards ?? []).map(card => { const c = cases.find(c => c.key === card.key); return { key: card.key, order: c?.order, summary: c?.card.summary ?? card.trigger }; });
  if (current && !active.length) active.push({ key: current.sent.kind, summary: current.sent.kind, order: undefined });
  const date = now.toISOString().slice(0, 10), hour = now.toISOString().slice(0, 13);
  const budget = stored(project, '_producer-session-budget.json', { hour: '', hourTurns: 0, day: '', dayUsage: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, unpricedTokens: 0 });
  const draft = stored(project, '_producer-drafting-budget.json', { day: '', keys: [] as string[] });
  const hourReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1)).toISOString();
  const dayReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const limits = project.producer.budgets;
  const round = stored<{ at?: string }>(project, '_producer-round.json', {});
  const until = status.budgetUntil;
  const sessionState = status.state === 'stopped' && status.recovery ? 'recovering' : status.state === 'running' || (status.state === 'paused' && until && Date.parse(until) <= now.getTime()) ? status.active ? 'thinking' : 'idle' : status.state;
  return {
    state: !project.producer.enabled ? 'disabled' : paused ? 'paused' : neverStarted ? 'idle' : status.state === 'paused' && until && Date.parse(until) > now.getTime() ? 'budget-exhausted' : sessionState,
    reason: paused ? 'Paused by a person' : sessionState === 'recovering' ? status.recovery?.cause === 'host-restart' ? 'Recovering after host restart' : status.recovery?.cause === 'turn-timeout' ? 'Recovering after a router turn timed out' : 'Recovering after process exit' : status.lastError, since: current?.at, until, lastTurnAt: status.lastTurnAt,
    retryAt: status.state === 'error' ? sessionRetryAt(project, status) : undefined,
    wanted: status.wanted === true, lastRestartedAt: status.lastRestartedAt,
    nextRoundAt: project.producer.enabled && !paused && project.producer.round?.enabled ? round.at ? new Date(Date.parse(round.at) + project.producer.round.every_minutes * 60000).toISOString() : now.toISOString() : undefined,
    cases: active, usageDays: producerUsage(project, 7, now), budgets: [
      { key: 'turns_per_hour', used: budget.hour === hour ? budget.hourTurns : 0, limit: limits.turns_per_hour, resetsAt: hourReset },
      { key: 'usage_per_day', used: budget.day === date ? budget.dayUsage : 0, limit: limits.usage_per_day, resetsAt: dayReset },
      { key: 'review_runs_per_day', used: reviewRunsToday(orders, now) + producerWorks(project).filter(r => r.kind !== 'draft' && r.started.slice(0, 10) === date).length, limit: limits.review_runs_per_day, resetsAt: dayReset },
      { key: 'draft_runs_per_day', used: draft.day === date ? draft.keys.length : 0, limit: limits.draft_runs_per_day, resetsAt: dayReset },
      { key: 'escalations_per_day', used: orders.all().flatMap(d => d.reroutes ?? []).filter(r => r.by === 'producer' && r.at.slice(0, 10) === date).length, limit: limits.escalations_per_day ?? 4, resetsAt: dayReset },
    ],
    usage: { uncachedInput: budget.day === date ? budget.uncachedInput ?? 0 : 0, cacheRead: budget.day === date ? budget.cacheRead ?? 0 : 0, cacheWrite: budget.day === date ? budget.cacheWrite ?? 0 : 0, output: budget.day === date ? budget.output ?? 0 : 0,
      cacheHitRate: budget.day === date && (budget.uncachedInput ?? 0) + (budget.cacheRead ?? 0) + (budget.cacheWrite ?? 0) > 0 ? (budget.cacheRead ?? 0) / ((budget.uncachedInput ?? 0) + (budget.cacheRead ?? 0) + (budget.cacheWrite ?? 0)) : 0,
      costUsd: budget.day === date ? budget.costUsd ?? 0 : 0, unpricedTokens: budget.day === date ? budget.unpricedTokens ?? 0 : 0 },
  };
}
