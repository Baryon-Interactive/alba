import { existsSync } from 'node:fs';
import type { ProjectConfig } from '../config.ts';
import type { Run } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import type { Probes } from '../tick/gather.ts';
import { t } from '../i18n.ts';
import { findLoops, isLongCommand, lastCommand, parseActions, type LoopFinding } from './loops.ts';
import { readStateJson, writeStateFile, stateTransaction } from '../orders/state-files.ts';
import { saveWipSnapshot } from './wip.ts';

/** What the tick saw of a run's log the last time commands were counted: used to tell "output still grows, nothing new is done". */
interface Seen { execs: number; bytes: number; changed_at: string }

function readSeen(project: ProjectConfig): Record<string, Seen> { return readStateJson(project, '_watch.json', {}); }
function writeSeen(project: ProjectConfig, seen: Record<string, Seen>): void {
  writeStateFile(project, '_watch.json', JSON.stringify(seen) + '\n');
}

export interface WatchInput {
  tag: string;
  run: Run;
  /** When the branch last got a commit. */
  lastCommitAt?: string;
}

/**
 * Is this open run going round in circles? Looks at what the worker did in its log (three engines): the same command failing the same way
 * again and again, two commands taking turns, and the log growing for `loop_idle_minutes` with no new command started and no commit
 * (the number of commands is remembered between looks in `_watch.json`). A command in `dispatch.long_commands` that is still open, a
 * build or a package step, never counts as idling. `record: false` (a dry run) reads and remembers nothing.
 */
export function watchRun(project: ProjectConfig, probes: Probes, input: WatchInput, options: { record: boolean }): LoopFinding[] {
  return stateTransaction(project, () => {
    const { run } = input;
    const file = run.events_file && existsSync(run.events_file) ? run.events_file : run.log;
    if (!file || run.imported || !existsSync(file)) return [];
    const rules = { repeat: project.dispatch.loop_repeat, alternate: project.dispatch.loop_alternate, longCommands: project.dispatch.long_commands };
    const text = probes.readText(file) ?? '';
    const parsed = parseActions(text);
    const findings = findLoops(parsed.actions, rules);
    const key = `${input.tag}:${run.id}`;
    const seen = readSeen(project);
    const now = probes.now();
    const bytes = Buffer.byteLength(text);
    const before = seen[key];
    if (!before || before.execs !== parsed.started) {
      if (options.record) { seen[key] = { execs: parsed.started, bytes, changed_at: now.toISOString() }; writeSeen(project, seen); }
      return findings;
    }
    const quiet = (now.getTime() - Date.parse(before.changed_at)) / 60000;
    const commitSince = input.lastCommitAt && Date.parse(input.lastCommitAt) > Date.parse(before.changed_at);
    const current = parsed.open ?? (run.events_file ? undefined : lastCommand(parsed));
    if (quiet >= project.dispatch.loop_idle_minutes && bytes > before.bytes + 1024 && !commitSince && !(current && isLongCommand(current, rules.longCommands))) {
      findings.push({ kind: 'idle', count: Math.round(quiet), ...(current ? { command: current } : {}), text: t('the log grew by {kb} KB in {min} min with no new command and no commit', { kb: Math.round((bytes - before.bytes) / 1024), min: Math.round(quiet) }) });
    }
    return findings;
  });
}

/** `dispatch.on_loop: stop`: kills the process of a run that goes round in circles, ends the run and says why in a failed report (a person decides what next). */
export function stopLoopingRun(_project: ProjectConfig, orders: Orders, probes: Probes, tag: string, evidence: string[]): string {
  const doc = orders.get(tag);
  const run = doc.runs.find(r => r.ended === undefined);
  if (!run) return t('{tag}: no open run to stop', { tag });
  if (run.pid && probes.isAlive(run.pid)) {
    const stopped = !run.imported ? probes.kill?.(run.pid, run.process_started_at, run.started) : [];
    if (!stopped?.includes(run.pid)) return t('Refusing to stop process {pid} of {tag}: it is not the process this run started.', { pid: run.pid, tag });
  }
  const summary = t('stopped by alba: the run was going round in circles ({evidence})', { evidence: evidence.join('; ') });
  const cleanSummary = summary.replace(/\n/g, ' ');
  const wip = saveWipSnapshot(doc.order.worktree ?? run.cwd, { tag: doc.order.tag, runId: run.id, kind: 'killed-by-alba' });
  orders.runEnd(tag, 'stalled', { kind: 'killed-by-alba', detail: 'stopped by alba (loop-stopped)', why: cleanSummary, ...wip });
  orders.report(tag, { status: 'failed', summary: cleanSummary, evidence: run.log ? [run.log] : [], commits: [] }, 'tick');
  orders.record(tag, 'loop-stopped', { run: run.id, evidence });
  return t('{tag}: stopped run {run} (going round in circles)', { tag, run: run.id });
}

/** The evidence lines of a finding, as a problem shows them: the command, the error, and how many times. */
export function evidenceOf(f: LoopFinding): string[] {
  return [...(f.command ? [`${t('command')}: ${f.command}`] : []), ...(f.error ? [`${t('error')}: ${f.error}`] : []), `${f.kind === 'idle' ? t('minutes') : t('times')}: ${f.count}`];
}

/** Forgets the runs that are over (their entries would only grow the file). */
export function pruneSeen(project: ProjectConfig, open: readonly string[]): void {
  return stateTransaction(project, () => {
    const seen = readSeen(project);
    const keep = Object.fromEntries(Object.entries(seen).filter(([k]) => open.includes(k)));
    if (Object.keys(keep).length !== Object.keys(seen).length) writeSeen(project, keep);
  });
}
