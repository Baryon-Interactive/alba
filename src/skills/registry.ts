import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { OrderSkill, SkillInfo, SkillLayer, SkillSourceInfo } from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import { kindForFit } from '../routing/kinds.ts';
import { ENGINES, normalizeEngine, validateSourceList, type SkillSourceConfig } from './sources.ts';

export type { SkillSourceConfig } from './sources.ts';

export interface SkillsRegistryConfig { sources: SkillSourceConfig[]; files: string[] }

/** The skill every run gets. It ships with the tool (templates/skills). */
export const CORE_SKILL = 'alba-worker-rules';
const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/skills');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads the `sources` list of a `skills:` block (in the workers file) or of a `skills.yaml`. Relative folders start at the file's folder. */
export function validateSkillSources(raw: unknown, file: string): SkillsRegistryConfig {
  const base = path.dirname(path.resolve(file));
  if (!isRecord(raw)) fail('{file}: "skills" must be a mapping with a list "sources".', { file });
  const unknownTop = Object.keys(raw).filter(k => k !== 'sources');
  if (unknownTop.length) fail('{file}: unknown key(s) under "skills": {keys}.', { file, keys: unknownTop.join(', ') });
  if (!Array.isArray(raw.sources)) fail('{file}: "skills.sources" must be a list of folders.', { file });
  const sources = validateSourceList(raw.sources, file, 'skills.sources', base, 'global');
  return { sources, files: [path.resolve(file)] };
}

/** The workers file's own `skills:` block and the `skills.yaml` next to it, put together. */
export function loadSkillsConfig(workersFile: string, inline: unknown): SkillsRegistryConfig | undefined {
  const parts: SkillsRegistryConfig[] = [];
  if (inline !== undefined) parts.push(validateSkillSources(inline, workersFile));
  const sibling = path.join(path.dirname(path.resolve(workersFile)), 'skills.yaml');
  if (existsSync(sibling)) {
    let raw: unknown;
    try { raw = parse(readFileSync(sibling, 'utf8')); } catch (e) { fail('{file} is not valid YAML: {error}', { file: sibling, error: (e as Error).message }); }
    parts.push(validateSkillSources(raw ?? { sources: [] }, sibling));
  }
  if (!parts.length) return undefined;
  const ids = new Set<string>();
  for (const p of parts) for (const s of p.sources) {
    if (ids.has(s.id)) fail('skill source id "{id}" is defined in both {a} and {b}.', { id: s.id, a: workersFile, b: sibling });
    ids.add(s.id);
  }
  return { sources: parts.flatMap(p => p.sources), files: parts.flatMap(p => p.files) };
}

// ------------------------------------------------------------------------------------------------------------------ reading

export interface RegistrySkill extends SkillInfo {
  skillFile: string;
  core: boolean;
  /** One of Alba's built-in skills other than the core rules: used only where it is named, never by a tag. */
  library?: boolean;
  /** Can the project use it (always true when the registry was read without a project). */
  applicable: boolean;
  inapplicable?: string;
}
export interface Registry { sources: SkillSourceInfo[]; skills: RegistrySkill[]; problems: string[] }

const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** The simple `key: value` lines of a front matter that is not valid YAML (a value may contain colons). */
function lineByLine(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** `name`, `description` and `tags` out of the front matter of a SKILL.md. */
export function readFrontMatter(text: string): { name?: string; description?: string; tags: string[]; engines: string[] } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { tags: [], engines: [] };
  let v: unknown;
  try { v = parse(m[1]); } catch { v = lineByLine(m[1]); }     // real skills often have a colon in the description, which is not valid YAML
  if (!isRecord(v)) return { tags: [], engines: [] };
  const tags = Array.isArray(v.tags) ? v.tags.map(String) : typeof v.tags === 'string' ? v.tags.replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean) : [];
  const meta = isRecord(v.metadata) && typeof v.metadata.tags === 'string' ? v.metadata.tags.split(/[,\s]+/).filter(Boolean) : [];
  const wordsOf = (x: unknown): string[] => Array.isArray(x) ? x.map(String) : typeof x === 'string' ? x.replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean) : [];
  const engines = [...wordsOf(v.engines), ...wordsOf(v.engine), ...(isRecord(v.metadata) ? [...wordsOf(v.metadata.engines), ...wordsOf(v.metadata.engine)] : [])].map(normalizeEngine).filter(Boolean);
  return { ...(typeof v.name === 'string' ? { name: v.name.trim() } : {}), ...(typeof v.description === 'string' ? { description: v.description.trim().replace(/\s+/g, ' ') } : {}), tags: [...tags, ...meta].map(x => x.trim().toLowerCase()).filter(Boolean), engines };
}

