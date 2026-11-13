import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type * as A from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { OptionInput, OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { findWorktree, type Probes } from '../tick/gather.ts';

export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
export const VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
export const MEDIA_TYPES: Record<string, string> = { ...IMAGE_TYPES, ...VIDEO_TYPES };

const MAX_FILES = 500;
const MAX_DEPTH = 4;

/** An error that says the file may not be read, as opposed to not being there. */
export class FileRefused extends Error {
  readonly status: 400 | 403 | 404;
  constructor(status: 400 | 403 | 404, message: string) { super(message); this.status = status; }
}

const slash = (p: string) => p.replace(/\\/g, '/');
const realOrSelf = (p: string): string => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const fold = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase());     // Windows and macOS compare paths without case
const inside = (root: string, file: string): boolean => {
  const rel = path.relative(fold(root), fold(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The worktrees of an order: the recorded one, the one found by tag, and every worktree of the project. */
function worktreesOf(project: ProjectConfig, doc: OrderDoc | undefined, probes: Probes): string[] {
  const listed = probes.worktrees(project.root);
  const own = doc ? doc.order.worktree ?? findWorktree(doc.order.tag, listed) : undefined;
  return [...new Set([...(own ? [own] : []), ...listed.map(w => w.path)])].filter(p => existsSync(p));
}

/** The configured evidence folders of an order (existing ones only), in the order they are looked in: its worktree first, then the project. */
export function evidenceFolders(project: ProjectConfig, doc: OrderDoc | undefined, tag: string, probes: Probes): string[] {
  const found: string[] = [];
  for (const template of project.evidence?.dirs ?? []) {
    const rel = template.replace(/\{tag\}/g, tag);
    const bases = path.isAbsolute(rel) ? [''] : [...(doc ? worktreesOf(project, doc, probes).slice(0, 1) : []), project.root];
    for (const base of bases) {
      const dir = path.resolve(base, rel);
      if (existsSync(dir) && statSync(dir).isDirectory() && !found.includes(dir)) found.push(dir);
    }
  }
  return found;
}

/** The folders a file may be read from: the project, its work orders and state, every worktree, and the configured evidence folders. */
export function readableRoots(project: ProjectConfig, orders: Orders, probes: Probes): string[] {
  const roots = [project.root, project.work_orders, project.state_dir, ...probes.worktrees(project.root).map(w => w.path)];
  for (const doc of orders.all()) {
    if (doc.order.worktree) roots.push(doc.order.worktree);
    roots.push(...evidenceFolders(project, doc, doc.order.tag, probes));
  }
  return [...new Set(roots.filter(r => existsSync(r)).map(realOrSelf))];
}

/**
 * Finds the file a path names and checks that it may be read: it is an image or video, it exists, and its real location
 * (links and junctions followed) lies inside one of the readable folders. A relative path is looked for in the order's worktree
 * (when `tag` is given), then in the project.
 */
export function resolveReadable(project: ProjectConfig, orders: Orders, probes: Probes, requested: string, tag?: string): { file: string; type: string } {
  if (!requested?.trim()) throw new FileRefused(400, t('"path" is required.'));
  const ext = path.extname(requested).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) throw new FileRefused(400, t('Only images and videos can be read ({types}).', { types: Object.keys(MEDIA_TYPES).join(' ') }));
  let doc: OrderDoc | undefined;
  if (tag) { const real = orders.resolveTag(tag); doc = real ? orders.get(real) : undefined; }
  const bases = path.isAbsolute(requested) ? [''] : [...(doc ? worktreesOf(project, doc, probes) : []), project.root, project.work_orders, ...evidenceFolders(project, doc, tag ?? '', probes)];
  const candidates = bases.map(b => path.resolve(b, requested)).filter(c => existsSync(c) && statSync(c).isFile());
  if (!candidates.length) throw new FileRefused(404, t('No file {path}.', { path: requested }));
  const roots = readableRoots(project, orders, probes);
  for (const c of candidates) {
    const real = realOrSelf(c);
    if (roots.some(r => inside(r, real))) return { file: real, type };
  }
  throw new FileRefused(403, t('{path} is outside the folders of the project; it is not read.', { path: requested }));
}

/** Width and height from the file header of a png, jpeg or gif. */
export function imageSize(file: string): { width: number; height: number } | undefined {
  let buffer: Buffer;
  const fd = openSync(file, 'r');
  try {
    buffer = Buffer.alloc(Math.min(statSync(file).size, 262144));
    readSync(fd, buffer, 0, buffer.length, 0);
  } finally { closeSync(fd); }
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString('ascii', 12, 16) === 'IHDR') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'GIF') return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) { i++; continue; }
      const marker = buffer[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      const length = buffer.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      i += 2 + length;
    }
  }
  return undefined;
}

