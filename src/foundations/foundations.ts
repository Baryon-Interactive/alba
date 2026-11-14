import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { listDesignDocsReadOnly } from '../design/docs.ts';
import { t } from '../i18n.ts';
import { backendName } from '../orders/backend.ts';
import type { OrderDoc } from '../orders/model.ts';
import { kindOfOrder } from '../resources/leases.ts';
import { routingOf } from '../routing/classify.ts';
import { FOUNDATION_TAG, isFileRef, type FoundationSet } from './config.ts';

export { FOUNDATION_TAG, isFileRef, validateFoundations, type FoundationMode, type FoundationSet, type FoundationsConfig } from './config.ts';

export type FoundationDocStatus = 'approved' | 'present' | 'draft' | 'retired' | 'empty' | 'missing';
export interface FoundationDocState {
  ref: string;
  /** `design-doc`: an entry of `design_docs` (file or database); `file`: a project file named by path; `none`: found nowhere. */
  source: 'design-doc' | 'file' | 'none';
  status: FoundationDocStatus;
  ok: boolean;
  path?: string;
  title?: string;
}
export interface FoundationSetState extends FoundationSet { ready: boolean; documents: FoundationDocState[] }

function fileState(project: ProjectConfig, rel: string): 'present' | 'empty' | 'missing' {
  const file = path.resolve(project.root, rel);
  if (!existsSync(file)) return 'missing';
  try { return readFileSync(file, 'utf8').trim() ? 'present' : 'empty'; } catch { return 'missing'; }
}

/** The state of every foundation set of the project: each document and whether all of them are there and approved. */
export function foundationStates(project: ProjectConfig): FoundationSetState[] {
  const config = project.foundations;
  if (!config) return [];
  let stored: Map<string, { status: string; title: string }> | undefined;
  // Database documents (`alba design-docs import`) are read only when a reference is not in the project file; a project without
  // SQLite state has none.
  const database = () => {
    if (stored) return stored;
    stored = new Map();
    if (backendName(project) !== 'sqlite') return stored;
    try { for (const d of listDesignDocsReadOnly(project)) if (d.source === 'db') stored.set(d.id, { status: d.status, title: d.title }); } catch { /* no design documents yet */ }
    return stored;
  };
  const one = (ref: string): FoundationDocState => {
    const entry = project.design_docs?.files.find(f => f.id === ref);
    if (entry) {
      const there = fileState(project, entry.path ?? '');
      const status: FoundationDocStatus = there === 'present' ? entry.status : there;
      return { ref, source: 'design-doc', status, ok: status === 'approved', ...(entry.path ? { path: entry.path } : {}), ...(entry.title ? { title: entry.title } : {}) };
    }
    if (isFileRef(ref)) {
      const status = fileState(project, ref);
      return { ref, source: 'file', status, ok: status === 'present', path: ref };
    }
    const row = database().get(ref);
    if (row) return { ref, source: 'design-doc', status: row.status as FoundationDocStatus, ok: row.status === 'approved', title: row.title };
    return { ref, source: 'none', status: 'missing', ok: false };
  };
  return config.sets.map(set => {
    const documents = set.docs.map(one);
    return { ...set, documents, ready: documents.every(d => d.ok) };
  });
}

/** What an order is for the foundations: its kind (after classification) and its tags (its own and the classifier's). */
export function orderTraits(project: ProjectConfig, doc: OrderDoc): { kind: string; tags: string[] } {
  let routed: string[] = [];
  try { routed = routingOf(project, doc).tags; } catch { /* no rules */ }
  return { kind: kindOfOrder(project, doc), tags: [...new Set([...(doc.order.tags ?? []), ...routed].map(x => x.toLowerCase()))] };
}

/** The sets that apply to an order of this kind and these tags and are not ready. An order tagged `foundation` has none. */
export function foundationGaps(states: FoundationSetState[], traits: { kind: string; tags: string[] }): FoundationSetState[] {
  const tags = traits.tags.map(x => x.toLowerCase());
  if (tags.includes(FOUNDATION_TAG)) return [];
  const kind = traits.kind.toLowerCase();
  return states.filter(s => !s.ready && (s.kinds.includes(kind) || s.tags.some(x => tags.includes(x))));
}

const statusWord = (s: FoundationDocStatus): string => ({ approved: t('approved'), present: t('present'), draft: t('draft, not approved'), retired: t('retired'), empty: t('empty'), missing: t('missing') })[s];

/** "art-bible: missing, palette: draft, not approved" */
export function missingText(set: FoundationSetState): string {
  return set.documents.filter(d => !d.ok).map(d => `${d.ref}: ${statusWord(d.status)}`).join('; ');
}

/** Why a matching order cannot start (block mode), or undefined. */
export function foundationBlock(project: ProjectConfig, doc: OrderDoc): string | undefined {
  if (!project.foundations) return undefined;
  const gap = foundationGaps(foundationStates(project), orderTraits(project, doc)).find(s => s.mode === 'block');
  return gap ? t('the "{set}" foundations are not ready ({missing})', { set: gap.name, missing: missingText(gap) }) : undefined;
}

/** A line for a person who just added an order the foundations apply to, or undefined. */
export function foundationNotice(project: ProjectConfig, doc: OrderDoc): string | undefined {
  if (!project.foundations) return undefined;
  const gaps = foundationGaps(foundationStates(project), orderTraits(project, doc));
  if (!gaps.length) return undefined;
  return gaps.map(set => set.mode === 'block'
    ? t('The "{set}" foundations are not ready ({missing}): {tag} will not start until they are (alba foundations).', { set: set.name, missing: missingText(set), tag: doc.order.tag })
    : t('The "{set}" foundations are not ready ({missing}): write and approve them before content orders (alba foundations).', { set: set.name, missing: missingText(set) })).join('\n');
}

/** `alba foundations`: each set, its documents and the orders it holds back or warns about. */
export function formatFoundations(project: ProjectConfig, states: FoundationSetState[], affected: Record<string, { tag: string; stage: string }[]>): string {
  if (!project.foundations) return t('{file} has no "foundations:" section; orders start without foundation documents.', { file: project.file });
  const out: string[] = [];
  for (const s of states) {
    const which = [s.kinds.length ? t('kinds {list}', { list: s.kinds.join(', ') }) : '', s.tags.length ? t('tags {list}', { list: s.tags.join(', ') }) : ''].filter(Boolean).join('; ');
    out.push(`${s.name}  [${s.mode}]  ${which}  ${s.ready ? t('ready') : t('NOT READY')}`);
    const width = Math.max(...s.documents.map(d => d.ref.length));
    for (const d of s.documents) out.push(`  ${d.ok ? 'ok' : '--'}  ${d.ref.padEnd(width)}  ${statusWord(d.status)}${d.source === 'none' ? `  ${t('(not in design_docs, and not a file path)')}` : ''}${d.path && d.path !== d.ref ? `  ${d.path}` : ''}`);
    const orders = affected[s.name] ?? [];
    if (!s.ready && orders.length) out.push(`  ${s.mode === 'block' ? t('held back:') : t('going ahead without them:')} ${orders.map(o => `${o.tag} (${o.stage})`).join(', ')}`);
  }
  return out.join('\n');
}
