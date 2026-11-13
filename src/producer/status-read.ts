import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { activeLeases, kindOfOrder, usesOf } from '../resources/leases.ts';
import { capacityUsage } from '../tick/capacity.ts';
import { systemProbes, tick, type Probes, type TickResult } from '../tick/gather.ts';
import { cachedProbes } from '../web/snapshot.ts';
import { loadWorkers, type WorkersFile } from '../workers/config.ts';
import { selectedCases, selectedOrders, type ReadArgs } from './collection-read.ts';

const probes = cachedProbes(systemProbes, 30000);
const short = (value: unknown, max = 160) => String(value ?? '-').replace(/\s+/g, ' ').slice(0, max);

/** Retain section counts and explicit omission markers instead of cutting a JSON object mid-record. */
function section(title: string, lines: string[], budget: number): string {
  const header = `${title} (${lines.length})\n`;
  const kept: string[] = [];
  let size = header.length;
  for (const line of lines) {
    if (size + line.length + 60 > budget) break;
    kept.push(line); size += line.length + 1;
  }
  return header + kept.join('\n') + (kept.length < lines.length ? `\n… ${lines.length - kept.length} omitted; use filtered producer_read.` : lines.length ? '' : 'none');
}

/** Same dry-run gather and planner as the board: no launches, verification or state writes. */
export function readProducerStatus(project: ProjectConfig, orders: Orders, args: ReadArgs = {}, env: { probes?: Probes; workers?: WorkersFile; result?: TickResult } = {}) {
  const reader = env.probes ?? probes;
  const workersFile = process.env.ALBA_WORKERS ?? project.workers;
  const workers = env.workers ?? (workersFile ? loadWorkers(workersFile) : { file: '', workers: [], quota_sources: {} });
  const now = reader.now(), minutes = (at?: string) => at ? Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 60000)) : '?';
  const result = env.result ?? tick(project, orders, workers, reader, { record: false });
  const docs = selectedOrders(orders, { ...args, include_closed: false }), allOpen = selectedOrders(orders, {});
  const rows = docs.map(doc => ({ doc, stage: orders.stage(doc).stage, kind: kindOfOrder(project, doc) }));
  const caps = capacityUsage(allOpen.map(doc => ({ stage: orders.stage(doc).stage, kind: kindOfOrder(project, doc), heavy: doc.order.heavy })), project.dispatch.caps);
  const ready = allOpen.filter(d => orders.stage(d).stage === 'queued');
  const needs = allOpen.filter(d => orders.stage(d).stage === 'waiting-needs');
  const leases = activeLeases(project, orders);
  const reason = (candidates: typeof ready, waiting: typeof needs, free: number): string => {
    if (!candidates.length) return waiting.length ? `needs: ${waiting.map(d => short(d.order.tag, 32)).slice(0, 4).join(', ')}` : 'no ready order';
    const tags = new Set(candidates.map(d => d.order.tag));
    const moves = result.report.moves.filter(m => tags.has(m.tag));
    const blockers = [...result.report.heldBack.filter(h => tags.has(h.tag)).map(h => h.why), ...result.report.problems.filter(p => p.tag && tags.has(p.tag)).map(p => p.text)];
    const blocked = blockers.join(' | ');
    return short(moves.length ? `next tick: ${moves.map(m => short(m.tag, 32)).slice(0, 4).join(', ')}${moves.length < free ? `; remaining ${free - moves.length}: ${blocked || 'no additional ready order'}` : ''}` : blocked || 'worker/quota availability unknown', 210);
  };
  const capacity = Object.entries(caps).map(([kind, cap]) => `kind ${short(kind, 48)} ${cap.used}/${cap.cap}; free ${Math.max(0, cap.cap - cap.used)}${cap.used < cap.cap ? `: ${reason(ready.filter(d => kindOfOrder(project, d) === kind || d.order.heavy === kind), needs.filter(d => kindOfOrder(project, d) === kind || d.order.heavy === kind), cap.cap - cap.used)}` : ''}`);
  for (const [name, resource] of Object.entries(project.resources ?? {})) {
    const used = leases.filter(l => l.resource === name).length;
    capacity.push(`resource ${short(name, 48)} ${used}/${resource.slots}; free ${Math.max(0, resource.slots - used)}${used < resource.slots ? `: ${reason(ready.filter(d => usesOf(project, d).includes(name)), needs.filter(d => usesOf(project, d).includes(name)), resource.slots - used)}` : ''}`);
  }
  capacity.unshift(`memory ${reader.freeRamGb()?.toFixed(1) ?? 'unknown'} GB free / minimum ${project.dispatch.min_free_ram_gb ?? 'unset'} GB`);
  if (!workers.workers.length) capacity.push('worker/quota availability unknown: no workers configured');
  const tags = new Set(docs.map(d => d.order.tag));
  const stalls = result.report.problems.filter(p => p.kind === 'stalled' && p.tag && tags.has(p.tag)).map(p => short(p.text, 240));
  const cases = selectedCases(project, orders, { ...args, include_closed: false }).filter(c => c.status === 'open');
  const groupedCases = [...new Set(cases.map(c => c.trigger))].sort().map(trigger => {
    const group = cases.filter(c => c.trigger === trigger);
    return `${trigger} (${group.length}): ${short(group.map(c => short(c.key, 100)).join(', '), 250)}`;
  });
  const held = rows.filter(r => r.stage === 'held').flatMap(({ doc }) => {
    const hold = [...doc.actions].sort((a, b) => b.seq - a.seq).find(a => a.kind === 'hold');
    return hold && now.getTime() - Date.parse(hold.at) > 3 * 86400000 ? [`${short(doc.order.tag, 48)} held ${Math.floor(Number(minutes(hold.at)) / 1440)} days`] : [];
  });
  const orderLines: string[] = [];
  for (const stage of ['running', 'monitoring', 'queued', 'waiting-needs', 'held', 'failed', 'awaiting-review', 'awaiting-user', 'blocked', 'dropped', 'idle', 'draft']) {
    const group = rows.filter(r => r.stage === stage);
    if (!group.length) continue;
    for (const { doc, kind } of group) {
      const run = [...doc.runs].sort((a, b) => b.seq - a.seq)[0], report = [...doc.reports].sort((a, b) => b.seq - a.seq)[0];
      const commit = result.activity[doc.order.tag]?.lastCommitAt ?? (doc.order.worktree ? reader.gitActivity(doc.order.worktree).lastCommitAt : undefined);
      orderLines.push(`${stage === 'awaiting-review' ? 'ready for review' : stage}: ${short(doc.order.tag, 48)} ${short(kind, 32)} worker=${short(run?.worker ?? doc.order.worker, 32)} commit=${commit ?? '?'} (${minutes(commit)}m) age=${minutes(run?.started)}m report=${report?.status ?? '-'}`);
    }
  }
  const counts = [...new Set(rows.map(r => r.stage))].map(stage => `${stage}=${rows.filter(r => r.stage === stage).length}`).join(' ');
  const text = [`Status ${now.toISOString()}; ${docs.length} open orders`, short(counts, 400),
    section('Capacity', capacity, 1350), section('Stalled runs (tick rule)', stalls, 650),
    section('Open cases by trigger', groupedCases, 600), section('Held over 3 days', held, 450),
    section('Producer rule modes', project.producer.rules.map(rule => `${short(rule.id, 64)}: ${rule.mode} (${rule.action})`), 400),
    section('Open orders; commit/age in minutes (? = unknown)', orderLines, 2050)].join('\n\n');
  return { text };
}
