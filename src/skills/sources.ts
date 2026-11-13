import path from 'node:path';
import { fail } from '../i18n.ts';

/** One folder of skills the registry reads. Nothing in it is ever written. */
export interface SkillSourceConfig {
  id: string;
  dir: string;
  layout: 'dirs' | 'recursive';       // dirs: <dir>/<name>/SKILL.md; recursive: any SKILL.md below dir
  tags: string[];                     // tags for every skill of the source
  skills: Record<string, string[]>;   // extra tags by skill name
  exclude: string[];                  // skill names (or folder names) left out
  /** The engines every skill of the source is for (empty: decided per skill). */
  engines: string[];
  /** Engines by skill name, from the `skills:` mapping of the source. */
  skillEngines: Record<string, string[]>;
  /** `global`: the workers file (this machine); `project`: the project's own `skills.sources`. */
  scope: 'global' | 'project';
}

/** The engines alba knows by name. A skill for none of them is for any engine. */
export const ENGINES = ['unreal', 'unity', 'godot'] as const;
const ENGINE_ALIASES: Record<string, string> = { ue: 'unreal', ue4: 'unreal', ue5: 'unreal', 'unreal-engine': 'unreal', unrealengine: 'unreal', unity3d: 'unity', godot4: 'godot' };

/** `UE5` → `unreal`; anything else lower-cased. */
export const normalizeEngine = (word: string): string => { const w = word.trim().toLowerCase(); return ENGINE_ALIASES[w] ?? w; };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads a list of source definitions. Relative folders start at `base`. */
export function validateSourceList(list: unknown[], file: string, label: string, base: string, scope: 'global' | 'project'): SkillSourceConfig[] {
  const seen = new Set<string>();
  return list.map((s, i): SkillSourceConfig => {
    const at = `${file}: ${label}[${i}]`;
    if (!isRecord(s)) fail('{at} must be a mapping.', { at });
    const unknown = Object.keys(s).filter(k => !['id', 'dir', 'layout', 'tags', 'skills', 'exclude', 'engines'].includes(k));
    if (unknown.length) fail('{at}: unknown key(s): {keys}.', { at, keys: unknown.join(', ') });
    if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) fail('{at}: "id" must be lower-case letters, digits and "-".', { at });
    if (seen.has(s.id)) fail('{at}: source id "{id}" appears twice.', { at, id: s.id });
    seen.add(s.id);
    if (typeof s.dir !== 'string' || !s.dir.trim()) fail('{at}: "dir" must be a folder.', { at });
    if (s.layout !== undefined && s.layout !== 'dirs' && s.layout !== 'recursive') fail('{at}: "layout" must be "dirs" or "recursive".', { at });
    const words = (v: unknown, key: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) fail('{at}: "{key}" must be a list of words.', { at, key });
      return (v as string[]).map(x => x.trim());
    };
    const skills: Record<string, string[]> = {};
    const skillEngines: Record<string, string[]> = {};
    if (s.skills !== undefined) {
      if (!isRecord(s.skills)) fail('{at}: "skills" must map a skill name to {tags: [...]}.', { at });
      for (const [name, v] of Object.entries(s.skills)) {
        const tags = Array.isArray(v) ? v : isRecord(v) ? v.tags ?? [] : undefined;
        if (!Array.isArray(tags) || tags.some(x => typeof x !== 'string')) fail('{at}: "skills.{name}" needs a list "tags".', { at, name });
        skills[name] = (tags as string[]).map(x => x.trim()).filter(Boolean);
        if (isRecord(v) && v.engines !== undefined) {
          if (!Array.isArray(v.engines) || v.engines.some(x => typeof x !== 'string' || !x.trim())) fail('{at}: "skills.{name}.engines" must be a list of engines.', { at, name });
          skillEngines[name] = (v.engines as string[]).map(normalizeEngine);
        }
      }
    }
    return {
      id: s.id, dir: path.resolve(base, s.dir.trim()), layout: s.layout === 'recursive' ? 'recursive' : 'dirs', tags: words(s.tags, 'tags'), skills, exclude: words(s.exclude, 'exclude'),
      engines: words(s.engines, 'engines').map(normalizeEngine), skillEngines, scope,
    };
  });
}
