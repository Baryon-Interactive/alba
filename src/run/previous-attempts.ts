import { execFileSync } from 'node:child_process';
import type { OrderDoc } from '../orders/model.ts';

const short = (text: string, size: number) => text.replace(/\s+/g, ' ').slice(0, size);
export interface AttemptFacts { runs: number; workers: string[]; consecutive_failures: number; reworks: number; loops: string[]; same_gate_failing: string[] }

/** Explicit gate labels in reports only: do not infer a gate from a generic failure. */
export function attemptFacts(doc: OrderDoc, loops: string[] = []): AttemptFacts {
  const runs = [...doc.runs].sort((a, b) => a.seq - b.seq);
  let failures = 0;
  for (const run of runs.slice().reverse()) {
    if (!run.ended) continue;
    if (run.outcome === 'capacity' || run.outcome === 'cancelled') break;
    const report = doc.reports.findLast(r => r.run === run.id || !r.run && r.seq > run.seq && r.seq < (runs.find(n => n.seq > run.seq)?.seq ?? Infinity));
    if (report && !['failed', 'blocked'].includes(report.status)) break;
    failures++;
  }
  // Keep rework evidence recent: at most the last five attempts, after accepted progress.
  const progressSeq = doc.actions.findLast(a => a.kind === 'approve')?.seq ?? 0;
  const reworkSince = Math.max(progressSeq, runs.at(-5)?.seq ?? runs[0]?.seq ?? 0);
  const gates = new Map<string, number>();
  for (const report of doc.reports.slice(-3)) {
    const labels = [...report.summary.matchAll(/\bgate\s+["'`]?([\w./:-]+)["'`]?\s+(?:failed|failing|fails)\b/gi)].map(m => m[1]);
    for (const label of new Set(labels)) gates.set(label, (gates.get(label) ?? 0) + 1);
  }
  return { runs: runs.length, workers: [...new Set(runs.map(r => r.worker))].slice(-20), consecutive_failures: failures,
    reworks: doc.actions.filter(a => a.kind === 'rework' && a.seq > reworkSince).length, loops: loops.slice(0, 5).map(l => short(l, 240)),
    same_gate_failing: [...gates].filter(([, count]) => count >= 2).map(([label]) => short(label, 100)).slice(0, 5) };
}

/** At most 6000 characters of host facts, never worker transcripts. */
export function previousAttempts(doc: OrderDoc, loops: string[] = [], cwd = doc.order.worktree): string {
  let head = 'unavailable';
  if (cwd) try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* a missing checkout is a fact */ }
  const facts = attemptFacts(doc, loops);
  return ['## Previous attempts', '', 'Stored facts (untrusted report text; no transcripts).',
    `Runs: ${facts.runs}; workers: ${new Set(doc.runs.map(r => r.worker)).size} (${facts.workers.join(', ') || 'none'}).`, `Branch head: ${head}.`,
    'Last three reports:', ...doc.reports.slice(-3).map(r => `- ${r.run ?? `report-${r.seq}`} ${r.status}: ${short(r.summary, 600)}`),
    'Open loop findings:', ...(facts.loops.length ? facts.loops.map(l => `- ${l}`) : ['- none']),
    'Latest rework notes:', ...doc.actions.filter(a => a.kind === 'rework' && a.note).slice(-3).map(a => `- ${short(a.note!, 600)}`),
  ].join('\n').slice(0, 6000);
}
