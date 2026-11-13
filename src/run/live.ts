import type { UsageFold } from '../usage/fold.ts';
import { LiveFold } from '../workers/adapters/index.ts';
export { LiveFold } from '../workers/adapters/index.ts';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { LiveState, LiveSummary } from '../api/live-types.ts';
export type { LiveState, LiveSummary } from '../api/live-types.ts';
import type { ProjectConfig } from '../config.ts';
import type { Run } from '../orders/model.ts';
import type { Probes } from '../tick/gather.ts';
import { readReceipt } from './progress.ts';

const oneLine = (v: string): string => v.replace(/\s+/g, ' ').trim().slice(0, 500);

interface Entry { fold: LiveFold; offset: number; identity?: number; diffAt: number; diff?: string; gitFiles?: string[]; gitBusy?: boolean; last?: LiveState }

/** One cache per server/CLI process, keyed by run file. Partial UTF-8 lines stay unread until their newline arrives. */
export class LiveRuns {
  private entries = new Map<string, Entry>();
  accounting(run: Run): UsageFold | undefined { return this.entries.get(run.events_file ?? run.log ?? '')?.fold.accounting; }
  peek(run: Run): LiveState | undefined { return this.entries.get(run.events_file ?? run.log ?? '')?.last; }
  read(project: ProjectConfig, tag: string, run: Run, probes: Probes, worktree?: string, git = false): LiveState {
    const file = run.events_file ?? run.log ?? '';
    let entry = this.entries.get(file);
    if (!entry) { entry = { fold: new LiveFold(project.dispatch.long_commands), offset: 0, diffAt: 0 }; this.entries.set(file, entry); }
    const now = probes.now();
    try {
      const stat = statSync(file);
      if (stat.size < entry.offset || (entry.identity !== undefined && stat.birthtimeMs !== entry.identity)) { entry.fold = new LiveFold(project.dispatch.long_commands); entry.offset = 0; }
      entry.identity = stat.birthtimeMs;
      if (stat.size > entry.offset) {
        const fd = openSync(file, 'r');
        // A bounded allocation, but consume all complete chunks on rebuild.
        try {
          while (entry.offset < stat.size) {
            const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, stat.size - entry.offset));
            const n = readSync(fd, buffer, 0, buffer.length, entry.offset);
            const cut = buffer.subarray(0, n).lastIndexOf(10);
            if (cut < 0) break;
            const text = buffer.subarray(0, cut + 1).toString('utf8');
            entry.offset += cut + 1;
            const at = stat.mtime.toISOString();
            for (const line of text.split('\n').filter(Boolean)) {
              try { entry.fold.event(JSON.parse(line), at); }
              catch { if (!run.events_file) { entry.fold.state.recent.push({ at, kind: 'log', summary: oneLine(line) }); entry.fold.state.recent = entry.fold.state.recent.slice(-30); } }
            }
            entry.fold.state.last_event_at = at;
          }
        } finally { closeSync(fd); }
      }
    } catch { /* no file yet, or rotated between stat and read */ }
    const state = entry.fold.view(run.ended ? new Date(run.ended) : now);
    state.plan ??= readReceipt(project, probes, tag, worktree)?.progress;
    state.diff_stat = entry.diff;
    state.files_changed = [...new Set([...state.files_changed, ...entry.gitFiles ?? []])];
    if (run.ended) { state.phase = 'idle'; delete state.current; }
    entry.last = state;
    if (git && worktree && !entry.gitBusy && now.getTime() - entry.diffAt >= 120000) {
      entry.diffAt = now.getTime(); entry.gitBusy = true;
      const base = project.dispatch.base_ref ?? 'HEAD';
      execFile('git', ['diff', '--stat', base, '--'], { cwd: worktree, encoding: 'utf8', timeout: 10000, windowsHide: true }, (_error, stdout) => {
        entry!.diff = stdout.trim(); entry!.gitBusy = false;
        entry!.gitFiles = stdout.split('\n').filter(l => l.includes(' | ')).map(l => l.split(' | ')[0].trim());
      });
    }
    return state;
  }
}

export const liveRuns = new LiveRuns();
export const liveSummary = (s: LiveState): LiveSummary => ({ input_tokens: s.usage.input_tokens, cached_input_tokens: s.usage.cached_input_tokens, output_tokens: s.usage.output_tokens, turns: s.usage.turns, commands: s.commands, failed_commands: s.failed_commands, long_command_minutes: s.long_command_seconds / 60, files_changed: s.files_changed });
