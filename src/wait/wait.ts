import { t } from '../i18n.ts';
import { openCommand } from '../workers/adapters/index.ts';
import { liveRuns } from '../run/live.ts';
import { applyFinish, findFinishes } from '../run/finish.ts';
import type { RunContext } from '../run/launch.ts';
import { syncOrders } from '../sync/sync.ts';
import { systemGit, type GitProbe } from '../sync/git.ts';
import { findWorktree } from '../tick/gather.ts';

export interface WaitOptions {
  stallMinutes: number;
  timeoutMinutes?: number;
  pollMinutes: number;
}

export interface WaitDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  print(line: string): void;
  git?: GitProbe;
}

/** 0 the run ended (and was recorded), 2 it stalled, 3 the time ran out. */
export interface WaitResult { exitCode: 0 | 2 | 3; line: string }

/**
 * Blocks until the order's open run ends, stalls, or the time runs out. It polls slowly (every `pollMinutes`).
 *  - A run the tool started: when its process is gone the end is recorded exactly as a tick would record it, then one line says how it ended.
 *  - An imported run (no process): `<TAG>.last.txt` and the git signal are looked at (as `alba sync` does, for this order only).
 *  - Stalled: no commit, no log growth for `stallMinutes`, unless the last command in a Codex log is still running; then it is
 *    waiting, which is not a stall until `long_command_minutes` have passed.
 */
export async function waitFor(ctx: RunContext, tag: string, options: WaitOptions, deps: WaitDeps): Promise<WaitResult> {
  const { project, orders, probes } = ctx;
  const git = deps.git ?? systemGit;
  const began = deps.now();
  let waitingNote = '';
  for (;;) {
    let doc = orders.get(tag);
    let open = doc.runs.find(r => r.ended === undefined);
    if (open && !open.pid) {
      // Delivered somewhere the tool can read? Same rules as `alba sync`.
      syncOrders(project, orders, { only: [doc.order.tag], git, now: () => new Date(deps.now()) });
      doc = orders.get(tag);
      open = doc.runs.find(r => r.ended === undefined);
    }
    if (!open) {
      const { stage, why } = orders.stage(doc);
      const last = [...doc.runs].sort((a, b) => b.seq - a.seq)[0];
      return { exitCode: 0, line: last ? t('{tag}: run {run} ended: {outcome}; stage {stage} ({why})', { tag: doc.order.tag, run: last.id, outcome: last.outcome ?? '-', stage, why }) : t('{tag}: no run to wait for; stage {stage}', { tag: doc.order.tag, stage }) };
    }
    if (open.pid && !probes.isAlive(open.pid)) {
      const finish = findFinishes(project, orders, probes).find(f => f.tag === doc.order.tag && f.run === open!.id);
      if (finish) {
        applyFinish(orders, finish, ctx.project);
        return { exitCode: 0, line: t('{tag}: run {run} ended: {outcome}{status} ({why})', { tag: doc.order.tag, run: finish.run, outcome: finish.outcome, status: finish.report ? `, ${finish.report.status}` : '', why: finish.why }) };
      }
    }
    // stall
    const worktree = doc.order.worktree ?? findWorktree(doc.order.tag, git.worktrees(project.root));
    const activity = worktree ? probes.gitActivity(worktree) : {};
    const live = open.events_file ? liveRuns.read(project, doc.order.tag, open, probes, worktree) : undefined;
    const logAt = live?.last_event_at ?? (open.log ? probes.fileTime(open.log) : undefined);
    const newest = [activity.lastCommitAt, open.imported ? undefined : open.started, logAt].filter((x): x is string => !!x).sort().pop();
    if (newest) {
      const quiet = Math.round((deps.now() - Date.parse(newest)) / 60000);
      if (quiet >= options.stallMinutes) {
        const command = live?.current?.command ?? (open.log && !open.events_file ? openCommand(probes.tail(open.log, 524288)) : undefined);
        if (command && (live ? live.phase === 'waiting_long_command' : quiet <= project.dispatch.long_command_minutes)) {
          // said once per command, not at every poll (the minutes would make every line new)
          if (command !== waitingNote) deps.print(t('{tag}: waiting for a command: {command}, {min} min', { tag: doc.order.tag, command: command.slice(0, 60), min: quiet }));
          waitingNote = command;
        } else {
          return { exitCode: 2, line: t('{tag}: stalled: no commit or log activity for {min} min (limit {limit}){command}', { tag: doc.order.tag, min: quiet, limit: options.stallMinutes, command: command ? t(', the last command has been running for a long time: {command}', { command: command.slice(0, 60) }) : '' }) };
        }
      }
    }
    if (options.timeoutMinutes !== undefined && deps.now() - began >= options.timeoutMinutes * 60000) {
      return { exitCode: 3, line: t('{tag}: still running after {min} min; stopped waiting', { tag: doc.order.tag, min: options.timeoutMinutes }) };
    }
    await deps.sleep(options.pollMinutes * 60000);
  }
}
