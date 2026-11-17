import { existsSync, readFileSync } from 'node:fs';
import type * as A from '../api/types.ts';
import { table } from '../cli/format.ts';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { Action, OrderDoc, Run } from '../orders/model.ts';
import { brokenRun } from '../routing/breaker.ts';
import { readLessons } from './lessons.ts';

export type LessonEffectLabel =
  | 'too few runs'
  | 'in every run of this kind'
  | 'no effect visible'
  | 'higher with it'
  | 'lower with it';

export interface SideStats {
  runs: number;
  judged: number;
  accepted_first_pass: number;
  first_pass_share?: number;
}

export interface LessonStatRow {
  id: string;
  title: string;
  kinds: string[];
  with: SideStats;
  without: SideStats;
  diff_points?: number;
  label: LessonEffectLabel;
}

export interface LessonStatsReport {
  project: string;
  since?: string;
  kind?: string;
  runs_in_window: number;
  runs_from_prompt_files: number;
  items: LessonStatRow[];
}

const PROMPT_LESSON_ID = /^-\s+([A-Za-z]+(?:-[A-Za-z0-9]+)*-?\d+[A-Za-z]?)\b/;
const RESUMED_CONTINUATION = /^(?:The person has answered your question\.|The long job you handed to the monitor is over|The person stopped the run to send you a message\.)/;

/** Parses mounted lesson ids from a prompt or hand-over file (`## Lessons from earlier work`), stopping before any `Also on file` list. */
export function parsePromptLessons(text: string): { ids: string[]; resumedContinuation: boolean } {
  const trimmed = text.replace(/^\uFEFF/, '');
  const withoutRules = trimmed.startsWith('## Role rules\n')
    ? trimmed.replace(/^## Role rules\n\n[\s\S]*?\n\n(?=(?:Read the UTF-8 file |The person |The long job ))/, '')
    : trimmed;
  const resumedContinuation = RESUMED_CONTINUATION.test(withoutRules);
  const lines = trimmed.split(/\r?\n/);
  const start = lines.findIndex(l => /^## Lessons from earlier work\s*$/.test(l));
  if (start < 0) return { ids: [], resumedContinuation };
  const ids: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line) || /^Also on file; read the ones that touch your work:/.test(line)) break;
    const m = PROMPT_LESSON_ID.exec(line);
    if (m) ids.push(m[1].toUpperCase());
  }
  return { ids, resumedContinuation };
}

export function parseStatsSince(since: string | undefined, now = new Date()): string | undefined {
  if (!since || since.trim().toLowerCase() === 'all') return undefined;
  const m = /^(\d+)(h|d)$/i.exec(since.trim());
  const ms = m ? now.getTime() - Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3600000 : 86400000) : Date.parse(since);
  if (!Number.isFinite(ms)) fail('Invalid --since value "{value}" (expected 30d, 7d, 24h, all or YYYY-MM-DD).', { value: since });
  return new Date(ms).toISOString();
}

/** First `approve` or `rework` after `run` and before `nextRun`, matching `src/routing/history.ts`. */
function runVerdict(actions: readonly Action[], run: Run, nextRun: Run | undefined): Action | undefined {
  if (run.outcome !== 'completed') return undefined;
  const until = nextRun?.seq ?? Infinity;
  return actions.find(a => a.seq > run.seq && a.seq < until && (a.kind === 'approve' || a.kind === 'rework'));
}

function summarizeSide(runs: readonly { judged: boolean; acceptedFirstPass: boolean }[]): SideStats {
  const judged = runs.filter(r => r.judged);
  const accepted = judged.filter(r => r.acceptedFirstPass).length;
  return {
    runs: runs.length,
    judged: judged.length,
    accepted_first_pass: accepted,
    ...(judged.length > 0 ? { first_pass_share: accepted / judged.length } : {}),
  };
}

