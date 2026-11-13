import type { ProducerMode, ProducerRule, ProducerTrustConfig, ProjectConfig } from '../config.ts';
import type { OrderDoc, OrderEvent } from '../orders/model.ts';
import { readStateJson, updateStateJson } from '../orders/state-files.ts';
import type { ProducerAction, ProducerCase } from './producer.ts';

export const TRUST_STATE = '_producer-trust.json';
export const trustDefaults = { window_days: 14, outcome_hours: 72, min_cases: 10, raise_rate: .9, lower_rate: .6 };
export type AgreementOutcome = 'pending' | 'accepted' | 'edited' | 'rejected' | 'different' | 'nothing';
export interface AgreementRecord {
  actionId: string; ruleId: string; caseId: string; caseRevision: number; order?: string; run?: string;
  proposed: string; note?: string; priority?: number; needs?: string[]; at: string; expiresAt: string; baselineSeq: number;
  createdOrder?: { title?: string; kind: string; needs: string[] };
  outcome: AgreementOutcome; decidedAt?: string; humanAction?: string; evidence?: string;
}
export interface RuleTrust {
  ruleId: string; mode: ProducerMode; counts: Record<AgreementOutcome, number>; decided: number;
  rate: number | null; enough: boolean; disagreements: AgreementRecord[];
  suggestion?: { from: ProducerMode; to: ProducerMode; direction: 'raise' | 'lower'; yaml: string };
}
export const agreementRecords = (p: ProjectConfig) => readStateJson<Record<string, AgreementRecord[]>>(p, TRUST_STATE, {});
const human = (e: OrderEvent) => !['tick', 'serve', 'producer', 'producer-session'].includes(e.by ?? 'cli');
const sameAction = (a: string, b: string) => (a === 'accept' ? 'approve' : a === 'nudge' || a === 'broadcast' ? 'message' : a) === b;
const clean = (s?: string) => (s ?? '').trim().replace(/\s+/g, ' ');

/** Capture the order sequence before a proposal can execute, including observe-only proposals. */
export function trackAgreement(p: ProjectConfig, action: ProducerAction, c: ProducerCase, docs: readonly OrderDoc[]): void {
  if (action.status === 'refused') return;
  const target = action.target ?? c.order;
  const order = action.kind === 'add-order' ? action.order?.tag : target, doc = docs.find(d => d.order.tag === order);
  const createdOrder = action.kind === 'add-order' && action.order ? { title: action.order.title, kind: action.order.kind, needs: action.order.needs } : undefined;
  const hours = p.producer.trust?.outcome_hours ?? trustDefaults.outcome_hours;
  updateStateJson<Record<string, AgreementRecord[]>>(p, TRUST_STATE, {}, groups => {
    const rows = groups[action.ruleId] ??= [];
    if (!rows.some(r => r.actionId === action.id)) rows.push({ actionId: action.id, ruleId: action.ruleId, caseId: c.id, caseRevision: c.revision, order,
      run: typeof c.facts.run === 'string' ? c.facts.run : undefined, proposed: action.kind, note: action.note, priority: action.priority, needs: action.needs, createdOrder, at: action.at,
      expiresAt: new Date(Date.parse(action.at) + hours * 3600_000).toISOString(), baselineSeq: Math.max(0, ...[...(doc?.actions ?? []), ...(doc?.runs ?? []), ...(doc?.reports ?? [])].map(a => a.seq)), outcome: 'pending' });
    return groups;
  });
}

