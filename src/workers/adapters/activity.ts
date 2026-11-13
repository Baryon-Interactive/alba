import type { LiveActivity, LiveCurrent, LiveState, TokenCounts } from '../../api/live-types.ts';
import { claudeContent, eventText, toolResultText } from './claude-protocol.ts';
import { UsageFold, totalUsage } from './usage-fold.ts';
import { isLongCommand } from '../../run/loops.ts';
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' ? v as Record<string, any> : {};
const oneLine = (v: string): string => v.replace(/\s+/g, ' ').trim().slice(0, 500);
const counts = (u: Record<string, any>): TokenCounts => ({ input_tokens: number(u.input_tokens ?? u.input), cached_input_tokens: number(u.cached_input_tokens ?? u.cache_read_input_tokens ?? u.cache?.read), output_tokens: number(u.output_tokens ?? u.output) });

/** A bounded fold. Unknown events are liveness, never a parse failure. */
export class LiveFold {
  readonly accounting = new UsageFold();
  readonly state: LiveState = { phase: 'idle', recent: [], messages: [], usage: { ...counts({}), turns: 0, per_turn: [] }, files_changed: [], commands: 0, failed_commands: 0, long_command_seconds: 0 };
  private active = new Map<string, LiveCurrent>();
  private longDone = 0;
  private files = new Set<string>();
  readonly longCommands: readonly string[];
  constructor(longCommands: readonly string[] = []) { this.longCommands = longCommands; }

