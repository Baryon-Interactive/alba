import { createHash } from 'node:crypto';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { readStateJson, writeStateFile, updateStateJson } from '../orders/state-files.ts';
import { tick } from '../tick/gather.ts';
import { runMonitors } from '../monitor/monitor.ts';
import { staleMonitor } from '../monitor/stale.ts';
import { planClean, systemClean } from '../clean/clean.ts';
import { repeatedFailure } from './loop-guard.ts';
import { dispatchCandidates } from './dispatch.ts';
import { readProducerStatus } from './status-read.ts';
import { planFingerprint } from './drafting.ts';
import { syncRoundCases, producerState, producerAct, runProducerActions, type ProducerCard, type ProducerExecutionEnv } from './producer.ts';
import { BRIEFS_STATE, buildBrief, type ProducerBrief } from './briefs.ts';
import { standingDirection } from './conversation-state.ts';

const ROUND = '_producer-round.json';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Deterministic and model-free. Only actionable facts become session cards. */
export function scheduledRound(project: ProjectConfig, orders: Orders, env: ProducerExecutionEnv) {
  const config = project.producer.round, now = env.probes.now().toISOString();
  if (!project.producer.enabled || !config?.enabled || producerState(project).paused) return;
  const last = readStateJson<{ at: string } | undefined>(project, ROUND, undefined);
  if (last && Date.parse(now) - Date.parse(last.at) < config.every_minutes * 60000) return;
  // A monitored job whose process has ended is checked once more and handed back like any other end (src/monitor/monitor.ts).
  runMonitors(project, orders, env.probes);
  const result = tick(project, orders, env.workers, env.probes, { record: false });
  const status = readProducerStatus(project, orders, {}, { ...env, result }).text;
  const inputs: Parameters<typeof syncRoundCases>[1] = [];
  const add = (trigger: string, order: string | undefined, summary: string, facts: Record<string, unknown>, gates?: unknown) => {
    const identity = { ...facts }; delete identity.plan;
    const card: ProducerCard = { trigger, summary, ...(order ? { stage: orders.stage(orders.get(order)).stage } : {}), pointers: order ? [`order:${order}`] : [], untrusted: ['summary', 'report', 'log'], gates };
    inputs.push({ key: `round/${trigger}/${order ?? 'project'}`, trigger, order, facts: { ...facts, roundFingerprint: digest(identity) }, card });
  };
  for (const p of result.report.problems.filter(p => p.kind === 'stalled' && p.tag)) {
    const doc = orders.get(p.tag!);
    add('stalled-run', p.tag, p.text, { run: doc.runs.at(-1)?.id, lastCommit: result.activity[p.tag!]?.lastCommitAt ?? null });
  }
  for (const p of result.report.problems.filter(p => p.kind === 'machine-down')) {
    const facts = { machine: p.evidence?.[0], service: p.evidence?.[1], problem: p.text };
    inputs.push({ key: `round/machine-down/${p.evidence?.join('/')}`, trigger: 'machine-down', facts: { ...facts, roundFingerprint: digest(facts) },
      card: { trigger: 'machine-down', summary: p.text, pointers: [`machines:${facts.machine}`], untrusted: ['summary'] } });
  }
  for (const doc of orders.all()) {
    const stage = orders.stage(doc).stage;
    if (stage === 'monitoring') {
      const stale = staleMonitor(project, doc, env.probes);
      if (stale) add('monitor-stale', doc.order.tag, stale.reason, { report: doc.monitor?.report_seq, ...stale.evidence });
    }
    const failures = repeatedFailure(doc);
    if (failures && !['merged', 'cancelled', 'held', 'dropped', 'running', 'monitoring', 'awaiting-review'].includes(stage)) add('repeated-failure', doc.order.tag, `Repeated ${failures[0].cause} failure: ${failures[0].summary}. Change the fix or ask a person.`, { failures });
  }
  // Planned orders compete in the same pure tick planner, never in the launch path.
  const preview = tick(project, orders, env.workers, env.probes, { record: false, includePlanned: true });
  for (const candidate of dispatchCandidates(project, orders, preview)) {
    const doc = orders.get(candidate.move.tag);
    if (orders.stage(doc).stage === 'planned') {
      add('ready-to-draft', doc.order.tag, `Next dispatch item needs its order body. ${candidate.why}`, { fingerprint: planFingerprint(doc), kind: candidate.kind, next: candidate.next });
    } else add('dispatch', doc.order.tag, candidate.why, { kind: candidate.kind, worker: candidate.move.worker, next: candidate.next, run: doc.runs.at(-1)?.id ?? null }, candidate);
  }
  const plan = planClean(project, orders, env.clean ?? systemClean(env.probes));
  const deletions = plan.items.filter(i => ['remove', 'prune', 'delete'].includes(i.action));
  const gain = deletions.reduce((sum, i) => sum + (i.bytes ?? i.measuredBytes ?? 0), 0) / 2 ** 30;
  const unknown = deletions.some(i => i.bytes === undefined);
  const size = unknown ? gain > 0 ? `≥ ${gain.toFixed(3)} GB (partial)` : 'size unknown' : `${gain.toFixed(3)} GB`;
  if (plan.drives?.some(d => d.low) || gain > (project.clean?.min_gain_gb ?? 1)) add('clean', undefined, `Cleanup dry-run: ${deletions.length} items, ${size}; ${plan.drives?.filter(d => d.low).map(d => `${d.path} below ${d.min_free_gb} GB`).join('; ') || 'gain threshold exceeded'}.`,
    { plan, signature: digest(deletions.map(i => [i.path, i.pathClass, i.action, i.targets, i.branch, i.signature])), lowDrives: plan.drives?.filter(d => d.low).map(d => d.path) ?? [] }, plan);
  const cases = syncRoundCases(project, inputs, now);
  for (const c of cases) {
    if (c.trigger === 'dispatch') producerAct(project, orders, c.id, 'dispatch', { reason: [c.card.summary, ...(Array.isArray(c.facts.next) ? (c.facts.next as { tag: string; why: string }[]).map(n => `${n.tag}: ${n.why}`) : [])].join('\n'), now: env.probes.now() });
    if (c.trigger === 'monitor-stale') producerAct(project, orders, c.id, 'rework', { note: c.card.summary, reason: 'Stale monitor evidence', now: env.probes.now() });
    if (c.trigger === 'clean') producerAct(project, orders, c.id, 'clean', { reason: c.card.summary, now: env.probes.now() });
  }
  runProducerActions(project, orders, env);
  const brief = buildBrief({ now, language: project.producer.brief?.language ?? 'en', orders: orders.all(), events: orders.store.events(), readings: result, actions: producerState(project).actions, direction: standingDirection(project) });
  brief.kind = 'round';
  brief.round = { status, cases: cases.map(c => ({ id: c.id, revision: c.revision, facts: c.facts })) };
  brief.facts.push({ id: 'round:attention', value: cases.length, unit: 'cases', sources: cases.map(c => `case:${c.id}:${c.revision}`) });
  for (const c of cases) brief.facts.push({ id: `round:${c.id}`, value: c.card.summary, unit: 'attention evidence', sources: [`case:${c.id}:${c.revision}`] });
  brief.skeleton = brief.text = `Scheduled round checked stalls, monitors, dispatch, repeated failures and disk.\n${brief.skeleton}\nAttention: ${cases.length} [round:attention]\n${cases.map(c => `${c.trigger}: ${c.order ?? project.id}: ${c.card.summary} [round:${c.id}]`).join('\n')}`;
  brief.fingerprint = digest({ skeleton: brief.skeleton, facts: brief.facts, round: brief.round });
  updateStateJson<ProducerBrief[]>(project, BRIEFS_STATE, [], rows => [...rows, brief].slice(-200));
  writeStateFile(project, ROUND, JSON.stringify({ at: now }));
  return { cases, brief, plan, status };
}
