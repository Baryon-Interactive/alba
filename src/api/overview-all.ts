import { usageRows } from '../usage/store.ts';
import { readOrders } from './read-orders.ts';
import { usageDashboard, budgetWarnings, sinceDate } from '../usage/accounting.ts';
import type { Snapshot, ProjectView } from '../web/snapshot.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Probes } from '../tick/gather.ts';
import type { WorkersFile } from '../workers/config.ts';
import { resourceViews } from '../resources/leases.ts';
import { quoteList } from '../credits/credits.ts';
import { decisionList } from '../ledger/decisions.ts';
import { countStages, pendingPicksOf, summaryOf, workerViews, type ViewEnv } from './views.ts';
import { NEEDS_YOU } from '../web/snapshot.ts';
import { t } from '../i18n.ts';
import { producerCases, producerPolicy, producerState, producerWouldDo } from '../producer/producer.ts';
import { gatesStatus } from '../gates/state.ts';
import { capacityUsage } from '../tick/capacity.ts';
import { routingOf } from '../routing/classify.ts';
import { isGenericKind } from '../routing/kinds.ts';
import type { AttentionGroup, AttentionItem, OverviewAll, OverviewDay, Problem, RecentMerge, ProjectOverview, RunOutcome, Stage, OrderSummary } from './types.ts';

const DAY = 86400_000;
const percentile = (sorted: number[], fraction: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : undefined;
const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : undefined;
};

interface ProjectFacts {
  view: ProjectView;
  docs: OrderDoc[];
  items: OrderSummary[];
  merged: Set<string>;
  rows: Map<string, NonNullable<ProjectView['rows'][number]['activity']>>;
  base: Omit<ProjectOverview, 'workers' | 'attention' | 'live' | 'nextUp' | 'dependencies' | 'throughput' | 'usage' | 'recent' | 'recentDecisions' | 'recentApprovals' | 'total' | 'needsCount' | 'mergesPerDay'>;
  localAttention: Map<string, AttentionGroup>;
  live: ProjectOverview['live']['items'];
  days: OverviewDay[];
  approvals: RecentMerge[];
  kinds: Map<string, { merges: number; reworks: number; outcomes: Partial<Record<RunOutcome, number>>; leads: number[] }>;
}

function copyDays(days: OverviewDay[], project: string): OverviewDay[] {
  return days.map(d => ({ day: d.day, merges: d.merges[project] ? { [project]: d.merges[project] } : {}, reworks: 0, endings: {} }));
}

function addGroup(groups: Map<string, AttentionGroup>, kind: string, problem: boolean, item: AttentionItem): void {
  let group = groups.get(kind);
  if (!group) { group = { kind, problem, count: 0, items: [] }; groups.set(kind, group); }
  const shared = problem && !item.tag ? group.items.find(i => !i.tag && i.text === item.text) : undefined;
  if (shared) shared.projects = [...new Set([...(shared.projects ?? [shared.project]), ...(item.projects ?? [item.project])])];
  else group.items.push(item);
  group.count = group.items.length;
}

