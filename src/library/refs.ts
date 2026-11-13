import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, parseDocument, stringify } from 'yaml';
import type { ArtRef } from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import type { ArtConfig } from './config.ts';
import { fail, t } from '../i18n.ts';
import { cleanRel, inside, isObject, isText, sha256 } from './files.ts';
import { readStateJson, writeStateFile, updateStateJson } from '../orders/state-files.ts';

/** A reference picture as the board file says it. */
export interface RefEntry { id: string; image: string; page?: string; title: string; work?: string; tags: string[]; learn?: string; added?: string }

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MIN_HOST_GAP_MS = 1500;
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp' };

/** Only https, no user name in the address. Returns the parsed address. */
export function httpsUrl(value: string): URL {
  let u: URL;
  try { u = new URL(value); } catch { fail('Not an address: {value}', { value }); }
  if (u.protocol !== 'https:' || u.username || u.password) fail('Only https addresses without a user name are used: {value}', { value });
  return u;
}

/** `refs.yaml` as written; an entry that cannot be used is left out and named in `problems` (the board still shows the rest). */
export function readRefs(art: ArtConfig): { refs: RefEntry[]; problems: string[]; file: string } {
  const file = path.join(art.dir, 'refs.yaml');
  const out = { refs: [] as RefEntry[], problems: [] as string[], file };
  if (!existsSync(file)) return out;
  let raw: unknown;
  try { raw = parse(readFileSync(file, 'utf8')); } catch (e) { out.problems.push(t('refs.yaml is not valid YAML: {error}', { error: (e as Error).message.split('\n')[0] })); return out; }
  if (raw === null || raw === undefined) return out;
  if (!Array.isArray(raw)) { out.problems.push(t('refs.yaml must be a list of references')); return out; }
  const ids = new Set<string>();
  raw.forEach((v, i) => {
    const at = `refs[${i}]`;
    if (!isObject(v) || !isText(v.id) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.id)) { out.problems.push(t('{at}: "id" is missing or not letters, digits, "-" and "_"', { at })); return; }
    if (ids.has(v.id)) { out.problems.push(t('{at}: the id "{id}" is used twice', { at, id: v.id })); return; }
    ids.add(v.id);
    if (!isText(v.image)) { out.problems.push(t('{at}: "image" is missing', { at })); return; }
    const tags = Array.isArray(v.tags) ? v.tags.filter(isText).map(x => x.trim()) : isText(v.tags) ? [v.tags.trim()] : [];
    if (!tags.length) out.problems.push(t('{at}: no tags', { at }));
    out.refs.push({ id: v.id, image: v.image.trim(), ...(isText(v.page) ? { page: v.page.trim() } : {}), title: isText(v.title) ? v.title : v.id, ...(isText(v.work) ? { work: v.work } : {}), tags, ...(isText(v.learn) ? { learn: v.learn } : {}), ...(isText(v.added) ? { added: String(v.added) } : {}) });
  });
  return out;
}

