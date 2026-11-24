import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { RunEnd, RunOutcome } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import type { Probes } from '../tick/gather.ts';
import { liveRuns, type LiveState } from '../run/live.ts';
import { parseOutbox, unanswered } from '../run/messages.ts';
import { handedIn } from '../run/lingering.ts';

export const phaseText = (phase: LiveState['phase']): string => ({ thinking: t('Thinking'), running_command: t('Running a command'), editing_files: t('Editing files'), waiting_long_command: t('Waiting on a long command'), idle: t('Idle') })[phase];
export interface StatusRow {
  orderPhase?: string;
  project: string; tag: string; run: string; worker: string; phase: LiveState['phase']; current?: LiveState['current'];
  plan?: { step: number; total: number; current?: string }; event_minutes?: number; commit_minutes?: number;
  /** `tokens_reported: false`: the engine has not reported any usage yet (Codex `exec --json` reports it only when its turn ends, at the end of the run), so `tokens` is 0 but not known. */
  tokens: number; tokens_reported: boolean; usage: LiveState['usage']; unanswered: { id: string; kind: string; text: string }[];
  /** The log already ends with the run's report while its process is still alive; `ended`: the engine's own end event came last. */
  delivered?: { status: string; ended: boolean };
  ended?: string;
  outcome?: RunOutcome;
  end?: RunEnd;
}

const RECENT_ENDED_MS = 24 * 60 * 60 * 1000;

/** Non-imported runs that ended within the last 24 hours, carrying `end` for `alba status --json`. */
export function recentEndedStatusRows(projects: { project: ProjectConfig; orders: Orders }[], probes: Probes): StatusRow[] {
  const cutoff = probes.now().getTime() - RECENT_ENDED_MS;
  const rows: StatusRow[] = [];
  for (const { project, orders } of projects) {
    for (const doc of orders.all()) {
      for (const run of doc.runs) {
        if (!run.ended || run.imported) continue;
        const endedAt = Date.parse(run.ended);
        if (!Number.isFinite(endedAt) || endedAt < cutoff) continue;
        const inputTokens = run.usage?.input_tokens ?? 0;
        const outputTokens = run.usage?.output_tokens ?? 0;
        const cachedTokens = run.usage?.cached_tokens ?? 0;
        const turns = run.usage?.turns ?? 0;
        const totalTokens = run.usage?.total_tokens ?? (inputTokens + outputTokens);
        rows.push({
          project: project.id,
          tag: doc.order.tag,
          run: run.id,
          worker: run.worker,
          phase: 'idle',
          tokens: totalTokens,
          tokens_reported: turns > 0 || run.usage !== undefined,
          usage: { input_tokens: inputTokens, cached_input_tokens: cachedTokens, output_tokens: outputTokens, turns, per_turn: [] },
          unanswered: [],
          ended: run.ended,
          ...(run.outcome ? { outcome: run.outcome } : {}),
          ...(run.end ? { end: run.end } : {}),
        });
      }
    }
  }
  return rows;
}

