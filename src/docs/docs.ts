// The project's Markdown documents: the list from `docs` in the project file, one file, and a full-text search.
// A search keeps an index per file and reads the file again only when its size or modified time changes.
// Reading is confined: the path has to be a listed document, or a `.md` file under the folder of one, and the real
// path (links and junctions followed) has to stay inside the project root.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import type * as A from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';

/** An error that says a document may not be read, or the query may not be run. */
export class DocsError extends Error {
  readonly status: 400 | 403 | 404;
  constructor(status: 400 | 403 | 404, message: string) { super(message); this.status = status; }
}

/** The match inside a snippet is wrapped in these two characters (they are not part of the text). */
export const DOC_MARK_START = '\u0001';
export const DOC_MARK_END = '\u0002';

const MAX_QUERY = 200;
const SNIPPET = 160;

const slash = (p: string) => p.replace(/\\/g, '/');
const realOrSelf = (p: string): string => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const fold = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase());
const inside = (root: string, file: string): boolean => {
  const rel = path.relative(fold(root), fold(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

interface Indexed {
  mtimeMs: number;
  size: number;
  text: string;
  title: string;
  headings: A.DocHeading[];
}

const indexes = new Map<string, Map<string, Indexed>>();
const reads = new Map<string, number>();

/** How many times file contents were read for this project root (a cache hit does not count). For tests. */
export function documentContentReads(root: string): number {
  return reads.get(realOrSelf(root)) ?? 0;
}

/** Drops the index of one project root, or of every project when `root` is omitted. */
export function resetDocumentIndex(root?: string): void {
  if (!root) { indexes.clear(); reads.clear(); return; }
  const key = realOrSelf(root);
  indexes.delete(key);
  reads.delete(key);
}

const R_SPECIAL = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’–—<>,.?/]+/g;
const R_COMBINING = /[\u0300-\u036f]/g;

/** A heading slug in the style of GitHub: lower case, punctuation folded to `-`, repeats get `-1`, `-2`. */
export function slugify(value: string): string {
  const s = value.normalize('NFKD').replace(R_COMBINING, '').toLowerCase().replace(R_SPECIAL, '-').replace(/^-+|-+$/g, '');
  return s || 'section';
}

function uniqueSlug(base: string, used: Map<string, number>): string {
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function plainHeading(raw: string): string {
  let s = raw.replace(/[ \t]+#+\s*$/, '').trim();
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2');
  s = s.replace(/~~([\s\S]*?)~~/g, '$1');
  s = s.replace(/<[^>]+>/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Title and level 1–3 headings. A heading inside a fenced code block is not one. The title is the first `#` heading, else the file name. */
export function parseDocument(text: string, fileName: string): { title: string; headings: A.DocHeading[] } {
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const headings: A.DocHeading[] = [];
  const used = new Map<string, number>();
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    const marker = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[2]![0] === fence.ch && marker[2]!.length >= fence.len && /^[ \t]*$/.test(marker[3] ?? '')) fence = null;
      continue;
    }
    if (marker && (marker[2]![0] === '~' || !(marker[3] ?? '').includes('`'))) { fence = { ch: marker[2]![0]!, len: marker[2]!.length }; continue; }
    const h = /^( {0,3})(#{1,3})[ \t]+(.*)$/.exec(line);
    if (!h) continue;
    const textOf = plainHeading(h[3] ?? '');
    if (!textOf) continue;
    const slug = uniqueSlug(slugify(textOf), used);
    headings.push({ level: h[2]!.length as 1 | 2 | 3, text: textOf, slug, line: i + 1 });
  }
  const title = headings.find(h => h.level === 1)?.text || fileName;
  return { title, headings };
}

function isGlob(pattern: string): boolean {
  return /[*?\[]/.test(pattern);
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = slash(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; continue; }
        re += '.*'; i++; continue;
      }
      re += '[^/]*'; continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end > i + 1) { re += '[' + g.slice(i + 1, end).replace(/[\\\]^-]/g, '\\$&') + ']'; i = end; continue; }
    }
    re += /[\\^$.|+(){}[\]]/.test(c) ? '\\' + c : c;
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

/** `.md` files under `root` matching `glob`, as paths relative to `root` with forward slashes. Directory links are not followed. */
function expandGlob(root: string, glob: string): string[] {
  const pattern = globToRegExp(glob);
  const rootReal = realOrSelf(root);
  const parts = slash(glob).split('/');
  const meta = parts.findIndex(p => /[*?\[]/.test(p));
  const prefix = (meta < 0 ? parts : parts.slice(0, meta)).filter(Boolean).join('/');
  const start = prefix ? path.join(root, prefix) : root;
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = path.join(dir, name);
      const child = rel ? `${rel}/${name}` : name;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) {
        let real: string;
        let followed: Stats;
        try { real = realpathSync(full); followed = statSync(real); } catch { continue; }
        // A link to a directory is not walked (it could leave the project or loop). A linked file is listed only when its target stays inside.
        if (!inside(rootReal, real) || !followed.isFile()) continue;
        if (pattern.test(child) && child.toLowerCase().endsWith('.md')) out.push(child);
        continue;
      }
      if (st.isDirectory()) {
        let real: string;
        try { real = realpathSync(full); } catch { continue; }
        if (!inside(rootReal, real)) continue;
        walk(full, child);
      }
      else if (st.isFile() && pattern.test(child) && child.toLowerCase().endsWith('.md')) out.push(child);
    }
  };
  walk(start, prefix);
  return out;
}

