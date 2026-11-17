import { existsSync, readFileSync } from 'node:fs';
import type { OrderTemplateConfig, ProjectConfig } from '../config.ts';
import { fail } from '../i18n.ts';
import { parseOrderSections } from '../verify/verify.ts';

const SECTION_HEAD = /^##\s+(.+?)\s*$/i;
const BULLET = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/;

export interface ResolvedOrderTemplate {
  sourceKind: string;
  acceptance: string[];
  evidence: string[];
  paths: string[];
  rules: string[];
}

export const BUILTIN_DRAFTING_TEMPLATE = '## Background\n\n## Files to read\n\n## Task\n\n## Acceptance\n\n## Evidence\n\n## Hard rules\n';

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

function parseTemplateFileSections(markdown: string): Pick<ResolvedOrderTemplate, 'acceptance' | 'evidence' | 'paths' | 'rules'> {
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

function applyPlaceholders(text: string, tag: string, kind: string): string {
  return text
    .replace(/\{tag\}/g, tag)
    .replace(/\{tag_lower\}/g, tag.toLowerCase())
    .replace(/\{kind\}/g, kind);
}

function cleanBulletItem(item: string): string {
  return item.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
}

function findTemplateEntry(templates: Record<string, OrderTemplateConfig>, kind: string): { sourceKind: string; entry: OrderTemplateConfig } | undefined {
  const k = kind.trim() || 'default';
  if (Object.hasOwn(templates, k)) return { sourceKind: k, entry: templates[k] };
  const lower = Object.keys(templates).find(key => key.toLowerCase() === k.toLowerCase());
  if (lower !== undefined) return { sourceKind: lower, entry: templates[lower] };
  if (Object.hasOwn(templates, 'default')) return { sourceKind: 'default', entry: templates.default };
  return undefined;
}

/** Resolves the per-kind (or `default`) template with placeholders filled, or `undefined` when no template applies. */
export function resolveOrderTemplate(project: ProjectConfig, kind: string, tag: string): ResolvedOrderTemplate | undefined {
  const templates = project.orders?.templates;
  if (!templates) return undefined;
  const found = findTemplateEntry(templates, kind);
  if (!found) return undefined;
  const { sourceKind, entry } = found;
  const fromFile = entry.file !== undefined
    ? (() => {
        if (!existsSync(entry.file)) fail('{file}: order template file does not exist: {path}.', { file: project.file, path: entry.file });
        return parseTemplateFileSections(readFileSync(entry.file, 'utf8'));
      })()
    : { acceptance: [], evidence: [], paths: [], rules: [] };
  const effectiveKind = kind.trim() || 'default';
  const mapList = (inline: string[] | undefined, fallback: string[]) =>
    (inline !== undefined ? inline : fallback).map(item => applyPlaceholders(cleanBulletItem(item), tag, effectiveKind));
  return {
    sourceKind,
    acceptance: mapList(entry.acceptance, fromFile.acceptance),
    evidence: mapList(entry.evidence, fromFile.evidence),
    paths: mapList(entry.paths, fromFile.paths),
    rules: mapList(entry.rules, fromFile.rules),
  };
}

const TEMPLATE_SECTIONS = [
  { key: 'acceptance', title: 'Acceptance', heading: 'acceptance' },
  { key: 'evidence', title: 'Evidence', heading: 'evidence' },
  { key: 'paths', title: 'Paths', heading: 'paths' },
  { key: 'rules', title: 'Standing rules', heading: 'standing rules' },
] as const;

/**
 * Fills missing sections of an order body from `orders.templates.<kind>` (else `default`).
 * Existing sections (even empty or numbered) are never modified; missing ones go before a trailing Report section, else at the end.
 */
export function fillOrderBody(project: ProjectConfig, kind: string, tag: string, body: string): { body: string; filled: string[] } {
  if (!body.trim()) return { body, filled: [] };
  const resolved = resolveOrderTemplate(project, kind, tag);
  if (!resolved) return { body, filled: [] };
  const parsed = parseOrderSections(body);
  const headings = findSectionHeadings(body);
  const present = new Set(headings.map(h => h.name));
  if (parsed.acceptance.length) present.add('acceptance');
  if (parsed.evidence.length) present.add('evidence');
  if (parsed.allow.length || parsed.deny.length || parsed.maxLines.length) present.add('paths');

  const filled: string[] = [];
  const blocks: string[] = [];
  for (const spec of TEMPLATE_SECTIONS) {
    const items = resolved[spec.key];
    if (!items.length || present.has(spec.heading)) continue;
    filled.push(spec.title);
    blocks.push(`## ${spec.title}\n\n${items.map(item => `- ${item}`).join('\n')}`);
  }
  if (!blocks.length) return { body, filled: [] };

  const lastHeading = headings.at(-1);
  if (lastHeading && lastHeading.name.startsWith('report')) {
    const before = body.slice(0, lastHeading.offset).replace(/[ \t\r\n]+$/, '');
    const reportTail = body.slice(lastHeading.offset);
    const next = `${before ? `${before}\n\n` : ''}${blocks.join('\n\n')}\n\n${reportTail}`;
    return { body: next, filled };
  }
  const trimmed = body.replace(/[ \t\r\n]+$/, '');
  return { body: `${trimmed}\n\n${blocks.join('\n\n')}\n`, filled };
}

/** Producer drafting template when `drafting.template` is unset: built-in sections with the kind's template sections in place of empty Acceptance and Evidence. */
export function draftingTemplateFor(project: ProjectConfig, kind: string, tag: string): string {
  const resolved = resolveOrderTemplate(project, kind, tag);
  if (!resolved) return BUILTIN_DRAFTING_TEMPLATE;
  const blocks: string[] = [];
  for (const spec of TEMPLATE_SECTIONS) {
    const items = resolved[spec.key];
    if (items.length) blocks.push(`## ${spec.title}\n\n${items.map(item => `- ${item}`).join('\n')}`);
  }
  if (!blocks.length) return BUILTIN_DRAFTING_TEMPLATE;
  if (!resolved.acceptance.length) blocks.unshift('## Acceptance');
  return `## Background\n\n## Files to read\n\n## Task\n\n${blocks.join('\n\n')}\n\n## Hard rules\n`;
}