/** Read-only and quota-free. Commit probes run concurrently and have a small deadline. */
export async function statusRows(projects: { project: ProjectConfig; orders: Orders }[], probes: Probes): Promise<StatusRow[]> {
  const rows = projects.flatMap(({ project, orders }) => orders.all().flatMap(doc => doc.runs.filter(r => !r.ended).map(run => ({ project, doc, run }))));
  return Promise.all(rows.map(async ({ project, doc, run }) => {
    const live = liveRuns.read(project, doc.order.tag, run, probes, doc.order.worktree);
    const now = probes.now().getTime();
    const commit = doc.order.worktree ? await new Promise<string | undefined>(resolve => {
      execFile('git', ['log', '-1', '--format=%cI'], { cwd: doc.order.worktree, encoding: 'utf8', timeout: 300, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
    }) : undefined;
    let pending = unanswered(doc);
    if (doc.order.worktree) try {
      const found = parseOutbox(readFileSync(path.join(doc.order.worktree, '.alba', 'outbox.jsonl'), 'utf8'));
      pending = [...pending, ...found.filter(e => ['question', 'blocker'].includes(e.kind) && !doc.outbox?.some(o => o.id === e.id))];
    } catch { /* no mailbox */ }
    const delivered = handedIn(probes, run);
    return {
      project: project.id, tag: doc.order.tag, run: run.id, worker: run.worker, ...(run.phase ? { orderPhase: run.phase } : {}), phase: live.phase, ...(live.current ? { current: live.current } : {}),
      ...(live.plan ? { plan: { step: live.plan.current ? Math.min(live.plan.total, live.plan.done + 1) : live.plan.done, total: live.plan.total, current: live.plan.current } } : {}),
      ...(live.last_event_at ? { event_minutes: Math.max(0, (now - Date.parse(live.last_event_at)) / 60000) } : {}),
      ...(commit ? { commit_minutes: Math.max(0, (now - Date.parse(commit)) / 60000) } : {}),
      tokens: live.usage.input_tokens + live.usage.output_tokens, tokens_reported: live.usage.turns > 0, usage: live.usage, unanswered: pending.map(e => ({ id: e.id, kind: e.kind, text: e.text })),
      ...(delivered ? { delivered: { status: delivered.status, ended: delivered.ended } } : {}),
    };
  }));
}

/** Queued orders whose latest run ended because the model endpoint was unreachable. */
export function unreachableStatusLines(projects: { project: ProjectConfig; orders: Orders }[]): string[] {
  const lines: string[] = [];
  for (const { project, orders } of projects) {
    for (const doc of orders.all()) {
      if (doc.runs.some(r => r.ended === undefined)) continue;
      const last = [...doc.runs].filter(r => r.ended).sort((a, b) => b.seq - a.seq)[0];
      if (last?.limit !== 'unreachable' || orders.stage(doc).stage !== 'queued') continue;
      lines.push(`${project.id}/${doc.order.tag} ${last.id} ${last.worker} | ${t('endpoint unreachable')}`);
    }
  }
  return lines;
}

export function formatStatus(rows: StatusRow[]): string {
  if (!rows.length) return t('No open runs.');
  return rows.map(r => `${r.project}/${r.tag} ${r.run} ${r.worker}${r.orderPhase ? ` | ${r.orderPhase}` : ''} | ${r.delivered ? (r.delivered.ended ? t('turn ended, report handed in ({status}); process still running', { status: r.delivered.status }) : t('report handed in ({status}); process still running', { status: r.delivered.status })) : phaseText(r.phase)}${!r.delivered && r.current ? `: ${r.current.command.replace(/\s+/g, ' ')} (${t('{n} s', { n: Math.floor(r.current.elapsed_seconds) })})` : ''} | ${t('step {n}/{m}', { n: r.plan?.step ?? 0, m: r.plan?.total ?? 0 })} | ${t('event {event} min, commit {commit} min ago', { event: r.event_minutes === undefined ? '?' : Math.floor(r.event_minutes), commit: r.commit_minutes === undefined ? '?' : Math.floor(r.commit_minutes) })} | ${r.tokens_reported ? t('{n} tokens', { n: r.tokens }) : t('tokens not reported yet')} | ${t('{n} unanswered', { n: r.unanswered.length })}${r.unanswered.length ? `: ${r.unanswered.map(q => `${q.id} ${q.text}`).join(' / ')}` : ''}`).join('\n');
}

export function watchOrder(project: ProjectConfig, orders: Orders, tag: string, probes: Probes, print: (line: string) => void = console.log): Promise<string> {
  return new Promise(resolve => {
    const seen = new Set<string>();
    const stop = () => { clearInterval(timer); process.removeListener('SIGINT', stop); resolve(''); };
    const poll = () => {
      const doc = orders.get(tag), run = doc.runs.find(r => !r.ended) ?? doc.runs.at(-1);
      if (!run) { print(t('No open runs.')); stop(); return; }
      const live = liveRuns.read(project, doc.order.tag, run, probes, doc.order.worktree);
      for (const a of live.recent) {
        const key = JSON.stringify(a);
        if (seen.has(key)) continue;
        seen.add(key);
        print(`${a.at} ${a.kind} ${a.summary}${a.exit_code !== undefined ? ` [${a.exit_code}]` : ''}${a.output_tail ? `\n${a.output_tail}` : ''}`);
      }
      if (seen.size > 300) { const keep = [...seen].slice(-60); seen.clear(); keep.forEach(k => seen.add(k)); }
      for (const e of unanswered(doc)) if (!seen.has(e.id)) { seen.add(e.id); print(`${e.at} ${e.kind} ${e.id}: ${e.text}`); }
      if (run.ended) { print(t('Run ended: {outcome}', { outcome: run.outcome ?? '' })); stop(); }
    };
    const timer = setInterval(poll, 1000);
    process.once('SIGINT', stop);
    poll();
  });
}
