import type { WorkersFile } from '../workers/config.ts';
import { nightlyCaseInputs } from '../gates/state.ts';
import { scheduleCaseInputs } from '../schedules/store.ts';
import { ESCALATE_HARD, rerouteRefusal } from './reroute.ts';
import { attemptFacts, previousAttempts } from '../run/previous-attempts.ts';
import { ownerOf } from '../usage/spend.ts';
import { acceptDraft, hasAcceptanceSection, planFingerprint, readyToDraft } from './drafting.ts';
import { acceptanceCard, runAcceptanceTrials, type AcceptanceCard } from '../review/acceptance.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ProducerActionKind, ProducerConfig, ProducerMode, ProducerRule, ProjectConfig } from '../config.ts';
import { PRODUCER_ACTIONS } from '../config.ts';
import { Orders } from '../orders/service.ts';
import type { OrderDoc, Report } from '../orders/model.ts';
import { appendStateFile, readStateJson, readStateFile, stateTransaction, writeStateFile } from '../orders/state-files.ts';
import { verifyOrder, type VerifyReport } from '../verify/verify.ts';
import { findLoops, parseActions } from '../run/loops.ts';
import { appendInbox } from '../run/inbox.ts';
import { humanAction } from '../service/actions.ts';
import { createOrder } from '../service/new-order.ts';
import type { TickReport, WorkerState } from '../tick/plan.ts';
import { t } from '../i18n.ts';
import { PRODUCER_ACTION_LIMIT, producerActionInputError } from './tool-schemas.ts';
import { lintBounceCount } from './delivery-lint.ts';
import type { CheckItem } from '../check/general.ts';
import { ACTIVE_CHAT } from './conversation-state.ts';
import { refreshAgreement, trackAgreement, recordAgreementDecision } from './trust.ts';
import { loopGuard, LOOP_REFUSAL } from './loop-guard.ts';
import { executeDispatch } from './dispatch.ts';
import { answerOrder } from '../run/answer.ts';
import { systemProbes } from '../tick/gather.ts';
import { loadWorkers } from '../workers/config.ts';
import type { RunContext } from '../run/launch.ts';
import { applyClean, systemClean, type CleanEnv } from '../clean/clean.ts';
import type { CleanPlan } from '../api/types.ts';
import { checkToolJob, createToolJob, startToolJob } from '../plugins/jobs.ts';
import { designGoalCases, freeGoalCapacity, goalOrderMatches, isGoalDraft } from './goals.ts';
import { reserveDraftAllowance } from './drafting-budget.ts';
import { currentIndependentCheck, needsIndependentCheck, pollIndependentChecks, startIndependentCheck, IndependentCheckPending } from '../review/independent.ts';

export interface ProducerActionDetails {
  worker?: string;
  fromWorker?: string;
  goalFacts?: Record<string, unknown>;
  cleanPlan?: CleanPlan;
  target?: string;
  order?: { tag: string; title: string; kind: string; needs: string[]; body: string; worker?: string };
  planFingerprint?: string;
  priority?: number;
  needs?: string[];
  /** A tool-call: the enabled tool, its operation and the input. */
  tool?: { id: string; operation: string; input: Record<string, unknown> };
}

export interface ProducerCard {
  acceptance?: AcceptanceCard;
  trigger: string;
  stage?: string;
  gates?: unknown;
  summary: string;
  pointers: string[];
  untrusted: string[];
}
export interface ProducerCase {
  id: string;
  key: string;
  project: string;
  trigger: string;
  status: 'open' | 'closed';
  revision: number;
  openedAt: string;
  updatedAt: string;
  order?: string;
  facts: Record<string, unknown>;
  card: ProducerCard;
  closedAt?: string;
}
export type ProducerActionStatus = 'would-do' | 'proposed' | 'done' | 'refused' | 'failed' | 'rejected' | 'superseded';
export interface ProducerAction extends ProducerActionDetails {
  independentCheck?: string;
  reviewCard?: string;
  basis?: { stage: string; run?: string; actionSeq: number };
  supersededReason?: string;
  rejectionReason?: string;
  decision?: { at: string; outcome: 'accepted' | 'edited' | 'rejected' };
  messageId?: string;
  id: string;
  idempotencyKey: string;
  caseId: string;
  caseRevision: number;
  kind: ProducerActionKind;
  status: ProducerActionStatus;
  note?: string;
  reason?: string;
  ruleId: string;
  mode: ProducerMode;
  policyVersion: string;
  policyHash: string;
  at: string;
  result?: string;
  refusal?: string;
  ranAt?: string;
  completedAt?: string;
  evidence?: string[];
  source?: string;
  /** The tool job a done tool-call started. */
  job?: string;
  /** The process running this action now (taken under the state lock, so no other process runs it too). */
  claim?: { pid: number; at: string };
}
export interface ProducerState { cases: ProducerCase[]; actions: ProducerAction[]; paused: boolean; policyVersion: string; policyHash: string }
export interface ProducerPassOptions { now?: Date; tick?: TickReport; workers?: readonly WorkerState[]; workersFile?: WorkersFile; verify?: boolean; env?: ProducerExecutionEnv }
export type ProducerExecutionEnv = Pick<RunContext, 'probes' | 'workers'> & { clean?: CleanEnv };

const CASES = '_producer-cases.json';
const ACTIONS = '_producer-actions.json';
const PAUSED = '_producer-paused.json';
const HEARTBEAT = '_producer-heartbeat.json';
const AUDIT = 'producer-audit.jsonl';
const WOULD_DO = 'producer-would-do.jsonl';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const short = (value: unknown, n = 600): string => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length <= n ? text : `${text.slice(0, n - 1)}…`; };
const atIso = (now?: Date): string => (now ?? new Date()).toISOString();

export function producerPolicy(config: ProjectConfig): { version: string; hash: string; rules: ProducerRule[]; enabled: boolean; budgets: ProducerConfig['budgets'] } {
  const block = config.producer ?? { enabled: false, rules: [], budgets: {}, session: { engine: 'claude' as const, max_turns: 40, enabled: false } };
  let rules: ProducerRule[] = config.design?.enabled && !block.rules.some(r => r.id === 'draft-from-goal')
    ? [...block.rules, { id: 'draft-from-goal', instruction: 'Draft work towards active milestone goals.', action: 'draft-order', mode: 'propose' }]
    : block.rules;
  if (!rules.some(r => r.action === 'reroute')) rules = [...rules, ESCALATE_HARD];
  const normalized = { enabled: block.enabled, rules: rules.filter(r => r !== ESCALATE_HARD).map(r => ({ id: r.id, instruction: r.instruction, action: r.action, mode: r.mode })), budgets: block.budgets, session: block.session, drafting: config.drafting, round: block.round, monitor: config.monitor, clean: config.clean, dispatch: config.dispatch };
  const digest = hash(normalized);
  return { version: `producer-${digest.slice(0, 12)}`, hash: digest, rules, enabled: block.enabled, budgets: block.budgets };
}

