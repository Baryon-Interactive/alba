import { findLoops } from '../../run/loops.ts';
import { parseActions } from './actions.ts';
import { t } from '../../i18n.ts';
import type { RunUsage } from '../../api/types.ts';
import type { UsageSignal, WasteRules } from '../../usage/types.ts';
import { claudeContent, toolResultText } from './claude-protocol.ts';

const n = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
export interface Turn { turn: number; at: string; usage: RunUsage; raw: Record<string, unknown> }
export function totalUsage(turns: Turn[]): RunUsage | undefined {
  if (!turns.length) return;
  const result: RunUsage = { source: turns[0].usage.source, turns: turns.reduce((n,t) => n + (t.usage.turns ?? 1), 0) };
  for (const key of ['total_tokens', 'input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'reasoning_tokens', 'cost_usd'] as const) {
    const known = turns.map(t => t.usage[key]).filter(v => v !== undefined);
    if (known.length) result[key] = known.reduce((n,v) => n + v, 0);
  }
  return result;
}
export function tokenUsage(raw: Record<string, any>, source: RunUsage['source']): RunUsage {
  const input = n(raw.input_tokens ?? raw.input), output = n(raw.output_tokens ?? raw.output);
  const cached = n(raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? raw.cache?.read);
  const write = n(raw.cache_creation_input_tokens ?? raw.cache_write_input_tokens ?? raw.cache?.write);
  const reasoning = n(raw.reasoning_output_tokens ?? raw.reasoning_tokens ?? raw.reasoning ?? raw.output_tokens_details?.reasoning_tokens);
  // OpenCode and Claude report cache separately; Codex includes it in input, and reasoning in output.
  const total = n(raw.total_tokens ?? raw.total) ?? (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) + (source === 'opencode-json' || source === 'claude-json' || source === 'grok-end' ? (cached ?? 0) + (write ?? 0) + (source === 'opencode-json' ? reasoning ?? 0 : 0) : 0) : undefined);
  return { source: total === undefined ? 'unknown' : source, total_tokens: total, input_tokens: input, output_tokens: output, cached_tokens: cached, cache_write_tokens: write, reasoning_tokens: reasoning };
}