function groupOf(rel: string, research: string | undefined): A.DocEntry['group'] {
  if (!research) return 'docs';
  const folder = slash(research).replace(/\/+$/, '');
  const p = slash(rel);
  return p === folder || p.startsWith(folder + '/') ? 'research' : 'docs';
}

/** The relative path a request names, or undefined when it leaves the project (`..`, an absolute path, a scheme). */
export function normalizeDocPath(requested: string): string | undefined {
  let p = requested.trim().replace(/\\/g, '/');
  if (!p || p.includes('\0') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p) || p.startsWith('//')) return undefined;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return undefined; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function listedPaths(project: ProjectConfig): string[] {
  const cfg = project.docs;
  if (!cfg) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (rel: string) => {
    const key = fold(slash(rel));
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(slash(rel));
  };
  // Plain paths first, in the order they were written (a missing file stays). Glob matches follow, in path order.
  for (const entry of cfg.files) if (!isGlob(entry)) add(entry);
  const found: string[] = [];
  for (const entry of cfg.files) if (isGlob(entry)) found.push(...expandGlob(project.root, entry));
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const f of found) add(f);
  return out;
}

function dirOf(rel: string): string {
  const i = slash(rel).lastIndexOf('/');
  return i < 0 ? '' : slash(rel).slice(0, i);
}

function underDir(dir: string, base: string): boolean {
  const d = fold(slash(dir));
  const b = fold(slash(base));
  if (!b) return true;
  return d === b || d.startsWith(b + '/');
}

/** Listed, or a `.md` file in (or under) the folder of a listed document. */
function isAllowed(rel: string, listed: readonly string[]): boolean {
  const key = fold(slash(rel));
  if (listed.some(p => fold(p) === key)) return true;
  if (!rel.toLowerCase().endsWith('.md')) return false;
  const dir = dirOf(rel);
  // A listed document at the project root opens no folder: it would make every .md of the project readable (the state folder too).
  return listed.some(p => dirOf(p) !== '' && underDir(dir, dirOf(p)));
}

function loadIndex(root: string, rel: string, full: string, st: Stats): Indexed {
  const rootReal = realOrSelf(root);
  let bucket = indexes.get(rootReal);
  if (!bucket) { bucket = new Map(); indexes.set(rootReal, bucket); }
  const key = fold(slash(rel));
  const prev = bucket.get(key);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev;
  reads.set(rootReal, (reads.get(rootReal) ?? 0) + 1);
  const text = readFileSync(full, 'utf8');
  const parsed = parseDocument(text, path.basename(rel));
  const next: Indexed = { mtimeMs: st.mtimeMs, size: st.size, text, title: parsed.title, headings: parsed.headings };
  bucket.set(key, next);
  return next;
}

function fileStat(root: string, rel: string): { full: string; st: Stats; real: string } | undefined {
  const full = path.resolve(root, rel);
  const rootReal = realOrSelf(root);
  let st: Stats;
  try { st = statSync(full); } catch { return undefined; }
  if (!st.isFile()) return undefined;
  const real = realOrSelf(full);
  if (!inside(rootReal, real)) return undefined;
  return { full, st, real };
}

function absent(rel: string, group: A.DocEntry['group']): A.DocEntry {
  return { path: slash(rel), title: path.basename(rel), group, exists: false, bytes: 0, headings: [] };
}

function describe(project: ProjectConfig, rel: string): A.DocEntry {
  const group = groupOf(rel, project.docs?.research);
  const found = fileStat(project.root, rel);
  if (!found) return absent(rel, group);
  try {
    const idx = loadIndex(project.root, rel, found.full, found.st);
    return { path: slash(rel), title: idx.title, group, exists: true, bytes: found.st.size, modified: found.st.mtime.toISOString(), headings: idx.headings };
  } catch {
    return absent(rel, group);
  }
}

