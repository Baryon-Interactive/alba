import path from 'node:path';
import type { OrderSpend } from '../api/types.ts';
import { readRunConsults } from '../consult/config.ts';
import type { OrderDoc, Run } from '../orders/model.ts';
import { liveRuns } from '../run/live.ts';
import type { Probes } from '../tick/gather.ts';
import { mentions } from '../tick/plan.ts';
import type { WorkerConfig } from '../workers/config.ts';
import { totalUsage } from './fold.ts';
import { parseUsage, UNKNOWN, withCost, type RunUsage } from './usage.ts';

const TAIL = 65536;
const cache = new Map<string, { size: string; usage: RunUsage }>();

/** The worker an order's run text names (a worker id or one of its aliases). */
export function ownerOf(workers: readonly WorkerConfig[], text: string | undefined): WorkerConfig | undefined {
  return workers.find(w => w.id === text) ?? workers.find(w => mentions(text, w));
}

export function stateDirOfRun(run: Pick<Run, 'log' | 'prompt_file' | 'events_file'>, stateDir?: string): string | undefined {
  if (stateDir) return stateDir;
  const ref = run.log ?? run.prompt_file ?? run.events_file;
  return ref ? path.resolve(path.dirname(ref), '..') : undefined;
}

/**
 * Tokens and cost of one run: what was stored when it ended, else read from its log now (older runs, or runs the tick has not
 * recorded yet). An open run, an imported run and a run without a log are `unknown`. Cost: the engine's own, else an estimate from
 * the worker's price.
 */
export function usageOf(run: Run, workers: readonly WorkerConfig[], probes: Probes, storedOnly = false): RunUsage {
  const counted = totalUsage(liveRuns.accounting(run)?.turns ?? []);
  let usage: RunUsage = counted ?? run.usage ?? UNKNOWN;
  const live = liveRuns.peek(run)?.usage ?? run.live_summary;
  if (!counted && !run.usage && live?.turns) usage = { source: 'codex-log', input_tokens: live.input_tokens, cached_tokens: live.cached_input_tokens, output_tokens: live.output_tokens, total_tokens: live.input_tokens + live.output_tokens, turns: live.turns };
  if (!counted && !storedOnly && !run.usage && run.ended && run.log && !run.imported) {
    const stamp = `${probes.fileTime(run.log) ?? ''}`;
    const hit = cache.get(run.log);
    if (hit && hit.size === stamp) usage = hit.usage;
    else {
      const tail = probes.tail(run.log, TAIL);
      usage = parseUsage(/step[-_]finish/.test(tail) ? probes.readText(run.log) ?? tail : tail, { cut: Buffer.byteLength(tail) >= TAIL && !/step[-_]finish/.test(tail) });
      cache.set(run.log, { size: stamp, usage });
    }
  }
  return withCost(usage, ownerOf(workers, run.worker)?.price);
}

export function orderSpend(doc: OrderDoc, workers: readonly WorkerConfig[], probes: Probes, storedOnly = false, stateDir?: string): OrderSpend {
  let tokens = 0, cost: number | undefined, estimated = false, known = 0, unknown = 0;
  let consultCount = 0, consultTokens = 0, consultCost: number | undefined;
  for (const run of doc.runs) {
    const u = usageOf(run, workers, probes, storedOnly);
    if (u.source === 'unknown' && u.cost_usd === undefined) { if (run.ended && !run.imported) unknown++; }
    else {
      known++;
      tokens += u.total_tokens ?? 0;
      if (u.cost_usd !== undefined) cost = (cost ?? 0) + u.cost_usd;
      if (u.cost_estimated) estimated = true;
    }
    for (const c of readRunConsults(stateDirOfRun(run, stateDir), doc.order.tag, run.id)) {
      if (c.outcome === 'refused') continue;
      consultCount++;
      if (!c.usage) continue;
      const cu = withCost(c.usage, ownerOf(workers, c.consultant)?.price);
      if (cu.source === 'unknown' && cu.cost_usd === undefined) continue;
      const ct = cu.total_tokens ?? 0;
      tokens += ct;
      consultTokens += ct;
      if (cu.cost_usd !== undefined) {
        cost = (cost ?? 0) + cu.cost_usd;
        consultCost = (consultCost ?? 0) + cu.cost_usd;
      }
      if (cu.cost_estimated) estimated = true;
    }
  }
  const cap = doc.order.mandate?.spend_cap;
  const spend: OrderSpend = {
    total_tokens: tokens,
    ...(cost !== undefined ? { cost_usd: Math.round(cost * 1e6) / 1e6 } : {}),
    estimated,
    runs_with_usage: known,
    runs_unknown: unknown,
    ...(consultCount > 0 ? {
      consults: consultCount,
      consult_tokens: consultTokens,
      ...(consultCost !== undefined ? { consult_cost_usd: Math.round(consultCost * 1e6) / 1e6 } : {}),
    } : {}),
    over_cap: false,
  };
  if (cap !== undefined) { spend.cap_usd = cap; spend.over_cap = (cost ?? 0) >= cap; }
  return spend;
}

/** Dollars spent today (local date) on each worker, by the runs and consults the tool started or recorded today. */
export function spendToday(docs: readonly OrderDoc[], workers: readonly WorkerConfig[], probes: Probes, now: Date, storedOnly = false, stateDir?: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const doc of docs) for (const run of doc.runs) {
    if (!run.imported && new Date(run.started).toDateString() === now.toDateString()) {
      const owner = ownerOf(workers, run.worker);
      const cost = usageOf(run, workers, probes, storedOnly).cost_usd;
      if (owner && cost) out.set(owner.id, (out.get(owner.id) ?? 0) + cost);
    }
    for (const c of readRunConsults(stateDirOfRun(run, stateDir), doc.order.tag, run.id)) {
      if (c.outcome === 'refused' || !c.usage || new Date(c.at).toDateString() !== now.toDateString()) continue;
      const owner = ownerOf(workers, c.consultant);
      const cost = withCost(c.usage, owner?.price).cost_usd;
      if (owner && cost) out.set(owner.id, (out.get(owner.id) ?? 0) + cost);
    }
  }
  return out;
}