  event(raw: unknown, observedAt: string): void {
    const e = object(raw), item = object(e.item), part = object(e.part);
    if (!string(e.type)) return;
    const timestamp = e.timestamp;
    const at = string(e.alba_at) || (typeof timestamp === 'number' ? new Date(timestamp).toISOString() : string(timestamp)) || string(e.at) || observedAt;
    this.accounting.event(e, at);
    this.state.last_event_at = at;
    const type = string(e.type);
    if (type === 'turn.started' || type === 'step_start' || type === 'step-start') this.state.phase = 'thinking';
    if (type === 'turn.completed' || type === 'step_finish' || type === 'step-finish' || type === 'result' || type === 'end') {
      const usage = object(e.usage ?? part.tokens ?? e.tokenUsage);
      if (Object.keys(usage).length) {
        const c = counts(usage);
        this.state.usage.per_turn.push(c);
        this.state.usage.turns++;
        for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const) this.state.usage[k] += c[k];
      }
      this.state.phase = 'idle';
    }
    if (type === 'error' || type === 'turn.failed') this.add({ at, kind: 'error', summary: oneLine(string(e.message) || string(object(e.error).message) || JSON.stringify(e.error ?? e)) });
    if (type.startsWith('item.')) {
      const kind = string(item.type), id = string(item.id) || kind;
      if (kind === 'agent_message' && type === 'item.completed') this.message(at, string(item.text));
      else if (kind === 'todo_list') this.plan(item.items, at);
      else if (kind === 'file_change') {
        for (const f of Array.isArray(item.changes) ? item.changes : []) if (string(f.path)) this.files.add(f.path);
        this.state.files_changed = [...this.files];
        this.state.phase = type === 'item.completed' ? 'thinking' : 'editing_files';
        if (type === 'item.completed') this.add({ at, kind, summary: oneLine((item.changes ?? []).map((f: any) => `${f.kind ?? ''} ${f.path ?? ''}`).join(', ')) });
      } else if (kind === 'reasoning') this.state.phase = 'thinking';
      else if (['command_execution', 'mcp_tool_call', 'web_search'].includes(kind)) {
        const command = string(item.command) || [item.server, item.tool, item.query].filter(Boolean).join(' ');
        if (type === 'item.started') this.start(id, kind, command, at);
        else if (type === 'item.completed') this.end(id, kind, command, at, item.exit_code, item.status === 'failed', string(item.aggregated_output) || string(object(item.error).message));
      }
    }
    // OpenCode JSON stream: tool parts carry stable ids and the current status.
    if (type === 'tool_use') {
      const s = object(part.state), input = object(s.input), id = string(part.id) || string(part.callID) || string(part.tool);
      const command = string(input.command) || string(input.cmd) || `${part.tool ?? ''} ${input.filePath ?? input.path ?? ''}`;
      if (s.status === 'running' || s.status === 'pending') this.start(id, 'tool', command, at);
      else this.end(id, 'tool', command, at, object(s.metadata).exit, s.status === 'error', string(s.output) || string(s.error));
    }
    if (type === 'text') this.message(at, string(part.text) || string(e.text) || string(e.data));
    // Grok streaming-json.
    if (type === 'tool_call') {
      const input = object(e.rawInput);
      this.start(string(e.toolCallId), 'tool', string(input.command) || string(input.cmd) || `${e.toolName ?? ''} ${input.path ?? input.file_path ?? ''}`, at);
    }
    if (type === 'tool_call_update' && ['completed', 'failed'].includes(e.status)) {
      const output = object(e.rawOutput);
      this.end(string(e.toolCallId), 'tool', '', at, output.exit_code, e.status === 'failed' || output.timed_out, string(output.output_for_prompt));
    }
    if (type === 'message' || type === 'assistant') {
      const msg = object(e.message);
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c.type === 'text') this.message(at, string(c.text));
        if (c.type === 'tool_use') this.start(string(c.id), /bash|shell/i.test(string(c.name)) ? 'command_execution' : 'tool', string(object(c.input).command) || `${c.name ?? ''} ${object(c.input).file_path ?? ''}`, at);
      }
    }
    if (type === 'user') for (const c of claudeContent(e)) if (c.type === 'tool_result') this.end(string(c.tool_use_id), this.active.get(string(c.tool_use_id))?.kind ?? 'tool', '', at, undefined, !!c.is_error, toolResultText(c.content));
    if (type === 'result') {
      const text = eventText(e);
      if (text && this.state.messages.at(-1)?.text !== text) this.message(at, text);
    }
    if (type === 'assistant' || type === 'result') {
      const usage = totalUsage(this.accounting.turns);
      if (usage?.source === 'claude-json') this.state.usage = { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0, cached_input_tokens: usage.cached_tokens ?? 0, turns: usage.turns ?? 0, per_turn: this.accounting.turns.map(t => ({ input_tokens: t.usage.input_tokens ?? 0, output_tokens: t.usage.output_tokens ?? 0, cached_input_tokens: t.usage.cached_tokens ?? 0 })) };
    }
    if (type === 'content' && typeof e.content === 'string') this.message(at, e.content);
  }

  private add(a: LiveActivity): void { this.state.recent.push(a); this.state.recent = this.state.recent.slice(-30); }
  private message(at: string, text: string): void { if (!text) return; this.state.messages.push({ at, text }); this.state.messages = this.state.messages.slice(-10); this.add({ at, kind: 'message', summary: oneLine(text) }); }
  private plan(items: unknown, at: string): void {
    if (!Array.isArray(items)) return;
    const plan = items.map(i => ({ step: string(i.text ?? i.step), status: i.completed ? 'done' : string(i.status) || 'todo' })).filter(i => i.step);
    const done = plan.filter(i => ['done', 'completed'].includes(i.status)).length;
    this.state.plan = { plan, done, total: plan.length, current: plan.find(i => ['doing', 'in_progress'].includes(i.status))?.step ?? plan.find(i => i.status !== 'done')?.step, at };
  }
  private start(id: string, kind: string, command: string, at: string): void {
    if (this.active.has(id)) return;
    this.active.set(id, { id, kind, command, started_at: at, elapsed_seconds: 0 });
    this.state.phase = 'running_command';
    if (kind === 'command_execution' || /command|bash|shell/i.test(command)) this.state.commands++;
    if (/inbox\.md/i.test(command)) this.state.inbox_opened_at = at;
    this.add({ at, kind, summary: oneLine(command) });
  }
  private end(id: string, kind: string, command: string, at: string, code: unknown, failed: boolean, output: string): void {
    const current = this.active.get(id);
    const cmd = current?.command || command;
    const seconds = current ? Math.max(0, (Date.parse(at) - Date.parse(current.started_at)) / 1000) : 0;
    if (!current && (kind === 'command_execution' || /command|bash|shell/i.test(cmd))) this.state.commands++;
    const bad = failed || (typeof code === 'number' && code !== 0);
    if (bad && (kind === 'command_execution' || /command|bash|shell/i.test(cmd))) this.state.failed_commands++;
    if (isLongCommand(cmd, this.longCommands)) this.longDone += seconds;
    if (/inbox\.md/i.test(cmd)) this.state.inbox_opened_at = at;
    this.add({ at, kind, summary: oneLine(cmd), ...(typeof code === 'number' ? { exit_code: code } : bad ? { exit_code: -1 } : {}), duration_seconds: seconds, ...(bad && output ? { output_tail: output.split(/\r?\n/).slice(-20).join('\n') } : {}) });
    this.active.delete(id);
    this.state.phase = 'thinking';
  }

  view(now: Date): LiveState {
    const active = [...this.active.values()].map(c => ({ ...c, elapsed_seconds: Math.max(0, (now.getTime() - Date.parse(c.started_at)) / 1000) }));
    const current = active.at(-1);
    this.state.current = current;
    if (current) this.state.phase = isLongCommand(current.command, this.longCommands) ? 'waiting_long_command' : 'running_command';
    this.state.long_command_seconds = this.longDone + active.filter(c => isLongCommand(c.command, this.longCommands)).reduce((n, c) => n + c.elapsed_seconds, 0);
    return structuredClone(this.state);
  }
}

