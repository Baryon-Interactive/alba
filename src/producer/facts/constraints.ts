import { createHash } from 'node:crypto';
import type { ConstraintThresholds, ProjectConfig } from '../../config.ts';
import type { OrderDoc } from '../../orders/model.ts';
import type { UsageRow } from '../../usage/types.ts';
import { endingCaseText } from '../../run/endpoint.ts';
import type { Fact, FactsSnapshot, FlowStage } from './engine.ts';

export type ConstraintType = 'queue' | 'cause' | 'monitoring' | 'acceptor' | 'yield' | 'role';
export interface Candidate {
  id: string; type: ConstraintType; title: string; value: number; threshold: number;
  eligible: boolean; score: number; factIds: string[];
}
export interface ConstraintCard {
  type: ConstraintType | 'none'; title: string; factIds: string[];
  responses: { exploit: string; subordinate: string; elevate: string };
  candidates: Candidate[];
}
export interface Risk {
  id: string; type: 'failure' | 'loop' | 'budget' | 'aging'; title: string;
  firstSeen: string; lastSeen: string; count: number; factIds: string[];
}
export interface ConstraintAnalysis { constraint: ConstraintCard; risks: Risk[] }
const DAY = 86_400_000;
const key = (s: string) => encodeURIComponent(s).replace(/\./g, '%2E');
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);
const waiting: FlowStage[] = ['queued', 'monitoring', 'acceptor', 'stopped', 'held'];
const templates: Record<ConstraintType | 'none', ConstraintCard['responses']> = {
  queue: { exploit: 'Clear the oldest ready work at this stage first.', subordinate: 'Release upstream work at the pace this queue can absorb.', elevate: 'Propose additional capacity or remove a dependency at this stage.' },
  cause: { exploit: 'Resolve the repeated failure signature before retrying affected work.', subordinate: 'Hold releases that depend on the failing resource or condition.', elevate: 'Propose a tooling, environment or specification repair for this cause.' },
  monitoring: { exploit: 'Finish or diagnose existing monitored builds before starting more.', subordinate: 'Pace build releases to the available cap.', elevate: 'Propose more build capacity or shorter build and package steps.' },
  acceptor: { exploit: 'Review the oldest ready delivery first in a regular review slot.', subordinate: 'Limit new deliveries to the acceptor review pace.', elevate: 'Propose another qualified reviewer or smaller acceptance batches.' },
  yield: { exploit: 'Check acceptance criteria before the next delivery of this kind.', subordinate: 'Reduce parallel starts until the rework queue clears.', elevate: 'Propose better checks, clearer specifications or a different worker for this kind.' },
  role: { exploit: 'Restore an eligible worker for this role.', subordinate: 'Hold new work for this role until supply is available.', elevate: 'Propose worker capabilities, quota or role fallback changes.' },
  none: { exploit: 'Inspect the leading candidates and collect more observations.', subordinate: 'Keep current release limits while the evidence is inconclusive.', elevate: 'Reassess after the next snapshot before proposing added capacity.' },
};