export function lessonStats(
  project: Pick<ProjectConfig, 'id' | 'name' | 'lessons'>,
  docs: readonly OrderDoc[],
  options: { since?: string; kind?: string; lessons?: readonly A.Lesson[]; now?: Date } = {},
): LessonStatsReport {
  const sinceIso = parseStatsSince(options.since, options.now);
  const sinceMs = sinceIso !== undefined ? Date.parse(sinceIso) : undefined;
  const wantKind = options.kind?.trim().toLowerCase();

  interface ObservedRun {
    kind: string;
    ids: Set<string>;
    judged: boolean;
    acceptedFirstPass: boolean;
    fromPromptFile: boolean;
  }

  const observed: ObservedRun[] = [];
  for (const doc of docs) {
    const kind = (doc.order.routing?.kind || doc.order.kind || '').trim();
    if (!kind) continue;
    if (wantKind && kind.toLowerCase() !== wantKind) continue;
    const runs = [...doc.runs].sort((a, b) => a.seq - b.seq);
    const actions = [...doc.actions].sort((a, b) => a.seq - b.seq);
    let sessionIds: string[] = [];
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (run.imported) continue;
      let ids: string[] | undefined;
      let fromPromptFile = false;
      if (run.lessons) {
        const resumed = !!run.continuation && run.lessons.mounted.length === 0 && run.prompt_bytes?.order === 0;
        ids = resumed ? sessionIds : run.lessons.mounted.map(x => x.toUpperCase());
        if (!resumed) sessionIds = ids;
      } else {
        const file = run.handoff_file && existsSync(run.handoff_file) ? run.handoff_file : run.prompt_file;
        if (file && existsSync(file)) {
          const parsed = parsePromptLessons(readFileSync(file, 'utf8'));
          ids = parsed.resumedContinuation ? sessionIds : parsed.ids;
          if (!parsed.resumedContinuation) sessionIds = ids;
          fromPromptFile = true;
        }
      }
      if (!ids) continue;
      if (sinceMs !== undefined && Date.parse(run.started) < sinceMs) continue;

      let judged = false;
      let acceptedFirstPass = false;
      if (brokenRun(run)) {
        judged = true;
      } else {
        const verdict = runVerdict(actions, run, runs[i + 1]);
        if (verdict) {
          judged = true;
          acceptedFirstPass = verdict.kind === 'approve' && !actions.some(a => a.seq < verdict.seq && a.kind === 'rework');
        }
      }
      observed.push({ kind, ids: new Set(ids), judged, acceptedFirstPass, fromPromptFile });
    }
  }

  const library = (options.lessons ?? readLessons(project.lessons, project)).filter(l => l.appliesToProject);
  const byId = new Map<string, { id: string; title: string; tags: string[] }>();
  const kindMatchesLesson = (k: string, tags: readonly string[]): boolean => {
    const kl = k.toLowerCase();
    const mapped = project.lessons?.kind_tags[k] ?? project.lessons?.kind_tags[kl] ?? [];
    const set = new Set([kl, ...mapped.map(x => x.toLowerCase()), 'all']);
    return tags.some(tag => set.has(tag.toLowerCase()));
  };

  for (const l of library) {
    if (wantKind && !kindMatchesLesson(wantKind, l.tags) && !observed.some(r => r.ids.has(l.id))) continue;
    byId.set(l.id.toUpperCase(), { id: l.id.toUpperCase(), title: l.title, tags: l.tags });
  }
  for (const r of observed) {
    for (const id of r.ids) {
      if (!byId.has(id)) byId.set(id, { id, title: id, tags: [] });
    }
  }

  const allKindsInWindow = [...new Set(observed.map(r => r.kind))];
  const items: LessonStatRow[] = [];

  for (const meta of byId.values()) {
    const withRuns = observed.filter(r => r.ids.has(meta.id));
    const kindsSet = withRuns.length
      ? new Set(withRuns.map(r => r.kind))
      : new Set(wantKind ? allKindsInWindow : allKindsInWindow.filter(k => kindMatchesLesson(k, meta.tags)));
    const withoutRuns = observed.filter(r => kindsSet.has(r.kind) && !r.ids.has(meta.id));
    const withSide = summarizeSide(withRuns);
    const withoutSide = summarizeSide(withoutRuns);
    const diffPoints = withSide.first_pass_share !== undefined && withoutSide.first_pass_share !== undefined
      ? Math.round((withSide.first_pass_share - withoutSide.first_pass_share) * 1000) / 10
      : undefined;

    let label: LessonEffectLabel;
    if (withSide.judged >= 5 && withoutSide.runs === 0) {
      label = 'in every run of this kind';
    } else if (withSide.judged < 5 || withoutSide.judged < 5) {
      label = 'too few runs';
    } else {
      const diff = withSide.first_pass_share! - withoutSide.first_pass_share!;
      const bound = 1 / Math.sqrt(Math.min(withSide.judged, withoutSide.judged));
      label = Math.abs(diff) < bound ? 'no effect visible' : diff > 0 ? 'higher with it' : 'lower with it';
    }

    items.push({
      id: meta.id,
      title: meta.title,
      kinds: [...kindsSet].sort(),
      with: withSide,
      without: withoutSide,
      ...(diffPoints !== undefined ? { diff_points: diffPoints } : {}),
      label,
    });
  }

  const labelOrder: Record<LessonEffectLabel, number> = {
    'higher with it': 0,
    'lower with it': 0,
    'no effect visible': 1,
    'in every run of this kind': 2,
    'too few runs': 3,
  };
  items.sort((a, b) => {
    if (labelOrder[a.label] !== labelOrder[b.label]) return labelOrder[a.label] - labelOrder[b.label];
    if (a.diff_points !== undefined && b.diff_points !== undefined && Math.abs(b.diff_points) !== Math.abs(a.diff_points)) {
      return Math.abs(b.diff_points) - Math.abs(a.diff_points);
    }
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });

  return {
    project: project.id,
    ...(sinceIso ? { since: sinceIso } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
    runs_in_window: observed.length,
    runs_from_prompt_files: observed.filter(r => r.fromPromptFile).length,
    items,
  };
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

export function formatLessonStats(report: LessonStatsReport): string {
  const scope = [
    report.since ? `since ${report.since.slice(0, 10)}` : 'all time',
    ...(report.kind ? [`kind ${report.kind}`] : []),
    `${report.runs_in_window} run(s)`,
    `${report.runs_from_prompt_files} from prompt files`,
  ].join(', ');
  const head = t('Lessons stats ({scope}):', { scope });
  if (!report.items.length) return `${head}\n${t('(none)')}`;
  const rows = report.items.map(r => [
    r.id,
    String(r.with.runs),
    r.with.first_pass_share !== undefined ? `${pct(r.with.first_pass_share)} (${r.with.accepted_first_pass}/${r.with.judged})` : `- (0/${r.with.judged})`,
    r.without.first_pass_share !== undefined ? `${pct(r.without.first_pass_share)} (${r.without.accepted_first_pass}/${r.without.judged})` : `- (0/${r.without.judged})`,
    r.diff_points !== undefined ? `${r.diff_points >= 0 ? '+' : ''}${r.diff_points.toFixed(1)} pt` : '-',
    r.label,
  ]);
  return `${head}\n${table(['LESSON', 'CARRIED', 'WITH (1ST PASS)', 'WITHOUT (SAME KIND)', 'DIFF', 'LABEL'], rows, 60)}`;
}
