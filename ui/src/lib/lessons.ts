import type { Lesson } from '@api';

/** Every tag of the library with the number of lessons that carry it, most used first. */
export function tagCounts(lessons: Lesson[]): { tag: string; count: number }[] {
  const n = new Map<string, number>();
  for (const l of lessons) for (const tag of new Set(l.tags)) n.set(tag, (n.get(tag) ?? 0) + 1);
  return [...n].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Lessons with all the chosen tags (none chosen: all of them) and every word of the query in their id, title or rule; with `onlyThisProject`, only those that apply to the project. */
export function filterLessons(lessons: Lesson[], tags: string[], query = '', onlyThisProject = false): Lesson[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return lessons.filter(l => (!onlyThisProject || l.appliesToProject) && tags.every(x => l.tags.includes(x)) && words.every(w => `${l.id} ${l.title} ${l.rule}`.toLowerCase().includes(w)));
}

/** The levels of the lessons in the library (`rule`, `checklist`, ...) with how many lessons have each. */
export function levelCounts(lessons: Lesson[]): { level: string; count: number }[] {
  const n = new Map<string, number>();
  for (const l of lessons) if (l.level) n.set(l.level, (n.get(l.level) ?? 0) + 1);
  return [...n].map(([level, count]) => ({ level, count })).sort((a, b) => b.count - a.count || a.level.localeCompare(b.level));
}
