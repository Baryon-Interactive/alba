import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from '../i18n.ts';
import { MANIFEST, ManifestError, pluginFolders, readManifest, withSettings, type ToolManifest } from './manifest.ts';

/** The plugins that ship with Alba (`plugins/` of the Alba repository). */
export const BUILTIN_PLUGINS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins');

export type PluginOrigin = 'built-in' | 'project';
export interface LoadedTool { manifest: ToolManifest; dir: string; origin: PluginOrigin; file: string; /** The settings the project gave (the manifest already has them put in). */ settings?: Record<string, string> }
export interface PluginSource { path: string }
/** The `plugins` block of alba.yaml, checked. Source folders are absolute. */
export interface PluginsConfig {
  enable: string[];
  sources: PluginSource[];
  /** Tools every order of a kind uses: `{ model: [tripo-3d] }`. */
  by_kind: Record<string, string[]>;
  /** The enabled tools, read once with the project. */
  tools: Record<string, LoadedTool>;
  /** Built-in plugin ids that the project's own plugin of the same id replaces (absent: none; such a plugin is refused). */
  replace?: string[];
  /** Quotes of tool operations Alba approves itself, per unit (absent: a person approves every one). */
  auto_approve?: Record<string, AutoApprove>;
}
/**
 * What Alba may approve by itself in one unit: one job's quote up to `per_job`, and in all at most `per_day` in a UTC day and
 * `per_project` ever in this project (what was approved counts, not what was spent). `{ credits: 5 }` is `per_job: 5`, `per_day: 50`.
 */
export interface AutoApprove { per_job: number; per_day: number; per_project?: number }
/** A day's auto approvals are this many times one job's cap when the project names no `per_day`. */
export const AUTO_APPROVE_DAY_JOBS = 10;
/** A plugin that was found but not loaded because its id is taken; `problem` says why and what to do. */
export interface RefusedPlugin { id: string; file: string; problem: string }
export interface Discovery { tools: LoadedTool[]; problems: string[]; refused: RefusedPlugin[] }

/**
 * Every plugin Alba can see: the built-in ones, then each project source in order. The manifest's id is the plugin's identity,
 * never its folder name (a folder named otherwise is reported). A project plugin with a built-in plugin's id replaces it only when
 * the project lists that id under `plugins.replace`; otherwise it is refused and the built-in one stays. Of two project plugins
 * with one id the first is kept and the later one refused. A manifest that cannot be read is a problem, not a failure, so one
 * broken plugin does not hide the others.
 */
export function discoverPlugins(sources: readonly PluginSource[], builtin = BUILTIN_PLUGINS, replace: readonly string[] = []): Discovery {
  const byId = new Map<string, LoadedTool>();
  const problems: string[] = [];
  const refused: RefusedPlugin[] = [];
  const layers: [string, PluginOrigin][] = [[builtin, 'built-in'], ...sources.map(s => [s.path, 'project'] as [string, PluginOrigin])];
  for (const [dir, origin] of layers) for (const folder of pluginFolders(dir)) {
    const file = path.join(folder, MANIFEST);
    const shown = file.replace(/\\/g, '/');
    try {
      const manifest = readManifest(file);
      const id = manifest.id;
      if (path.basename(folder) !== id) problems.push(`${shown}: id: "${id}" differs from its folder name "${path.basename(folder)}"; the plugin is known by its id "${id}"`);
      const taken = byId.get(id);
      if (taken) {
        const where = taken.file.replace(/\\/g, '/');
        const why = taken.origin === 'project'
          ? `${shown}: id: "${id}" is already used by ${where}; the first one is used. Give this one an id of its own`
          : replace.includes(id) ? undefined
          : `${shown}: id: "${id}" is the id of a built-in plugin (${where}); the built-in one is used. To use this one instead, list "${id}" under plugins.replace in alba.yaml, or give it an id of its own`;
        if (why) { problems.push(why); refused.push({ id, file: shown, problem: why }); continue; }
      }
      byId.set(id, { manifest, dir: folder, origin, file });
    } catch (e) {
      if (!(e instanceof ManifestError)) throw e;
      problems.push(e.message);
    }
  }
  return { tools: [...byId.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)), problems, refused };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Checks the `plugins` block and loads the enabled tools. Fails on anything that would make a launch go wrong later. */