/** Counts the files and bytes a skill folder would copy. */
export function folderSize(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files++; bytes += statSync(p).size; }
    }
  };
  try { walk(dir); } catch { /* unreadable: counted as far as it went */ }
  return { files, bytes };
}

function skillFilesOf(source: SkillSourceConfig): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md') && d !== source.dir) { out.push(path.join(d, 'SKILL.md')); return; }
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && (source.layout === 'recursive' || depth === 0)) walk(path.join(d, e.name), depth + 1);
  };
  walk(source.dir, 0);
  return out.sort();
}

/** The engines named by the folders a skill sits in below its source (`unity/`, `godot/`, `ue/` in a library that groups by engine). */
function enginesFromPath(source: SkillSourceConfig, skillFile: string): string[] {
  const parents = path.relative(source.dir, path.dirname(skillFile)).split(/[\\/]/).slice(0, -1);
  return parents.map(normalizeEngine).filter(w => (ENGINES as readonly string[]).includes(w));
}

/** The engines a skill names without declaring them: a whole word of its name or one of its tags (`unity-ui`, `godot-dev-guide`, `ue5`). */
function enginesFromWords(words: readonly string[]): string[] {
  return words.flatMap(w => w.toLowerCase().split(/[^a-z0-9]+/)).map(normalizeEngine).filter(w => (ENGINES as readonly string[]).includes(w));
}

/** The words of a rule list (`skills.include` / `skills.exclude`) that a skill matches: its name, or one of its tags. */
export function ruleMatch(skill: Pick<RegistrySkill, 'name' | 'tags'>, rules: readonly string[]): { by: 'name' | 'tag'; word: string } | undefined {
  const name = skill.name.toLowerCase();
  const tags = skill.tags.map(x => x.toLowerCase());
  for (const rule of rules) {
    const w = rule.trim().toLowerCase();
    if (w === name) return { by: 'name', word: rule };
    if (tags.includes(w)) return { by: 'tag', word: rule };
  }
  return undefined;
}

/** What decides whether a global skill is for a project: its engine, and the project's include and exclude (exclude wins, then include, then the engine). */
export interface SkillFilter { engine?: string; include: readonly string[]; exclude: readonly string[] }

export const filterOf = (project: Pick<ProjectConfig, 'skills'> | undefined): SkillFilter => ({ engine: project?.skills?.engine, include: project?.skills?.include ?? [], exclude: project?.skills?.exclude ?? [] });

/** Can the project use this skill, and if not, why. The tool's own skill and the project's own skills always pass. */
export function applicability(skill: Pick<RegistrySkill, 'name' | 'tags' | 'engines' | 'scope' | 'core'>, filter: SkillFilter): { applicable: boolean; inapplicable?: string } {
  if (skill.core || skill.scope === 'project') return { applicable: true };
  const out = ruleMatch(skill, filter.exclude);
  if (out) return { applicable: false, inapplicable: out.by === 'name' ? t('excluded by name') : t('excluded by tag {tag}', { tag: out.word }) };
  if (ruleMatch(skill, filter.include)) return { applicable: true };
  const engine = filter.engine ? normalizeEngine(filter.engine) : undefined;
  if (engine && engine !== 'any' && skill.engines.length && !skill.engines.includes(engine)) return { applicable: false, inapplicable: t('for {engines}, the project is {engine}', { engines: skill.engines.join('/'), engine }) };
  return { applicable: true };
}

/**
 * Reads the registry: the core skill, then the project's own sources (when a project is given), then every global source in order.
 * A name seen twice keeps the first (later ones are a problem line), so a project's skill shadows a global one of the same name.
 * With a project, each skill says whether the project can use it (`applicable`, with the reason when not).
 */