/** Appends a reference to `refs.yaml` (keeps the comments and order of what is there). */
export function addRef(art: ArtConfig, entry: Omit<RefEntry, 'id' | 'added'>, now: Date = new Date()): RefEntry {
  httpsUrl(entry.image);
  if (entry.page) httpsUrl(entry.page);
  if (!entry.title.trim() || !entry.tags.length || !entry.learn?.trim()) fail('A reference needs --title, --tags and --learn (what to take from it).');
  const prior = readRefs(art).refs;
  if (prior.some(r => r.image === entry.image)) fail('The picture {image} is on the board already.', { image: entry.image });
  const ref: RefEntry = { id: `ref-${sha256(entry.image).slice(0, 10)}`, ...entry, added: now.toISOString() };
  const file = path.join(art.dir, 'refs.yaml');
  mkdirSync(path.dirname(file), { recursive: true });
  const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (old.trim() && !/^\s*(?:#.*\r?\n\s*)*-/.test(old)) { const doc = parseDocument(old); doc.add(ref); writeFileSync(file, doc.toString(), 'utf8'); return ref; }
  appendFileSync(file, (old && !old.endsWith('\n') ? '\n' : '') + stringify([ref]), 'utf8');
  return ref;
}

const decode = (v: string): string => v.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => String.fromCodePoint(n[0] === 'x' || n[0] === 'X' ? parseInt(n.slice(1), 16) : Number(n)));
const challenge = (html: string): boolean => /cf-chl-|challenge-platform|verify you are human|(?:class|id)\s*=\s*["'][^"']*(?:captcha|challenge)|<title>[^<]*(?:captcha|just a moment|access denied)/i.test(html);

/** The picture a page names in `og:image` or `twitter:image`, as an https address. A human-check page is not read. */
export function pageImage(html: string, page: string): string {
  if (challenge(html)) fail('The page asks for a human check; it is skipped.');
  const found: Record<string, string> = {};
  for (const tag of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4]);
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (['og:image', 'twitter:image', 'twitter:image:src'].includes(key) && attrs.content) found[key] = attrs.content;
  }
  const value = found['og:image'] ?? found['twitter:image'] ?? found['twitter:image:src'];
  if (!value) fail('The page has no og:image or twitter:image.');
  const url = new URL(value, page).href;
  httpsUrl(url);
  return url;
}

export interface CacheEntry { image: string; file: string; bytes: number; at: string }
export interface RefFailure { id: string; image: string; reason: string; status?: number; at: string }

/** The folder of fetched pictures of a project: `<state_dir>/refs/`. */
export const cacheDir = (project: ProjectConfig): string => path.join(project.state_dir, 'refs');

const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; } };

/** Index of fetched pictures by address (`index.json`). */
export const cacheIndex = (dir: string, project?: ProjectConfig): Record<string, CacheEntry> => readStateJson(project ?? path.dirname(dir), 'refs/index.json', {});
export const cacheFailures = (dir: string, project?: ProjectConfig): RefFailure[] => readStateJson(project ?? path.dirname(dir), 'refs/failures.json', []);

interface ExternalCacheEntry { image: string; file: string }

/** Where the picture of `ref` is kept, if anywhere: first the project's own cache, then (read only) the cache of another tool the project names. */
export function cachedFile(project: ProjectConfig, ref: { id: string; image: string }): { file: string; from: 'alba' | 'external' } | undefined {
  const dir = cacheDir(project);
  const own = cacheIndex(dir, project)[ref.image];
  if (own && cleanRel(own.file) && existsSync(path.join(dir, own.file))) return { file: path.join(dir, own.file), from: 'alba' };
  const reuse = project.art?.reuse_cache;
  if (reuse) {
    const index = readJson<Record<string, ExternalCacheEntry>>(path.join(reuse, 'index.json'), {});
    const entry = index[ref.image];
    if (entry && cleanRel(entry.file)) {
      const full = path.resolve(reuse, entry.file);
      if (inside(path.resolve(reuse), full) && existsSync(full) && statSync(full).isFile()) return { file: full, from: 'external' };
    }
  }
  return undefined;
}

