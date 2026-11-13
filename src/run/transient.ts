/** Retries after errors that usually go away by themselves (an overloaded model service, a dropped connection). */
export const MAX_RESUMES = 3;
/** Minutes to wait before resume number 1, 2, 3. */
export const BACKOFF_MINUTES = [1, 5, 15] as const;

const PATTERNS: RegExp[] = [
  /model (?:is )?at capacity/i,
  /\b429\b/,
  /too many requests/i,
  /\b(?:HTTP|status|error|code)\D{0,12}5\d\d\b/i,
  /\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EPIPE)\b/,
  /connection (?:was )?(?:reset|closed|refused)|stream (?:disconnected|closed)|error sending request|Reconnecting\.\.\./i,
  /overloaded/i,
];

/** A usage window or balance that is used up (not a hiccup: it lasts until the window resets). */
const LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i, /hit your (?:usage |rate )?limit/i, /limit (?:has been )?reached/i, /(?:5|five)[- ]hour limit/i, /weekly limit/i,
  /insufficient[_ ]quota/i, /exceeded your current quota/i, /quota (?:exceeded|exhausted|used up)/i, /out of (?:credits|quota)/i, /billing hard limit/i,
];

/** How many of the last non-empty log lines are looked at: a hiccup in the middle of a long run is not why it ended. */
const TAIL_LINES = 15;

/** Only error events are classifier input; a command quoting an old error must not trigger a retry. */
export function eventErrors(events: string): string {
  return events.split(/\r?\n/).flatMap(line => {
    try {
      const e = JSON.parse(line);
      return e.type === 'error' || e.type === 'turn.failed' ? [typeof e.message === 'string' ? e.message : JSON.stringify(e.error ?? e)] : [];
    } catch { return []; }
  }).slice(-TAIL_LINES).join('\n');
}

/** Whether the service says the conversation can no longer be continued. */
export function isLostSessionError(logTail: string): boolean {
  const tail = logTail.split('\n').filter(line => line.trim()).slice(-TAIL_LINES).join('\n');
  // Codex: `thread/resume failed: no rollout found for thread id ...`; Claude Code: `No conversation found with session ID: ...`.
  return /CLIENT_TOOL_CONTINUATION_UNAVAILABLE/i.test(tail) || /conversation state; start a new conversation/i.test(tail)
    || /no rollout found for thread id/i.test(tail) || /No conversation found with session ID/i.test(tail);
}

/** Does the very end of a worker's log look like a transient service error? */
export function isTransientError(logTail: string): boolean {
  logTail = logTail.split(/\r?\n/).filter(line => !line.trim().startsWith('{')).join('\n') + '\n' + eventErrors(logTail);
  // Optional local tool servers print connection errors all the time (rmcp), and Codex logs harmless ERROR lines about its own bookkeeping; those say nothing about the model service.
  const lines = logTail.split('\n').filter(line => line.trim() && !/rmcp::transport|ignoring unrecognized|unrecognized configuration|OutputTextDelta without active item|failed to refresh available models/i.test(line));
  const tail = lines.slice(-TAIL_LINES).join('\n');
  return isLostSessionError(tail) || PATTERNS.some(p => p.test(tail));
}

/** Does the very end of a worker's log say its usage window or balance is used up? */
export function isLimitError(logTail: string): boolean {
  logTail = logTail.split(/\r?\n/).filter(line => !line.trim().startsWith('{')).join('\n') + '\n' + eventErrors(logTail);
  const lines = logTail.split('\n').filter(line => line.trim() && !/rmcp::transport|ignoring unrecognized|unrecognized configuration|OutputTextDelta without active item|failed to refresh available models/i.test(line));
  return LIMIT_PATTERNS.some(p => p.test(lines.slice(-TAIL_LINES).join('\n')));
}

/** Minutes to wait before the next automatic resume, given how many transient failures happened in a row (1-based). */
export function backoffMinutes(failures: number, maxResumes = MAX_RESUMES, backoff: readonly number[] = BACKOFF_MINUTES): number | undefined {
  if (failures < 1 || failures > maxResumes || !backoff.length) return undefined;
  return backoff[Math.min(failures, backoff.length) - 1];
}
