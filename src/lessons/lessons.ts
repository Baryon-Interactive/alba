import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type * as A from '../api/types.ts';
import type { LessonsConfig, ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';

/** Markdown lessons use English fields: tags, projects, level, priority, added, rule, why and check.
 * See docs/library-formats.md for the complete schema and selection rules. */
export function readLessons(cfg: LessonsConfig | undefined, project?: Pick<ProjectConfig, 'id' | 'name'>): A.Lesson[] {
  if (!cfg) return [];
  return readRaw(cfg).map(({ lesson, full }) => {
    const item: A.Lesson = { ...lesson, appliesToProject: appliesTo(lesson.projects, project), orders: [] };
    Object.defineProperty(item, 'path', { value: full, enumerable: false, configurable: true, writable: true });
    return item;
  });
}

// ------------------------------------------------------------------------------------------------------------------ reading, cached until a file changes

const cache = new Map<string, { sig: string; lessons: { lesson: A.Lesson; full: string }[] }>();

function readRaw(cfg: LessonsConfig): { lesson: A.Lesson; full: string }[] {
  const files: { file: string; full: string }[] = [];
  for (const dir of cfg.dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter(x => /\.md$/i.test(x)).sort()) files.push({ file: cfg.dirs.length > 1 ? `${path.basename(dir)}/${f}` : f, full: path.join(dir, f) });
  }
  const sig = `${cfg.format}|${files.map(f => { try { const s = statSync(f.full); return `${f.full}:${s.mtimeMs}:${s.size}`; } catch { return f.full; } }).join('|')}`;
  const key = cfg.dirs.join('|');
  const hit = cache.get(key);
  if (hit && hit.sig === sig) return hit.lessons;
  const lessons = files.flatMap(f => parseLessons(readFileSync(f.full, 'utf8'), f.file).map(lesson => ({ lesson, full: f.full })));
  cache.set(key, { sig, lessons });
  return lessons;
}

// ------------------------------------------------------------------------------------------------------------------ the alba format

const HEADING = /^#{2,4}\s+([A-Za-z]+(?:-[A-Za-z0-9]+)*-?\d+[A-Za-z]?)\b[\s:.-]*(.*)$/;
const FIELD = /^[-*]\s*(tags|projects|level|priority|added|rule|why|check):\s*(.*)$/i;
const PRIORITIES = new Set(['must', 'high', 'normal', 'low']);
const splitTags = (text: string): string[] => text.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Fenced examples are ignored. A heading and nonempty rule are required. */
export function parseLessons(markdown: string, file: string): A.Lesson[] {
  const out: A.Lesson[] = [];
  let cur: { id: string; title: string; fields: Record<string, string[]>; field?: string } | undefined;
  let fence: string | undefined;
  const flush = () => {
    if (!cur) return;
    const value = (key: string) => (cur!.fields[key] ?? []).join('\n').trim();
    if (value('rule')) {
      const id = cur.id.toUpperCase();
      let priority: A.Lesson['priority'];
      if ('priority' in cur.fields) {
        const rawPriority = value('priority');
        const normalized = rawPriority.toLowerCase();
        if (!PRIORITIES.has(normalized)) fail('{file} ({id}): "priority" must be must, high, normal or low (got "{value}").', { file, id, value: rawPriority });
        priority = normalized as A.Lesson['priority'];
      }
      let added: string | undefined;
      if ('added' in cur.fields) {
        const rawAdded = value('added');
        if (!validDate(rawAdded)) fail('{file} ({id}): "added" must be YYYY-MM-DD (got "{value}").', { file, id, value: rawAdded });
        added = rawAdded;
      }
      const projects = value('projects').split(',').map(s => s.trim()).filter(Boolean);
      out.push({ id, title: cur.title.trim() || cur.id, tags: splitTags(value('tags')), rule: value('rule'),
        ...(value('why') ? { why: value('why') } : {}), ...(value('level') ? { level: value('level') } : {}),
        ...(priority ? { priority } : {}), ...(added ? { added } : {}),
        ...(projects.length && !projects.includes('*') ? { projects } : {}), file, appliesToProject: true, orders: [] });
    }
    cur = undefined;
  };
  for (const line of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1]; else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined; continue; }
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h) { flush(); cur = { id: h[1], title: h[2], fields: {} }; continue; }
    if (/^#{1,6}\s/.test(line)) { flush(); continue; }
    if (!cur) continue;
    const field = FIELD.exec(line);
    if (field) { cur.field = field[1].toLowerCase(); cur.fields[cur.field] = field[2] ? [field[2]] : []; continue; }
    if (cur.field && line.trim()) cur.fields[cur.field].push(line.replace(/^ {2}/, '').trimEnd());
  }
  flush();
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ which lessons an order gets

