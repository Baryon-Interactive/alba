import path from 'node:path';
import type * as A from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { loadMachines } from '../machines/config.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { WorkerConfig, WorkersFile } from '../workers/config.ts';
import { lessonsForOrder, lessonsSection, readLessons } from './lessons.ts';

export interface LessonRun {
  engine?: string;
  family?: string;
  os?: string;
  remote?: boolean;
}

export interface LessonSelection {
  mounted: A.Lesson[];
  listed: A.Lesson[];
  bytes: number;
  over_budget: boolean;
  /** Rendered lines of the prompt's lessons section (mounted rules and optional "Also on file" trailer). */
  section: string[];
}

export const hostOs = (): 'windows' | 'linux' | 'macos' | undefined =>
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined;

/** Resolves run-tag attributes (`engine`, `family`, `os`, `remote`) for a worker and its machine. */
export function workerLessonRun(project: ProjectConfig, worker: WorkerConfig | undefined, workersFile?: string, remoteOs?: 'windows' | 'linux' | 'macos'): LessonRun {
  if (!worker) return {};
  let os: string | undefined = remoteOs;
  if (!os) {
    try {
      const machines = loadMachines(project, workersFile).machines;
      os = worker.host ? machines.find(m => m.id === worker.host)?.os : (machines.find(m => 'local' in m.connect)?.os ?? hostOs());
    } catch {
      os = worker.host ? undefined : hostOs();
    }
  }
  return {
    engine: worker.engine,
    ...(worker.model_family ? { family: worker.model_family } : {}),
    ...(os ? { os } : {}),
    ...(worker.host || remoteOs ? { remote: true } : {}),
  };
}

/** Resolves run-tag attributes for a worker id or alias when a workers file is available (`alba prompt`). */
export function lessonRunFor(project: ProjectConfig, workers: WorkersFile | undefined, workerId: string | undefined): LessonRun {
  if (!workers || !workerId) return {};
  const worker = workers.workers.find(w => w.id === workerId || w.aliases.includes(workerId));
  return workerLessonRun(project, worker, workers.file);
}

/**
 * Selects and ranks lessons for an order's run within `lessons.max_bytes` and `lessons.max_items`.
 * When both limits are 0, returns today's exact `lessonsForOrder` output with no run tags, ranking or list.
 */