function describe(file: string, from: A.EvidenceFile['from']): A.EvidenceFile {
  const ext = path.extname(file).toLowerCase();
  const stat = statSync(file);
  const kind: A.EvidenceFile['kind'] = IMAGE_TYPES[ext] ? 'image' : VIDEO_TYPES[ext] ? 'video' : 'other';
  let size: { width: number; height: number } | undefined;
  if (kind === 'image') { try { size = imageSize(file); } catch { /* unreadable header: no size */ } }
  return { path: slash(file), name: path.basename(file), kind, size: stat.size, modified: stat.mtime.toISOString(), ...(size ?? {}), from };
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { return; }
  for (const name of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }            // a dead link
    if (stat.isDirectory()) walk(full, depth + 1, out);
    else if (MEDIA_TYPES[path.extname(name).toLowerCase()]) out.push(full);
  }
}

/** Everything an order has as evidence: files named by its reports, files in the evidence folders, and images of its questions. */
export function listEvidence(project: ProjectConfig, orders: Orders, probes: Probes, tag: string): A.EvidenceList {
  const doc = orders.get(tag);
  const roots = readableRoots(project, orders, probes);
  const seen = new Set<string>();
  const files: A.EvidenceFile[] = [];
  const add = (file: string, from: A.EvidenceFile['from']) => {
    const real = realOrSelf(file);
    if (seen.has(fold(real)) || !roots.some(r => inside(r, real))) return;
    seen.add(fold(real));
    files.push(describe(real, from));
  };
  const tryResolve = (p: string, from: A.EvidenceFile['from']) => {
    if (!MEDIA_TYPES[path.extname(p).toLowerCase()]) return;
    try { add(resolveReadable(project, orders, probes, p, doc.order.tag).file, from); } catch { /* named but not there, or not readable: not listed */ }
  };
  for (const report of [...doc.reports].sort((a, b) => b.seq - a.seq)) for (const e of report.evidence) tryResolve(e, 'report');
  const folders = evidenceFolders(project, doc, doc.order.tag, probes);
  for (const dir of folders) {
    const found: string[] = [];
    walk(dir, 0, found);
    for (const f of found) add(f, 'folder');
  }
  for (const q of doc.questions ?? []) for (const o of q.options) for (const image of o.images ?? []) tryResolve(image, 'question');
  const note = files.length ? undefined
    : project.evidence?.dirs.length ? t('Nothing found in the evidence folders {folders}, and no report names an image or video.', { folders: project.evidence.dirs.map(d => d.replace(/\{tag\}/g, doc.order.tag)).join(', ') })
    : t('No report names an image or video, and the project has no evidence folders ("evidence: dirs" in the project file).');
  return { project: project.id, tag: doc.order.tag, files, folders: folders.map(slash), ...(note ? { note } : {}) };
}

/** The images of a question's options as full paths that may be read (so a thumbnail can be shown); a path that cannot be read is an error. */
export function checkOptionImages(project: ProjectConfig, orders: Orders, probes: Probes, tag: string, options: readonly OptionInput[]): OptionInput[] {
  return options.map(o => ({
    ...o,
    ...(o.images?.length ? { images: o.images.map(p => {
      try { return slash(resolveReadable(project, orders, probes, p, tag).file); } catch (e) { return fail('The image {path} of option "{label}" cannot be used: {why}', { path: p, label: o.label, why: (e as Error).message }); }
    }) } : {}),
  }));
}
