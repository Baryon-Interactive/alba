import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@api';
import { zh } from '@/i18n/zh';
import { invalidationsFor } from '@/lib/events';
import {
  compactInputPairs,
  countFailedCommands,
  countTranscriptCategories,
  earlierPageQuery,
  filterTranscriptEntries,
  formatStepDuration,
  hasJsonStream,
  isSmallEditDiff,
  mergeTranscriptEntries,
  nextFailedCommandSeq,
  parseUnifiedDiff,
  renderEditDiff,
  resolveRunTab,
  shouldFollowTranscript,
} from './TranscriptLogic';

const sampleEntries: TranscriptEntry[] = [
  { seq: 0, at: '2026-02-10T10:00:00Z', kind: 'reasoning', state: 'done', title: 'Inspecting build script', text: 'Inspecting build.ps1' },
  { seq: 1, at: '2026-02-10T10:00:01Z', kind: 'message', state: 'done', title: 'Starting verification', text: 'Starting verification of `src/main.c`.' },
  { seq: 2, at: '2026-02-10T10:00:02Z', kind: 'command', state: 'failed', title: 'pwsh -File build.ps1', exit_code: 1, output: 'error C2065: undeclared identifier' },
  {
    seq: 3,
    at: '2026-02-10T10:00:04Z',
    kind: 'edit',
    state: 'done',
    title: 'Edit src/main.c',
    edit: [{ path: 'src/main.c', kind: 'edit', diff: '--- a/src/main.c\n+++ b/src/main.c\n@@ -1,2 +1,2 @@\n-int x = y;\n+int x = 0;\n return x;' }],
  },
  { seq: 4, at: '2026-02-10T10:00:06Z', kind: 'command', state: 'done', title: 'pwsh -File build.ps1', exit_code: 0, output: 'Build succeeded' },
  { seq: 5, at: '2026-02-10T10:00:08Z', kind: 'command', state: 'failed', title: 'node --test test/smoke.test.js', exit_code: 1, output: 'AssertionError: expected 1 to equal 2' },
  { seq: 6, at: '2026-02-10T10:00:09Z', kind: 'error', state: 'failed', title: 'Tool warning', text: 'Connection reset once' },
  { seq: 7, at: '2026-02-10T10:00:10Z', kind: 'result', state: 'done', title: 'Completed check', text: 'Completed check.' },
];

