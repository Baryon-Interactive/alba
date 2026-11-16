/**
 * The Antigravity CLI (`agy -p ... --output-format stream-json`) prints one JSON object per line keyed by `event`, not `type`:
 *   {"event":"init","conversation_id":"...","init":{"model":"...","cwd":"...","tools":[...]}}
 *   {"event":"step_update","step_update":{"conversation_id":"...","step_index":2,"state":"ACTIVE"|"DONE"|...,"step_type":"tool"|"agent_response"|"user_input"|"error_message",
 *     "tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"..."},"output":"..."},"text_delta":"...","usage":{...}}}
 *   {"event":"result","result":{"conversation_id":"...","status":"SUCCESS"|"ERROR","response":"...","error":"...","num_turns":1,"usage":{...}}}
 * (agy 1.4.3 to 1.5.9). The conversation id resumes the run with `--conversation <id>`.
 */
export interface AgyUsage { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number; total_tokens?: number }
export interface AgyStep { conversationId?: string; index: number; state: string; type: string; tool?: string; target?: string; command?: string; output?: string; textDelta?: string; usage?: AgyUsage }
export interface AgyResult { conversationId?: string; status: string; response: string; error: string; turns?: number; usage?: AgyUsage }
export type AgyEvent = { kind: 'init'; conversationId?: string; model?: string } | { kind: 'step'; step: AgyStep } | { kind: 'result'; result: AgyResult } | { kind: 'other' };

const str = (v: unknown): string => typeof v === 'string' ? v : '';
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const usage = (v: unknown): AgyUsage | undefined => { const u = obj(v); return Object.keys(u).length ? u as AgyUsage : undefined; };

/** An agy line (already parsed), or undefined for anything else (Claude, Codex, Grok and OpenCode events all have `type`). */
export function agyEvent(raw: unknown): AgyEvent | undefined {
  const e = obj(raw);
  if (typeof e.type === 'string' || typeof e.event !== 'string') return undefined;
  if (e.event === 'init') return { kind: 'init', conversationId: str(e.conversation_id) || undefined, model: str(obj(e.init).model) || undefined };
  if (e.event === 'step_update') {
    const s = obj(e.step_update), info = obj(s.tool_info), p = obj(info.parameters);
    const tool = str(s.tool_name) || str(info.name) || undefined;
    const target = str(p.CommandLine) || str(p.Path) || str(p.AbsolutePath) || str(p.TargetFile) || str(p.Query) || str(p.Url) || str(p.Action);
    const command = tool === 'run_command' && str(p.CommandLine) ? str(p.CommandLine) : tool ? `${tool} ${target}`.trim() : undefined;
    return { kind: 'step', step: { conversationId: str(s.conversation_id) || undefined, index: typeof s.step_index === 'number' ? s.step_index : -1, state: str(s.state), type: str(s.step_type), tool, target: target || undefined, command, output: typeof info.output === 'string' ? info.output : undefined, textDelta: typeof s.text_delta === 'string' ? s.text_delta : undefined, usage: usage(s.usage) } };
  }
  if (e.event === 'result') {
    const r = obj(e.result);
    return { kind: 'result', result: { conversationId: str(r.conversation_id) || undefined, status: str(r.status), response: str(r.response) || str(r.result), error: str(r.error), turns: typeof r.num_turns === 'number' ? r.num_turns : undefined, usage: usage(r.usage) } };
  }
  return { kind: 'other' };
}

/** Parses one log line as an agy event. */
export function agyLine(line: string): AgyEvent | undefined {
  const text = line.trim();
  if (!text.startsWith('{')) return undefined;
  try { return agyEvent(JSON.parse(text)); } catch { return undefined; }
}

/** The error of an agy result line that did not succeed (for the transient/limit classifiers, which read only error events). */
export const agyResultError = (e: AgyEvent | undefined): string | undefined => e?.kind === 'result' && e.result.status !== 'SUCCESS' && e.result.error ? e.result.error : undefined;

/** Why an agy run could not work at all, from its error text (stderr and the result's error). Order matters: a quota message may also say 429. */
export type AgyFailureKind = 'region' | 'auth' | 'model' | 'quota';
export function agyFailureKind(text: string): AgyFailureKind | undefined {
  // Seen 2026-10-20: the proxy exit node drifted to a region Gemini does not serve; it worked again once the node moved back.
  if (/location is not supported/i.test(text)) return 'region';
  if (/not signed in|not logged in|authentication required|login required|sign[- ]in required|please (?:sign|log) in|UNAUTHENTICATED/i.test(text)) return 'auth';
  // agy 1.5.x: `invalid model selection (--model "x" ...): model x is not recognized as a known model or custom model in settings`
  if (/invalid model selection|not recognized as a known model|unknown model|model \S+ (?:is )?not (?:found|available|supported)/i.test(text)) return 'model';
  if (/quota|daily limit|usage limit|exhausted your capacity/i.test(text)) return 'quota';
  return undefined;
}