/** Deterministic L2: seven-day flow and strict threshold comparisons, no model calls. */
export function findConstraint(snapshot: FactsSnapshot, overrides: ConstraintThresholds = {}): ConstraintCard {
  const window = '7d', data = snapshot.windows[window], facts = snapshot.facts;
  const value = (id: string) => { const v = facts.find(f => f.id === id)?.value; return typeof v === 'number' ? v : null; };
  const candidates: Candidate[] = [];
  const add = (c: Candidate) => { candidates.push(c); };
  for (const f of facts.filter(f => f.window === window && f.id.includes('.no_qualifying_worker.') && f.value === 1)) add({ id: f.id, type: 'role', title: `No qualifying worker: ${decodeURIComponent(f.id.split('.')[1])}`, value: 1, threshold: 0, eligible: true, score: 1, factIds: [f.id] });
  const first = data.cumulative[0], last = data.cumulative.at(-1);
  const durations = waiting.map(stage => ({ stage, facts: facts.filter(f => f.window === window && f.id.startsWith('F:kind.') && f.id.endsWith(`.stage.${stage}.${window}`)) }));
  const total = durations.reduce((n, d) => n + d.facts.reduce((sum, f) => sum + Number(f.value ?? 0), 0), 0);
  for (const { stage, facts: stageFacts } of durations) {
    const share = total > 0 ? stageFacts.reduce((n, f) => n + Number(f.value ?? 0), 0) / total : 0;
    const growth = (last?.stages[stage] ?? 0) - (first?.stages[stage] ?? 0);
    const growthId = `F:constraint.queue.${stage}.growth.${window}`, shareId = `F:constraint.queue.${stage}.share.${window}`;
    for (const fact of [{ id: growthId, window, value: growth, unit: 'orders' }, { id: shareId, window, value: share, unit: 'ratio' }] as Fact[]) {
      const old = facts.find(f => f.id === fact.id);
      if (old) Object.assign(old, fact); else facts.push(fact);
    }
    add({ id: `queue:${stage}`, type: 'queue', title: `${stage} queue is limiting flow`, value: share, threshold: 0, eligible: share > 0 && growth > 0, score: share, factIds: [shareId, growthId, ...stageFacts.map(f => f.id), ...(first && last ? [`F:cfd.${Date.parse(first.at)}.${stage}.${window}`, `F:cfd.${Date.parse(last.at)}.${stage}.${window}`] : [])] });
  }
  const causeThresholds = { environment: .3, ...overrides.cause_shares };
  const reports = data.causes.reduce((n, c) => n + c.count, 0);
  for (const [cause, threshold] of Object.entries(causeThresholds)) {
    const count = data.causes.find(c => c.cause === cause)?.count ?? 0, share = reports ? count / reports : 0;
    add({ id: `cause:${cause}`, type: 'cause', title: `${cause} failures limit throughput`, value: share, threshold, eligible: reports > 0 && share > threshold, score: share / (threshold || Number.EPSILON), factIds: data.causes.map(c => `F:cause.${c.cause}.${window}`) });
  }
  for (const slot of data.slots) {
    const threshold = overrides.monitoring_cap_share ?? .4, share = slot.limit > 0 ? slot.monitoring / slot.limit : 0;
    add({ id: `monitoring:${slot.cap}`, type: 'monitoring', title: `Monitored builds hold the ${slot.cap} cap`, value: share, threshold, eligible: slot.limit > 0 && slot.monitoring > threshold * slot.limit, score: share / (threshold || Number.EPSILON), factIds: [`F:slot.${key(slot.cap)}.monitoring.${window}`, `F:slot.${key(slot.cap)}.cap.${window}`] });
  }
  for (const fact of facts.filter(f => f.window === window && f.id.startsWith('F:kind.'))) {
    const match = /^F:kind\.(.+)\.(acceptor_p90|first_pass_yield)\.7d$/.exec(fact.id);
    if (!match) continue;
    const kind = decodeURIComponent(match[1]), v = value(fact.id), isYield = match[2] === 'first_pass_yield';
    if (!kind.trim()) continue;
    const threshold = isYield ? overrides.first_pass_yield_min ?? .6 : overrides.acceptor_p90_hours ?? 8;
    add({ id: `${isYield ? 'yield' : 'acceptor'}:${kind}`, type: isYield ? 'yield' : 'acceptor', title: isYield ? `${kind} first-pass yield is low` : `${kind} deliveries wait for the acceptor`, value: v ?? 0, threshold, eligible: v !== null && (isYield ? v < threshold : v > threshold), score: v === null ? 0 : isYield ? (1 - v) / (1 - threshold || Number.EPSILON) : v / (threshold || Number.EPSILON), factIds: [fact.id] });
  }
  const rank = (a: Candidate, b: Candidate) => b.score - a.score || a.id.localeCompare(b.id);
  const queue = candidates.filter(c => c.type === 'queue' && c.eligible).sort(rank)[0];
  const chosen = queue ?? candidates.filter(c => c.eligible).sort(rank)[0];
  const top = [...candidates].sort(rank).slice(0, 2);
  return { type: chosen?.type ?? 'none', title: chosen?.title ?? 'no clear constraint', factIds: chosen?.factIds ?? [...new Set(top.flatMap(c => c.factIds))], responses: { ...templates[chosen?.type ?? 'none'] }, candidates: chosen ? [chosen] : top };
}

