/**
 * How a link inside a project document is opened.
 * A relative `.md` stays in the reader. A relative image or video goes through `GET /api/files`.
 * Anything that leaves the project, or uses a scheme other than http(s), is not a link.
 */
export type DocHref =
  | { kind: 'hash'; id: string }
  | { kind: 'external'; href: string }
  | { kind: 'doc'; path: string; hash: string }
  | { kind: 'file'; path: string }
  | { kind: 'blocked' };

/** The API wraps the matched text of a snippet in U+0001 and U+0002. */
export const DOC_MARK_START = '\u0001';
export const DOC_MARK_END = '\u0002';

const MEDIA = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'mp4', 'webm', 'mov']);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function decodePart(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** A path that stays inside the project, or undefined when a `..` would leave it. Leading `/` is the project root. */
function resolveInside(fromDoc: string, rel: string): string | undefined {
  const parts = rel.startsWith('/') ? [] : dirname(fromDoc).split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const path = parts.join('/');
  return path || undefined;
}

export function classifyDocHref(fromDoc: string, href: string | undefined | null): DocHref {
  const raw = href?.trim() ?? '';
  if (!raw) return { kind: 'blocked' };
  if (raw.startsWith('#')) {
    const id = decodePart(raw.slice(1));
    return id ? { kind: 'hash', id } : { kind: 'blocked' };
  }
  if (raw.startsWith('//') || raw.includes('\\') || raw.includes('\0')) return { kind: 'blocked' };
  const scheme = SCHEME.exec(raw);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    return name === 'http' || name === 'https' ? { kind: 'external', href: raw } : { kind: 'blocked' };
  }

  let body = raw;
  let hash = '';
  const hashAt = body.indexOf('#');
  if (hashAt >= 0) {
    const id = decodePart(body.slice(hashAt + 1));
    if (id === undefined) return { kind: 'blocked' };
    hash = id;
    body = body.slice(0, hashAt);
  }
  const queryAt = body.indexOf('?');
  if (queryAt >= 0) body = body.slice(0, queryAt);
  const decoded = decodePart(body);
  if (decoded === undefined || decoded.startsWith('//') || decoded.includes('\\') || decoded.includes('\0') || SCHEME.test(decoded)) return { kind: 'blocked' };
  const path = resolveInside(fromDoc, decoded);
  if (!path) return { kind: 'blocked' };
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) return { kind: 'doc', path, hash };
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  if (MEDIA.has(ext)) return { kind: 'file', path };
  return { kind: 'blocked' };
}

/** Address of the reader for one document. `hash` is a heading slug. */
export function docReaderTo(project: string, path: string, hash = ''): string {
  const base = `/p/${encodeURIComponent(project)}/docs/read?path=${encodeURIComponent(path)}`;
  return hash ? `${base}#${encodeURIComponent(hash)}` : base;
}

/**
 * Same query as `fileUrl` in `lib/api.ts` (`GET /api/files`).
 * Kept here so the reader does not load that module, which reads `document` at startup.
 */
export function docFileUrl(project: string, path: string): string {
  const u = new URLSearchParams();
  u.set('project', project);
  u.set('path', path);
  return `/api/files?${u.toString()}`;
}

export function isVideoPath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  return ext === 'mp4' || ext === 'webm' || ext === 'mov';
}

/** Split a search snippet into plain and marked runs. The marks are U+0001 and U+0002. */
export function splitSnippet(snippet: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  let i = 0;
  while (i < snippet.length) {
    const start = snippet.indexOf(DOC_MARK_START, i);
    if (start < 0) {
      out.push({ text: snippet.slice(i), mark: false });
      break;
    }
    if (start > i) out.push({ text: snippet.slice(i, start), mark: false });
    const end = snippet.indexOf(DOC_MARK_END, start + 1);
    if (end < 0) {
      out.push({ text: snippet.slice(start + 1), mark: true });
      break;
    }
    out.push({ text: snippet.slice(start + 1, end), mark: true });
    i = end + 1;
  }
  return out.filter(part => part.text.length > 0);
}
