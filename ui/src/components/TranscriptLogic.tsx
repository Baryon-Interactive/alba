import type { Run, TranscriptEdit, TranscriptEntry } from '@api';

export type TranscriptFilterCategory = 'all' | 'messages' | 'commands' | 'edits' | 'errors';
export type RunViewTab = 'transcript' | 'activity' | 'log';

export const TRANSCRIPT_CATEGORIES: readonly TranscriptFilterCategory[] = ['all', 'messages', 'commands', 'edits', 'errors'];

export const STRUCTURED_ENGINES: ReadonlySet<string> = new Set([
  'codex-cli',
  'claude-cli',
  'agy-cli',
  'opencode',
  'grok-cli',
]);

export const STRUCTURED_USAGE_SOURCES: ReadonlySet<string> = new Set([
  'codex-json',
  'claude-json',
  'agy-json',
  'opencode-json',
  'grok-end',
]);

export function matchesTranscriptCategory(entry: TranscriptEntry, category: TranscriptFilterCategory): boolean {
  switch (category) {
    case 'all':
      return true;
    case 'messages':
      return entry.kind === 'message' || entry.kind === 'result';
    case 'commands':
      return entry.kind === 'command';
    case 'edits':
      return entry.kind === 'edit';
    case 'errors':
      return entry.kind === 'error' || entry.state === 'failed';
  }
}

export function matchesTranscriptQuery(entry: TranscriptEntry, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  if (entry.title.toLowerCase().includes(q)) return true;
  if (entry.text?.toLowerCase().includes(q)) return true;
  if (entry.output?.toLowerCase().includes(q)) return true;
  if (entry.edit?.some(e => e.path.toLowerCase().includes(q) || e.diff?.toLowerCase().includes(q))) return true;
  if (entry.plan?.some(p => p.step.toLowerCase().includes(q))) return true;
  return false;
}

export function filterTranscriptEntries(
  entries: readonly TranscriptEntry[],
  category: TranscriptFilterCategory,
  query: string,
): TranscriptEntry[] {
  if (category === 'all' && !query.trim()) return entries as TranscriptEntry[];
  return entries.filter(e => matchesTranscriptCategory(e, category) && matchesTranscriptQuery(e, query));
}

export function countTranscriptCategories(entries: readonly TranscriptEntry[]): Record<TranscriptFilterCategory, number> {
  const counts: Record<TranscriptFilterCategory, number> = {
    all: entries.length,
    messages: 0,
    commands: 0,
    edits: 0,
    errors: 0,
  };
  for (const e of entries) {
    if (e.kind === 'message' || e.kind === 'result') counts.messages++;
    if (e.kind === 'command') counts.commands++;
    if (e.kind === 'edit') counts.edits++;
    if (e.kind === 'error' || e.state === 'failed') counts.errors++;
  }
  return counts;
}

export function countFailedCommands(entries: readonly TranscriptEntry[]): number {
  let n = 0;
  for (const e of entries) if (e.kind === 'command' && e.state === 'failed') n++;
  return n;
}

/** Returns the `seq` of the next failed command after `afterSeq`, wrapping around to the first failed command. */
export function nextFailedCommandSeq(entries: readonly TranscriptEntry[], afterSeq?: number): number | undefined {
  const failed: number[] = [];
  for (const e of entries) if (e.kind === 'command' && e.state === 'failed') failed.push(e.seq);
  if (!failed.length) return undefined;
  if (afterSeq === undefined) return failed[0];
  const next = failed.find(seq => seq > afterSeq);
  return next ?? failed[0];
}

/** Merges incoming new or updated entries into `existing` by `seq`, maintaining ascending `seq` order and bounded size. */
export function mergeTranscriptEntries(
  existing: readonly TranscriptEntry[],
  incoming: readonly TranscriptEntry[],
  maxEntries = 5000,
): TranscriptEntry[] {
  if (!incoming.length) return [...existing];
  const map = new Map<number, TranscriptEntry>();
  for (const e of existing) map.set(e.seq, e);
  for (const e of incoming) map.set(e.seq, e);
  const merged = [...map.values()].sort((a, b) => a.seq - b.seq);
  if (merged.length <= maxEntries) return merged;
  return merged.slice(merged.length - maxEntries);
}