export function readRegistry(config: SkillsRegistryConfig | undefined, project?: Pick<ProjectConfig, 'skills'>): Registry {
  const registry: Registry = { sources: [], skills: [], problems: [] };
  const names = new Map<string, string>();
  const add = (source: SkillSourceConfig | undefined, skillFile: string, core: boolean): void => {
    const dir = path.dirname(skillFile);
    const front = readFrontMatter(readFileSync(skillFile, 'utf8'));
    const folder = path.basename(dir);
    const name = front.name || folder;
    if (source && (source.exclude.includes(name) || source.exclude.includes(folder))) return;
    if (!front.name) registry.problems.push(t('{path} has no name in its front matter; the folder name "{name}" is used.', { path: skillFile.replace(/\\/g, '/'), name }));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { registry.problems.push(t('skill "{name}" ({path}) has a name that cannot be a folder name; left out.', { name, path: skillFile.replace(/\\/g, '/') })); return; }
    const sourceId = source?.id ?? 'alba';
    // A source's skill replaces a library skill of the same name (a project may keep its own version).
    const shadowed = source ? registry.skills.findIndex(s => s.name === name && s.library) : -1;
    if (shadowed >= 0) { registry.skills.splice(shadowed, 1); names.delete(name); }
    if (names.has(name)) { registry.problems.push(t('skill "{name}" is in {a} and in {b}; the first one is used.', { name, a: names.get(name)!, b: sourceId })); return; }
    names.set(name, sourceId);
    const size = folderSize(dir);
    const extra = source ? (source.skills[folder] ?? source.skills[front.name ?? ''] ?? []) : ['alba'];
    const tags = [...new Set([...front.tags, ...(source?.tags ?? []), ...extra].map(x => x.toLowerCase()))];
    const declared = !source ? front.engines : [...front.engines, ...source.engines, ...(source.skillEngines[folder] ?? source.skillEngines[front.name ?? ''] ?? []), ...enginesFromPath(source, skillFile)];
    // nothing declared: the engine named by the skill's own name or tags (`unity-ui`, `godot-physics`, tag `ue`); `engines: [any]` says it is for every engine
    // Alba's library skills say their engine the same way (front matter, else name and tags); the core rules are for every engine.
    const engines = source || !core ? [...new Set((declared.length ? declared : enginesFromWords([name, folder, ...tags])).filter(e => e !== 'any'))] : [];
    registry.skills.push({ name, description: front.description ?? '', tags, source: sourceId, dir: dir.replace(/\\/g, '/'), files: size.files, bytes: size.bytes, skillFile: skillFile.replace(/\\/g, '/'), core, scope: source?.scope ?? 'global', engines, applicable: true });
  };
  const core = path.join(coreDir, CORE_SKILL, 'SKILL.md');
  if (existsSync(core)) {
    add(undefined, core, true);
    // The rest of templates/skills is Alba's skill library: in the registry, used where a project, role, order or editor names it.
    const library = existsSync(coreDir) ? readdirSync(coreDir).filter(d => d !== CORE_SKILL && existsSync(path.join(coreDir, d, 'SKILL.md'))).sort() : [];
    for (const d of library) { add(undefined, path.join(coreDir, d, 'SKILL.md'), false); registry.skills[registry.skills.length - 1]!.library = true; }
    registry.sources.push({ id: 'alba', dir: coreDir.replace(/\\/g, '/'), exists: true, count: 1 + library.length, tags: [], scope: 'global' });
  }
  const sources = [...(project?.skills?.sources ?? []), ...(config?.sources ?? [])];
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) { registry.problems.push(t('skill source id "{id}" is used by a project source and a global one; the first is read.', { id: source.id })); continue; }
    ids.add(source.id);
    const info: SkillSourceInfo = { id: source.id, dir: source.dir.replace(/\\/g, '/'), exists: existsSync(source.dir), count: 0, tags: source.tags, scope: source.scope };
    if (!info.exists) { info.problem = t('the folder does not exist'); registry.problems.push(t('skill source {id}: {dir} does not exist.', { id: source.id, dir: info.dir })); registry.sources.push(info); continue; }
    const before = registry.skills.length;
    for (const file of skillFilesOf(source)) {
      try { add(source, file, false); }
      catch (e) { registry.problems.push(t('{path} could not be read: {why}', { path: file.replace(/\\/g, '/'), why: (e as Error).message.split('\n')[0] })); }
    }
    info.count = registry.skills.length - before;
    registry.sources.push(info);
  }
  if (project) {
    const filter = filterOf(project);
    for (const s of registry.skills) Object.assign(s, applicability(s, filter));
  }
  return registry;
}

