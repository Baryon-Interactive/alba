import type { ProjectConfig } from '../config.ts';
import { autoApproved, toolJobs, type ToolJob, type ToolJobStatus } from './jobs.ts';
import { withSettings, type ToolManifest } from './manifest.ts';
import { discoverPlugins, type PluginOrigin } from './registry.ts';

/** One environment variable a tool's server reads: its name, and whether it is set where Alba runs. The value is never read out. */
export interface PluginEnvName { name: string; set: boolean }
export interface PluginServerView {
  name: string;
  command: string;
  args: string[];
  /** The tools workers are offered (absent: all the server has). */
  tools?: string[];
  engines?: string[];
  /** false: only the tool's operations use it (`workers: false`). */
  workers: boolean;
  env: PluginEnvName[];
}
export interface PluginSettingView { name: string; description: string; default?: string; /** What the project gives (`plugins.settings.<id>.<name>`); absent: the default. */ value?: string }
export interface PluginOperationView {
  name: string;
  description: string;
  input: unknown;
  timeout_minutes: number;
  paid?: { unit: string; fixed?: number; priced_by_tool?: boolean };
}
export interface PluginView {
  id: string;
  version: string;
  description: string;
  origin: PluginOrigin;
  enabled: boolean;
  /** The plugin's folder (forward slashes). */
  folder: string;
  settings: PluginSettingView[];
  servers: PluginServerView[];
  /** The skill folder workers get (absolute, forward slashes). */
  skill?: string;
  cli?: { program: string; fallback: boolean };
  probe?: string[];
  resources: { name: string; slots: number; lease_minutes?: number }[];
  operations: PluginOperationView[];
  /** The kinds whose orders use it (`plugins.by_kind`). */
  kinds: string[];
  /** What is wrong with it: a setting without a value, a copy of it that was refused, a folder named otherwise. */
  problems: string[];
}
/** `plugins.auto_approve.<unit>` as the loader reads it, with what Alba approved by itself in the UTC day and in the project. */
export interface AutoApproveView { unit: string; per_job: number; per_day: number; per_project?: number; today: number; ever: number }
export interface ToolJobView {
  id: string; tool: string; version: string; operation: string; status: ToolJobStatus; by: string; order?: string; case?: string;
  quote?: ToolJob['quote']; spent?: number; spentUnknown?: boolean; files?: string[]; error?: string; waiting?: string; warning?: string;
  created: string; started?: string; ended?: string;
}
export interface PluginsView {
  project: string;
  /** The project file that `POST /api/config` changes (`plugins.enable`, `settings`, `by_kind`, `auto_approve`). */
  file: string;
  /** The ids under `plugins.enable`, in the file's order. */
  enable: string[];
  tools: PluginView[];
  by_kind: Record<string, string[]>;
  auto_approve: AutoApproveView[];
  /** The units the paid operations of the enabled tools are priced in. */
  units: string[];
  /** Manifests that cannot be read, and problems no plugin above owns. */
  problems: string[];
  /** The newest tool jobs first, at most `JOBS_SHOWN`; `jobCount` is how many there are. */
  jobs: ToolJobView[];
  jobCount: number;
}

export const JOBS_SHOWN = 30;
const slash = (p: string) => p.replace(/\\/g, '/');
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const jobNumber = (j: ToolJob) => Number(/^J(\d+)$/.exec(j.id)?.[1] ?? 0);

/**
 * Every plugin the project can see (built in and its own sources), enabled or not, with what the console shows of it: settings with
 * the project's values, servers with their tools and the names of the variables they read (set or not, never the value), skill, CLI,
 * probe, resources, operations and the kinds that use it; the auto approvals and the latest tool jobs.
 */