describe('transcript entry merging and grouping', () => {
  it('replaces running entries in place by seq and keeps ascending file order across live and earlier pages', () => {
    const initial: TranscriptEntry[] = [
      { seq: 2, at: '2026-02-10T10:00:02Z', kind: 'command', state: 'running', title: 'pwsh -File build.ps1' },
      { seq: 3, at: '2026-02-10T10:00:03Z', kind: 'message', state: 'done', title: 'Waiting' },
    ];
    const liveUpdate: TranscriptEntry[] = [
      { seq: 2, at: '2026-02-10T10:00:02Z', kind: 'command', state: 'done', title: 'pwsh -File build.ps1', exit_code: 0, output: 'OK' },
      { seq: 4, at: '2026-02-10T10:00:05Z', kind: 'result', state: 'done', title: 'Done' },
    ];
    const afterLive = mergeTranscriptEntries(initial, liveUpdate);
    expect(afterLive.map(e => [e.seq, e.state, e.output])).toEqual([
      [2, 'done', 'OK'],
      [3, 'done', undefined],
      [4, 'done', undefined],
    ]);

    const earlierPage: TranscriptEntry[] = [
      { seq: 0, at: '2026-02-10T10:00:00Z', kind: 'message', state: 'done', title: 'First' },
      { seq: 1, at: '2026-02-10T10:00:01Z', kind: 'tool', state: 'done', title: 'Read src/main.c' },
    ];
    const combined = mergeTranscriptEntries(earlierPage, afterLive);
    expect(combined.map(e => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('transcript category filters, text search and failed-command jump', () => {
  it('counts and filters All, Messages, Commands, Edits and Errors accurately', () => {
    expect(countTranscriptCategories(sampleEntries)).toEqual({
      all: 8,
      messages: 2,
      commands: 3,
      edits: 1,
      errors: 3,
    });
    expect(filterTranscriptEntries(sampleEntries, 'messages', '').map(e => e.seq)).toEqual([1, 7]);
    expect(filterTranscriptEntries(sampleEntries, 'commands', '').map(e => e.seq)).toEqual([2, 4, 5]);
    expect(filterTranscriptEntries(sampleEntries, 'edits', '').map(e => e.seq)).toEqual([3]);
    expect(filterTranscriptEntries(sampleEntries, 'errors', '').map(e => e.seq)).toEqual([2, 5, 6]);
  });

  it('filters by text across title, body text, command output and edited paths', () => {
    expect(filterTranscriptEntries(sampleEntries, 'all', 'undeclared').map(e => e.seq)).toEqual([2]);
    expect(filterTranscriptEntries(sampleEntries, 'all', 'SRC/MAIN.C').map(e => e.seq)).toEqual([1, 3]);
    expect(filterTranscriptEntries(sampleEntries, 'commands', 'smoke').map(e => e.seq)).toEqual([5]);
  });

  it('counts failed commands and cycles through them with wrap-around', () => {
    expect(countFailedCommands(sampleEntries)).toBe(2);
    const first = nextFailedCommandSeq(sampleEntries, undefined);
    expect(first).toBe(2);
    const second = nextFailedCommandSeq(sampleEntries, first);
    expect(second).toBe(5);
    const wrapped = nextFailedCommandSeq(sampleEntries, second);
    expect(wrapped).toBe(2);
  });
});

describe('unified diff parsing and 40-line auto-expand rule', () => {
  it('parses unified diff hunks, line numbers and +/- counts', () => {
    const diff = [
      '--- a/src/main.c',
      '+++ b/src/main.c',
      '@@ -10,3 +10,4 @@',
      ' int init() {',
      '-  return 1;',
      '+  int ok = 0;',
      '+  return ok;',
      ' }',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parsed.bodyLines).toBe(5);
    const body = parsed.lines.filter(l => l.kind !== 'meta' && l.kind !== 'hunk');
    expect(body).toEqual([
      { kind: 'context', text: 'int init() {', oldLine: 10, newLine: 10 },
      { kind: 'del', text: '  return 1;', oldLine: 11 },
      { kind: 'add', text: '  int ok = 0;', newLine: 11 },
      { kind: 'add', text: '  return ok;', newLine: 12 },
      { kind: 'context', text: '}', oldLine: 12, newLine: 13 },
    ]);
  });

  it('renders write-only edits as added lines and expands small diffs (< 40 lines) while collapsing large diffs', () => {
    const smallWrite = { path: 'src/new.c', kind: 'write', after: 'int a = 1;\nint b = 2;\n' };
    const rendered = renderEditDiff(smallWrite);
    expect(rendered.additions).toBe(2);
    expect(rendered.bodyLines).toBe(2);
    expect(isSmallEditDiff([smallWrite])).toBe(true);

    const fortyLines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    expect(isSmallEditDiff([{ path: 'src/big.c', kind: 'write', after: fortyLines }])).toBe(false);
    expect(isSmallEditDiff([])).toBe(false);
  });
});

describe('follow/pause rule, backwards paging and default tab selection', () => {
  it('follows while at the bottom, pauses when the user scrolls up, and ignores programmatic scrolls', () => {
    expect(
      shouldFollowTranscript({ scrollTop: 585, scrollHeight: 1000, clientHeight: 400, currentFollow: false, programmatic: false }),
    ).toBe(true);
    expect(
      shouldFollowTranscript({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400, currentFollow: true, programmatic: false }),
    ).toBe(false);
    expect(
      shouldFollowTranscript({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400, currentFollow: true, programmatic: true }),
    ).toBe(true);
  });

  it('computes non-overlapping earlier page requests', () => {
    expect(earlierPageQuery(300, 100, 200)).toEqual({ after: 100, limit: 200 });
    expect(earlierPageQuery(50, 0, 200)).toEqual({ after: 0, limit: 50 });
    expect(earlierPageQuery(0, undefined, 200)).toBeUndefined();
  });

  it('defaults to Transcript for JSON stream runs and Raw log for plain-text runs, unless ?tab= is set', () => {
    const unknownUsage = { usage: { source: 'unknown' as const } };
    expect(resolveRunTab(null, hasJsonStream(unknownUsage, 'agy-cli'))).toBe('transcript');
    expect(resolveRunTab(null, hasJsonStream(unknownUsage, 'claude-cli'))).toBe('transcript');
    expect(resolveRunTab(null, hasJsonStream(unknownUsage, 'codex-cli'))).toBe('transcript');
    expect(resolveRunTab(null, hasJsonStream(unknownUsage, 'script'))).toBe('log');
    expect(resolveRunTab(null, hasJsonStream(unknownUsage, undefined, [{ kind: 'log' }]))).toBe('log');
    expect(resolveRunTab(null, hasJsonStream(unknownUsage, undefined, [{ kind: 'command' }]))).toBe('transcript');
    expect(resolveRunTab('transcript', false)).toBe('transcript');
    expect(resolveRunTab('activity', true)).toBe('activity');
    expect(resolveRunTab('log', true)).toBe('log');
  });

  it('formats durations, compact inputs, stream invalidations and Chinese catalog entries cleanly', () => {
    expect(formatStepDuration(0.4)).toBe('0.4s');
    expect(formatStepDuration(125)).toBe('2m 5s');
    expect(compactInputPairs({ Path: 'src/main.c', StartLine: 1, Empty: '' })).toEqual([
      { key: 'Path', value: 'src/main.c' },
      { key: 'StartLine', value: '1' },
    ]);
    expect(invalidationsFor('run.transcript', { project: 'p1', key: 'T1:r1', entries: [] }, 'p1')).toEqual([]);

    const marks = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const key of ['Transcript', 'Raw log', 'Watch', '{n} failed', '{shown} of {total} steps', 'Load earlier', 'Jump to latest']) {
      expect(zh[key], key).toMatch(/\p{Script=Han}/u);
      expect(marks(zh[key]), key).toEqual(marks(key));
    }
  });
});