/** Does a lesson meant for `projects` (absent: all) apply to this project (by id or by name)? */
export function appliesTo(projects: readonly string[] | undefined, project?: Pick<ProjectConfig, 'id' | 'name'>): boolean {
  if (!projects?.length || !project) return true;
  const mine = new Set([project.id, project.name].filter(Boolean).map(s => s.toLowerCase()));
  return projects.some(p => mine.has(p.toLowerCase()));
}

/** The lessons for an order's tags (and the ones tagged `all`), in id order. */
export function lessonsFor(all: readonly A.Lesson[], tags: readonly string[] | undefined): A.Lesson[] {
  const want = new Set((tags ?? []).map(x => x.toLowerCase()));
  return all.filter(l => l.tags.includes('all') || l.tags.some(x => want.has(x))).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** The words an order is matched on: its own tags, its kind (as classified) and what the project maps that kind to (`lessons.kind_tags`). */
export function lessonTagsOf(project: ProjectConfig, doc: OrderDoc): string[] {
  const o = doc.order;
  const kinds = [o.kind, o.routing?.kind].filter((k): k is string => !!k);
  const mapped = kinds.flatMap(k => project.lessons?.kind_tags[k] ?? []);
  return [...new Set([...(o.tags ?? []), ...(o.routing?.tags ?? []), ...kinds, ...mapped].map(x => x.toLowerCase()))];
}

/** The lessons an order's prompt carries: those of this project (or of all), matched on its tags, kind and the project's kind mapping. */
export function lessonsForOrder(project: ProjectConfig, doc: OrderDoc, all?: readonly A.Lesson[]): A.Lesson[] {
  return lessonsFor((all ?? readLessons(project.lessons, project)).filter(l => l.appliesToProject), lessonTagsOf(project, doc));
}

/** The section of a prompt that carries the lessons. Empty when there are none. A long rule is cut to `maxLines` lines. */
export function lessonsSection(lessons: readonly A.Lesson[], maxLines = 6, also: readonly string[] = []): string[] {
  if (!lessons.length && !also.length) return [];
  const body = (l: A.Lesson): string[] => {
    const lines = l.rule.split('\n');
    const kept = lines.length > maxLines ? [...lines.slice(0, maxLines), '…'] : lines;
    // a rule written as a list starts on the next line
    if (/^\s*(?:[-*]|\d+[.)])\s/.test(kept[0])) return [`- ${l.id} ${l.title}:`, ...kept.map(x => `  ${x}`)];
    return [`- ${l.id} ${l.title}: ${kept[0]}`, ...kept.slice(1).map(x => `  ${x}`)];
  };
  const head = lessons.length
    ? ['## Lessons from earlier work', '', 'These rules come from mistakes made before. Follow them.', '', ...lessons.flatMap(body)]
    : ['## Lessons from earlier work'];
  return also.length ? [...head, '', 'Also on file; read the ones that touch your work:', ...also] : head;
}

export function formatLessons(items: readonly A.Lesson[]): string {
  if (!items.length) return t('(none)');
  return items.map(l => `${l.id}  ${l.title}  [${l.tags.join(', ')}]${l.projects ? `  (${l.projects.join(', ')})` : ''}\n    ${l.rule.split('\n').join('\n    ')}${l.why ? `\n    ${t('why')}: ${l.why.split('\n').join('\n    ')}` : ''}`).join('\n');
}