export function selectLessons(project: ProjectConfig, doc: OrderDoc, run: LessonRun = {}, all?: readonly A.Lesson[]): LessonSelection {
  if (!project.lessons && !all) return { mounted: [], listed: [], bytes: 0, over_budget: false, section: [] };
  const maxRuleLines = project.lessons?.max_rule_lines ?? 6;
  const maxBytes = project.lessons?.max_bytes ?? 6000;
  const maxItems = project.lessons?.max_items ?? 15;

  if (maxBytes === 0 && maxItems === 0) {
    const mounted = lessonsForOrder(project, doc, all);
    const section = lessonsSection(mounted, maxRuleLines);
    const bytes = section.length ? Buffer.byteLength(section.join('\n'), 'utf8') : 0;
    return { mounted, listed: [], bytes, over_budget: false, section };
  }

  const source = all ?? readLessons(project.lessons, project);
  const filePos = new Map<A.Lesson, number>();
  const seenInFile = new Map<string, number>();
  for (const l of source) {
    const key = l.path ?? l.file;
    const idx = seenInFile.get(key) ?? 0;
    filePos.set(l, idx);
    seenInFile.set(key, idx + 1);
  }

  const o = doc.order;
  const kinds = [o.kind, o.routing?.kind].filter((k): k is string => !!k);
  const ownTags = new Set([...(o.tags ?? []), ...(o.routing?.tags ?? []), ...kinds].map(x => x.trim().toLowerCase()).filter(Boolean));
  const mappedTags = new Set(kinds.flatMap(k => project.lessons?.kind_tags[k] ?? project.lessons?.kind_tags[k.toLowerCase()] ?? []).map(x => x.trim().toLowerCase()).filter(Boolean));
  const runTags = new Set<string>();
  if (run.engine?.trim()) {
    const eng = run.engine.trim().toLowerCase();
    runTags.add(eng);
    if (eng.endsWith('-cli') && eng.length > 4) runTags.add(eng.slice(0, -4));
  }
  if (run.family?.trim()) runTags.add(run.family.trim().toLowerCase());
  if (run.os?.trim()) runTags.add(run.os.trim().toLowerCase());

  const tagClass = (tag: string): number =>
    ownTags.has(tag) ? 3 : runTags.has(tag) ? 2 : mappedTags.has(tag) ? 1 : tag === 'all' ? 0 : -1;

  const levelOrder = (project.lessons?.level_order ?? []).map(x => x.trim().toLowerCase());
  const prioScore: Record<NonNullable<A.Lesson['priority']>, number> = { must: 3, high: 2, normal: 1, low: 0 };
  const levelScore = (level: string | undefined): number => {
    if (!levelOrder.length || !level?.trim()) return 0;
    const idx = levelOrder.indexOf(level.trim().toLowerCase());
    return idx >= 0 ? levelOrder.length - idx : 0;
  };

  const scored = source
    .filter(l => l.appliesToProject)
    .map(lesson => {
      const uniqueTags = [...new Set(lesson.tags.map(t => t.toLowerCase()))];
      const matched = uniqueTags.map(tagClass).filter(c => c >= 0);
      if (!matched.length) return undefined;
      return {
        lesson,
        must: lesson.priority === 'must' ? 1 : 0,
        bestClass: Math.max(...matched),
        matchedCount: matched.length,
        prio: prioScore[lesson.priority ?? 'normal'],
        level: levelScore(lesson.level),
        pos: filePos.get(lesson) ?? 0,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined);

  scored.sort((a, b) => {
    if (a.must !== b.must) return b.must - a.must;
    if (a.bestClass !== b.bestClass) return b.bestClass - a.bestClass;
    if (a.matchedCount !== b.matchedCount) return b.matchedCount - a.matchedCount;
    if (a.prio !== b.prio) return b.prio - a.prio;
    if (a.level !== b.level) return b.level - a.level;
    if (a.lesson.added && b.lesson.added) {
      if (a.lesson.added !== b.lesson.added) return b.lesson.added.localeCompare(a.lesson.added);
    } else if (a.lesson.added !== b.lesson.added) {
      return a.lesson.added ? -1 : 1;
    }
    if (a.pos !== b.pos) return b.pos - a.pos;
    return a.lesson.id.localeCompare(b.lesson.id, undefined, { numeric: true });
  });
  const candidates = scored.map(x => x.lesson);

  const whereOf = (l: A.Lesson): string => {
    const full = l.path ?? path.resolve(project.lessons?.dir ?? project.root, l.file);
    const rel = path.relative(project.root, full).replace(/\\/g, '/');
    const inside = !!rel && !path.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel) && rel !== '..' && !rel.startsWith('../');
    if (inside) return rel;
    return run.remote ? 'on the alba machine' : full.replace(/\\/g, '/');
  };

  const alsoLines = (listed: readonly A.Lesson[]): string[] => {
    if (!listed.length) return [];
    const shown = listed.slice(0, 30).map(l => `- ${l.id} ${l.title} (${whereOf(l)})`);
    const more = listed.length - shown.length;
    return more > 0 ? [...shown, `and ${more} more: alba lessons --order ${doc.order.tag}`] : shown;
  };

  const render = (mountedSet: ReadonlySet<A.Lesson>) => {
    const mounted = candidates.filter(c => mountedSet.has(c));
    const listed = candidates.filter(c => !mountedSet.has(c));
    const section = lessonsSection(mounted, maxRuleLines, alsoLines(listed));
    const bytes = section.length ? Buffer.byteLength(section.join('\n'), 'utf8') : 0;
    return { mounted, listed, section, bytes };
  };

  const mountedSet = new Set<A.Lesson>(candidates.filter(c => c.priority === 'must'));
  const mustCount = mountedSet.size;
  const mustOnlyBytes = mustCount > 0 ? Buffer.byteLength(lessonsSection([...mountedSet], maxRuleLines).join('\n'), 'utf8') : 0;
  let current = render(mountedSet);
  const overBudget = mustCount > 0 && ((maxItems > 0 && mustCount > maxItems) || (maxBytes > 0 && (mustOnlyBytes > maxBytes || current.bytes > maxBytes)));

  for (const candidate of candidates) {
    if (mountedSet.has(candidate)) continue;
    if (maxItems > 0 && mountedSet.size + 1 > maxItems) continue;
    const trial = new Set(mountedSet);
    trial.add(candidate);
    const next = render(trial);
    if (maxBytes > 0 && next.bytes > maxBytes) continue;
    mountedSet.add(candidate);
    current = next;
  }

  return { mounted: current.mounted, listed: current.listed, bytes: current.bytes, over_budget: overBudget, section: current.section };
}