export function pluginsView(project: ProjectConfig, now: string, environment: NodeJS.ProcessEnv = process.env): PluginsView {
  const plugins = project.plugins;
  const found = discoverPlugins(plugins?.sources ?? [], undefined, plugins?.replace);
  const byKind = plugins?.by_kind ?? {};
  const owned = new Set<string>();
  const isSet = (name: string) => environment[name] !== undefined && environment[name] !== '';
  const tools = found.tools.map((raw): PluginView => {
    const id = raw.manifest.id;
    const loaded = plugins?.tools[id];
    const problems: string[] = [];
    // An enabled tool has the project's settings put in; another one is shown with its defaults (or as written, when one has none).
    let manifest: ToolManifest = loaded?.manifest ?? raw.manifest;
    if (!loaded) {
      try { manifest = withSettings(raw.manifest, {}); }
      catch (e) { problems.push(`${(e as Error).message}; enable it and set it under plugins.settings.${id}`); }
    }
    const folder = slash(raw.dir);
    for (const p of found.problems) if (p.startsWith(`${folder}/`)) { problems.push(p); owned.add(p); }
    for (const r of found.refused) if (r.id === id) { if (!problems.includes(r.problem)) problems.push(r.problem); owned.add(r.problem); }
    return {
      id, version: manifest.version, description: manifest.description, origin: raw.origin, enabled: !!loaded, folder,
      settings: Object.entries(raw.manifest.settings ?? {}).map(([name, s]) => ({ name, description: s.description, ...(s.default !== undefined ? { default: s.default } : {}), ...(loaded?.settings?.[name] !== undefined ? { value: loaded.settings[name] } : {}) })),
      servers: Object.entries(manifest.agent.mcp).map(([name, s]) => ({
        name, command: s.command, args: s.args, ...(s.tools ? { tools: s.tools } : {}), ...(s.engines ? { engines: s.engines } : {}), workers: s.workers !== false,
        env: (s.env_from ?? []).filter(n => ENV_NAME.test(n)).map(n => ({ name: n, set: isSet(n) })),
      })),
      ...(manifest.agent.skill ? { skill: manifest.agent.skill } : {}),
      ...(manifest.agent.cli ? { cli: manifest.agent.cli } : {}),
      ...(manifest.machines?.probe ? { probe: manifest.machines.probe } : {}),
      resources: Object.entries(manifest.resources ?? {}).map(([name, r]) => ({ name, slots: r.slots, ...(r.lease_minutes !== undefined ? { lease_minutes: r.lease_minutes } : {}) })),
      operations: Object.entries(manifest.operations ?? {}).map(([name, o]) => ({
        name, description: o.description, input: o.input, timeout_minutes: o.timeout_minutes,
        ...(o.quote ? { paid: { unit: o.quote.unit, ...(o.quote.fixed !== undefined ? { fixed: o.quote.fixed } : {}), ...(o.quote.tool ? { priced_by_tool: true } : {}) } } : {}),
      })),
      kinds: Object.entries(byKind).filter(([, ids]) => ids.includes(id)).map(([kind]) => kind),
      problems,
    };
  });
  const jobs = [...toolJobs(project)].sort((a, b) => jobNumber(b) - jobNumber(a) || b.created.localeCompare(a.created));
  const units = [...new Set(Object.values(plugins?.tools ?? {}).flatMap(t => Object.values(t.manifest.operations ?? {}).flatMap(o => (o.quote ? [o.quote.unit] : []))))].sort();
  return {
    project: project.id, file: slash(project.file), enable: plugins?.enable ?? [], tools, by_kind: byKind,
    auto_approve: Object.entries(plugins?.auto_approve ?? {}).map(([unit, rule]) => ({ unit, ...rule, ...autoApproved(jobs, unit, now) })),
    units, problems: found.problems.filter(p => !owned.has(p)),
    jobs: jobs.slice(0, JOBS_SHOWN).map(jobView), jobCount: jobs.length,
  };
}

/** A job as the console lists it: no input and no answer text (they can be long), only what the table shows. */
function jobView(j: ToolJob): ToolJobView {
  return {
    id: j.id, tool: j.tool, version: j.version, operation: j.operation, status: j.status, by: j.by, created: j.created,
    ...(j.order ? { order: j.order } : {}), ...(j.case ? { case: j.case } : {}), ...(j.quote ? { quote: j.quote } : {}),
    ...(j.spent !== undefined ? { spent: j.spent } : {}), ...(j.spentUnknown ? { spentUnknown: true } : {}), ...(j.files?.length ? { files: j.files } : {}),
    ...(j.error ? { error: j.error } : {}), ...(j.waiting ? { waiting: j.waiting } : {}), ...(j.warning ? { warning: j.warning } : {}),
    ...(j.started ? { started: j.started } : {}), ...(j.ended ? { ended: j.ended } : {}),
  };
}
