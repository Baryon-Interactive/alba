import { claudeContent, eventText } from './claude-protocol.ts';

/**
 * Reads the log of a headless run of an agent CLI that prints newline-delimited JSON events
 * (`--output-format streaming-json`) on stdout and its own messages on stderr, both in one log file.
 * Only lines that parse as JSON with a `type` count as events; everything else is a message.
 */
export interface StreamLog {
  events: number;
  sessionId?: string;
  /** `end.stopReason`: end_turn, max_turn_requests, refusal, cancelled, ... Absent when the process died before the end event. */
  stopReason?: string;
  turns?: number;
  costUsd?: number;
  tokens?: number;
  /** The split of `end.usage` when it has one. */
  usage?: { input?: number; output?: number; cached?: number };
  /** What the agent said after its last tool call: its final message. */
  finalText: string;
  /**
   * The last event is the engine's own end of the run: Codex `turn.completed` (`codex exec` runs one turn) or the `end` event.
   * Claude's `result` does not count: `claude -p` can start another turn for a background command's notification.
   */
  ended?: boolean;
  /** The command (or "Edit <file>") the run was not allowed to do: the engine refuses it, and the whole run stops there. */
  blockedCommand?: string;
  /** Messages of `error` events and plain (non-JSON) lines other than the permission note, oldest first. */
  errors: string[];
}

const PERMISSION = /^permission required: (?:(Execute|Edit|Write|Read) )?(.*?) was not run, as a headless run cannot ask for approval/;

export function parseStreamLog(text: string, options: { cut?: boolean } = {}): StreamLog {
  const log: StreamLog = { events: 0, errors: [], finalText: '' };
  // The tail of a long log starts in the middle of a line.
  for (const raw of text.split(/\r?\n/).slice(options.cut ? 1 : 0)) {
    const line = raw.trim();
    if (!line) continue;
    let event: Record<string, unknown> | undefined;
    if (line.startsWith('{')) {
      try { const v = JSON.parse(line) as unknown; if (typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string') event = v as Record<string, unknown>; } catch { /* not an event */ }
    }
    if (!event) {
      const blocked = PERMISSION.exec(line);
      if (blocked) log.blockedCommand = (blocked[1] && blocked[1] !== 'Execute' ? `${blocked[1]} ` : '') + blocked[2].replace(/^`|`$/g, '');
      else if (!line.startsWith('{')) log.errors.push(line);
      continue;
    }
    log.events++;
    log.ended = event.type === 'turn.completed' || event.type === 'end';
    if (typeof event.session_id === 'string') log.sessionId = event.session_id;
    if (event.type === 'assistant' && (event.message as { model?: string } | undefined)?.model !== '<synthetic>') {
      if (claudeContent(event).some(c => c.type === 'tool_use')) log.finalText = '';
      const text = eventText(event);
      if (text) log.finalText = text;
    }
    if (event.type === 'result') {
      const text = eventText(event);
      if (event.is_error === true) {
        log.finalText = '';
        log.errors.push(...(Array.isArray(event.errors) ? event.errors.filter((e): e is string => typeof e === 'string') : text ? [text] : []));
      } else if (text) log.finalText = text;
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') log.sessionId = event.thread_id;
    const item = event.item as { type?: string; text?: string } | undefined;
    if (event.type === 'item.started' && item?.type === 'command_execution') log.finalText = '';
    if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') log.finalText = item.text;
    if (event.type === 'tool_call') log.finalText = '';
    if (event.type === 'text' && typeof event.data === 'string') log.finalText += event.data;
    if (event.type === 'error' && typeof event.message === 'string') log.errors.push(event.message);
    if (event.type === 'end') {
      if (typeof event.sessionId === 'string') log.sessionId = event.sessionId;
      if (typeof event.stopReason === 'string') log.stopReason = event.stopReason;
      if (typeof event.num_turns === 'number') log.turns = event.num_turns;
      if (typeof event.total_cost_usd === 'number') log.costUsd = event.total_cost_usd;
      const usage = event.usage as { total_tokens?: unknown } | undefined;
      if (typeof usage?.total_tokens === 'number') log.tokens = usage.total_tokens;
      const split = event.usage as { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown } | undefined;
      if (split) log.usage = { input: typeof split.input_tokens === 'number' ? split.input_tokens : undefined, output: typeof split.output_tokens === 'number' ? split.output_tokens : undefined, cached: typeof split.cache_read_input_tokens === 'number' ? split.cache_read_input_tokens : undefined };
    }
  }
  return log;
}