// ------------------------------------------------------------------------------------------------------------------ selection

export interface SelectedSkill { skill: RegistrySkill; layer: SkillLayer; why: string }
export interface Selection { selected: SelectedSkill[]; problems: string[]; truncated: number }

/**
 * The skills an order gets, in three layers:
 *  - core: the tool's own worker rules, always;
 *  - project: `skills.always` and `skills.by_kind` of the project file (by the order's kind and extra tags);
 *  - order: skills named on the order (`skills`), and skills whose tags share a word with the order's tags, kind and extra tags.
 * A skill that appears in several layers is listed once, under the first. At most `skills.max_per_order` (default 16) are chosen,
 * but the cap only drops a role's own additions (last first) and tag matches: core, project, tool, editor and order-named skills
 * are always kept, even when they alone pass the cap.
 */
export function selectSkills(project: ProjectConfig, registry: Registry, doc: OrderDoc, routing: { kind: string; tags: string[] } | undefined, roleSkills: readonly string[] = [], toolSkills: readonly { name: string; tool: string }[] = []): Selection {
  const o = doc.order;
  const kind = kindForFit(routing?.kind || o.kind);
  const words = [...new Set([...(o.tags ?? []), ...(routing?.tags ?? []), ...(kind ? [kind] : [])].map(x => x.toLowerCase()))];
  const byName = new Map(registry.skills.map(s => [s.name, s]));
  const problems: string[] = [];
  const out: SelectedSkill[] = [];
  const have = new Set<string>();
  const put = (name: string, layer: SkillLayer, why: string, from: string): void => {
    if (have.has(name)) return;
    const skill = byName.get(name);
    if (!skill) { problems.push(t('{from} names the skill "{name}", which is not in the registry.', { from, name })); return; }
    if (!skill.applicable) { problems.push(t('{from} names the skill "{name}", which this project does not use ({why}).', { from, name, why: skill.inapplicable ?? '-' })); return; }
    have.add(name);
    out.push({ skill, layer, why });
  };
  for (const s of registry.skills.filter(x => x.core)) put(s.name, 'core', t('always'), 'core');
  for (const name of project.skills?.always ?? []) put(name, 'project', t('always (project)'), 'skills.always');
  for (const k of [kind, ...(routing?.tags ?? [])].filter(Boolean)) for (const name of project.skills?.by_kind[k] ?? []) put(name, 'project', t('kind {kind}', { kind: k }), `skills.by_kind.${k}`);
  for (const name of roleSkills) put(name, 'project', 'role', 'role.skills');
  for (const { name, tool } of toolSkills) put(name, 'order', t('tool {tool}', { tool }), `tool ${tool}`);
  for (const name of o.skills ?? []) put(name, 'order', t('named on the order'), `${o.tag}`);
  const cap = project.skills?.max_per_order ?? 16;
  // The cap only drops skills nobody else asked for: a role's own additions and tag matches. Core, project, tool, editor
  // and order-named skills are always mounted (a tool without its skill is misused), and they count towards the cap first.
  const required = new Set([...(o.skills ?? []), ...toolSkills.map(x => x.name)]);
  const optional = (s: SelectedSkill): boolean => s.why === 'role' && !required.has(s.skill.name);
  let truncated = 0;
  for (let i = out.length - 1; i >= 0 && out.length > cap; i--) if (optional(out[i]!)) { out.splice(i, 1); truncated++; }
  for (const s of registry.skills) {
    if (have.has(s.name) || !s.applicable || s.library) continue;
    const hit = s.tags.find(x => words.includes(x));
    if (!hit) continue;
    if (out.length >= cap) { truncated++; continue; }
    put(s.name, 'order', t('tag {tag}', { tag: hit }), o.tag);
  }
  return { selected: out, problems, truncated };
}

/** What the order's page shows: name, description, layer and reason; `where` is the folder skills are mounted in (the first of the engine's). */
export function orderSkills(selection: Selection, where: string | undefined): OrderSkill[] {
  return selection.selected.map(({ skill, layer, why }) => ({ name: skill.name, description: skill.description, layer, why, path: `${where ?? '.agents/skills'}/${skill.name}/SKILL.md` }));
}
