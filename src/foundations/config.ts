import path from 'node:path';
import { fail } from '../i18n.ts';

/**
 * Foundations: documents a kind of work needs before its first content order (an art bible, a palette, a scale sheet). Optional;
 * a project without `foundations:` behaves as before. `warn` lets matching orders start and says what is missing on every tick;
 * `block` holds them back until every document is there and approved. See docs/libraries/030-design-intake.md.
 */
export type FoundationMode = 'warn' | 'block';
export interface FoundationSet { name: string; mode: FoundationMode; kinds: string[]; tags: string[]; docs: string[] }
export interface FoundationsConfig { mode: FoundationMode; sets: FoundationSet[] }

/** An order with this tag writes foundations itself and is never held back by them. */
export const FOUNDATION_TAG = 'foundation';

const MODES: FoundationMode[] = ['warn', 'block'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A document reference is a project file when it has a folder or an extension; otherwise it is a `design_docs` id. */
export const isFileRef = (ref: string): boolean => /[\\/]/.test(ref) || /\.[A-Za-z0-9]+$/.test(ref);

const words = (raw: unknown, file: string, where: string): string[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string' || !v.trim())) fail('{file}: "{where}" must be a list of words.', { file, where });
  return [...new Set((raw as string[]).map(v => v.trim().toLowerCase()))];
};

export function validateFoundations(raw: unknown, file: string): FoundationsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('{file}: "foundations" must be a mapping.', { file });
  const block = raw as Record<string, unknown>;
  const mode = block.mode ?? 'warn';
  if (!MODES.includes(mode as FoundationMode)) fail('{file}: "foundations.mode" must be warn or block.', { file });
  const sets: FoundationSet[] = [];
  for (const [name, value] of Object.entries(block)) {
    if (name === 'mode') continue;
    if (!NAME.test(name)) fail('{file}: "foundations.{name}" is not a valid set name (letters, digits, "-" and "_").', { file, name });
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('{file}: "foundations.{name}" must be a mapping with kinds or tags, and docs.', { file, name });
    const set = value as Record<string, unknown>;
    const unknown = Object.keys(set).filter(k => !['kinds', 'tags', 'docs', 'mode'].includes(k));
    if (unknown.length) fail('{file}: unknown key(s) under "foundations.{name}": {keys}.', { file, name, keys: unknown.join(', ') });
    const kinds = words(set.kinds, file, `foundations.${name}.kinds`), tags = words(set.tags, file, `foundations.${name}.tags`);
    if (!kinds.length && !tags.length) fail('{file}: "foundations.{name}" needs kinds or tags: the orders it applies to.', { file, name });
    if (!Array.isArray(set.docs) || !set.docs.length || set.docs.some(v => typeof v !== 'string' || !v.trim())) fail('{file}: "foundations.{name}.docs" must be a nonempty list of design document ids or project files.', { file, name });
    const docs = (set.docs as string[]).map(d => {
      const ref = d.trim().replace(/\\/g, '/').replace(/^\.\//, '');
      if (isFileRef(ref)) {
        if (path.isAbsolute(ref) || /^[A-Za-z]:/.test(ref) || ref.split('/').includes('..')) fail('{file}: "{where}" must be a path inside the project, "{p}" is not.', { file, where: `foundations.${name}.docs`, p: d.trim() });
      } else if (!DOC_ID.test(ref)) fail('{file}: "foundations.{name}.docs" has an invalid design document id "{id}".', { file, name, id: ref });
      return ref;
    });
    const own = set.mode ?? mode;
    if (!MODES.includes(own as FoundationMode)) fail('{file}: "foundations.{name}.mode" must be warn or block.', { file, name });
    sets.push({ name, mode: own as FoundationMode, kinds, tags, docs: [...new Set(docs)] });
  }
  if (!sets.length) fail('{file}: "foundations" names no set (for example art: { kinds: [art], docs: [art-bible] }).', { file });
  return { mode: mode as FoundationMode, sets };
}
