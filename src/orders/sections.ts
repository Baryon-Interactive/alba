const SECTION_HEAD = /^##\s+(.+?)\s*$/i;
const BULLET = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/;

/** Normalizes a `## ...` heading the same way `parseOrderSections` in `src/verify/verify.ts` does. */
export function normalizeSectionHeading(rawHeading: string): string {
  return rawHeading
    .trim()
    .toLowerCase()
    .replace(/^\d+[.)]?\s+/, '')
    .replace(/\s*(?:\(.*|:.*|\s[-\u2013\u2014]\s.*)$/, '')
    .trim();
}

export function findSectionHeadings(markdown: string): { name: string; raw: string; offset: number }[] {
  const out: { name: string; raw: string; offset: number }[] = [];
  const text = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;
  const bomShift = markdown.length - text.length;
  let pos = 0;
  for (const line of text.split('\n')) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    const h = SECTION_HEAD.exec(clean);
    if (h) out.push({ name: normalizeSectionHeading(h[1]), raw: clean, offset: bomShift + pos });
    pos += line.length + 1;
  }
  return out;
}

export function parseTemplateFileSections(markdown: string) {
  let section = '';
  const acceptance: string[] = [];
  const evidence: string[] = [];
  const paths: string[] = [];
  const rules: string[] = [];
  for (const raw of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const h = SECTION_HEAD.exec(raw);
    if (h) {
      section = normalizeSectionHeading(h[1]);
      continue;
    }
    const b = BULLET.exec(raw);
    if (!b) continue;
    const item = b[1].trim();
    if (section === 'acceptance') acceptance.push(item);
    else if (section === 'evidence') evidence.push(item);
    else if (section === 'paths') paths.push(item);
    else if (section === 'standing rules') rules.push(item);
  }
  return { acceptance, evidence, paths, rules };
}
