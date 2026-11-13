import { claudeContent, toolResultText } from './claude-protocol.ts';

/** One thing a worker did: a command (or a tool call) and how it ended. */
export interface Action {
  /** The command with the shell wrapper taken off and blanks collapsed, or `<tool> <target>` for a tool that is not a command. */
  command: string;
  failed: boolean;
  /** For a failed action: what went wrong, boiled down so that the same error with other numbers compares equal. */
  error?: string;
  /** Milliseconds since 1970 when the engine says so (OpenCode); absent for the others. */
  at?: number;
}

export type LogFormat = 'codex' | 'codex-json' | 'stream' | 'opencode' | 'claude-json' | 'unknown';

export interface ParsedLog { format: LogFormat; actions: Action[]; /** Commands started (a count that does not need the results). */ started: number; /** The command that was started last and has no result yet (Codex logs only). */ open?: string }

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\[\?\d+[hl]|\]0;[^\n]*/g;
const RESULT = /^ (succeeded|exited -?\d+|failed|timed out)\b[^:]* in [\d.]+m?s:\s*$/;
const STAMP = /^20\d\d-\d\d-\d\dT[\d:.]+Z\s/;
const ERROR_WORDS = /error|fail|denied|refused|timed out|timeout|cannot|can't|not found|no such|exception|unable|fatal|invalid|unexpected|disconnect|closed/i;