/** `GET /api/docs`. Without a `docs` section, `enabled` is false and `note` says how to turn it on. */
export function listDocuments(project: ProjectConfig): A.DocList {
  if (!project.docs) {
    return { project: project.id, enabled: false, items: [], note: t('Documents are off. Add a docs section to the project file (docs.files, and optionally docs.research).') };
  }
  return { project: project.id, enabled: true, items: listedPaths(project).map(rel => describe(project, rel)) };
}

/** `GET /api/docs/file`. Refuses a path that is not allowed or whose real location leaves the project root. */
export function readDocument(project: ProjectConfig, requested: string): A.DocFile {
  if (!project.docs) throw new DocsError(404, t('The project has no docs section.'));
  if (!requested?.trim()) throw new DocsError(400, t('"path" is required.'));
  const rel = normalizeDocPath(requested);
  if (rel === undefined) throw new DocsError(403, t('{path} is outside the folders of the project; it is not read.', { path: requested }));
  const listed = listedPaths(project);
  if (!isAllowed(rel, listed)) throw new DocsError(403, t('{path} is not a document this project lists, so it is not read.', { path: rel }));
  const found = fileStat(project.root, rel);
  if (!found) {
    // stat succeeded but the real path is outside: fileStat returns undefined for that too. Tell the two cases apart.
    const full = path.resolve(project.root, rel);
    let st: Stats | undefined;
    try { st = statSync(full); } catch { /* missing */ }
    if (st?.isFile() && !inside(realOrSelf(project.root), realOrSelf(full))) throw new DocsError(403, t('{path} is outside the folders of the project; it is not read.', { path: rel }));
    throw new DocsError(404, t('No document {path}.', { path: rel }));
  }
  const idx = loadIndex(project.root, rel, found.full, found.st);
  const canon = listed.find(p => fold(p) === fold(rel)) ?? slash(rel);
  return { project: project.id, path: canon, title: idx.title, group: groupOf(canon, project.docs.research), headings: idx.headings, markdown: idx.text };
}

function lineNumber(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function headingAbove(headings: readonly A.DocHeading[], line: number): A.DocHeading | undefined {
  let found: A.DocHeading | undefined;
  for (const h of headings) {
    if ((h.line ?? 0) <= line) found = h;
    else break;
  }
  return found;
}

function snippet(text: string, at: number, len: number): string {
  const clean = (s: string) => s.replace(/[\u0000-\u0002]/g, '').replace(/\s+/g, ' ');
  const match = text.slice(at, at + len);
  const room = Math.max(0, SNIPPET - match.length);
  const beforeN = Math.min(at, Math.floor(room / 2));
  const afterN = Math.min(text.length - (at + len), room - beforeN);
  const pre = at - beforeN > 0 ? '…' : '';
  const post = at + len + afterN < text.length ? '…' : '';
  return pre + clean(text.slice(at - beforeN, at)) + DOC_MARK_START + clean(match) + DOC_MARK_END + clean(text.slice(at + len, at + len + afterN)) + post;
}

function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** `GET /api/docs/search`. Case-insensitive substring, one hit per line, unchanged files not read again. A query of 200 characters or more is refused. */
export function searchDocuments(project: ProjectConfig, q: string, limit: number): A.DocSearch {
  if (!project.docs) throw new DocsError(404, t('The project has no docs section.'));
  if (q.length >= MAX_QUERY) throw new DocsError(400, t('A search of 200 characters or more is refused.'));
  const cap = Math.min(100, Math.max(1, limit || 30));
  const items: A.DocSearchHit[] = [];
  if (q.trim()) {
    const re = new RegExp(escapeRegExp(q), 'giu');
    for (const rel of listedPaths(project)) {
      if (items.length >= cap) break;
      const found = fileStat(project.root, rel);
      if (!found) continue;
      const idx = loadIndex(project.root, rel, found.full, found.st);
      const seen = new Set<number>();
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(idx.text)) && items.length < cap) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const line = lineNumber(idx.text, m.index);
        const nl = idx.text.indexOf('\n', m.index);
        re.lastIndex = nl < 0 ? idx.text.length : nl + 1;
        if (seen.has(line)) continue;
        seen.add(line);
        const heading = headingAbove(idx.headings, line);
        items.push({
          path: slash(rel),
          title: idx.title,
          heading: heading ? { text: heading.text, slug: heading.slug } : { text: idx.title, slug: '' },
          line,
          snippet: snippet(idx.text, m.index, m[0].length),
        });
      }
    }
  }
  return { project: project.id, q, count: items.length, items };
}
