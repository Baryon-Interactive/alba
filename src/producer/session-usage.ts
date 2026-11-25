import type { ProjectConfig } from '../config.ts';
import { readStateJson, stateTransaction, writeStateFile } from '../orders/state-files.ts';
import { audit } from './producer.ts';
import { agyEvent, type AgyUsage } from '../workers/adapters/agy-protocol.ts';

export interface SessionUsage {
  /** Total prompt tokens, including both cache categories (aggregate across cache categories). */
  input_tokens: number; output_tokens: number; total_tokens: number;
  uncached_input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
  /** Last model request's prompt, never the sum across requests. */
  context_tokens?: number;
}
export const emptyUsage = (): SessionUsage => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
export interface ModelUsage {
  engine: string; model: string; requests: number;
  uncachedInput: number; cacheRead: number; cacheWrite: number; output: number;
  cacheHitRate: number; costUsd: number; unpricedTokens: number;
}
export interface DailyModelUsage extends ModelUsage { day: string }
export interface DailyBudget {
  hour: string; hourTurns: number; day: string; dayTurns: number; dayUsage: number;
  uncachedInput: number; cacheRead: number; cacheWrite: number; output: number; costUsd: number; unpricedTokens: number;
  warned?: boolean;
  models?: ModelUsage[];
}
export const BUDGET = '_producer-session-budget.json';
export function budgetState(project: ProjectConfig, now = new Date()): DailyBudget {
  const day = now.toISOString().slice(0, 10), hour = now.toISOString().slice(0, 13);
  const empty: DailyBudget = { day, hour, hourTurns: 0, dayTurns: 0, dayUsage: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, unpricedTokens: 0 };
  const old = readStateJson<DailyBudget>(project, BUDGET, empty);
  return { ...empty, ...(old.day === day ? old : {}), hour, hourTurns: old.hour === hour ? old.hourTurns : 0 };
}
const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
/** Codex output_tokens already includes reasoning_output_tokens; never charge it twice. */
function codexUsage(u: Record<string, unknown>): SessionUsage {
  const input = count(u.input_tokens ?? u.inputTokens), read = Math.min(input, count(u.cached_input_tokens ?? u.cachedInputTokens));
  const output = Math.max(count(u.output_tokens ?? u.outputTokens), count(u.reasoning_output_tokens ?? u.reasoningOutputTokens));
  return { input_tokens: input, output_tokens: output, total_tokens: input + output, uncached_input_tokens: input - read, cache_read_input_tokens: read, cache_creation_input_tokens: 0 };
}
/** Claude input excludes cached tokens. Only complete assistant messages are requests; result is a cumulative envelope. */
export function requestUsage(raw: Record<string, unknown>): SessionUsage | undefined {
  if (raw.type === 'turn.completed' && raw.usage) {
    const usage = codexUsage(raw.usage as Record<string, unknown>);
    if (raw.last_token_usage) usage.context_tokens = codexUsage(raw.last_token_usage as Record<string, unknown>).input_tokens;
    return usage;
  }
  if (raw.type === 'token_count' || raw.type === 'event_msg') {
    const payload = (raw.payload ?? raw) as { type?: string; info?: { last_token_usage?: Record<string, unknown>; total_token_usage?: Record<string, unknown> } };
    if (payload.type === 'token_count' && payload.info?.total_token_usage) { const usage = codexUsage(payload.info.total_token_usage); if (payload.info.last_token_usage) usage.context_tokens = codexUsage(payload.info.last_token_usage).input_tokens; return usage; }
  }
  if (raw.method === 'thread/tokenUsage/updated') {
    const token = (raw.params as { tokenUsage?: { total?: Record<string, unknown>; last?: Record<string, unknown> } })?.tokenUsage;
    if (token?.total) { const usage = codexUsage(token.total); if (token.last) usage.context_tokens = codexUsage(token.last).input_tokens; return usage; }
  }
  const agy = agyEvent(raw);
  if (agy) return agy.kind === 'step' && agy.step.type === 'agent_response' && agy.step.state === 'DONE' && agy.step.usage ? agyParts(agy.step.usage) : undefined;
  if (raw.type !== 'assistant') return;
  const message = raw.message as { usage?: Record<string, unknown> } | undefined;
  const u = message?.usage;
  return u ? claudeParts(u) : undefined;
}
/**
 * Antigravity: each finished agent_response step is one model request. Its input_tokens exclude the cache read and its
 * output_tokens already include thinking_tokens. A result's usage is the running total of the whole process, never charged.
 */
