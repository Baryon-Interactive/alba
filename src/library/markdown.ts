/**
 * Sections of a Markdown file by heading anchor, the way a external tool's pages name them: the anchor of a heading is its text with the
 * inline marks taken off, lower-cased, everything but letters, digits, "-" and "_" removed, spaces turned into "-"; a heading whose
 * anchor was used before gets "-1", "-2", ... A section runs from its heading to the next heading of the same or a higher level
 * (lines of fenced code are not headings). What is cut out is the raw text, line endings and all: its sha256 is what a confirmation records.
 */

const escapeHtml = (s: string): string => s.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Anchor of a heading's text. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

/** The text of a heading as rendered: marks of emphasis, links and code taken off, `&` and the like escaped as an HTML page does. */
export function headingText(raw: string): string {
  let s = raw.replace(/\\([\\`*_{}\[\]()#+\-.!~|<>])/g, (_, c: string) => `\u0000${c.charCodeAt(0)};`);
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');                                   // an image leaves nothing
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');                                // a link keeps its words
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/`+([^`]*)`+/g, (_, code: string) => `\u0001${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}\u0002`);
  s = s.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2').replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2');
  const parts = s.split(/(\u0001[\s\S]*?\u0002)/);
  s = parts.map(p => (p.startsWith('\u0001') ? p.slice(1, -1) : escapeHtml(p))).join('');
  s = s.replace(/\u0000(\d+);/g, (_, n: string) => escapeHtml(String.fromCharCode(Number(n))));
  return s.trim();
}

export interface Heading { level: number; text: string; id: string; start: number; end: number }

/** Every top-level heading with its anchor and the offset of its first character in `source` (lines end with `\n`, `\r\n` or `\r`). */
export function headings(source: string): Heading[] {
  const lines: { text: string; start: number }[] = [];
  let last = 0;
  for (const m of source.matchAll(/\r\n|\r|\n/g)) { lines.push({ text: source.slice(last, m.index), start: last }); last = m.index! + m[0].length; }
  if (last < source.length) lines.push({ text: source.slice(last), start: last });
  const out: Heading[] = [];
  const used = new Map<string, number>();
  let fence: { ch: string; len: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && /^ {0,3}[`~]+\s*$/.test(text)) fence = undefined;
      continue;
    }
    if (f) { fence = { ch: f[1][0], len: f[1].length }; continue; }
    let level = 0; let body = '';
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(text);
    if (atx) { level = atx[1].length; body = atx[2] ?? ''; }
    else if (i + 1 < lines.length && text.trim() && !/^ {4}/.test(text) && !/^\s*([-*+]|\d+[.)])\s/.test(text) && !/^\s*>/.test(text) && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i + 1].text) && (i === 0 || lines[i - 1].text.trim() === '')) {
      level = lines[i + 1].text.trim().startsWith('=') ? 1 : 2; body = text.trim();
    }
    if (!level) continue;
    const plain = headingText(body);
    const base = slug(plain) || 'section';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    out.push({ level, text: plain, id: n ? `${base}-${n}` : base, start: lines[i].start, end: 0 });
    if (!atx) i++;
  }
  return out;
}

/** The raw text of the section with this anchor, or undefined when the file has no such heading. Without an anchor: the whole file. */
export function markdownSection(source: string, anchor?: string): string | undefined {
  if (!anchor) return source;
  const all = headings(source);
  const at = all.findIndex(h => h.id === anchor);
  if (at < 0) return undefined;
  const next = all.slice(at + 1).find(h => h.level <= all[at].level);
  return source.slice(all[at].start, next ? next.start : source.length);
}