export interface Fetching {
  /** Replaceable for tests: the global `fetch` by default. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Downloads with the manners of a guest: https only, one request per host every 1.5 seconds, redirects checked, images only, at most 15 MB, no human-check pages. */
export class RefClient {
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastByHost = new Map<string, number>();
  readonly requests: string[] = [];
  constructor(options: Fetching = {}) {
    this.transport = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  async get(url: string, options: { image: boolean; max?: number }): Promise<{ bytes: Buffer; status: number; type: string; url: string }> {
    const max = options.max ?? (options.image ? MAX_IMAGE_BYTES : 2 * 1024 * 1024);
    for (let hop = 0; hop < 6; hop++) {
      const u = httpsUrl(url);
      const last = this.lastByHost.get(u.hostname);
      if (last !== undefined) await this.sleep(Math.max(0, MIN_HOST_GAP_MS - (this.now() - last)));
      this.lastByHost.set(u.hostname, this.now());
      this.requests.push(url);
      const res = await this.transport(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'alba (local art research)' } });
      const refuse = (reason: string): never => { throw Object.assign(new Error(t('HTTP {status} {url}: {reason}', { status: res.status, url, reason })), { status: res.status }); };
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { await res.body?.cancel(); url = new URL(res.headers.get('location')!, url).href; continue; }
      if (!res.ok) { await res.body?.cancel(); refuse(t('the request failed; skipped')); }
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (options.image && !type.startsWith('image/')) { await res.body?.cancel(); refuse(t('not a picture, or a human-check page')); }
      if (Number(res.headers.get('content-length')) > max) { await res.body?.cancel(); refuse(t('the file is over the size limit')); }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (!reader) refuse(t('an empty answer'));
      try {
        for (;;) {
          const { done, value } = await reader!.read();
          if (done) break;
          size += value.length;
          if (size > max) { await reader!.cancel(); refuse(t('the file is over the size limit')); }
          chunks.push(value);
        }
      } finally { reader!.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      if (!options.image && challenge(bytes.toString('utf8'))) refuse(t('a human-check page; skipped'));
      return { bytes, status: res.status, type, url };
    }
    fail('Too many redirects.');
  }
}

export interface FetchResult { fetched: number; reused: number; skipped: number; failed: number; failures: RefFailure[] }

/** Fetches every picture of the board that is not kept yet. A picture that cannot be had goes to `failures.json` with the reason; the others go on. */
export async function fetchRefs(project: ProjectConfig, client: RefClient = new RefClient(), now: () => string = () => new Date().toISOString()): Promise<FetchResult> {
  if (!project.art) fail('The project file has no "art" section.');
  const dir = cacheDir(project);
  mkdirSync(dir, { recursive: true });
  const index = cacheIndex(dir, project);
  const failures: RefFailure[] = [];
  let fetched = 0, reused = 0, skipped = 0;
  for (const r of readRefs(project.art).refs) {
    let status: number | undefined;
    try {
      httpsUrl(r.image);
      const have = cachedFile(project, r);
      if (have) { have.from === 'alba' ? skipped++ : reused++; continue; }
      const res = await client.get(r.image, { image: true });
      status = res.status;
      const ext = IMAGE_EXT[res.type] ?? 'img';
      const file = `${sha256(res.bytes)}.${ext}`;
      if (!existsSync(path.join(dir, file))) writeFileSync(path.join(dir, file), res.bytes);
      index[r.image] = { image: r.image, file, bytes: res.bytes.length, at: now() };
      updateStateJson<Record<string, CacheEntry>>(project, 'refs/index.json', {}, current => ({ ...current, [r.image]: index[r.image] }));
      fetched++;
    } catch (e) {
      failures.push({ id: r.id, image: r.image, reason: (e as Error).message, ...((e as { status?: number }).status ?? status ? { status: (e as { status?: number }).status ?? status } : {}), at: now() });
    }
  }
  writeStateFile(project, 'refs/failures.json', JSON.stringify(failures, null, 2));
  return { fetched, reused, skipped, failed: failures.length, failures };
}

/** The board as the console shows it. */
export function refCards(project: ProjectConfig): { refs: ArtRef[]; problems: string[] } {
  if (!project.art) return { refs: [], problems: [] };
  const { refs, problems } = readRefs(project.art);
  const failures = new Map(cacheFailures(cacheDir(project), project).map(f => [f.id, f.reason]));
  return {
    problems,
    refs: refs.map(r => {
      const have = cachedFile(project, r);
      const own: string[] = [];
      try { httpsUrl(r.image); } catch { own.push(t('the picture address is not https')); }
      return {
        id: r.id, image: r.image, ...(r.page ? { page: r.page } : {}), title: r.title, ...(r.work ? { work: r.work } : {}), tags: r.tags, ...(r.learn ? { learn: r.learn } : {}), ...(r.added ? { added: r.added } : {}),
        cached: Boolean(have), ...(have ? { cacheFrom: have.from } : {}), ...(!have && failures.has(r.id) ? { failure: failures.get(r.id) } : {}), problems: own,
      };
    }),
  };
}