/** Builds the cross-project overview and project slices from the same cached snapshot. */
export function overviewAll(snap: Snapshot, workersFile?: WorkersFile, extra: (project: string) => Problem[] = () => [], lastTickAt?: string, now = new Date()): OverviewAll {
  snap = { ...snap, projects: snap.projects.map(view => ({ ...view, orders: readOrders(view.orders) })) };
  const env: ViewEnv = { workers: workersFile, cachedOnly: true, probes: { now: () => now } as Probes };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days: OverviewDay[] = Array.from({ length: 14 }, (_, i) => ({ day: new Date(today - (13 - i) * DAY).toISOString().slice(0, 10), merges: {}, reworks: 0, endings: {} }));
  const byDay = new Map(days.map(d => [d.day, d]));
  const dayOf = (at: string) => { const ms = Date.parse(at); return Number.isFinite(ms) && ms <= now.getTime() ? byDay.get(new Date(ms).toISOString().slice(0, 10)) : undefined; };
  const groups = new Map<string, AttentionGroup>();
  const resources = snap.projects.flatMap(v => resourceViews(v.config, v.orders, now).map(r => ({ ...r, project: v.config.id })));
  const live: OverviewAll['live']['items'] = [];
  const approvals: RecentMerge[] = [];
  const facts = new Map<string, ProjectFacts>();
  const addAttention = (local: Map<string, AttentionGroup>, kind: string, problem: boolean, item: AttentionItem) => { addGroup(groups, kind, problem, item); addGroup(local, kind, problem, item); };

  for (const view of snap.projects) {
    const id = view.config.id;
    const docs = view.orders.all();
    const merged = view.orders.mergedSet(docs);
    const rows = new Map(view.rows.flatMap(r => r.activity ? [[r.tag, r.activity] as const] : []));
    const capacityOrders: { stage: Stage; kind: string; heavy?: string }[] = [];
    const items = docs.map(doc => {
      const stage = view.orders.stage(doc, merged);
      const capacityStage = doc.runs.some(r => r.ended === undefined) ? 'running' : stage.stage;
      if ((capacityStage === 'running' || capacityStage === 'monitoring') && Object.keys(view.config.dispatch.caps).length) {
        const o = doc.order;
        capacityOrders.push({ stage: capacityStage, kind: isGenericKind(o.kind) ? routingOf(view.config, doc, now.toISOString()).kind || o.kind : o.kind, heavy: o.heavy });
      }
      const latest = [...doc.reports].sort((a, b) => b.seq - a.seq)[0];
      return summaryOf(view.config, doc, stage, env, rows.get(doc.order.tag), NEEDS_YOU.includes(stage.stage) ? latest : undefined);
    });
    const needs = items.filter(i => NEEDS_YOU.includes(i.stage));
    const running = items.filter(i => i.run);
    const problems: Problem[] = [...extra(id), ...(view.tick?.problems ?? []).map(p => ({ kind: p.kind, ...(p.tag ? { tag: p.tag } : {}), ...(p.evidence?.length ? { evidence: p.evidence } : {}), text: p.text }))];
    const pendingQuotes = quoteList(id, view.orders, 'pending');
    const pendingPicks = pendingPicksOf(view);
    const moves = (view.tick?.moves ?? []).map(m => ({ tag: m.tag, mode: m.mode, worker: m.worker }));
    const needsCount = needs.length + pendingQuotes.items.length + pendingPicks.length + moves.filter(m => m.mode === 'card').length;
    const localAttention = new Map<string, AttentionGroup>();
    const base = {
      project: id, name: view.config.name, at: snap.at,
      ...(view.config.gates?.nightly.length ? { nightlyGates: gatesStatus(view.config) } : {}),
      capacity: capacityUsage(capacityOrders, view.config.dispatch.caps),
      needsYou: { count: needs.length, items: needs }, problems: { count: problems.length, items: problems }, running: { count: running.length, items: running }, pendingQuotes: { count: pendingQuotes.count, items: pendingQuotes.items },
      ...(pendingPicks.length ? { pendingPicks: { count: pendingPicks.length, items: pendingPicks } } : {}), stages: countStages(items), next: { moves, heldBack: view.tick?.heldBack ?? [] }, ...(view.error ? { error: view.error } : {}),
      producer: (() => { const state = producerState(view.config); const policy = producerPolicy(view.config); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); return { openCases: policy.enabled ? producerCases(view.config, true).length : 0, wouldDoToday: policy.enabled ? producerWouldDo(view.config).filter(a => Date.parse(a.at) >= today).length : 0, paused: state.paused }; })(),
    } as ProjectFacts['base'];
    for (const row of needs) addAttention(localAttention, row.stage === 'awaiting-user' ? (row.waitingFor === 'card' ? 'card' : 'answer') : row.stage === 'awaiting-review' ? 'review' : 'blocked', false, { project: id, tag: row.tag, text: row.unanswered?.[0]?.text ?? row.report?.question ?? row.report?.summary ?? row.why });
    for (const q of pendingQuotes.items) addAttention(localAttention, 'quotes', false, { project: id, tag: q.tag, text: q.service, target: 'spend' });
    for (const p of pendingPicks) addAttention(localAttention, 'picks', false, { project: id, ...(p.order ? { tag: p.order } : {}), text: p.title, target: 'picks' });
    for (const m of moves.filter(m => m.mode === 'card')) addAttention(localAttention, 'card', false, { project: id, tag: m.tag, text: m.worker });
    for (const p of problems) addAttention(localAttention, p.kind, true, { project: id, ...(p.tag ? { tag: p.tag } : {}), text: p.text });
    const projectDays = copyDays(days, id);
    const projectLive: ProjectOverview['live']['items'] = [];
    for (const row of items.filter(i => i.run || i.stage === 'monitoring')) {
      const activity = rows.get(row.tag); const commit = activity?.lastCommitAt; const receipt = activity?.receiptAt;
      const commitMinutes = commit && Number.isFinite(Date.parse(commit)) ? Math.max(0, Math.floor((now.getTime() - Date.parse(commit)) / 60000)) : undefined;
      const receiptMinutes = receipt && Number.isFinite(Date.parse(receipt)) ? Math.max(0, Math.floor((now.getTime() - Date.parse(receipt)) / 60000)) : undefined;
      const item = { ...row, ...(commitMinutes !== undefined ? { commitMinutes } : {}), ...(receipt ? { receiptAt: receipt, ...(receiptMinutes !== undefined ? { receiptMinutes } : {}) } : {}), leases: resources.filter(r => r.project === id).flatMap(r => r.leases.filter(l => l.tag === row.tag)) };
      projectLive.push(item); live.push(item);
    }
    const fact: ProjectFacts = { view, docs, items, merged, rows, base, localAttention, live: projectLive, days: projectDays, approvals: [], kinds: new Map() };
    facts.set(id, fact);
    for (const doc of docs) collect(doc, id, fact);
  }

  function collect(doc: OrderDoc, project: string, fact: ProjectFacts): void {
    for (const action of doc.actions) {
      const day = dayOf(action.at); const projectDay = day && fact.days.find(d => d.day === day.day);
      if (action.kind === 'rework') { if (day) day.reworks++; if (projectDay) projectDay.reworks++; const kind = doc.order.kind || 'unknown'; const f = fact.kinds.get(kind) ?? { merges: 0, reworks: 0, outcomes: {}, leads: [] }; f.reworks++; fact.kinds.set(kind, f); }
      if (action.kind !== 'approve') continue;
      if (day) { day.merges[project] = (day.merges[project] ?? 0) + 1; if (projectDay) projectDay.merges[project] = (projectDay.merges[project] ?? 0) + 1; }
      const queue = doc.actions.filter(a => a.kind === 'queue' && a.seq < action.seq).sort((a, b) => a.seq - b.seq)[0]; const leadHours = queue ? (Date.parse(action.at) - Date.parse(queue.at)) / 3600000 : undefined; const runs = doc.runs.filter(r => r.seq < action.seq);
      const approval = { project, tag: doc.order.tag, title: doc.order.title, at: action.at, runs: runs.length, reworks: doc.actions.filter(a => a.kind === 'rework' && a.seq < action.seq).length, ...(runs.at(-1) ? { worker: runs.at(-1)!.worker } : {}), ...(leadHours !== undefined && leadHours >= 0 && Number.isFinite(leadHours) ? { leadHours } : {}) } satisfies RecentMerge;
      approvals.push(approval); fact.approvals.push(approval);
      const kind = doc.order.kind || 'unknown'; const f = fact.kinds.get(kind) ?? { merges: 0, reworks: 0, outcomes: {}, leads: [] }; f.merges++; if (approval.leadHours !== undefined) f.leads.push(approval.leadHours); fact.kinds.set(kind, f);
    }
    for (const run of doc.runs) {
      const day = run.ended ? dayOf(run.ended) : undefined; if (!day || !run.outcome) continue;
      day.endings[run.outcome] = (day.endings[run.outcome] ?? 0) + 1; const projectDay = fact.days.find(d => d.day === day.day); if (projectDay) projectDay.endings[run.outcome] = (projectDay.endings[run.outcome] ?? 0) + 1;
      const kind = doc.order.kind || 'unknown'; const f = fact.kinds.get(kind) ?? { merges: 0, reworks: 0, outcomes: {}, leads: [] }; f.outcomes[run.outcome] = (f.outcomes[run.outcome] ?? 0) + 1; fact.kinds.set(kind, f);
    }
  }

  const workers = workerViews(snap, env).map(w => {
    const history = snap.projects.flatMap(v => v.history ?? []).filter(q => q.source === w.quotaSource && q.balance?.amount !== undefined && Date.parse(q.at) <= now.getTime() - DAY).sort((a, b) => b.at.localeCompare(a.at)); const old = history[0]?.balance?.amount;
    const limit = w.running >= w.concurrency ? t('at its concurrency limit ({n}/{max})', { n: w.running, max: w.concurrency }) : w.dailyRuns !== undefined && w.runsToday >= w.dailyRuns ? t('at its daily limit ({n}/{max} runs today)', { n: w.runsToday, max: w.dailyRuns }) : undefined;
    return { ...w, available: w.available && !limit, reasons: [...w.reasons, ...(limit ? [limit] : [])], ...(old !== undefined && w.quota?.balance?.amount !== undefined ? { balanceChange24h: w.quota.balance.amount - old } : {}) };
  }).sort((a, b) => Number(a.available) - Number(b.available) || a.id.localeCompare(b.id));
  const quotas: OverviewAll['quotas'] = []; for (const w of workers) if (w.quotaSource && !quotas.some(q => q.source === w.quotaSource)) quotas.push({ source: w.quotaSource, workers: workers.filter(x => x.quotaSource === w.quotaSource).map(x => x.id), ...(w.quota ? { reading: w.quota } : {}) });
  const ledger = snap.projects.flatMap(p => usageRows(p.config));
  const warnings = snap.projects.flatMap(p => budgetWarnings(p.config, ledger.filter(r => r.project === p.config.id), now).map(w => ({ ...w, project: p.config.id })));
  for (const w of warnings) { const item = { project: w.project, ...(w.order ? { tag: w.order } : {}), text: w.text }; addGroup(groups, 'usage-budget', true, item); const local = facts.get(w.project)?.localAttention; if (local) addGroup(local, 'usage-budget', true, item); }
  const since = sinceDate('7d', now);
  const projectSlices: ProjectOverview[] = [...facts.values()].map(fact => {
    const id = fact.view.config.id; const projectRows = ledger.filter(r => r.project === id); const projectWarnings = warnings.filter(w => w.project === id).map(({ project: _project, ...w }) => w);
    const used = new Set(projectRows.filter(r => Date.parse(r.at) >= Date.parse(since)).map(r => r.worker)); for (const doc of fact.docs) for (const run of doc.runs) if (Date.parse(run.started) >= Date.parse(since)) used.add(run.worker);
    const projectWorkers = workerViews(snap, env, fact.view).filter(w => used.has(w.id) || (fact.view.workers ?? []).some(x => x.config.id === w.id && x.running > 0));
    const moves = new Map<string, { worker?: string; mode?: 'dispatch' | 'resume' | 'card'; reason: string }>(); for (const m of fact.base.next.moves) moves.set(m.tag, { worker: m.worker, mode: m.mode, reason: t('would start next tick') }); for (const h of fact.base.next.heldBack) moves.set(h.tag, { reason: h.why });
    const nextUp = fact.items.filter(i => i.stage === 'queued').map(i => ({ i, m: moves.get(i.tag) })).filter(x => x.m).sort((a, b) => { const ai = [...moves.keys()].indexOf(a.i.tag), bi = [...moves.keys()].indexOf(b.i.tag); return (ai < 0 ? 999999 : ai) - (bi < 0 ? 999999 : bi) || a.i.tag.localeCompare(b.i.tag); }).map(({ i, m }) => ({ tag: i.tag, title: i.title, stage: i.stage, reason: m!.reason, ...(m!.worker ? { worker: m!.worker } : {}), ...(m!.mode ? { mode: m!.mode } : {}) }));
    const byTag = new Map(fact.docs.map(d => [d.order.tag, d])); const dep = new Map<string, { title: string; items: { tag: string; title: string; stage: Stage }[] }>();
    for (const doc of fact.docs) { const stage = fact.view.orders.stage(doc, fact.merged).stage; if (stage !== 'draft' && stage !== 'queued') continue; for (const need of doc.order.needs ?? []) { const required = byTag.get(need); if (!required) continue; const requiredStage = fact.view.orders.stage(required, fact.merged).stage; if (requiredStage === 'merged' || requiredStage === 'cancelled') continue; const current = dep.get(required.order.tag) ?? { title: required.order.title, items: [] }; current.items.push({ tag: doc.order.tag, title: doc.order.title, stage }); dep.set(required.order.tag, current); } }
    const dependencies = [...dep.entries()].map(([tag, d]) => ({ tag, title: d.title, count: d.items.length, items: d.items })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    const kindRows = [...fact.kinds.entries()].map(([kind, f]) => ({ kind, merges: f.merges, reworks: f.reworks, outcomes: f.outcomes, ...(f.leads.length ? { medianLeadHours: median(f.leads), p90LeadHours: percentile([...f.leads].sort((a,b) => a-b), .9) } : {}) })).sort((a,b) => a.kind.localeCompare(b.kind)); const allLeads = fact.approvals.filter(a => a.leadHours !== undefined).map(a => a.leadHours!);
    const throughput = { days: fact.days, byKind: kindRows, ...(allLeads.length ? { medianLeadHours: median(allLeads), p90LeadHours: percentile([...allLeads].sort((a,b) => a-b), .9) } : {}) };
    const decisions = decisionList(fact.view.config, fact.view.orders).items.slice(-10).reverse(); const recentApprovals = [...fact.approvals].sort((a,b) => b.at.localeCompare(a.at)).slice(0, 10);
    return { ...fact.base, total: fact.items.length, needsCount: fact.base.needsYou.count + fact.base.pendingQuotes.count + (fact.base.pendingPicks?.count ?? 0) + fact.base.next.moves.filter(m => m.mode === 'card').length, mergesPerDay: fact.days.map(d => d.merges[id] ?? 0), attention: [...fact.localAttention.values()], live: { count: fact.live.length, items: fact.live.sort((a,b) => (b.commitMinutes ?? b.receiptMinutes ?? 0) - (a.commitMinutes ?? a.receiptMinutes ?? 0) || a.tag.localeCompare(b.tag)) }, nextUp, dependencies, throughput, usage: usageDashboard(projectRows, [], projectWarnings, since, now), workers: { count: projectWorkers.length, items: projectWorkers }, recent: { decisions, approvals: recentApprovals }, recentDecisions: decisions, recentApprovals };
  });
  const merges = days.reduce((n, d) => n + Object.values(d.merges).reduce((a,b) => a+b, 0), 0); const endings = days.reduce((n, d) => n + Object.values(d.endings).reduce((a,b) => a+b, 0), 0); const leads = approvals.filter(a => dayOf(a.at) && a.leadHours !== undefined).map(a => a.leadHours!).sort((a,b) => a-b);
  return {
    usage: usageDashboard(ledger, [], warnings.map(({ project: _project, ...w }) => w), since, now), at: now.toISOString(), readingsAt: snap.at, projects: projectSlices,
    attention: [...groups.values()], live: { count: live.length, items: live.sort((a,b) => (b.commitMinutes ?? b.receiptMinutes ?? 0) - (a.commitMinutes ?? a.receiptMinutes ?? 0) || a.project.localeCompare(b.project) || a.tag.localeCompare(b.tag)) }, workers: { count: workers.length, items: workers }, quotas,
    ...(snap.freeRamGb !== undefined || snap.minFreeRamGb !== undefined ? { machine: { freeRamGb: snap.freeRamGb, minFreeRamGb: snap.minFreeRamGb } } : {}), days,
    metrics: { merges7d: days.slice(-7).reduce((n,d) => n + Object.values(d.merges).reduce((a,b) => a+b,0), 0), ...(endings ? { runSuccessRate: days.reduce((n,d) => n + (d.endings.completed ?? 0),0) / endings } : {}), ...(merges ? { reworksPerMerge: days.reduce((n,d) => n + d.reworks,0) / merges } : {}), ...(leads.length ? { medianLeadHours: median(leads), p95LeadHours: percentile(leads,.95) } : {}) }, recentMerges: { count: approvals.length, items: approvals.sort((a,b) => b.at.localeCompare(a.at)) }, resources,
    next: { moves: projectSlices.flatMap(p => p.next.moves.map(m => ({ ...m, project: p.project }))), heldBack: projectSlices.flatMap(p => p.next.heldBack.map(h => ({ ...h, project: p.project }))), ...(lastTickAt ? { lastTickAt } : {}) },
  };
}

/** Return one project slice using the exact builder used by `/api/overview/all`. */
export function overviewProject(snap: Snapshot, project: string, workersFile?: WorkersFile, extra: (project: string) => Problem[] = () => [], lastTickAt?: string, now = new Date()): ProjectOverview {
  const found = overviewAll({ ...snap, projects: snap.projects.filter(v => v.config.id === project) }, workersFile, extra, lastTickAt, now).projects.find(p => p.project === project);
  if (!found) throw new Error(`No project "${project}".`);
  return found;
}