export interface ParsedDiffLine {
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'context';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ParsedDiff {
  lines: ParsedDiffLine[];
  additions: number;
  deletions: number;
  bodyLines: number;
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  if (!diff.trim()) return { lines: [], additions: 0, deletions: 0, bodyLines: 0 };
  const rawLines = diff.replace(/\r\n/g, '\n').split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  const lines: ParsedDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let bodyLines = 0;
  let oldLine = 1;
  let newLine = 1;

  for (const raw of rawLines) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      lines.push({ kind: 'meta', text: raw });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      additions++;
      bodyLines++;
      lines.push({ kind: 'add', text: raw.slice(1), newLine: newLine++ });
    } else if (raw.startsWith('-')) {
      deletions++;
      bodyLines++;
      lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++ });
    } else if (raw.startsWith(' ')) {
      bodyLines++;
      lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else {
      lines.push({ kind: 'meta', text: raw });
    }
  }
  return { lines, additions, deletions, bodyLines };
}

export function renderEditDiff(edit: TranscriptEdit): ParsedDiff {
  if (edit.diff) return parseUnifiedDiff(edit.diff);
  if (edit.after !== undefined && edit.before === undefined) {
    const raw = edit.after.replace(/\r\n/g, '\n');
    const contentLines = raw ? (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n') : [];
    const lines: ParsedDiffLine[] = contentLines.map((text, idx) => ({
      kind: 'add',
      text,
      newLine: idx + 1,
    }));
    return { lines, additions: lines.length, deletions: 0, bodyLines: lines.length };
  }
  return { lines: [], additions: 0, deletions: 0, bodyLines: 0 };
}

/** Edits with fewer than 40 diff body lines expand automatically; larger diffs start collapsed. */
export function isSmallEditDiff(edits: readonly TranscriptEdit[] | undefined, threshold = 40): boolean {
  if (!edits?.length) return false;
  let total = 0;
  for (const e of edits) total += renderEditDiff(e).bodyLines;
  return total > 0 && total < threshold;
}

export function shouldFollowTranscript(params: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  currentFollow: boolean;
  programmatic: boolean;
  threshold?: number;
}): boolean {
  if (params.programmatic) return params.currentFollow;
  const threshold = params.threshold ?? 24;
  return params.scrollHeight - params.scrollTop - params.clientHeight < threshold;
}

export function earlierPageQuery(
  earliestSeq: number | undefined,
  nextCursor: number | undefined,
  pageSize = 200,
): { after: number; limit: number } | undefined {
  if (nextCursor === undefined) return undefined;
  if (earliestSeq !== undefined && earliestSeq > nextCursor) {
    return { after: nextCursor, limit: Math.min(1000, Math.min(pageSize, earliestSeq - nextCursor)) };
  }
  return { after: nextCursor, limit: pageSize };
}

export function hasJsonStream(
  run: Pick<Run, 'usage' | 'live'>,
  workerEngine?: string,
  transcriptEntries?: readonly Pick<TranscriptEntry, 'kind'>[],
): boolean {
  if (STRUCTURED_USAGE_SOURCES.has(run.usage.source)) return true;
  if (run.live?.recent.some(a => a.kind !== 'log') || (run.live?.messages.length ?? 0) > 0) return true;
  if (transcriptEntries && transcriptEntries.length > 0) {
    return transcriptEntries.some(e => e.kind !== 'log');
  }
  if (workerEngine !== undefined) return STRUCTURED_ENGINES.has(workerEngine);
  return run.usage.source !== 'codex-log';
}

export function resolveRunTab(requestedTab: string | null | undefined, hasJson: boolean): RunViewTab {
  if (requestedTab === 'transcript' || requestedTab === 'activity' || requestedTab === 'log') return requestedTab;
  return hasJson ? 'transcript' : 'log';
}

export function formatStepDuration(seconds?: number): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

export function compactInputPairs(input?: Record<string, unknown>, maxPairs = 4, maxVal = 72): { key: string; value: string }[] {
  if (!input) return [];
  const out: { key: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null || raw === '') continue;
    const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : JSON.stringify(raw);
    if (!text) continue;
    out.push({ key, value: text.length > maxVal ? `${text.slice(0, maxVal - 1)}…` : text });
    if (out.length >= maxPairs) break;
  }
  return out;
}