const agyParts = (u: AgyUsage): SessionUsage => {
  const uncached = count(u.input_tokens), read = count(u.cache_read_tokens), output = count(u.output_tokens), input = uncached + read;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output, uncached_input_tokens: uncached, cache_read_input_tokens: read, cache_creation_input_tokens: 0, context_tokens: input };
};
const claudeParts = (u: Record<string, unknown>): SessionUsage => {
  const uncached = count(u.input_tokens), read = count(u.cache_read_input_tokens), write = count(u.cache_creation_input_tokens), output = count(u.output_tokens);
  const input = uncached + read + write;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output, uncached_input_tokens: uncached, cache_read_input_tokens: read, cache_creation_input_tokens: write, context_tokens: input };
};
/** The message being streamed by each request map (Claude stream events carry the id only at message_start). */
const streaming = new WeakMap<Map<string, SessionUsage>, { id: string; start: Record<string, unknown> }>();
/**
 * Claude with `--include-partial-messages`: the usage at `message_start` (also copied into every `assistant` event)
 * is provisional. It has no output tokens, and some gateways put an estimate there that differs from what they bill.
 * The `message_delta` at the end of the message carries the final usage. A streamed message is charged from it
 * alone; a message without stream events is charged from its `assistant` events as before.
 */
function streamedUsage(raw: Record<string, unknown>, previous: Map<string, SessionUsage>): { id: string; usage: SessionUsage } | null | undefined {
  if (raw.type === 'stream_event') {
    const event = raw.event as { type?: string; message?: { id?: string; usage?: Record<string, unknown> }; usage?: Record<string, unknown> } | undefined;
    if (event?.type === 'message_start' && event.message?.id) { streaming.set(previous, { id: event.message.id, start: event.message.usage ?? {} }); previous.set(`stream:${event.message.id}`, emptyUsage()); return null; }
    if (event?.type === 'message_delta' && event.usage) {
      const current = streaming.get(previous);
      if (!current) return null;
      return { id: current.id, usage: claudeParts({ ...current.start, ...Object.fromEntries(Object.entries(event.usage).filter(([, v]) => typeof v === 'number')) }) };
    }
    return null;
  }
  if (raw.type === 'assistant' && previous.has(`stream:${(raw.message as { id?: string } | undefined)?.id}`)) return null;
  return undefined;
}
/** Some engines repeat one assistant message id for multiple content blocks. Charge only positive deltas. */
export function requestDelta(raw: Record<string, unknown>, previous: Map<string, SessionUsage>): { id: string; usage: SessionUsage } | undefined {
  const streamed = streamedUsage(raw, previous);
  if (streamed === null) return undefined;
  const full = streamed?.usage ?? requestUsage(raw);
  if (!full) return;
  const cumulative = raw.type === 'turn.completed' || raw.method === 'thread/tokenUsage/updated' || raw.type === 'token_count' || raw.type === 'event_msg';
  const params = raw.params as { threadId?: string } | undefined;
  const agy = agyEvent(raw);
  const id = agy?.kind === 'step' ? `agy:${agy.step.conversationId ?? ''}:${agy.step.index}` : streamed ? streamed.id : cumulative ? `codex-cumulative:${raw.thread_id ?? params?.threadId ?? 'thread'}` : String(raw.request_id ?? (raw.message as { id?: string } | undefined)?.id ?? `request-${previous.size}`), old = previous.get(id);
  previous.set(id, full);
  const usage = { ...full };
  // A provider may restart cumulative totals after resume/compaction. Charge the fresh total.
  const reset = cumulative && old && (full.input_tokens < old.input_tokens || full.output_tokens < old.output_tokens);
  if (old && !reset) for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'uncached_input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) usage[key] = Math.max(0, (full[key] ?? 0) - (old[key] ?? 0));
  return { id: cumulative ? `${id}:${full.total_tokens}` : id, usage };
}
export function usageParts(u: Partial<SessionUsage>) {
  const read = count(u.cache_read_input_tokens), write = count(u.cache_creation_input_tokens), output = count(u.output_tokens);
  const input = u.uncached_input_tokens === undefined ? Math.max(0, count(u.input_tokens) - read - write) : count(u.uncached_input_tokens);
  // Some provider protocols report only total_tokens; preserve their budget meaning.
  return { input: u.input_tokens === undefined && u.uncached_input_tokens === undefined ? Math.max(0, count(u.total_tokens) - read - write - output) : input, read, write, output };
}
export function billedEquivalent(project: ProjectConfig, u: Partial<SessionUsage>): number {
  const p = usageParts(u);
  return p.input + p.write + p.output + p.read * (project.producer.budgets.cache_read_weight ?? .1);
}
export function addUsage(total: SessionUsage, u: Partial<SessionUsage>): void {
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'uncached_input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    if (u[key] !== undefined) total[key] = (total[key] ?? 0) + count(u[key]);
  }
  if (u.context_tokens !== undefined) total.context_tokens = u.context_tokens;
}
export function budgetProblem(project: ProjectConfig, budget = budgetState(project)): string | undefined {
  const limits = project.producer.budgets;
  if ((limits.usage_per_day !== undefined && budget.dayUsage >= limits.usage_per_day * .8) || (limits.cost_per_day_usd !== undefined && budget.costUsd >= limits.cost_per_day_usd * .8)) return 'Producer daily budget is at 80% or above.';
}
export function dayBudgetExhausted(project: ProjectConfig, budget = budgetState(project)): boolean {
  return (project.producer.budgets.usage_per_day !== undefined && budget.dayUsage >= project.producer.budgets.usage_per_day) || (project.producer.budgets.cost_per_day_usd !== undefined && budget.costUsd >= project.producer.budgets.cost_per_day_usd);
}
/** Called once per completed model request, including work sessions. Durable per-day history records each model request. */
export function modelUsage(project: ProjectConfig, usage: Partial<SessionUsage>, model: string | undefined, engine: string, requests = 1): ModelUsage {
  const p = usageParts(usage), price = model ? project.producer.model_prices?.[model] : undefined, input = p.input + p.read + p.write;
  return { engine, model: model ?? 'unknown', requests, uncachedInput: p.input, cacheRead: p.read, cacheWrite: p.write, output: p.output, cacheHitRate: input ? p.read / input : 0,
    costUsd: price ? (p.input * price.input + p.read * price.cache_read + p.write * price.cache_write + p.output * price.output) / 1e6 : 0, unpricedTokens: price ? 0 : input + p.output };
}
export function recordRequestUsage(project: ProjectConfig, usage: Partial<SessionUsage>, model = project.producer.session.model, now = new Date(), engine: string = project.producer.session.engine): DailyBudget {
  return stateTransaction(project, () => {
    const b = budgetState(project, now), p = usageParts(usage), price = model ? project.producer.model_prices?.[model] : undefined;
    b.dayUsage += billedEquivalent(project, usage);
    b.uncachedInput += p.input; b.cacheRead += p.read; b.cacheWrite += p.write; b.output += p.output;
    if (price) b.costUsd += (p.input * price.input + p.read * price.cache_read + p.write * price.cache_write + p.output * price.output) / 1_000_000;
    else b.unpricedTokens += p.input + p.read + p.write + p.output;
    const item = modelUsage(project, usage, model, engine);
    const models = b.models ??= [], existing = models.find(m => m.engine === item.engine && m.model === item.model);
    if (!existing) models.push(item);
    else {
      for (const key of ['requests', 'uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'costUsd', 'unpricedTokens'] as const) existing[key] += item[key];
      const input = existing.uncachedInput + existing.cacheRead + existing.cacheWrite;
      existing.cacheHitRate = input ? existing.cacheRead / input : 0;
    }
    if (!b.warned && budgetProblem(project, b)) { b.warned = true; audit(project, { kind: 'budget-warning', reason: 'Producer daily budget is at 80% or above.' }); }
    writeStateFile(project, BUDGET, JSON.stringify(b) + '\n');
    const history = readStateJson<Record<string, DailyBudget>>(project, '_producer-usage-days.json', {});
    history[b.day] = b;
    writeStateFile(project, '_producer-usage-days.json', JSON.stringify(history) + '\n');
    return b;
  });
}

/** Stored UTC history only. Unattributed totals stay spent without fabricated model attribution. */
export function producerUsage(project: ProjectConfig, days = 7, now = new Date()): DailyModelUsage[] {
  if (!Number.isInteger(days) || days < 1) throw new Error('Producer usage days must be a whole number >= 1.');
  const start = new Date(now); start.setUTCDate(start.getUTCDate() - days + 1);
  const first = start.toISOString().slice(0, 10), last = now.toISOString().slice(0, 10);
  const history = readStateJson<Record<string, DailyBudget>>(project, '_producer-usage-days.json', {});
  return Object.entries(history).filter(([day]) => day >= first && day <= last).sort(([a], [b]) => b.localeCompare(a)).flatMap(([day, value]) => (value.models ?? []).map(row => ({ day, ...row })));
}