export function audit(project: ProjectConfig, entry: Record<string, unknown>): void {
  appendStateFile(project, AUDIT, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export function producerState(project: ProjectConfig): ProducerState {
  const policy = producerPolicy(project);
  return {
    cases: readStateJson<ProducerCase[]>(project, CASES, []),
    actions: readStateJson<ProducerAction[]>(project, ACTIONS, []),
    paused: readStateJson<boolean>(project, PAUSED, false),
    policyVersion: policy.version,
    policyHash: policy.hash,
  };
}

export function producerCases(project: ProjectConfig, openOnly = false): ProducerCase[] {
  const cases = producerState(project).cases;
  return (openOnly ? cases.filter(c => c.status === 'open') : cases).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function producerActions(project: ProjectConfig): ProducerAction[] { return producerState(project).actions.sort((a, b) => b.at.localeCompare(a.at)); }
export function producerAudit(project: ProjectConfig): string[] { return (readStateFile(project, AUDIT) ?? '').split(/\r?\n/).filter(Boolean); }
export function producerWouldDo(project: ProjectConfig): ProducerAction[] { return producerActions(project).filter(a => a.status === 'would-do'); }

export function setProducerPaused(project: ProjectConfig, paused: boolean, _now = new Date()): boolean {
  stateTransaction(project, () => writeStateFile(project, PAUSED, JSON.stringify(paused) + '\n'));
  audit(project, { kind: paused ? 'pause' : 'resume', project: project.id });
  return paused;
}

export function producerHeartbeat(project: ProjectConfig, now = new Date()): void {
  const value = { at: now.toISOString(), project: project.id };
  stateTransaction(project, () => writeStateFile(project, HEARTBEAT, JSON.stringify(value) + '\n'));
  // Events are visible to the existing stream and provide an operator-readable heartbeat trail.
  const store = readStateJson<Record<string, unknown>[]>(project, '_producer-heartbeat-events.json', []);
  store.push(value);
  stateTransaction(project, () => writeStateFile(project, '_producer-heartbeat-events.json', JSON.stringify(store.slice(-1440)) + '\n'));
}

export function producerHeartbeatAt(project: ProjectConfig): string | undefined {
  return readStateJson<{ at?: string } | undefined>(project, HEARTBEAT, undefined)?.at;
}
export function producerHeartbeatProblem(project: ProjectConfig, now = new Date()): string | undefined {
  if (!project.producer?.enabled) return undefined;
  const at = producerHeartbeatAt(project);
  const parsed = at ? Date.parse(at) : NaN;
  if (!at || !Number.isFinite(parsed) || now.getTime() - parsed > 10 * 60_000) return t('producer heartbeat is stale (last seen {at})', { at: at ?? t('never') });
  return undefined;
}

function latestReport(doc: OrderDoc): Report | undefined { return [...doc.reports].sort((a, b) => b.seq - a.seq)[0]; }
function summaryFor(doc: OrderDoc, report: Report | undefined): string { return short(report?.summary ?? doc.order.title); }
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\[[0-9;]*m/g;
const ERROR_LINE = /\b(error|exception|fatal|denied|refused|timed out|timeout|panic)\b/i;
function normalizedError(text: string): string {
  const line = text.replace(ANSI, '').split(/\r?\n/).map(x => x.trim()).find(Boolean) ?? 'failed';
  return line.toLowerCase().replace(/[A-Za-z]:[\\/][^\s]+|(?:\\|\/)[^\s]+/g, '<path>').replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 160);
}
function reportOrLogError(doc: OrderDoc, report: Report | undefined): string | undefined {
  if (report && /error|fail|exception|fatal|denied|refused|timeout/i.test(report.summary)) return normalizedError(report.summary);
  const run = [...doc.runs].reverse().find(r => r.log && existsSync(r.log));
  if (!run?.log) return undefined;
  try {
    const lines = readFileSync(run.log, 'utf8').replace(ANSI, '').split(/\r?\n/).map(x => x.trim()).filter(x => ERROR_LINE.test(x));
    return lines.length ? normalizedError(lines[lines.length - 1]) : undefined;
  } catch { return undefined; }
}
function card(trigger: string, doc: OrderDoc | undefined, summary: string, pointers: string[], gates?: unknown, stage?: string): ProducerCard {
  return { trigger, ...(doc ? { stage: stage ?? 'unknown' } : {}), ...(gates !== undefined ? { gates } : {}), summary: short(summary), pointers, untrusted: ['summary', 'report', 'log'] };
}
function upsert(cases: ProducerCase[], input: Omit<ProducerCase, 'id' | 'revision' | 'openedAt' | 'updatedAt' | 'status'> & { now: string }): { changed: boolean; item: ProducerCase } {
  const existing = cases.find(c => c.key === input.key);
  if (existing) {
    const changed = (input.key.startsWith('round/') ? existing.facts.roundFingerprint !== input.facts.roundFingerprint : JSON.stringify(existing.facts) !== JSON.stringify(input.facts)) || existing.trigger !== input.trigger || existing.card.stage !== input.card.stage || existing.status !== 'open';
    if (changed) { existing.trigger = input.trigger; existing.facts = input.facts; existing.card = input.card; existing.revision += 1; existing.updatedAt = input.now; existing.status = 'open'; delete existing.closedAt; }
    existing.card = input.card;
    return { changed, item: existing };
  }
  const item: ProducerCase = { ...input, id: input.key, status: 'open', revision: 1, openedAt: input.now, updatedAt: input.now };
  cases.push(item);
  return { changed: true, item };
}
function closeResolved(cases: ProducerCase[], openKeys: Set<string>, now: string): ProducerCase[] {
  for (const c of cases) if (c.status === 'open' && !c.key.startsWith('chat/') && !c.key.startsWith('round/') && !c.key.startsWith('nightly/') && !c.key.startsWith('schedule/') && !openKeys.has(c.key)) { c.status = 'closed'; c.closedAt = now; c.updatedAt = now; }
  return cases;
}

/** The scheduled round owns only its namespace; event cases survive independent passes. */
export function syncRoundCases(project: ProjectConfig, inputs: { trigger: string; order?: string; facts: Record<string, unknown>; card: ProducerCard; key: string }[], now: string): ProducerCase[] {
  const cases = readStateJson<ProducerCase[]>(project, CASES, []), open = new Set<string>();
  const current: ProducerCase[] = [];
  for (const input of inputs) {
    const result = upsert(cases, { ...input, project: project.id, now });
    open.add(input.key); current.push(result.item);
    if (result.changed) audit(project, { kind: 'case', case: input.key, revision: result.item.revision, trigger: input.trigger });
  }
  for (const c of cases) if (c.key.startsWith('round/') && c.status === 'open' && !open.has(c.key)) { c.status = 'closed'; c.closedAt = now; c.updatedAt = now; }
  stateTransaction(project, () => writeStateFile(project, CASES, JSON.stringify(cases, null, 2) + '\n'));
  return current;
}

/** Gate completion owns this namespace; ordinary intake must not close a still failing gate. */
export function syncNightlyCases(project: ProjectConfig, now: string): void {
  stateTransaction(project, () => {
    const cases = readStateJson<ProducerCase[]>(project, CASES, []), open = new Set<string>();
    for (const input of nightlyCaseInputs(project)) {
      open.add(input.key);
      const result = upsert(cases, { ...input, now });
      if (result.changed) audit(project, { kind: 'case', case: input.key, revision: result.item.revision, trigger: input.trigger });
    }
    for (const c of cases) if (c.key.startsWith('nightly/') && c.status === 'open' && !open.has(c.key)) {
      c.status = 'closed'; c.closedAt = now; c.updatedAt = now;
      audit(project, { kind: 'case', case: c.key, status: c.status, trigger: c.trigger });
    }
    writeStateFile(project, CASES, JSON.stringify(cases));
  });
}

/** Schedule auto-pause owns this namespace; ordinary intake must not close an open schedule-paused card. */
export function syncScheduleCases(project: ProjectConfig, now: string): void {
  stateTransaction(project, () => {
    const cases = readStateJson<ProducerCase[]>(project, CASES, []), open = new Set<string>();
    for (const input of scheduleCaseInputs(project)) {
      open.add(input.key);
      const result = upsert(cases, { ...input, now });
      if (result.changed) audit(project, { kind: 'case', case: input.key, revision: result.item.revision, trigger: input.trigger });
    }
    for (const c of cases) if (c.key.startsWith('schedule/') && c.status === 'open' && !open.has(c.key)) {
      c.status = 'closed'; c.closedAt = now; c.updatedAt = now;
      audit(project, { kind: 'case', case: c.key, status: c.status, trigger: c.trigger });
    }
    writeStateFile(project, CASES, JSON.stringify(cases));
  });
}

/** Turns the durable order facts and one tick's findings into stable, mergeable cases. */
export function intakeProducer(project: ProjectConfig, orders: Orders, options: ProducerPassOptions = {}): ProducerCase[] {
  if (project.gates) syncNightlyCases(project, atIso(options.now));
  if (project.schedules?.length) syncScheduleCases(project, atIso(options.now));
  runAcceptanceTrials(project, orders);
  const now = atIso(options.now);
  const docs = orders.all();
  const cases = readStateJson<ProducerCase[]>(project, CASES, []);
  const openKeys = new Set<string>();
  for (const c of cases.filter(c => c.key.startsWith('lint/'))) {
    const d = docs.find(d => d.order.tag === c.order);
    if (d && orders.stage(d).stage === 'awaiting-review' && d.reports.at(-1)?.seq === c.facts.report) openKeys.add(c.key);
  }
  const changed: ProducerCase[] = [];
  type CaseInput = Omit<ProducerCase, 'id' | 'revision' | 'openedAt' | 'updatedAt' | 'status'>;
  // Gather every finding before upserting any case: proposal revisions must be stable on the next pass.
  const loopCases = new Map<string, CaseInput[]>();
  for (const doc of docs) {
    const stage = orders.stage(doc).stage;
    if (['merged', 'cancelled', 'held', 'dropped', 'planned', 'draft', 'queued', 'waiting-needs', 'waiting-children'].includes(stage)) continue;
    const r = doc.runs.at(-1);
    const file = r && (r.events_file && existsSync(r.events_file) ? r.events_file : r.log);
    if (!r || !file || !existsSync(file)) continue;
    try {
      const findings = findLoops(parseActions(readFileSync(file, 'utf8')).actions, { repeat: project.dispatch.loop_repeat, alternate: project.dispatch.loop_alternate, longCommands: project.dispatch.long_commands });
      loopCases.set(doc.order.tag, findings.filter(f => f.kind === 'repeat').map(f => ({ key: `loop/${doc.order.tag}/${r.id}/${hash([f.command, f.error]).slice(0, 12)}`, project: project.id, trigger: 'loop', order: doc.order.tag, facts: { run: r.id, kind: f.kind, command: f.command, error: f.error, count: f.count }, card: card(t('repeat finding'), doc, f.text, [`order:${doc.order.tag}`, `run:${r.id}`, `log:${file}`], undefined, stage) })));
    } catch { /* a partial log is data, not a host failure */ }
  }
  const add = (item: Omit<ProducerCase, 'id' | 'revision' | 'openedAt' | 'updatedAt' | 'status'>) => {
    const doc = docs.find(d => d.order.tag === item.order);
    if (doc) {
      const loops = (loopCases.get(doc.order.tag) ?? []).map(c => c.card.summary);
      item.facts = { ...item.facts, ...attemptFacts(doc, loops), kind: doc.order.kind, worker: doc.order.next_worker ?? doc.order.worker ?? doc.runs.at(-1)?.worker };
    }
    const result = upsert(cases, { ...item, now }); openKeys.add(item.key); if (result.changed) changed.push(result.item);
  };
  for (const doc of docs) {
    const latest = latestReport(doc);
    const stage = orders.stage(doc).stage;
    for (const q of (doc.questions ?? []).filter(q => !q.answered)) {
      add({ key: `question/${doc.order.tag}/${q.id}`, project: project.id, trigger: 'question', order: doc.order.tag, facts: { question: q.id }, card: card('question', doc, q.text, [`order:${doc.order.tag}`], undefined, stage) });
    }
    const run = [...doc.runs].reverse().find(r => r.ended);
    // A running order, or one a person has settled (merged, held, queued again…), has no open failure, loop or error case.
    const active = doc.runs.some(r => !r.ended);
    const settled = ['merged', 'cancelled', 'held', 'dropped', 'planned', 'draft', 'queued', 'waiting-needs', 'waiting-children'].includes(stage);
    const attempts = attemptFacts(doc);
    if (!active && !settled && stage !== 'monitoring' && !(stage === 'awaiting-review' && latest?.status === 'ready') && (attempts.consecutive_failures >= 3 || attempts.reworks >= 3 || attempts.same_gate_failing.length)) add({ key: `repeated-failure/${doc.order.tag}`, project: project.id, trigger: 'repeated-failure', order: doc.order.tag, facts: { run: doc.runs.at(-1)?.id, report: latest?.seq }, card: card('repeated-failure', doc, summaryFor(doc, latest), [`order:${doc.order.tag}`], undefined, stage) });
    const independent = currentIndependentCheck(project, orders, doc.order.tag);
    if (independent?.status === 'failed' && stage === 'awaiting-review') {
      add({ key: `independent-check/${doc.order.tag}/${independent.id}`, project: project.id, trigger: 'independent-check-failed', order: doc.order.tag,
        facts: { check: independent.id, report: independent.report, summary: independent.reason, checked: independent.verdict?.checked ?? [] },
        card: card('independent-check-failed', doc, independent.reason ?? 'Independent check failed', [`order:${doc.order.tag}`, `/p/${encodeURIComponent(project.id)}/orders/${encodeURIComponent(doc.order.tag)}#independent-check-${independent.id}`], undefined, stage) });
    }
    if (latest?.status === 'ready' && (run || project.accept) && stage === 'awaiting-review') {
      const deliveryId = run?.id ?? `report-${latest.seq}`;
      // A delivery is verified once per run: later passes reuse the stored result (verify walks the worktree and runs git).
      const prior = cases.find(c => c.key === `delivery/${doc.order.tag}/${deliveryId}`);
      let verification: VerifyReport | undefined = (prior?.facts as { verify?: VerifyReport } | undefined)?.verify ?? undefined;
      if (!verification && options.verify !== false) { try { verification = verifyOrder(project, orders, doc.order.tag, { manual: false }); } catch (e) { verification = { tag: doc.order.tag, at: now, results: [{ name: 'verify', status: 'fail', reason: (e as Error).message.split('\n')[0] }], ok: false, exitCode: 1 }; } }
      const acceptance = acceptanceCard(project, orders, doc.order.tag);
      const deliveryCard = card(t('ready run'), doc, acceptance?.trial?.status === 'failed' ? acceptance.trial.reason ?? 'Acceptance trial failed' : summaryFor(doc, latest), [`order:${doc.order.tag}`, ...(run ? [`run:${run.id}`] : []), 'verify', ...(acceptance ? [acceptance.href] : [])], verification, stage);
      if (acceptance) deliveryCard.acceptance = acceptance;
      add({ key: `delivery/${doc.order.tag}/${deliveryId}`, project: project.id, trigger: 'delivery', order: doc.order.tag, facts: { run: run?.id ?? null, report: latest.seq, verify: verification ?? null, ...(acceptance ? { acceptance: acceptance.trial ?? null } : {}) }, card: deliveryCard });
    }
    if (run && !active && !settled && (!latest || latest.seq < run.seq || ['blocked', 'failed'].includes(latest.status) || (latest.status === 'waiting' && !!latest.question))) {
      const trigger = latest?.status === 'waiting' ? 'question' : latest?.status === 'blocked' ? 'blocked' : latest?.status === 'failed' ? 'failed' : 'no-report';
      add({ key: `${trigger}/${doc.order.tag}`, project: project.id, trigger, order: doc.order.tag, facts: { run: run.id, report: latest?.seq ?? null, status: latest?.status ?? null }, card: card(trigger, doc, summaryFor(doc, latest), [`order:${doc.order.tag}`, `run:${run.id}`], undefined, stage) });
    }
    const nudge = readStateJson<Record<string, { at?: string; count?: number; files?: number; minutes?: number }>>(project, '_nudges.json', {});
    const second = Object.entries(nudge).find(([key, value]) => key.startsWith(`${doc.order.tag}:`) && (value.count ?? 0) >= 2);
    const commitAfterReminder = second && second[1].at && latest?.at && Date.parse(latest.at) >= Date.parse(second[1].at);
    const tickStillHasNudge = options.tick?.problems.some(p => p.kind === 'commit-nudge' && p.tag === doc.order.tag) ?? true;
    if (second && tickStillHasNudge && !commitAfterReminder && doc.runs.some(r => !r.ended)) add({ key: `stall/${doc.order.tag}`, project: project.id, trigger: 'commit-reminder', order: doc.order.tag, facts: { run: second[0].split(':').slice(1).join(':'), count: second[1].count }, card: card(t('second commit reminder'), doc, t('second commit reminder for {tag}', { tag: doc.order.tag }), [`order:${doc.order.tag}`, 'nudges'], undefined, stage) });
    for (const finding of loopCases.get(doc.order.tag) ?? []) add(finding);
    const recent = (d: OrderDoc) => d.runs.some(r => r.ended && Date.parse(r.ended) >= Date.parse(now) - 24 * 3600_000);
    const err = settled || !recent(doc) ? undefined : reportOrLogError(doc, latest);
    if (err) {
      const peers = docs.filter(other => other.order.tag !== doc.order.tag && recent(other) && reportOrLogError(other, latestReport(other)) === err);
      if (peers.length) add({ key: `pattern/${hash(err).slice(0, 20)}`, project: project.id, trigger: 'error-pattern', facts: { signature: err, orders: [doc.order.tag, ...peers.map(p => p.order.tag)].sort() }, card: card(t('same normalized error in multiple runs'), undefined, err, peers.map(p => `order:${p.order.tag}`)) });
    }
    // A changed order or a new commit resolves its old stall/question case.
    if (stage !== 'running' && stage !== 'blocked' && stage !== 'failed' && stage !== 'awaiting-user') openKeys.delete(`stall/${doc.order.tag}`);
  }
  const draftReady = new Set(readyToDraft(project, orders, options.workers, options.workersFile).map(d => d.order.tag));
  const merged = orders.mergedSet(docs);
  for (const doc of docs.filter(d => orders.stage(d, merged).stage === 'planned' && d.order.needs.every(n => merged.has(n)))) {
    const fingerprint = planFingerprint(doc);
    const prior = producerActions(project).filter(a => a.kind === 'draft-order' && a.target === doc.order.tag && a.planFingerprint === fingerprint);
    if (prior.some(a => !['failed', 'refused'].includes(a.status))) { const existing = cases.find(c => c.key === `draft/${doc.order.tag}`); if (existing && prior.some(a => ['proposed', 'would-do'].includes(a.status))) openKeys.add(existing.key); continue; }
    if (!draftReady.has(doc.order.tag)) continue;
    add({ key: `draft/${doc.order.tag}`, project: project.id, trigger: 'ready-to-draft', order: doc.order.tag, facts: { fingerprint }, card: card('ready-to-draft', doc, doc.order.intent ?? '', [`drafting:${doc.order.tag}`], undefined, 'planned') });
  }
  const tick = options.tick;
  const goals = designGoalCases(project, orders);
  for (const goal of goals) add({ key: goal.key, project: project.id, trigger: goal.trigger, facts: goal.facts, card: card(goal.trigger, undefined, goal.summary, [`design:${goal.facts.goal}`]) });
  for (const c of cases.filter(c => c.key.startsWith('goal/') && !openKeys.has(c.key))) c.facts.orderMatches = goalOrderMatches(project, orders, String(c.facts.goal));
  if (tick) {
    const freeKinds = freeGoalCapacity(project, orders, options.env?.probes.freeRamGb());
    if (tick.dispatched === 0 && freeKinds.length) add({ key: 'planning/idle-capacity', project: project.id, trigger: 'idle-capacity', facts: { freeKinds, goals: goals.map(g => ({ case: g.key, trigger: g.trigger, goal: g.facts.goal, system: g.facts.system?.code, summary: g.summary })) }, card: card('idle-capacity', undefined, `No orders dispatched; capacity is free for ${freeKinds.join(', ')}. ${goals.length} open goal cases.`, goals.map(g => `case:${g.key}`)) });
    const quota = tick.problems.filter(p => p.kind === 'quota');
    for (const p of quota) add({ key: `quota/${hash(p.text).slice(0, 20)}`, project: project.id, trigger: 'quota-unreadable', facts: { text: p.text }, card: card(t('quota unreadable'), undefined, p.text, ['tick:quota']) });
    if (!tick.moves.length && !tick.heldBack.length && docs.every(d => !['queued', 'running'].includes(orders.stage(d).stage)) && options.workers?.some(w => w.available)) add({ key: 'planning/free-slot', project: project.id, trigger: 'free-slot', facts: { at: now }, card: card(t('free slot with nothing eligible'), undefined, t('A worker slot is free, but nothing is eligible to run.'), ['tick']) });
  }
  const previous = new Map(cases.map(c => [c.key, c.status]));
  closeResolved(cases, openKeys, now);
  stateTransaction(project, () => writeStateFile(project, CASES, JSON.stringify(cases, null, 2) + '\n'));
  for (const c of changed) audit(project, { kind: 'case', case: c.key, revision: c.revision, status: c.status, trigger: c.trigger });
  for (const c of cases) if (previous.get(c.key) !== c.status && !changed.includes(c)) audit(project, { kind: 'case', case: c.key, revision: c.revision, status: c.status, trigger: c.trigger });
  return cases.filter(c => c.status === 'open').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Mechanical delivery proposals use the ordinary policy/action ledger, without session turns. */
export function proposeLintBounce(project: ProjectConfig, orders: Orders, tag: string, report: number, lint: CheckItem[], note: string): void {
  if (!project.producer.enabled) return;
  const cases = readStateJson<ProducerCase[]>(project, CASES, []);
  const limited = lintBounceCount(orders, tag) >= 2;
  const key = `lint/${tag}/${report}`;
  const result = upsert(cases, { key, project: project.id, order: tag, trigger: 'delivery', facts: { report, lint, limited }, card: { trigger: limited ? 'lint send-back limit' : 'delivery lint failed', stage: 'awaiting-review', summary: limited ? `Two consecutive lint send-backs reached. ${note}` : note, gates: lint, pointers: [`order:${tag}`, 'check'], untrusted: ['report'] }, now: orders.now() });
  stateTransaction(project, () => writeStateFile(project, CASES, JSON.stringify(cases, null, 2) + '\n'));
  if (result.changed) audit(project, { kind: 'case', case: key, revision: result.item.revision, trigger: 'delivery' });
  if (!limited) producerAct(project, orders, key, 'lint-bounce', { note, reason: 'Deterministic delivery checks failed', source: 'delivery-lint' });
}

function ruleFor(config: ProjectConfig, kind: ProducerActionKind, goal = false): ProducerRule {
  if (goal && ['add-order', 'draft-order'].includes(kind)) return producerPolicy(config).rules.find(r => r.id === 'draft-from-goal') ?? { id: 'draft-from-goal', instruction: 'Draft work towards active milestone goals.', action: kind, mode: 'propose' };
  return producerPolicy(config).rules.find(r => r.action === kind && r.id !== 'draft-from-goal') ?? { id: `default-${kind}`, instruction: `Record ${kind}`, action: kind, mode: ['dispatch', 'clean', 'tool-call'].includes(kind) ? 'propose' : 'observe' };
}
function findCase(project: ProjectConfig, id: string): ProducerCase {
  const found = producerCases(project).find(c => c.id === id || c.key === id);
  if (!found) throw new Error(t('No producer case "{id}".', { id }));
  return found;
}
/*
 * The action list is shared by every process of a project (the MCP server, `alba serve`, the tick, the CLI). Nothing rewrites it
 * from a copy read earlier: an action is added, or one action changed, in a read-change-write under the state lock, and an action
 * runs only after its process took it (`claim`) under the same lock.
 */
const writeActions = (project: ProjectConfig, actions: ProducerAction[]) => writeStateFile(project, ACTIONS, JSON.stringify(actions, null, 2) + '\n');
/** Adds an action; one with the same idempotency key stored meanwhile by another process is answered instead. */
function appendAction(project: ProjectConfig, item: ProducerAction): ProducerAction {
  return stateTransaction(project, () => {
    const actions = readStateJson<ProducerAction[]>(project, ACTIONS, []);
    const old = actions.find(a => a.idempotencyKey === item.idempotencyKey);
    if (old) return old;
    writeActions(project, [...actions, item]);
    return item;
  });
}
/** Changes one stored action as it is now; `change` answers false to leave it. Answers the stored action after the change. */
function patchAction(project: ProjectConfig, id: string, change: (stored: ProducerAction) => boolean | void): ProducerAction | undefined {
  return stateTransaction(project, () => {
    const actions = readStateJson<ProducerAction[]>(project, ACTIONS, []);
    const stored = actions.find(a => a.id === id);
    if (!stored || change(stored) === false) return stored;
    writeActions(project, actions);
    return stored;
  });
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/** Actions run synchronously, so a claim older than this belongs to a process that is gone (or a reused pid). */
const CLAIM_STALE_MS = 60 * 60 * 1000;
const CLAIM_LOST = 'The process that ran this action stopped before it recorded the result; check what it did before running it again.';
/** A claim of a process that is gone: the action may have half run, so it is failed, never run again by itself. */
function lostClaim(a: ProducerAction, now = Date.now()): boolean {
  return !!a.claim && a.claim.pid !== process.pid && (!alive(a.claim.pid) || now - Date.parse(a.claim.at) > CLAIM_STALE_MS);
}
function failLostClaim(a: ProducerAction): void {
  delete a.claim;
  Object.assign(a, { status: 'failed', refusal: CLAIM_LOST, completedAt: new Date().toISOString() });
}
/**
 * Takes a stored action for this process when `runnable` says it may run and no live process holds it. Answers the taken copy to
 * run (`item`), or only the action as stored when another process has it, it was decided meanwhile, or it is not there.
 */
function claimAction(project: ProjectConfig, id: string, runnable: (a: ProducerAction) => boolean): { item?: ProducerAction; stored?: ProducerAction } {
  let item: ProducerAction | undefined;
  const stored = patchAction(project, id, a => {
    if (a.claim) { if (!lostClaim(a)) return false; failLostClaim(a); return; }
    if (!runnable(a)) return false;
    a.claim = { pid: process.pid, at: new Date().toISOString() };
    item = structuredClone(a);
  });
  return { ...(item ? { item } : {}), ...(stored ? { stored } : {}) };
}
/** Stores the result of a claimed action and gives the claim back. */
function releaseAction(project: ProjectConfig, item: ProducerAction): void {
  delete item.claim;
  const done = structuredClone(item);
  stateTransaction(project, () => {
    const actions = readStateJson<ProducerAction[]>(project, ACTIONS, []);
    const i = actions.findIndex(a => a.id === item.id);
    if (i < 0) actions.push(done); else actions[i] = done;
    writeActions(project, actions);
  });
}

function rerouteEnv(project: ProjectConfig, env?: ProducerExecutionEnv): ProducerExecutionEnv {
  if (env) return env;
  const file = process.env.ALBA_WORKERS ?? project.workers;
  if (!file) throw new Error('Reroute refused: no workers file is configured.');
  return { workers: loadWorkers(file), probes: systemProbes };
}

/** Chat case revisions do not track the order targeted by a proposal. */
export function proposalValidity(orders: Orders, item: ProducerAction, c?: ProducerCase): ProducerAction {
  if (!['proposed', 'would-do'].includes(item.status)) return item;
  if (c?.status === 'closed' && (item.goalFacts || item.kind === 'clean' || item.kind === 'draft-order')) return { ...item, status: 'superseded', supersededReason: 'The source case closed.' };
  const tag = item.target ?? c?.order;
  if (!tag || item.kind === 'add-order' || item.kind === 'tool-call' || item.goalFacts) return item;
  let reason: string | undefined;
  try {
    const doc = orders.get(tag), basis = item.basis;
    if (!basis) reason = 'The proposal has no captured order basis.';
    else if (doc.actions.some(a => a.seq > basis.actionSeq)) reason = 'A person acted on this order.';
    else if (doc.runs.at(-1)?.id !== basis.run) reason = 'A newer run started.';
    else if (orders.stage(doc).stage !== basis.stage) reason = 'The order changed stage.';
  } catch { reason = 'The order is no longer available.'; }
  return reason ? item.kind === 'dispatch' ? { ...item, status: 'refused', refusal: `Dispatch refused: ${reason}` } : { ...item, status: 'superseded', supersededReason: reason } : item;
}

export function currentProducerActions(project: ProjectConfig, orders: Orders): ProducerAction[] {
  const state = producerState(project);
  return state.actions.map(a => proposalValidity(orders, a, state.cases.find(c => c.id === a.caseId)));
}

/**
 * A planned order has an intent but no order body yet, so it cannot be started, queued or accepted. The refusal says
 * what to do instead, so the router can offer the person a draft.
 */
export function plannedRefusal(orders: Orders, tag: string | undefined): string | undefined {
  if (!tag || !orders.resolveTag(tag)) return;
  const doc = orders.get(tag);
  if (orders.stage(doc).stage !== 'planned') return;
  const merged = orders.mergedSet(), unmet = doc.order.needs.filter(n => !merged.has(n));
  if (unmet.length) return t('{tag} is only planned (no order body yet), and it can be drafted only after {needs} are merged.', { tag: doc.order.tag, needs: unmet.join(', ') });
  return t('{tag} is only planned (no order body yet): draft it first. Offer to draft it now with producer_draft on case draft/{tag}; once a person accepts the draft it can be queued and started.', { tag: doc.order.tag });
}
/**
 * A reprioritize may reorder and add dependencies, never let an order run ahead of what it depends on: replacement needs
 * keep every need that is not merged yet and make no cycle. Only a person removes an open dependency. (A need that names
 * no order yet only makes the order wait.)
 */
export function reprioritizeRefusal(orders: Orders, tag: string | undefined, needs: string[] | undefined): string | undefined {
  if (!needs || !tag || !orders.resolveTag(tag)) return;
  const doc = orders.get(tag), merged = orders.mergedSet();
  const resolved = needs.map(n => orders.resolveTag(n) ?? n), same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const dropped = doc.order.needs.filter(n => !merged.has(n) && !resolved.some(r => same(r, n)));
  if (dropped.length) return t('Reprioritize refused: {tag} still depends on {needs}, which are not merged; only a person removes an open dependency.', { tag: doc.order.tag, needs: dropped.join(', ') });
  const seen = new Set<string>(), stack = [...resolved];
  while (stack.length) {
    const next = stack.pop()!;
    if (same(next, doc.order.tag)) return t('Reprioritize refused: {tag} would depend on itself through {needs}.', { tag: doc.order.tag, needs: resolved.join(', ') });
    if (seen.has(next.toLowerCase())) continue;
    seen.add(next.toLowerCase());
    const real = orders.resolveTag(next);
    if (real) stack.push(...orders.get(real).order.needs);
  }
}
/** Stages a producer rework never sends back: the run is still going, or a person has put the order aside. */
const REWORK_UNTOUCHABLE = ['running', 'held'];
function reworkRefusal(orders: Orders, tag: string | undefined): string | undefined {
  if (!tag || !orders.resolveTag(tag)) return;
  const stage = orders.stage(orders.get(tag)).stage;
  if (REWORK_UNTOUCHABLE.includes(stage)) return t('{tag} is {stage}; the producer never sends a running or held order back.', { tag, stage });
}
function executeAction(project: ProjectConfig, orders: Orders, item: ProducerAction, c: ProducerCase, env?: ProducerExecutionEnv): string {
  const tag = item.target ?? c.order;
  if (item.kind === 'rework') { const refusal = reworkRefusal(orders, tag); if (refusal) throw new Error(refusal); }
  if (item.kind === 'tool-call') {
    if (!item.tool) throw new Error('A tool-call needs its tool, operation and input.');
    const job = createToolJob(project, orders, { tool: item.tool.id, operation: item.tool.operation, input: item.tool.input, ...(tag ? { order: tag } : {}), by: 'producer', case: c.key, action: item.id });
    item.job = job.id;
    startToolJob(project, job, env?.probes.spawnDetached);
    return t('tool job {job} started ({tool}/{operation})', { job: job.id, tool: job.tool, operation: job.operation });
  }
  if (item.kind === 'reroute') {
    const context = rerouteEnv(project, env);
    const now = context.probes.now();
    const doc = orders.get(tag!);
    const loops = producerCases(project, true).filter(c => c.order === tag && c.trigger === 'loop' && c.facts.run === doc.runs.at(-1)?.id).map(c => c.card.summary);
    const from = doc.order.next_worker ?? ownerOf(context.workers.workers, doc.order.worker)?.id ?? doc.runs.at(-1)?.worker ?? 'unassigned';
    orders.reroute(tag!, { id: item.id, at: now.toISOString(), from, to: item.worker!, note: item.note!, brief: previousAttempts(doc, loops), loops: attemptFacts(doc, loops).loops }, current => {
      const refusal = rerouteRefusal(project, orders, current, item.worker, item.note, context, now);
      if (refusal) throw new Error(refusal);
    });
    item.fromWorker = from;
    return `rerouted ${tag} from ${from} to ${item.worker}: ${item.note}`;
  }
  if (item.goalFacts && ['draft-order', 'add-order'].includes(item.kind)) {
    const goal = String(item.goalFacts.goal);
    if (!designGoalCases(project, orders).some(g => g.facts.goal === goal)) throw new Error('Goal resolved or an open order already names it; refresh goal cases.');
    if (!item.order?.body.includes(goal)) throw new Error('Goal draft must reference its target or gap id.');
    const made = createOrder(project, orders, { ...item.order, queue: false });
    return t('added {tag}', { tag: made.doc.order.tag });
  }
  if (item.kind === 'clean') {
    if (!item.cleanPlan) throw new Error('Clean refused: proposal has no stored dry-run plan.');
    const plan = applyClean(project, orders, structuredClone(item.cleanPlan), env?.clean ?? systemClean(env?.probes ?? systemProbes));
    return `Clean applied: ${plan.items.filter(i => i.result).length} items. ${plan.items.filter(i => i.result).map(i => i.result).join('; ')}`;
  }
  if (tag && ['queue', 'rework', 'answer'].includes(item.kind)) {
    const refusal = loopGuard(orders.get(tag), producerActions(project), item.note || item.reason);
    if (refusal) throw new Error(refusal);
  }
  if (item.kind === 'dispatch') {
    const file = project.workers ?? process.env.ALBA_WORKERS;
    if (!env && !file) throw new Error('Dispatch refused: no workers file is configured.');
    return executeDispatch({ project, orders, ...(env ?? { probes: systemProbes, workers: loadWorkers(file!) }) }, tag!);
  }
  if (item.kind === 'close-case') {
    stateTransaction(project, () => { const cases = readStateJson<ProducerCase[]>(project, CASES, []); const found = cases.find(x => x.id === c.id); if (found) { found.status = 'closed'; found.closedAt = item.at; found.updatedAt = item.at; writeStateFile(project, CASES, JSON.stringify(cases, null, 2) + '\n'); } }); return t('case closed');
  }
  if (!tag && !['broadcast', 'note', 'add-order'].includes(item.kind)) throw new Error(t('This case has no order for that action.'));
  if (item.kind === 'lint-bounce') {
    const doc = orders.get(tag!);
    if (orders.stage(doc).stage !== 'awaiting-review' || doc.reports.at(-1)?.seq !== c.facts.report || !Array.isArray(c.facts.lint)) throw new Error('Delivery facts changed; lint rework is stale.');
    if (lintBounceCount(orders, tag!) >= 2) throw new Error('Two consecutive lint send-backs reached; review the attached findings.');
    orders.act(tag!, 'rework', { note: item.note, lint: true });
    orders.record(tag!, 'lint-bounced', { report: c.facts.report, action: item.id });
    return 'Delivery sent back by lint';
  }
  if (item.kind === 'draft-order') {
    if (!item.order || !item.planFingerprint) throw new Error('A draft-order action needs a complete body and planned order.');
    return acceptDraft(project, orders, item.order, item.planFingerprint);
  }
  if (item.kind === 'reprioritize') {
    const refusal = reprioritizeRefusal(orders, tag, item.needs);
    if (refusal) throw new Error(refusal);
    orders.update(tag!, { ...(item.priority !== undefined ? { priority: item.priority } : {}), ...(item.needs ? { needs: item.needs } : {}) });
    return 'Order priority/dependencies updated';
  }
  if (item.kind === 'note' || item.kind === 'broadcast') return item.note?.trim() || t('recorded');
  if (item.kind === 'nudge') { const doc = orders.get(tag!); if (!doc.order.worktree) throw new Error(t('The order has no worktree for a nudge.')); appendInbox(doc.order.worktree, { at: item.at, author: 'producer', text: item.note?.trim() || t('Please check this order and commit progress.') }); return t('nudged'); }
  if (item.kind === 'answer') {
    // The same path as `alba answer`: the answer is recorded and the order resumes at once on the worker that asked,
    // in its own session when the engine can continue one. Without a workers file only the answer is recorded.
    const file = env ? undefined : process.env.ALBA_WORKERS ?? project.workers;
    if (!env && !file) { orders.act(tag!, 'answer', { note: item.note || item.reason }); return t('answer recorded'); }
    return answerOrder({ project, orders, ...(env ?? { probes: systemProbes, workers: loadWorkers(file!) }) }, tag!, item.note || item.reason).message;
  }
  if (item.kind === 'ask') { orders.ask(tag!, { text: item.note || item.reason || t('What should happen next?'), options: [{ label: t('Proceed') }, { label: t('Wait') }] }); return t('question recorded'); }
  if (item.kind === 'accept') {
    if (needsIndependentCheck(project, orders.get(tag!))) {
      const file = project.workers ?? process.env.ALBA_WORKERS;
      if (!env && !file) throw new Error('Independent check requires a configured workers file with a verifier role.');
      const ctx = { project, orders, ...(env ?? { probes: systemProbes, workers: loadWorkers(file!) }) };
      const check = startIndependentCheck(ctx, tag!);
      item.independentCheck = check.id;
      if (check.status === 'running') throw new IndependentCheckPending(`Independent check running on ${check.worker}.`);
      if (check.status !== 'passed' || check.verdict?.pass !== true) throw new Error(`Independent check failed: ${check.reason}; ${check.verdict?.checked.filter(i => i.verdict !== 'pass').map(i => `${i.item}: ${i.verdict} (${i.evidence})`).join('; ') ?? 'no valid verdict'}`);
    }
    humanAction(project, orders, tag!, 'approve', item.note); return t('accepted');
  }
  if (item.kind === 'accept-part') { if (project.accept) throw new Error('Partial acceptance stays manual; select and merge the desired changes yourself.'); orders.record(tag!, 'producer-accept-part', { note: item.note ?? '' }); return t('accept-part recorded'); }
  if (item.kind === 'rework' || item.kind === 'queue' || item.kind === 'hold') { humanAction(project, orders, tag!, item.kind, item.note); return t('{action} applied', { action: item.kind }); }
  if (item.kind === 'add-order') {
    if (!item.order) throw new Error('add-order requires a complete draft order.');
    const made = createOrder(project, orders, { ...item.order, queue: false });
    return t('added {tag}', { tag: made.doc.order.tag });
  }
  return t('recorded');
}

/** An order is reviewed by a person when it says so, or when it says nothing and the project's `review` is manual. */
export function reviewOf(project: ProjectConfig, order: { review?: 'manual' | 'auto' }): 'manual' | 'auto' { return order.review ?? project.review ?? 'auto'; }

function requiresManualReview(project: ProjectConfig, orders: Orders, kind: string, target?: string): boolean {
  return ['accept', 'rework', 'lint-bounce'].includes(kind) && !!target && !!orders.resolveTag(target) && reviewOf(project, orders.get(target).order) === 'manual';
}

/** Stores a proposal and applies it only when the selected rule is in auto mode. */
export function producerAct(project: ProjectConfig, orders: Orders, caseId: string, kind: string, options: ProducerActionDetails & { note?: string; reason?: string; evidence?: string[]; source?: string; now?: Date } = {}, env?: ProducerExecutionEnv): ProducerAction {
  if (!(PRODUCER_ACTIONS as readonly string[]).includes(kind)) throw producerActionInputError(t('Unknown producer action "{kind}".', { kind }));
  if (!caseId?.trim()) throw producerActionInputError();
  const policy = producerPolicy(project); if (!policy.enabled) throw new Error(t('The producer is disabled in this project.'));
  if (kind === 'add-order' && (!options.order || !hasAcceptanceSection(options.order.body))) throw new Error('add-order requires a complete draft with an Acceptance section.');
  const c = findCase(project, caseId); let rule = ruleFor(project, kind as ProducerActionKind, isGoalDraft(c.trigger));
  // An action belongs to the running director message only when it is filed under that message's own case: a proposal for
  // any other case made while a chat runs does not borrow the chat's id (which would make an observe-mode action clickable).
  const messageId = chatMessageOf(project, c);
  const goalDraft = isGoalDraft(c.trigger) && ['draft-order', 'add-order'].includes(kind);
  if (goalDraft) {
    const goals = designGoalCases(project, orders), goal = goals.find(g => options.order?.body.includes(String(g.facts.goal)) && (c.trigger === 'idle-capacity' || g.key === c.key));
    if (!goal || !options.order || !hasAcceptanceSection(options.order.body)) throw new Error('Goal draft requires a complete order referencing the open target or gap id and an Acceptance section.');
    options = { ...options, goalFacts: structuredClone(goal.facts) };
  }
  if (kind === 'rework' && c.trigger === 'monitor-stale' && !policy.rules.some(r => r.action === 'rework')) rule = { ...rule, mode: 'propose' };
  const manualReview = requiresManualReview(project, orders, kind, options.target ?? c.order);
  if (manualReview) rule = { ...rule, mode: 'propose' };
  // Sending work back restarts a run: a person accepts it every time, whatever the rule's mode.
  if (kind === 'rework' && rule.mode === 'auto') rule = { ...rule, mode: 'propose' };
  if (kind === 'draft-order' && !goalDraft) {
    if (c.trigger !== 'ready-to-draft' || !options.order || options.order.tag !== c.order) throw new Error('draft-order requires a ready-to-draft case and its complete order.');
    const doc = orders.get(c.order!);
    if (orders.stage(doc).stage !== 'planned' || c.facts.fingerprint !== planFingerprint(doc)) throw new Error('The plan changed; refresh drafting context.');
    if (options.order.title !== doc.order.title || options.order.kind !== doc.order.kind || JSON.stringify(options.order.needs) !== JSON.stringify(doc.order.needs) || !hasAcceptanceSection(options.order.body)) throw new Error('Draft must preserve title, kind and needs and include Acceptance.');
    options = { ...options, target: c.order, planFingerprint: planFingerprint(doc) };
    if (rule.mode === 'auto' && !project.drafting?.auto_kinds.includes(doc.order.kind)) rule = { ...rule, mode: 'propose' };
  }
  if (kind === 'tool-call') {
    if (!options.tool?.id || !options.tool.operation || !options.tool.input || typeof options.tool.input !== 'object') throw producerActionInputError('A tool-call needs tool: { id, operation, input }; producer_read kind tools lists them.');
    const target = options.target ?? c.order;
    checkToolJob(project, orders, { tool: options.tool.id, operation: options.tool.operation, input: options.tool.input, ...(target ? { order: target } : {}) });
    options = { ...options, tool: { id: options.tool.id, operation: options.tool.operation, input: options.tool.input } };
  }
  if (kind === 'clean') {
    if (c.trigger !== 'clean' || !c.facts.plan) throw new Error('Clean requires a round dry-run plan.');
    options = { ...options, cleanPlan: structuredClone(c.facts.plan) as CleanPlan };
    const deletions = options.cleanPlan!.items.filter(i => ['remove', 'prune', 'delete'].includes(i.action));
    if (rule.mode === 'auto' && deletions.some(i => (['worktrees', 'packages'].includes(i.pathClass ?? '') && !project.clean?.auto_destructive) || !project.clean?.auto_classes?.includes(i.pathClass ?? ''))) rule = { ...rule, mode: 'propose' };
  }
  const now = atIso(options.now); const idempotencyKey = `${c.key}:${kind}:${c.revision}:${hash([options.target, options.worker, options.order, options.note, options.priority, options.needs, options.cleanPlan?.items, options.tool])}`;
  const actions = readStateJson<ProducerAction[]>(project, ACTIONS, []); const old = actions.find(a => a.idempotencyKey === idempotencyKey); if (old) return old;
  const evidence = options.evidence?.slice(0, PRODUCER_ACTION_LIMIT);
  const source = options.source;
  if (readStateJson<boolean>(project, PAUSED, false)) { const refused: ProducerAction = { id: randomUUID(), idempotencyKey, caseId: c.id, caseRevision: c.revision, kind: kind as ProducerActionKind, status: 'refused', ...(messageId ? { messageId } : {}), note: options.note, reason: options.reason, ...(evidence?.length ? { evidence } : {}), ...(source ? { source } : {}), ruleId: rule.id, mode: rule.mode, policyVersion: policy.version, policyHash: policy.hash, at: now, refusal: t('producer is paused') }; const stored = appendAction(project, refused); if (stored === refused) audit(project, { kind: 'action', id: refused.id, status: refused.status, case: c.key }); return stored; }
  if (rule.mode === 'off') { const refused: ProducerAction = { id: randomUUID(), idempotencyKey, caseId: c.id, caseRevision: c.revision, kind: kind as ProducerActionKind, status: 'refused', ...(messageId ? { messageId } : {}), note: options.note, reason: options.reason, ...(evidence?.length ? { evidence } : {}), ...(source ? { source } : {}), ruleId: rule.id, mode: rule.mode, policyVersion: policy.version, policyHash: policy.hash, at: now, refusal: t('rule mode is off') }; const stored = appendAction(project, refused); if (stored === refused) audit(project, { kind: 'action', id: refused.id, status: refused.status, case: c.key }); return stored; }
  const item: ProducerAction = { id: randomUUID(), idempotencyKey, caseId: c.id, caseRevision: c.revision, kind: kind as ProducerActionKind, status: rule.mode === 'observe' ? 'would-do' : 'proposed', ...(messageId ? { messageId } : {}), target: options.target, order: options.order, priority: options.priority, needs: options.needs, note: options.note, reason: options.reason, ...(evidence?.length ? { evidence } : {}), ...(source ? { source } : {}), ruleId: rule.id, mode: rule.mode, policyVersion: policy.version, policyHash: policy.hash, at: now };
  if (goalDraft) { reserveDraftAllowance(project, `goal/${options.goalFacts!.goal}`, options.now); item.goalFacts = options.goalFacts; }
  if (manualReview) item.reason = [item.reason, t('A person reviews this order (review: manual).')].filter(Boolean).join(' ');
  const target = item.target ?? c.order;
  if (target && kind !== 'add-order') {
    item.target = target;
    // Observe mode can describe a case whose order has disappeared. Keep the
    // proposal durable; read/execution validation will mark it unavailable.
    try {
      const doc = orders.get(target);
      item.basis = { stage: orders.stage(doc).stage, run: doc.runs.at(-1)?.id, actionSeq: Math.max(0, ...doc.actions.map(a => a.seq)) };
    } catch { /* the case can outlive its order */ }
  }
  item.planFingerprint = options.planFingerprint;
  item.worker = options.worker;
  if (options.tool) item.tool = options.tool;
  if (kind === 'reroute') {
    try {
      if (!options.target) throw new Error('Reroute refused: target is required.');
      const refusal = rerouteRefusal(project, orders, orders.get(target!), item.worker, item.note, rerouteEnv(project, env), options.now ?? env?.probes.now());
      if (refusal) throw new Error(refusal);
    } catch (error) { item.status = 'refused'; item.refusal = (error as Error).message; }
  }
  item.cleanPlan = options.cleanPlan;
  if (target && ['dispatch', 'queue', 'accept', 'rework', 'answer'].includes(kind) && item.status !== 'refused') {
    const planned = plannedRefusal(orders, target);
    if (planned) { item.status = 'refused'; item.refusal = planned; }
  }
  if (target && ['queue', 'rework', 'answer'].includes(kind) && item.status !== 'refused') {
    let refusal: string | undefined = kind === 'rework' ? reworkRefusal(orders, target) : undefined;
    try { refusal ??= loopGuard(orders.get(target), actions, item.note || item.reason); } catch { /* execution validates unavailable orders */ }
    if (refusal) { item.status = 'refused'; item.refusal = refusal; orders.record(target, 'producer-refused', { action: item.id, kind, reason: refusal }); }
  }
  if (kind === 'reprioritize' && target && item.status !== 'refused') {
    const refusal = reprioritizeRefusal(orders, target, options.needs);
    if (refusal) { item.status = 'refused'; item.refusal = refusal; }
  }
  if (kind === 'accept' && (options.target ?? c.order)) item.reviewCard = acceptanceCard(project, orders, (options.target ?? c.order)!)?.href;
  // Another process may have stored the same proposal meanwhile: that one is the action, and it runs (or not) only once.
  const stored = appendAction(project, item);
  if (stored !== item) return stored;
  audit(project, { kind: 'action', id: item.id, status: item.status, case: c.key, action: item.kind, policyVersion: item.policyVersion });
  trackAgreement(project, item, c, orders.all());
  if (item.status === 'would-do') appendStateFile(project, WOULD_DO, `${JSON.stringify(item)}\n`);
  if (rule.mode === 'auto' && !['dispatch', 'clean'].includes(kind)) runProducerActions(project, orders, env);
  return readStateJson<ProducerAction[]>(project, ACTIONS, []).find(a => a.id === item.id) ?? item;
}

/**
 * Runs stored auto actions once, checking the case revision before doing anything. Each one is claimed first, so an action two
 * processes see (the MCP server and `alba serve`) runs in one of them only.
 */
export function runProducerActions(project: ProjectConfig, orders: Orders, env?: ProducerExecutionEnv): ProducerAction[] {
  const runnable = (a: ProducerAction) => a.status === 'proposed' && a.mode === 'auto';
  for (const { id } of readStateJson<ProducerAction[]>(project, ACTIONS, []).filter(runnable)) {
    const { item } = claimAction(project, id, runnable);
    if (!item) continue;
    try { runAutoAction(project, orders, item, env); } finally { releaseAction(project, item); }
  }
  return readStateJson<ProducerAction[]>(project, ACTIONS, []);
}

function runAutoAction(project: ProjectConfig, orders: Orders, item: ProducerAction, env?: ProducerExecutionEnv): void {
  const now = new Date().toISOString();
  const c = readStateJson<ProducerCase[]>(project, CASES, []).find(x => x.id === item.caseId);
  const target = item.target ?? c?.order;
  if (requiresManualReview(project, orders, item.kind, target)) {
    item.mode = 'propose';
    item.reason = [item.reason, t('A person reviews this order (review: manual).')].filter(Boolean).join(' ');
    return;
  }
  Object.assign(item, proposalValidity(orders, item, c));
  if (item.status === 'superseded') return;
  if (item.status === 'refused') { actionFailure(orders, item, new Error(item.refusal), now); return; }
  if (producerState(project).paused || !project.producer.enabled || ruleFor(project, item.kind, !!item.goalFacts).mode === 'off' || item.policyHash !== producerPolicy(project).hash || !c || c.status !== 'open' || c.revision !== item.caseRevision) { item.status = 'refused'; item.refusal = t('the policy, pause state or case facts changed'); item.ranAt = now; actionFailure(orders, item, new Error(item.refusal), now); audit(project, { kind: 'action', id: item.id, status: item.status, case: item.caseId, refusal: item.refusal }); return; }
  try { item.result = executeAction(project, new Orders(orders.store, undefined, 'producer'), item, c, env); item.status = 'done'; item.ranAt = now; } catch (e) { actionFailure(orders, item, e, now); }
  item.completedAt = new Date().toISOString();
  audit(project, { kind: 'action', id: item.id, status: item.status, case: item.caseId, messageId: item.messageId, result: item.result, refusal: item.refusal });
  if (item.messageId) orders.store.appendEvent({ at: now, tag: item.target ?? '_producer', type: 'producer-chat-action', by: 'producer', data: { messageId: item.messageId, actionId: item.id, status: item.status } });
}

/** The running director message whose own case (`chat/<id>`) this is, if any. */
function chatMessageOf(project: ProjectConfig, c: ProducerCase): string | undefined {
  const active = readStateJson<string | null>(project, ACTIVE_CHAT, null);
  return active && c.key === `chat/${active}` && c.facts.messageId === active ? active : undefined;
}
/** A would-do a director asked for in chat: its message id and its case agree (a borrowed id does not make it runnable). */
function chatRequested(cases: ProducerCase[], a: ProducerAction): boolean {
  const c = cases.find(x => x.id === a.caseId);
  return !!a.messageId && c?.key === `chat/${a.messageId}` && c.facts.messageId === a.messageId;
}
/** Executes one stored proposal after a person clicks it in the console. A second click, here or in another process, runs nothing. */
export function runProducerAction(project: ProjectConfig, orders: Orders, actionId: string, edit?: { note: string }, env?: ProducerExecutionEnv): ProducerAction {
  const cases = readStateJson<ProducerCase[]>(project, CASES, []);
  const { item, stored } = claimAction(project, actionId, a => a.status === 'proposed' || (a.status === 'would-do' && (a.kind === 'draft-order' || chatRequested(cases, a))));
  if (!stored) throw new Error(t('No producer action "{id}".', { id: actionId }));
  if (!item && stored.status === 'would-do' && !stored.claim) throw new Error(t('This action was only observed (its rule is in observe mode); it cannot be run from here.'));
  if (!item) return stored;
  let decided = false;
  try {
    const c = readStateJson<ProducerCase[]>(project, CASES, []).find(x => x.id === item.caseId);
    const validity = proposalValidity(orders, item, c);
    Object.assign(item, validity);
    if (validity.status === 'superseded' || validity.status === 'refused') {
      if (validity.status === 'refused') actionFailure(orders, item, new Error(item.refusal), new Date().toISOString());
      return item;
    }
    if (edit && edit.note.length > 16000) throw new Error('Edited note is too long.');
    const now = new Date().toISOString();
    const manualReview = requiresManualReview(project, orders, item.kind, item.target ?? c?.order);
    if (producerState(project).paused || !project.producer.enabled || (ruleFor(project, item.kind, !!item.goalFacts).mode === 'off' && !manualReview) || item.policyHash !== producerPolicy(project).hash || !c || c.status !== 'open' || c.revision !== item.caseRevision) {
      item.status = 'refused'; item.refusal = t('the policy, pause state or case facts changed'); item.ranAt = now;
      actionFailure(orders, item, new Error(item.refusal), now);
    } else {
      try {
        const edited = edit !== undefined && edit.note !== item.note;
        if (edit) item.note = edit.note;
        item.result = executeAction(project, new Orders(orders.store, undefined, 'producer'), item, c, env); item.status = 'done'; item.ranAt = now;
        item.decision = { at: now, outcome: edited ? 'edited' : 'accepted' };
      }
      catch (e) { actionFailure(orders, item, e, now); }
    }
    item.completedAt = new Date().toISOString();
    decided = true;
  } finally { releaseAction(project, item); }
  if (decided) {
    recordAgreementDecision(project, item);
    audit(project, { kind: 'action', id: item.id, status: item.status, case: item.caseId, messageId: item.messageId, result: item.result, refusal: item.refusal });
  }
  return item;
}

function actionFailure(orders: Orders, item: ProducerAction, error: unknown, at: string): void {
  if (error instanceof IndependentCheckPending) { item.result = error.message; return; }
  item.refusal = (error as Error).message.split('\n')[0];
  item.status = item.status === 'refused' || item.refusal === LOOP_REFUSAL || ['dispatch', 'clean', 'reroute'].includes(item.kind) ? 'refused' : 'failed';
  item.ranAt = at;
  if (item.status === 'refused') orders.record(item.target ?? '_producer', 'producer-refused', { action: item.id, kind: item.kind, reason: item.refusal });
}

export function producerPass(project: ProjectConfig, orders: Orders, options: ProducerPassOptions = {}): ProducerCase[] {
  pollIndependentChecks({ project, orders, probes: options.env?.probes ?? systemProbes });
  producerHeartbeat(project, options.now);
  const open = intakeProducer(project, orders, options);
  expireActions(project, orders);
  runProducerActions(project, orders, options.env);
  refreshAgreement(project, producerActions(project), orders.all(), orders.store.events(), atIso(options.now));
  return open;
}

/**
 * Stores what a pass finds of the pending proposals (an order that changed stage, a newer run, a closed case), each one as it is
 * stored now, and fails an action whose process is gone while it ran it.
 */
function expireActions(project: ProjectConfig, orders: Orders): void {
  const state = producerState(project);
  const expired = new Map<string, ProducerAction>();
  for (const a of state.actions) {
    if (a.claim) continue;
    const v = proposalValidity(orders, a, state.cases.find(c => c.id === a.caseId));
    if (v.status !== a.status) expired.set(a.id, v);
  }
  if (!expired.size && !state.actions.some(a => lostClaim(a))) return;
  stateTransaction(project, () => {
    const actions = readStateJson<ProducerAction[]>(project, ACTIONS, []);
    for (const a of actions) {
      if (lostClaim(a)) { failLostClaim(a); continue; }
      const v = expired.get(a.id);
      if (!v || a.claim || !['proposed', 'would-do'].includes(a.status)) continue;
      a.status = v.status;
      if (v.supersededReason) a.supersededReason = v.supersededReason;
      if (v.refusal) a.refusal = v.refusal;
    }
    writeActions(project, actions);
  });
}

export function rejectProducerAction(project: ProjectConfig, actionId: string, reason?: string): ProducerAction {
  let rejected = false;
  const item = patchAction(project, actionId, a => {
    // One that runs now in some process is not rejected under it.
    if (a.claim || !(a.status === 'proposed' || a.status === 'would-do')) return false;
    a.decision = { at: atIso(), outcome: 'rejected' };
    a.status = 'rejected'; a.rejectionReason = reason?.slice(0, 16000);
    rejected = true;
  });
  if (!item) throw new Error('No such producer action.');
  if (rejected) {
    recordAgreementDecision(project, item);
    audit(project, { kind: 'action', id: item.id, messageId: item.messageId, status: 'rejected' });
  }
  return item;
}

export function editDraftAction(project: ProjectConfig, orders: Orders, actionId: string, body: string): ProducerAction {
  const pending = (a?: ProducerAction): a is ProducerAction => !!a?.order && a.kind === 'draft-order' && ['proposed', 'would-do'].includes(a.status) && !a.claim;
  const item = producerActions(project).find(a => a.id === actionId);
  if (!pending(item)) throw new Error('Only a pending draft can be edited.');
  if (!body.trim() || !hasAcceptanceSection(body)) throw new Error('A draft needs an Acceptance section.');
  if (item.goalFacts) {
    const id = item.goalFacts.goal;
    if (typeof id !== 'string' || !body.includes(id)) throw new Error('A goal draft must reference its target or gap id.');
    if (!designGoalCases(project, orders).some(c => c.facts.goal === id)) throw new Error('The goal changed; draft it again.');
  } else if (planFingerprint(orders.get(item.order!.tag)) !== item.planFingerprint) throw new Error('The plan changed; draft it again.');
  let edited = false;
  const stored = patchAction(project, actionId, a => { if (!pending(a)) return false; a.order!.body = body; edited = true; });
  if (!edited) throw new Error('Only a pending draft can be edited.');
  audit(project, { kind: 'draft-edited', id: item.id, tag: item.order!.tag });
  return stored!;
}

export function createChatCase(project: ProjectConfig, messageId: string): ProducerCase {
  const now = atIso();
  const c: ProducerCase = { id: randomUUID(), key: `chat/${messageId}`, project: project.id, trigger: 'director-message', status: 'open', revision: 1, openedAt: now, updatedAt: now, facts: { messageId }, card: { trigger: 'director-message', summary: 'Director conversation', pointers: [], untrusted: ['message'] } };
  stateTransaction(project, () => writeStateFile(project, CASES, JSON.stringify([...producerCases(project), c])));
  return c;
}