export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Programs whose exit code 1 means "nothing found" or "they differ", an answer and not an error. */
const ANSWER_PROGRAMS = /^(?:&\s+)?(?:['"]?[^\s'"]*[\\/])?(?:grep|egrep|fgrep|rg|findstr|select-string|diff|cmp|test|\[)(?:\.exe)?['"]?(?:\s|$)/i;
/** A failed result, unless the command is one for which exit code 1 is an answer (and a pipeline's last word decides nothing here: only the first program is looked at). */
export const failedExit = (command: string, code: number | undefined, other: boolean): boolean => (code === undefined ? other : code !== 0 && !(code === 1 && ANSWER_PROGRAMS.test(command)));

/** The command without the shell wrapper and the trailing ` in <folder>` of a Codex log. */
export function codexCommandText(line: string): string {
  return squash(line.replace(/\s+in \S[^"]*$/, '').replace(/^"?[^"]*?(?:powershell|pwsh|bash|cmd)(?:\.exe)?"?\s+(?:-Command|-lc|\/c)\s+/i, '').replace(/^["']|["']$/g, ''));
}

/** An error line boiled down: no escape codes, no numbers, no case, the first 110 characters. */
export function errorSignature(output: string[], code?: number): string {
  const lines = output.map(l => l.replace(ANSI, '').trim()).filter(Boolean);
  const pick = lines.find(l => ERROR_WORDS.test(l)) ?? lines[0] ?? (code !== undefined ? `exit ${code}` : 'failed');
  return pick.toLowerCase().replace(/[0-9a-f]{7,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 110);
}

function parseCodex(text: string): ParsedLog {
  const lines = text.split(/\r?\n/);
  const pending: string[] = [];
  const actions: Action[] = [];
  let started = 0;
  const boundary = (l: string) => l === 'exec' || l === 'codex' || l === 'thinking' || l === 'user' || /^tokens used/.test(l) || STAMP.test(l);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'exec' && i + 1 < lines.length) { pending.push(codexCommandText(lines[i + 1])); started++; i++; continue; }
    const m = RESULT.exec(lines[i]);
    if (!m) continue;
    const command = pending.shift();
    const out: string[] = [];
    for (let j = i + 1; j < lines.length && !boundary(lines[j]) && out.length < 400; j++) out.push(lines[j]);
    if (command === undefined) continue;
    const word = m[1];
    const code = /^exited (-?\d+)/.exec(word)?.[1];
    const failed = failedExit(command, code === undefined ? undefined : Number(code), word !== 'succeeded');
    actions.push({ command, failed, ...(failed ? { error: errorSignature(out, code === undefined ? undefined : Number(code)) } : {}) });
  }
  return { format: 'codex', actions, started, ...(pending.length ? { open: pending.at(-1) } : {}) };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function toolLine(name: string, input: Record<string, unknown> | undefined): string {
  const command = text(input?.command) || text(input?.cmd);
  if (command) return squash(command);
  const target = text(input?.target_file) || text(input?.filePath) || text(input?.file_path) || text(input?.path) || text(input?.pattern) || text(input?.url);
  return squash(`${name} ${target}`);
}

/** Grok CLI (`streaming-json`): `tool_call` names the call, `tool_call_update` brings the output and the exit code. */
function parseStream(events: Record<string, unknown>[]): ParsedLog {
  const calls = new Map<string, { command: string; order: number }>();
  const done = new Map<string, Action>();
  let n = 0;
  for (const e of events) {
    const id = text(e.toolCallId);
    if (e.type === 'tool_call' && id) { calls.set(id, { command: toolLine(text(e.toolName) || text(e.title), e.rawInput as Record<string, unknown> | undefined), order: n++ }); continue; }
    if (e.type !== 'tool_call_update' || !id || !calls.has(id)) continue;
    const raw = e.rawOutput as { exit_code?: unknown; output_for_prompt?: unknown; timed_out?: unknown } | null | undefined;
    const status = text(e.status);
    const content = (e.content as { content?: { text?: unknown } }[] | undefined)?.map(c => text(c?.content?.text)).join('\n') ?? '';
    const code = typeof raw?.exit_code === 'number' ? raw.exit_code : undefined;
    const command = calls.get(id)!.command;
    const failed = status === 'failed' || raw?.timed_out === true || failedExit(command, code, false);
    if (code === undefined && status !== 'failed' && status !== 'completed') continue;       // an update that is not the end of the call
    done.set(id, { command: calls.get(id)!.command, failed, ...(failed ? { error: errorSignature(`${text(raw?.output_for_prompt)}\n${content}`.split(/\r?\n/), code) } : {}) });
  }
  const actions = [...done.entries()].sort((a, b) => calls.get(a[0])!.order - calls.get(b[0])!.order).map(([, a]) => a);
  return { format: 'stream', actions, started: calls.size };
}

/** OpenCode (`--format json`): a `tool_use` event holds the tool, its input, its status and (for a command) the exit code. */
function parseOpenCode(events: Record<string, unknown>[]): ParsedLog {
  const actions: Action[] = [];
  let started = 0;
  for (const e of events) {
    const part = e.part as { type?: unknown; tool?: unknown; state?: { status?: unknown; input?: Record<string, unknown>; output?: unknown; error?: unknown; metadata?: { exit?: unknown } } } | undefined;
    if (e.type !== 'tool_use' || !part) continue;
    started++;
    const state = part.state;
    const status = text(state?.status);
    if (status && status !== 'completed' && status !== 'error') continue;
    const exit = typeof state?.metadata?.exit === 'number' ? state.metadata.exit : undefined;
    const failed = status === 'error' || failedExit(toolLine(text(part.tool), state?.input), exit, false);
    const at = typeof e.timestamp === 'number' ? e.timestamp : undefined;
    actions.push({ command: toolLine(text(part.tool), state?.input), failed, ...(failed ? { error: errorSignature(`${text(state?.error)}\n${text(state?.output)}`.split(/\r?\n/), exit) } : {}), ...(at !== undefined ? { at } : {}) });
  }
  return { format: 'opencode', actions, started };
}

/** Reads the actions out of a worker's log, whichever engine wrote it (the shape of the log tells). Anything unknown has no actions. */
export function parseActions(logText: string): ParsedLog {
  const head = logText.slice(0, 20000);
  if (/^exec\r?$/m.test(logText) || /^OpenAI Codex /m.test(head)) return parseCodex(logText);
  const events: Record<string, unknown>[] = [];
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try { const v = JSON.parse(line) as unknown; if (typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string') events.push(v as Record<string, unknown>); } catch { /* a line cut in the middle */ }
  }
  if (events.some(e => e.type === 'tool_use' || e.type === 'step_start' || e.type === 'step-start')) return parseOpenCode(events);
  if (events.some(e => String(e.type).startsWith('item.') || e.type === 'thread.started')) {
    const active = new Map<string, string>();
    const actions: Action[] = [];
    let started = 0;
    for (const e of events) {
      const item = e.item as Record<string, unknown> | undefined;
      if (item?.type !== 'command_execution') continue;
      const id = text(item.id), command = squash(text(item.command));
      if (e.type === 'item.started') { active.set(id, command); started++; }
      if (e.type !== 'item.completed') continue;
      if (!active.has(id)) started++;
      active.delete(id);
      const code = typeof item.exit_code === 'number' ? item.exit_code : undefined;
      const failed = failedExit(command, code, item.status === 'failed');
      actions.push({ command, failed, ...(failed ? { error: errorSignature(text(item.aggregated_output).split(/\r?\n/), code) } : {}), ...(typeof e.alba_at === 'string' ? { at: Date.parse(e.alba_at) } : {}) });
    }
    return { format: 'codex-json', actions, started, ...(active.size ? { open: [...active.values()].at(-1) } : {}) };
  }
  if (events.some(e => e.type === 'tool_call')) return parseStream(events);
  if (events.some(e => e.type === 'assistant' || e.type === 'user')) {
    const calls = new Map<string, string>(), active = new Map<string, string>(), done = new Map<string, Action>();
    for (const e of events) for (const c of claudeContent(e)) {
      if (e.type === 'assistant' && c.type === 'tool_use' && typeof c.id === 'string') {
        const command = toolLine(text(c.name), c.input);
        calls.set(c.id, command); active.set(c.id, command);
      }
      if (e.type === 'user' && c.type === 'tool_result' && calls.has(c.tool_use_id)) {
        const command = calls.get(c.tool_use_id)!;
        const failed = c.is_error === true;
        done.set(c.tool_use_id, { command, failed, ...(failed ? { error: errorSignature(toolResultText(c.content).split(/\r?\n/)) } : {}) });
        active.delete(c.tool_use_id);
      }
    }
    return { format: 'claude-json', started: calls.size, actions: [...calls.keys()].flatMap(id => done.has(id) ? [done.get(id)!] : []), ...(active.size ? { open: [...active.values()].at(-1) } : {}) };
  }
  return { format: 'unknown', actions: [], started: 0 };
}

/**
 * Stretches of a Codex log in which the engine's own timestamped lines kept coming (so the log grew) but no new command was started,
 * for `minutes` or more. Only for finished logs and for reading what happened: the tick uses growth between two looks instead.
 */
export function idleStretches(logText: string, minutes: number): { minutes: number; line: number; at: string; command: string }[] {
  const lines = logText.split(/\r?\n/);
  let stamp: number | undefined;
  const starts: { line: number; at: number; command: string }[] = [];
  const stamps: { line: number; at: number }[] = [];
  lines.forEach((l, i) => {
    const m = /^(20\d\d-\d\d-\d\dT[\d:.]+Z)\s/.exec(l);
    if (m) { stamp = Date.parse(m[1]); stamps.push({ line: i, at: stamp }); }
    if (l === 'exec' && stamp !== undefined) starts.push({ line: i, at: stamp, command: codexCommandText(lines[i + 1] ?? '') });
  });
  const out: { minutes: number; line: number; at: string; command: string }[] = [];
  const endAt = stamps.at(-1)?.at;
  starts.forEach((s, k) => {
    const next = starts[k + 1];
    const until = next ? next.at : endAt;
    if (until === undefined) return;
    const m = (until - s.at) / 60000;
    const grew = stamps.some(x => x.line > s.line && (!next || x.line < next.line));
    if (m >= minutes && grew) out.push({ minutes: Math.round(m), line: s.line + 1, at: new Date(s.at).toISOString(), command: s.command });
  });
  return out;
}