/** Fed by the live reader, so complete event lines are decoded once. Raw engine usage stays intact. */
export class UsageFold {
  turns: Turn[] = [];
  private commands: { turn: number; command: string; bytes: number; event: any }[] = [];
  private reads = new Map<string, number[]>();
  private committedTurn = 0;
  private committedTokens = 0;
  private pendingCommit = false;
  private active = new Map<string, string>();
  private seen = new Set<string>();
  private claudeMessages = new Map<string, Turn>();
  event(e: any, at: string): void {
    if (Number.isFinite(Date.parse(at))) at = new Date(at).toISOString();
    const p = e.part ?? {}, type = e.type;
    // Claude may emit several content blocks for one message, with updated usage.
    if (type === 'assistant' && e.message?.id) {
      const previous = this.claudeMessages.get(e.message.id);
      if (previous && e.message.usage) {
        const next = tokenUsage(e.message.usage, 'claude-json');
        for (const key of ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'total_tokens'] as const) if (next[key] !== undefined) previous.usage[key] = Math.max(previous.usage[key] ?? 0, next[key]!);
      }
    }
    // Result usage is cumulative: reconcile it with assistant usage, never add it a second time.
    if (type === 'result' && this.turns.some(t => t.usage.source === 'claude-json')) {
      const cumulative = tokenUsage(e.usage ?? {}, 'claude-json');
      const last = this.turns.at(-1)!;
      for (const key of ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'total_tokens'] as const) {
        const sum = this.turns.reduce((n, t) => n + (t.usage[key] ?? 0), 0);
        if (cumulative[key] !== undefined && cumulative[key]! > sum) last.usage[key] = (last.usage[key] ?? 0) + cumulative[key]! - sum;
      }
      if (n(e.total_cost_usd) !== undefined) last.usage.cost_usd = e.total_cost_usd;
    }
    let raw: Record<string, any> | undefined, source: RunUsage['source'] = 'unknown';
    if (type === 'turn.completed') { raw = e.usage; source = 'codex-json'; }
    if (/^step[-_]finish$/.test(type)) { raw = p.tokens ?? e.tokens; source = 'opencode-json'; }
    if (type === 'end') { raw = e.tokenUsage ?? e.usage; source = 'grok-end'; }
    if (type === 'assistant') { raw = e.message?.usage; source = 'claude-json'; }
    if (type === 'result' && !this.turns.length) { raw = e.usage; source = 'claude-json'; }
    const id = e.message?.id ?? p.id ?? e.id;
    if (raw && Object.keys(raw).length && (!id || !this.seen.has(id))) {
      if (id) this.seen.add(id);
      const usage = tokenUsage(raw, source);
      const cost = n(p.cost ?? e.cost ?? e.total_cost_usd ?? e.costUsd);
      if (cost !== undefined) usage.cost_usd = cost;
      if (n(e.num_turns) !== undefined) usage.turns = e.num_turns;
      this.turns.push({ turn: type === 'end' || type === 'result' ? 0 : this.turns.length + 1, at, usage, raw: structuredClone(raw) });
      if (source === 'claude-json' && e.message?.id) this.claudeMessages.set(e.message.id, this.turns.at(-1)!);
      if (this.pendingCommit) { this.committedTokens = this.turns.reduce((sum,t) => sum + (t.usage.total_tokens ?? 0), 0); this.pendingCommit = false; }
    }
    const item = e.item ?? {};
    if (type === 'assistant') for (const c of claudeContent(e)) if (c.type === 'tool_use') this.active.set(c.id, c.input?.command ?? c.input?.cmd ?? `${c.name ?? ''} ${c.input?.file_path ?? ''}`);
    if (type === 'user') for (const c of claudeContent(e)) if (c.type === 'tool_result' && this.active.has(c.tool_use_id)) {
      const command = this.active.get(c.tool_use_id)!;
      this.active.delete(c.tool_use_id);
      this.event({ type: 'item.completed', item: { type: 'command_execution', command, aggregated_output: toolResultText(c.content), exit_code: c.is_error ? 1 : 0 } }, at);
    }
    if (type === 'item.started' && item.type === 'command_execution') this.active.set(item.id, item.command ?? '');
    let command = '', output = '', done = false, failed = false;
    if (type === 'item.completed' && item.type === 'command_execution') { command = item.command ?? this.active.get(item.id) ?? ''; output = item.aggregated_output ?? ''; done = true; failed = typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed'; this.active.delete(item.id); }
    if (type === 'tool_use' && ['completed', 'error'].includes(p.state?.status)) { command = p.state.input?.command ?? `${p.tool ?? ''} ${p.state.input?.filePath ?? ''}`; output = p.state.output ?? p.state.error ?? ''; done = true; failed = p.state.status === 'error'; }
    if (type === 'tool_call') this.active.set(e.toolCallId, e.rawInput?.command ?? `${e.toolName ?? ''} ${e.rawInput?.path ?? ''}`);
    if (type === 'tool_call_update' && ['completed', 'failed'].includes(e.status)) { command = this.active.get(e.toolCallId) ?? ''; output = e.rawOutput?.output_for_prompt ?? ''; done = true; failed = e.status === 'failed' || !!e.rawOutput?.exit_code; this.active.delete(e.toolCallId); }
    if (done) {
      const turn = this.turns.length + 1;
      this.commands.push({ turn, command, bytes: Buffer.byteLength(output), event: { type: 'item.completed', item: { type: 'command_execution', command, aggregated_output: output.slice(-2000), exit_code: failed ? 1 : 0 } } });
      if (!failed && /\bgit\s+commit\b/.test(command)) { this.pendingCommit = true; this.committedTurn = turn; this.committedTokens = this.turns.reduce((sum, t) => sum + (t.usage.total_tokens ?? 0), 0); }
      const match = /(?:Get-Content(?:\s+-LiteralPath)?|cat|type|Read)\s+['"]?([^'"\s;|]+)/i.exec(command);
      if (match) { const list = this.reads.get(match[1]) ?? []; list.push(turn); this.reads.set(match[1], list); }
    }
  }
  signals(order: string, run: string, kind: string, rules: WasteRules = {}): UsageSignal[] {
    const out: UsageSignal[] = [], end = Math.max(1, this.turns.length);
    const add = (key: string, text: string, start = 1, last = end, more: Partial<UsageSignal> = {}) => out.push({ kind: key, order, run, turns: [start, last], text, ...more });
    const sum = (key: keyof RunUsage) => this.turns.reduce((v, t) => v + (typeof t.usage[key] === 'number' ? t.usage[key] as number : 0), 0);
    const total = sum('total_tokens'), input = sum('input_tokens') + this.turns.filter(t => ['opencode-json', 'claude-json', 'grok-end'].includes(t.usage.source)).reduce((n,t) => n + (t.usage.cached_tokens ?? 0) + (t.usage.cache_write_tokens ?? 0), 0), output = sum('output_tokens') + this.turns.filter(t => t.usage.source === 'opencode-json').reduce((n,t) => n + (t.usage.reasoning_tokens ?? 0), 0);
    if (total - this.committedTokens > (rules.tokens_without_commit ?? 1e6)) add('no-commit', t('Usage: {n} tokens since the last commit', { n: total - this.committedTokens }), this.committedTurn || 1);
    if (total > (rules.long_run_tokens ?? 1e6) && input > 0 && this.turns.some(t => t.usage.cached_tokens !== undefined) && sum('cached_tokens') / input < (rules.min_cached_share ?? .2)) add('low-cache', t('Usage: low cached share ({n}%)', { n: Math.round(100 * sum('cached_tokens') / input) }));
    for (const c of this.commands) if (c.bytes > (rules.command_output_bytes ?? 100000)) add('large-output', t('Usage: command returned {n} bytes: {command}', { n: c.bytes, command: c.command }), c.turn, c.turn, { command: c.command });
    for (const [file, turns] of this.reads) if (turns.length >= (rules.repeated_file_reads ?? 5)) add('repeated-read', t('Usage: file read {n} times: {file}', { n: turns.length, file }), turns[0], turns.at(-1), { file });
    // Reuse the loop detector on each consecutive streak; a successful command breaks the streak.
    const actions = parseActions(this.commands.map(c => JSON.stringify(c.event)).join('\n')).actions;
    const threshold = rules.failed_repeats ?? 3;
    for (let i = 0; i < actions.length;) {
      let j = i + 1;
      while (j < actions.length && actions[i].failed && actions[j].failed && actions[j].command === actions[i].command && actions[j].error === actions[i].error) j++;
      if (j - i >= threshold) for (const f of findLoops(actions.slice(i, j), { repeat: threshold, alternate: Infinity, longCommands: [] }).filter(f => f.kind === 'repeat')) add('failed-loop', f.text, this.commands[i].turn, this.commands[j - 1].turn, { command: f.command });
      i = j;
    }
    if (output > 0 && sum('reasoning_tokens') / output > (rules.reasoning_by_kind?.[kind] ?? rules.reasoning_share ?? .8)) add('reasoning', t('Usage: high reasoning share for {kind} ({n}%)', { kind, n: Math.round(100 * sum('reasoning_tokens') / output) }));
    return out;
  }
}