/** Strip volatile paths, identifiers and counters; retain the words that explain the error. */
export function normaliseError(text: string): string {
  return text.toLowerCase()
    .replace(/(?:https?:\/\/|[a-z]:[\\/]|\/{1,2})[^\s"'<>]+/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '<id>')
    .replace(/\b\d{4}-\d\d-\d\dt[\d:.+z-]+/g, '<time>')
    .replace(/\b(?:run|order|pid)\s*[#:=]\s*[\w.-]+/g, '<id>')
    .replace(/\b\d+\b/g, '<n>').replace(/\s+/g, ' ').trim();
}

interface Observation { id: string; at: string; lastAt?: string; factId: string; source: string }
/** Historical event IDs prevent polling from manufacturing recurrence. Retained risks keep evidence. */
export function buildRisks(snapshot: FactsSnapshot, orders: readonly OrderDoc[], usage: readonly UsageRow[], budget: ProjectConfig['budget'], previous?: FactsSnapshot): Risk[] {
  const end = Date.parse(snapshot.at), cutoff = end - 7 * DAY;
  const groups = new Map<string, { type: Risk['type']; title: string; observations: Map<string, Observation> }>();
  const addFact = (id: string, value: Fact['value'], unit: string, tags: string[] = []) => {
    if (!snapshot.facts.some(f => f.id === id)) snapshot.facts.push({ id, window: '7d', value, unit, tags });
  };
  const observe = (id: string, type: Risk['type'], title: string, o: Observation) => {
    if (Date.parse(o.at) > end || !Number.isFinite(Date.parse(o.at))) return;
    let group = groups.get(id);
    if (!group) { group = { type, title, observations: new Map() }; groups.set(id, group); }
    const old = group.observations.get(o.id);
    group.observations.set(o.id, old ? { ...o, at: old.at < o.at ? old.at : o.at, lastAt: (old.lastAt ?? old.at) > o.at ? old.lastAt ?? old.at : o.at } : o);
  };
  const loop = (worker: string, source: string, at: string, factId: string) => observe(`loop:${key(worker)}`, 'loop', `${worker} repeats failed work`, { id: source, source, at, factId });
  for (const d of orders) {
    const failures = [
      ...d.reports.filter(r => !['ready', 'monitoring', 'progress'].includes(r.status)).map(r => ({ id: `report:${r.seq}`, run: r.run, at: r.at, text: [r.summary, r.question].filter(Boolean).join(' ') })),
      ...d.runs.filter(r => r.ended && !d.reports.some(p => p.run === r.id && Date.parse(p.at) <= end)).map(r => ({ id: `run:${r.id}`, run: r.id, at: r.ended!, text: endingCaseText(r) })),
    ];
    for (const f of failures) {
      if (Date.parse(f.at) > end) continue;
      const signature = normaliseError(f.text);
      if (!signature) continue;
      const id = `failure:${hash(signature)}`, factId = `F:risk.event.${key(d.order.tag)}.${key(f.id)}.7d`;
      const source = `${d.order.tag}/${f.run ?? f.id}`;
      addFact(factId, signature, 'signature', [d.order.tag]);
      observe(id, 'failure', signature, { id: `${d.order.tag}/${f.id}`, at: f.at, source, factId });
      const worker = d.runs.find(r => r.id === f.run)?.worker;
      if (worker && /\bloop(?:ing|ed)?\b|repeated failed/i.test(f.text)) loop(worker, source, f.at, factId);
    }
  }
  const rows = usage.filter(r => Date.parse(r.at) <= end).sort((a, b) => a.at.localeCompare(b.at) || a.order.localeCompare(b.order) || a.run.localeCompare(b.run) || a.turn - b.turn);
  for (const row of rows) for (const signal of row.signals ?? []) if (signal.kind === 'failed-loop') {
    const source = `${row.order}/${row.run}`, factId = `F:risk.loop.${hash(`${source}/${signal.turns.join('-')}`)}.7d`;
    addFact(factId, signal.turns[1] - signal.turns[0] + 1, 'turns', [row.order]);
    loop(row.worker, source, row.at, factId);
  }
  // Use stored turns, falling back to a run total only when no turn rows exist (as in L1).
  const spend = [...rows, ...orders.flatMap(d => d.runs.filter(r => r.usage && !rows.some(u => u.order === d.order.tag && u.run === r.id) && Date.parse(r.ended ?? r.started) <= end && Date.parse(r.started) <= end).map(r => ({ order: d.order.tag, run: r.id, turn: 0, at: r.ended ?? r.started, ...r.usage } as UsageRow)))].sort((a, b) => a.at.localeCompare(b.at));
  const totals = new Map<string, number>();
  for (const row of spend) {
    const day = row.at.slice(0, 10);
    const measures = [
      { name: 'tokens_per_day', group: day, value: row.total_tokens, limit: budget?.tokens_per_day, unit: 'tokens' },
      { name: 'tokens_per_order', group: row.order, value: row.total_tokens, limit: budget?.tokens_per_order, unit: 'tokens' },
      { name: 'cost_per_day', group: day, value: (row.currency ?? 'USD') === (budget?.currency ?? 'USD') ? row.estimate ?? row.cost_usd : undefined, limit: budget?.cost_per_day, unit: budget?.currency ?? 'USD' },
    ];
    for (const m of measures) {
      if (m.limit === undefined || m.value === undefined || !Number.isFinite(m.value)) continue;
      const totalKey = `${m.name}:${m.group}`, total = (totals.get(totalKey) ?? 0) + m.value;
      totals.set(totalKey, total);
      if (total <= m.limit || m.value <= 0) continue;
      const id = m.name === 'tokens_per_order' ? `budget:${m.name}:${key(m.group)}` : `budget:${m.name}`;
      const factId = `F:risk.budget.${hash(`${totalKey}/${row.order}/${row.run}/${row.turn}`)}.7d`, limitId = `F:risk.budget.${m.name}.limit.7d`;
      addFact(factId, total, m.unit, [row.order]); addFact(limitId, m.limit, m.unit);
      observe(id, 'budget', `${m.name} budget exceeded${m.name === 'tokens_per_order' ? ` by ${row.order}` : ''}`, { id: `${row.order}/${row.run}/${row.turn}`, source: row.order, at: row.at, factId });
      // The limit is a supporting fact, not another recurrence.
    }
  }
  const risks: Risk[] = [];
  for (const [id, group] of groups) {
    const observations = [...group.observations.values()].sort((a, b) => a.at.localeCompare(b.at));
    if (group.type === 'failure' && new Set(observations.map(o => o.source)).size < 2) continue;
    const firstSeen = observations[0].at, lastSeen = observations.map(o => o.lastAt ?? o.at).sort().at(-1)!;
    if (Date.parse(lastSeen) <= cutoff) continue;
    const factIds = observations.map(o => o.factId);
    if (group.type === 'budget') factIds.push(`F:risk.budget.${id.split(':')[1]}.limit.7d`);
    risks.push({ id, type: group.type, title: group.title, firstSeen, lastSeen, count: observations.length, factIds: [...new Set(factIds)] });
  }
  for (const item of snapshot.windows['7d'].aging.filter(a => a.kind.trim() && a.p85 !== null && a.p85 > 0 && a.hours > a.p85)) {
    const id = `aging:${key(item.tag)}`, old = previous?.analysis?.risks.find(r => r.id === id);
    const ageId = `F:risk.aging.${key(item.tag)}.age.7d`, p85Id = `F:risk.aging.${key(item.tag)}.p85.7d`;
    addFact(ageId, item.hours, 'hours', [item.tag]); addFact(p85Id, item.p85, 'hours', [item.tag]);
    risks.push({ id, type: 'aging', title: `${item.tag} is older than ${item.kind} p85`, firstSeen: old?.firstSeen ?? snapshot.at, lastSeen: snapshot.at, count: (old?.count ?? 0) + (old && old.lastSeen === previous?.at ? 0 : 1), factIds: [ageId, p85Id] });
  }
  // Resolved continuous aging incidents remain visible for seven days with their last evidence.
  for (const old of previous?.analysis?.risks ?? []) if (!risks.some(r => r.id === old.id) && Date.parse(old.lastSeen) > cutoff) {
    risks.push(old);
  }
  for (const risk of risks) for (const id of risk.factIds) {
    const old = previous?.facts.find(f => f.id === id);
    if (old && !snapshot.facts.some(f => f.id === id)) snapshot.facts.push({ ...old });
  }
  return risks.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.id.localeCompare(b.id));
}