export function validatePlugins(raw: unknown, file: string, base: string, builtin = BUILTIN_PLUGINS): PluginsConfig {
  const fail = (message: string): never => { throw new UserError(message); };
  if (!isRecord(raw)) fail(`${file}: "plugins" must be a mapping with "enable" and optional "sources" and "by_kind".`);
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter(k => !['enable', 'sources', 'by_kind', 'auto_approve', 'settings', 'replace'].includes(k));
  if (unknown.length) fail(`${file}: unknown key(s) under "plugins": ${unknown.join(', ')}.`);
  const names = (v: unknown, at: string): string[] => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) fail(`${file}: "${at}" must be a list of plugin ids.`);
    return [...new Set((v as string[]).map(x => x.trim()))];
  };
  const enable = r.enable === undefined ? [] : names(r.enable, 'plugins.enable');
  const sources: PluginSource[] = [];
  if (r.sources !== undefined) {
    if (!Array.isArray(r.sources)) fail(`${file}: "plugins.sources" must be a list.`);
    (r.sources as unknown[]).forEach((s, i) => {
      const at = `plugins.sources[${i}]`;
      if (!isRecord(s)) fail(`${file}: "${at}" must be a mapping like { path: tools/alba/plugins }.`);
      const src = s as Record<string, unknown>;
      if ('git' in src || 'npm' in src) fail(`${file}: "${at}": git and npm sources are not supported yet; use { path: <folder> }.`);
      const extra = Object.keys(src).filter(k => k !== 'path');
      if (extra.length) fail(`${file}: "${at}": unknown key(s): ${extra.join(', ')}.`);
      if (typeof src.path !== 'string' || !src.path.trim()) fail(`${file}: "${at}.path" must be a folder.`);
      sources.push({ path: path.resolve(base, src.path as string) });
    });
  }
  const by_kind: Record<string, string[]> = {};
  if (r.by_kind !== undefined) {
    if (!isRecord(r.by_kind)) fail(`${file}: "plugins.by_kind" must map a kind to a list of tool ids.`);
    for (const [kind, v] of Object.entries(r.by_kind as Record<string, unknown>)) by_kind[kind] = names(v, `plugins.by_kind.${kind}`);
  }
  const replace = r.replace === undefined ? [] : names(r.replace, 'plugins.replace');
  const tools: Record<string, LoadedTool> = {};
  if (enable.length || replace.length) {
    const found = discoverPlugins(sources, builtin, replace);
    const builtIn = new Set(discoverPlugins([], builtin).tools.map(x => x.manifest.id));
    for (const id of replace) {
      if (!builtIn.has(id)) fail(`${file}: "plugins.replace": "${id}" is not a built-in plugin (built in: ${[...builtIn].join(', ') || 'none'}); a project plugin with an id of its own needs no entry here.`);
      if (found.tools.find(x => x.manifest.id === id)?.origin !== 'project') fail(`${file}: "plugins.replace": no plugin with the id "${id}" in plugins.sources replaces the built-in one.`);
    }
    for (const id of enable) {
      const clash = found.refused.find(x => x.id === id);
      if (clash) fail(`${file}: "plugins.enable": ${clash.problem}.`);
      const tool = found.tools.find(x => x.manifest.id === id);
      if (!tool) {
        const broken = found.problems.find(p => p.includes(`/${id}/${MANIFEST}`));
        fail(`${file}: "plugins.enable": ${broken ?? `no plugin "${id}" (found: ${found.tools.map(x => x.manifest.id).join(', ') || 'none'})`}.`);
      }
      tools[id] = tool!;
    }
  }
  // The project's settings, put into the enabled tools' manifests.
  const given = r.settings === undefined ? {} : r.settings;
  if (!isRecord(given)) fail(`${file}: "plugins.settings" must map a tool id to its settings, e.g. { image-gateway: { model: gpt-image-1 } }.`);
  for (const [id, v] of Object.entries(given as Record<string, unknown>)) {
    if (!tools[id]) fail(`${file}: "plugins.settings.${id}": "${id}" is not in plugins.enable.`);
    if (!isRecord(v)) fail(`${file}: "plugins.settings.${id}" must be a mapping of setting names.`);
    const declared = tools[id]!.manifest.settings ?? {};
    for (const [name, value] of Object.entries(v as Record<string, unknown>)) {
      if (!declared[name]) fail(`${file}: "plugins.settings.${id}.${name}": the tool has no such setting (it has: ${Object.keys(declared).join(', ') || 'none'}).`);
      if (!['string', 'number', 'boolean'].includes(typeof value)) fail(`${file}: "plugins.settings.${id}.${name}" must be a string, number or boolean.`);
    }
  }
  for (const [id, tool] of Object.entries(tools)) {
    const values = Object.fromEntries(Object.entries(((given as Record<string, Record<string, unknown>>)[id]) ?? {}).map(([k, v]) => [k, String(v)]));
    try { tools[id] = { ...tool, manifest: withSettings(tool.manifest, values), ...(Object.keys(values).length ? { settings: values } : {}) }; }
    catch (e) { fail(`${file}: "plugins.settings.${id}": ${(e as Error).message}.`); }
  }
  for (const [kind, ids] of Object.entries(by_kind)) for (const id of ids) if (!tools[id]) fail(`${file}: "plugins.by_kind.${kind}": "${id}" is not in plugins.enable.`);
  let auto_approve: Record<string, AutoApprove> | undefined;
  if (r.auto_approve !== undefined) {
    if (!isRecord(r.auto_approve)) fail(`${file}: "plugins.auto_approve" must map a unit to the largest amount Alba approves by itself, e.g. { credits: 5 } or { credits: { per_job: 5, per_day: 20, per_project: 200 } }.`);
    auto_approve = {};
    const amount = (v: unknown, at: string): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail(`${file}: "${at}" must be an amount of at least 0.`));
    for (const [unit, v] of Object.entries(r.auto_approve as Record<string, unknown>)) {
      const at = `plugins.auto_approve.${unit}`;
      if (isRecord(v)) {
        const extra = Object.keys(v).filter(k => !['per_job', 'per_day', 'per_project'].includes(k));
        if (extra.length) fail(`${file}: unknown key(s) under "${at}": ${extra.join(', ')} (it takes per_job, per_day and per_project).`);
        if (v.per_job === undefined) fail(`${file}: "${at}.per_job" is needed: the largest quote of one job Alba approves by itself.`);
        const per_job = amount(v.per_job, `${at}.per_job`);
        auto_approve[unit] = { per_job, per_day: v.per_day === undefined ? per_job * AUTO_APPROVE_DAY_JOBS : amount(v.per_day, `${at}.per_day`), ...(v.per_project !== undefined ? { per_project: amount(v.per_project, `${at}.per_project`) } : {}) };
      } else {
        const per_job = amount(v, at);
        auto_approve[unit] = { per_job, per_day: per_job * AUTO_APPROVE_DAY_JOBS };
      }
    }
  }
  return { enable, sources, by_kind, tools, ...(replace.length ? { replace } : {}), ...(auto_approve ? { auto_approve } : {}) };
}
