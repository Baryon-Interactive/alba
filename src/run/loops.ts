import { t } from '../i18n.ts';
import type { Action, ParsedLog } from '../workers/adapters/index.ts';
export type { Action, ParsedLog, LogFormat } from '../workers/adapters/index.ts';
export { parseActions, idleStretches, failedExit, codexCommandText, errorSignature, squash } from '../workers/adapters/index.ts';

/** What the three settings of the project say (`dispatch.loop_*`, `dispatch.long_commands`). */
export interface LoopRules { repeat: number; alternate: number; longCommands: readonly string[] }

export interface LoopFinding {
  kind: 'repeat' | 'retry' | 'alternate' | 'idle';
  /** The command (for `alternate`: the two, joined with " <-> "). */
  command?: string;
  error?: string;
  count: number;
  /** One line for people: the evidence. */
  text: string;
}

/** Is this one of the commands that legitimately run (and print nothing new) for a long time? */
export const isLongCommand = (command: string, words: readonly string[]): boolean => words.some(w => command.toLowerCase().includes(w.toLowerCase()));

const short = (s: string, n = 90): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Loops in what a worker did, from its log:
 *  - `repeat`: the same command failed with the same error `repeat` times (3) or more;
 *  - `retry`: the same command failed `repeat + 1` times in a row (the error may differ a little each time: a connection that keeps dropping);
 *  - `alternate`: two commands taking turns for `alternate` rounds (6) or more, most of them failing. Long commands are left out here:
 *    a build between edits is how work goes.
 * Long commands are not left out of the first two: a build that fails the same way four times is a loop however long each takes.
 */
export function findLoops(actions: readonly Action[], rules: LoopRules): LoopFinding[] {
  const out: LoopFinding[] = [];
  const same = new Map<string, number>();
  for (const a of actions) if (a.failed && a.error) { const k = `${a.command}\u0000${a.error}`; same.set(k, (same.get(k) ?? 0) + 1); }
  const reported = new Set<string>();
  for (const [key, count] of same) {
    if (count < rules.repeat) continue;
    const [command, error] = key.split('\u0000');
    reported.add(command);
    out.push({ kind: 'repeat', command, error, count, text: t('the same command failed with the same error {n} times: {command} -> {error}', { n: count, command: short(command), error: short(error) }) });
  }
  // the same command failing again and again, never succeeding in between
  const streak = new Map<string, { run: number; best: number; error?: string }>();
  for (const a of actions) {
    const s = streak.get(a.command) ?? { run: 0, best: 0 };
    if (a.failed) { s.run++; s.error = a.error; s.best = Math.max(s.best, s.run); } else s.run = 0;
    streak.set(a.command, s);
  }
  for (const [command, s] of streak) {
    if (s.best <= rules.repeat || reported.has(command)) continue;
    out.push({ kind: 'retry', command, ...(s.error ? { error: s.error } : {}), count: s.best, text: t('the same command failed {n} times in a row: {command} -> {error}', { n: s.best, command: short(command), error: short(s.error ?? '-') }) });
  }
  // two commands taking turns
  const names = actions.map(a => a.command);
  const flush = (start: number, end: number) => {
    const rounds = Math.floor((end - start) / 2);
    if (rounds < rules.alternate) return;
    const a = names[start], b = names[start + 1];
    if (isLongCommand(a, rules.longCommands) || isLongCommand(b, rules.longCommands)) return;
    const seg = actions.slice(start, end);
    if (seg.filter(x => x.failed).length * 2 <= seg.length) return;
    out.push({ kind: 'alternate', command: `${a} <-> ${b}`, count: rounds, text: t('two commands taking turns for {n} rounds, most of them failing: {a} <-> {b}', { n: rounds, a: short(a, 50), b: short(b, 50) }) });
  };
  for (let i = 0; i < names.length - 1;) {
    if (names[i] === names[i + 1]) { i++; continue; }
    let j = i + 2;
    while (j < names.length && names[j] === names[j - 2]) j++;
    flush(i, j);
    i = Math.max(i + 1, j - 1);
  }
  return out;
}

/** The last command a log shows (for the "waiting for a long command" exclusion of the idle check). */
export const lastCommand = (p: ParsedLog): string | undefined => p.actions.at(-1)?.command;