/** Pure reconciliation: first relevant human decision wins; a later run is another case. */
export function resolveAgreement(row: AgreementRecord, action: ProducerAction | undefined, doc: OrderDoc | undefined, events: readonly OrderEvent[], now: string): AgreementRecord {
  if (row.outcome !== 'pending') return row;
  const end = Math.min(Date.parse(now), Date.parse(row.expiresAt));
  const valid = (at: string) => Date.parse(at) >= Date.parse(row.at) && Date.parse(at) <= end;
  const decisions: { at: string; outcome: AgreementOutcome; humanAction: string; evidence: string }[] = [];
  if (action?.decision && valid(action.decision.at)) decisions.push({ at: action.decision.at, outcome: action.decision.outcome, humanAction: action.decision.outcome === 'rejected' ? 'reject' : action.kind, evidence: `action:${action.id}` });
  const nextRun = doc?.runs.filter(r => r.seq > row.baselineSeq && Date.parse(r.started) >= Date.parse(row.at)).sort((a, b) => a.seq - b.seq)[0];
  const relevant = (at: string) => valid(at) && (!nextRun || Date.parse(at) <= Date.parse(nextRun.started));
  for (const e of events) {
    if (!human(e) || !relevant(e.at) || (row.order ? e.tag !== row.order : e.data?.caseId !== row.caseId)) continue;
    if (e.data?.caseId && e.data.caseId !== row.caseId) continue;
    if (e.data?.run && row.run && e.data.run !== row.run) continue;
    const fields = Array.isArray(e.data?.fields) ? e.data.fields : [];
    const kind = e.type.startsWith('action-') ? e.type.slice(7) : ['question-answered', 'outbox-answered'].includes(e.type) ? 'answer' : e.type === 'question-asked' ? 'ask' : e.type === 'message' ? 'message' : e.type === 'order-updated' && fields.some(f => f === 'priority' || f === 'needs') ? 'reprioritize' : e.type === 'order-added' && row.proposed === 'add-order' ? 'add-order' : e.type === 'producer-accept-part' ? 'accept-part' : '';
    if (!kind) continue;
    const recorded = doc?.actions.find(a => a.kind === kind && a.at === e.at);
    if (recorded && recorded.seq <= row.baselineSeq) continue;
    const note = typeof e.data?.note === 'string' ? e.data.note : typeof e.data?.text === 'string' ? e.data.text : recorded?.note;
    const matches = sameAction(row.proposed, kind);
    const edited = kind === 'reprioritize' ? (row.priority !== undefined && doc?.order.priority !== row.priority) || (row.needs !== undefined && JSON.stringify(doc?.order.needs) !== JSON.stringify(row.needs))
      : kind === 'add-order' ? !!row.createdOrder && ((row.createdOrder.title !== undefined && doc?.order.title !== row.createdOrder.title) || doc?.order.kind !== row.createdOrder.kind || JSON.stringify(doc?.order.needs) !== JSON.stringify(row.createdOrder.needs))
      : clean(note) !== clean(row.note);
    decisions.push({ at: e.at, outcome: !matches ? 'different' : edited ? 'edited' : 'accepted', humanAction: kind, evidence: `event:${e.tag}:${e.type}:${e.at}` });
  }
  decisions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = decisions[0];
  if (first) return { ...row, outcome: first.outcome, decidedAt: first.at, humanAction: first.humanAction, evidence: first.evidence };
  return Date.parse(now) >= Date.parse(row.expiresAt) ? { ...row, outcome: 'nothing', decidedAt: row.expiresAt } : row;
}

export function refreshAgreement(p: ProjectConfig, actions: readonly ProducerAction[], docs: readonly OrderDoc[], events: readonly OrderEvent[], now: string): void {
  updateStateJson<Record<string, AgreementRecord[]>>(p, TRUST_STATE, {}, groups => Object.fromEntries(Object.entries(groups).map(([rule, rows]) => [rule, rows.map(row => resolveAgreement(row, actions.find(a => a.id === row.actionId), docs.find(d => d.order.tag === row.order), events, now))])));
}

export function recordAgreementDecision(p: ProjectConfig, action: ProducerAction): void {
  if (!action.decision) return;
  updateStateJson<Record<string, AgreementRecord[]>>(p, TRUST_STATE, {}, groups => {
    groups[action.ruleId] = (groups[action.ruleId] ?? []).map(row => row.actionId === action.id ? resolveAgreement(row, action, undefined, [], action.decision!.at) : row);
    return groups;
  });
}

export function ruleTrust(rules: readonly ProducerRule[], records: Record<string, AgreementRecord[]>, overrides: ProducerTrustConfig = {}, now = new Date().toISOString()): RuleTrust[] {
  const config = { ...trustDefaults, ...overrides }, cutoff = Date.parse(now) - config.window_days * 86400_000;
  return rules.map(rule => {
    // Rewording the same proposal cannot manufacture the minimum number of cases.
    const cases = new Map<string, AgreementRecord>();
    for (const r of (records[rule.id] ?? []).filter(r => Date.parse(r.decidedAt ?? r.at) >= cutoff && Date.parse(r.decidedAt ?? r.at) <= Date.parse(now)).sort((a, b) => a.at.localeCompare(b.at))) cases.set(JSON.stringify([r.caseId, r.caseRevision, r.order]), r);
    const rows = [...cases.values()];
    const counts: RuleTrust['counts'] = { pending: 0, accepted: 0, edited: 0, rejected: 0, different: 0, nothing: 0 };
    for (const row of rows) counts[row.outcome]++;
    const decided = counts.accepted + counts.edited + counts.rejected + counts.different, rate = decided ? counts.accepted / decided : null, enough = decided >= config.min_cases;
    const result: RuleTrust = { ruleId: rule.id, mode: rule.mode, counts, decided, rate, enough, disagreements: rows.filter(r => ['edited', 'rejected', 'different'].includes(r.outcome)).sort((a, b) => (b.decidedAt ?? b.at).localeCompare(a.decidedAt ?? a.at)).slice(0, 5) };
    const raise = enough && rate !== null && rate >= config.raise_rate;
    const lower = enough && rate !== null && rate < config.lower_rate;
    const to: ProducerMode | undefined = raise ? rule.mode === 'observe' ? 'propose' : rule.mode === 'propose' ? 'auto' : undefined : lower ? rule.mode === 'auto' ? 'propose' : rule.mode === 'propose' ? 'observe' : rule.mode === 'observe' ? 'off' : undefined : undefined;
    if (to) result.suggestion = { from: rule.mode, to, direction: raise ? 'raise' : 'lower', yaml: `mode: ${to} # producer.rules id: ${rule.id}` };
    return result;
  });
}
