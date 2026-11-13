import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

/** The manifest version this Alba reads. A manifest that asks for another one is refused with what it needs. */
export const PLUGIN_API_VERSION = 1;
export const MANIFEST = 'alba-plugin.yaml';

/** An MCP server a tool gives the workers that use it: a program and arguments (no shell), and environment variable names. */
export interface ToolServer {
  command: string;
  args: string[];
  /** Names of environment variables the server needs; their values come from Alba's environment at launch, never from a file. */
  env_from?: string[];
  /** Only these of the server's tools are offered to the worker (absent: all). */
  tools?: string[];
  /** Only for these worker engines (absent: all that can mount MCP servers). */
  engines?: string[];
  /** `false`: the server is only for the tool's operations (Alba calls it); workers never get it. */
  workers?: false;
}

/** A value the project gives the tool (`plugins.settings.<tool>.<name>`): a base URL, a model, a path. Never a secret. */
export interface ToolSetting { description: string; default?: string }
/** `${setting.<name>}` in a command, an argument, an `env_from` name or a probe. */
export const SETTING_REF = /\$\{setting\.([A-Za-z0-9_]+)\}/g;

export interface ToolManifest {
  id: string;
  version: string;
  apiVersion: number;
  kinds: ['tool'];
  description: string;
  /** What a worker gets when its order uses the tool. */
  agent: {
    mcp: Record<string, ToolServer>;
    /** The skill folder (absolute, forward slashes) with a SKILL.md: how to use the tool. */
    skill?: string;
    /** A command line program the worker may use instead of, or besides, the MCP server. */
    cli?: { program: string; fallback: boolean };
  };
  /** How a machine shows that the tool is there: a program and arguments that exit 0. */
  machines?: { probe?: string[] };
  /** Resources the tool holds while a run uses it (added to the project's resources when the project does not declare them). */
  resources?: Record<string, { slots: number; lease_minutes?: number }>;
  /** What Alba itself can run, without an agent: by a person (`alba tools run`) or the producer (`tool-call`). */
  operations?: Record<string, ToolOperation>;
  /** What the project may set; resolved into the strings above when the project enables the tool. */
  settings?: Record<string, ToolSetting>;
}

/** A JSON schema, the part Alba checks (see schema.ts). */
export type JsonSchema = Record<string, unknown>;

/** One operation of a tool: its input, how it runs, what it costs, what it leaves. */
export interface ToolOperation {
  description: string;
  /** The input, an object schema. */
  input: JsonSchema;
  /**
   * An MCP tool of one of the plugin's servers, called with the input (and the output folder in `out_arg`, when named); or a program
   * with arguments, where `{input}` is a JSON file with the input and `{out}` the output folder.
   */
  run: { mcp: string; tool: string; out_arg?: string } | { cli: string[] };
  /** A paid operation: priced before it runs, in `unit`, by a fixed amount or by an MCP tool of the same server that answers `{ amount }`. */
  quote?: { unit: string; fixed?: number; tool?: string };
  /** The files of the output folder that are the result (globs; absent: all), and a file the text of the answer is written to. */
  output: { files?: string[]; text?: string };
  timeout_minutes: number;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ID = /^[a-z0-9][a-z0-9-]*$/;
/** Keys a later manifest version will use; apiVersion 1 refuses them by name rather than ignoring them. */
const LATER = ['checks', 'viewers', 'engine', 'quota'];

export class ManifestError extends Error {}

/** Reads and checks one `alba-plugin.yaml`. Every problem names the file and the key. */
export function readManifest(file: string): ToolManifest {
  const dir = path.dirname(file);
  const bad = (key: string, message: string): never => { throw new ManifestError(`${file.replace(/\\/g, '/')}: ${key}: ${message}`); };
  // `${plugin}` in a command or an argument is the plugin's folder, so a program that ships with the plugin can be found.
  const here = (x: string): string => x.split('${plugin}').join(path.resolve(dir).replace(/\\/g, '/'));
  let raw: unknown;
  try { raw = parse(readFileSync(file, 'utf8')); } catch (e) { return bad('(file)', `not readable YAML (${(e as Error).message.split('\n')[0]})`); }
  if (!record(raw)) return bad('(file)', 'must be a mapping');
  if (raw.apiVersion !== PLUGIN_API_VERSION) bad('apiVersion', `this Alba reads apiVersion ${PLUGIN_API_VERSION}; the plugin says ${JSON.stringify(raw.apiVersion)}`);
  const later = LATER.filter(k => k in raw);
  if (later.length) bad(later[0]!, `not supported yet (apiVersion ${PLUGIN_API_VERSION} has tools with an agent face and operations)`);
  const unknown = Object.keys(raw).filter(k => !['id', 'version', 'apiVersion', 'kinds', 'description', 'agent', 'machines', 'resources', 'operations', 'settings'].includes(k));
  if (unknown.length) bad(unknown[0]!, 'unknown key');
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) bad('id', 'lower-case letters, digits and "-", starting with a letter or digit');
  if (typeof raw.version === 'number') raw.version = String(raw.version);     // `version: 2` in YAML is a number
  if (typeof raw.version !== 'string' || !raw.version.trim()) bad('version', 'a version string, e.g. "1.0.0"');
  if (!Array.isArray(raw.kinds) || raw.kinds.length !== 1 || raw.kinds[0] !== 'tool') bad('kinds', 'must be [tool]');
  if (typeof raw.description !== 'string' || !raw.description.trim()) bad('description', 'one sentence on what the tool does');
  const strings = (v: unknown, key: string): string[] => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) bad(key, 'a list of non-empty strings');
    return (v as string[]).map(x => x.trim());
  };
  if (raw.agent === undefined && raw.operations !== undefined) raw.agent = {};     // a tool only Alba runs needs no agent face
  if (!record(raw.agent)) return bad('agent', 'a mapping with mcp, skill and/or cli');
  const agentUnknown = Object.keys(raw.agent).filter(k => !['mcp', 'skill', 'cli'].includes(k));
  if (agentUnknown.length) bad(`agent.${agentUnknown[0]}`, 'unknown key');
  const mcp: Record<string, ToolServer> = {};
  if (raw.agent.mcp !== undefined) {
    if (!record(raw.agent.mcp)) bad('agent.mcp', 'a mapping of server names');
    for (const [name, s] of Object.entries(raw.agent.mcp as Record<string, unknown>)) {
      const at = `agent.mcp.${name}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) bad(at, 'a server name of letters, digits, "_" and "-"');
      if (!record(s)) return bad(at, 'a mapping with command and args');
      if ('env' in s) bad(`${at}.env`, 'values are not allowed in a manifest; name the variables in env_from');
      const extra = Object.keys(s).filter(k => !['command', 'args', 'env_from', 'tools', 'engines', 'workers'].includes(k));
      if (extra.length) bad(`${at}.${extra[0]}`, 'unknown key');
      if (typeof s.command !== 'string' || !s.command.trim()) bad(`${at}.command`, 'a program (no shell)');
      if (s.workers !== undefined && s.workers !== false) bad(`${at}.workers`, 'only false (a server for operations only); absent means workers get it');
      const server: ToolServer = {
        command: here((s.command as string).trim()), args: s.args === undefined ? [] : strings(s.args, `${at}.args`).map(here),
        ...(s.env_from !== undefined ? { env_from: strings(s.env_from, `${at}.env_from`) } : {}),
        ...(s.tools !== undefined ? { tools: strings(s.tools, `${at}.tools`) } : {}),
        ...(s.engines !== undefined ? { engines: strings(s.engines, `${at}.engines`) } : {}),
        ...(s.workers === false ? { workers: false as const } : {}),
      };
      for (const n of server.env_from ?? []) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !/^\$\{setting\.[A-Za-z0-9_]+\}$/.test(n)) bad(`${at}.env_from`, `"${n}" is not an environment variable name (or \${setting.<name>})`);
      mcp[name] = server;
    }
  }
  let skill: string | undefined;
  if (raw.agent.skill !== undefined) {
    if (typeof raw.agent.skill !== 'string' || !raw.agent.skill.trim()) bad('agent.skill', 'a folder relative to the plugin');
    const folder = path.resolve(dir, raw.agent.skill as string);
    if (path.relative(dir, folder).startsWith('..') || path.isAbsolute(path.relative(dir, folder))) bad('agent.skill', 'must be inside the plugin folder');
    if (!existsSync(path.join(folder, 'SKILL.md'))) bad('agent.skill', `${raw.agent.skill}/SKILL.md does not exist`);
    skill = folder.replace(/\\/g, '/');
  }
  let cli: ToolManifest['agent']['cli'];
  if (raw.agent.cli !== undefined) {
    const c = raw.agent.cli;
    if (!record(c) || typeof c.program !== 'string' || !c.program.trim()) return bad('agent.cli', 'a mapping with program');
    cli = { program: c.program.trim(), fallback: c.fallback === true };
  }
  if (!Object.keys(mcp).length && !skill && !cli && raw.operations === undefined) bad('agent', 'needs at least one of mcp, skill or cli');
  let machines: ToolManifest['machines'];
  if (raw.machines !== undefined) {
    if (!record(raw.machines)) return bad('machines', 'a mapping');
    machines = raw.machines.probe === undefined ? {} : { probe: strings(raw.machines.probe, 'machines.probe').map(here) };
  }
  let resources: ToolManifest['resources'];
  if (raw.resources !== undefined) {
    if (!record(raw.resources)) return bad('resources', 'a mapping of resource names');
    resources = {};
    for (const [name, r] of Object.entries(raw.resources)) {
      if (!record(r) || !Number.isInteger(r.slots) || (r.slots as number) < 1) bad(`resources.${name}.slots`, 'a whole number of at least 1');
      const rr = r as { slots: number; lease_minutes?: unknown };
      resources[name] = { slots: rr.slots, ...(Number.isInteger(rr.lease_minutes) ? { lease_minutes: rr.lease_minutes as number } : {}) };
    }
  }
  let operations: ToolManifest['operations'];
  if (raw.operations !== undefined) {
    if (!record(raw.operations) || !Object.keys(raw.operations).length) return bad('operations', 'a mapping of operation names');
    operations = {};
    for (const [name, o] of Object.entries(raw.operations)) operations[name] = readOperation(name, o, mcp, dir, here, bad);
  }
  let settings: ToolManifest['settings'];
  if (raw.settings !== undefined) {
    if (!record(raw.settings)) return bad('settings', 'a mapping of setting names');
    settings = {};
    for (const [name, v] of Object.entries(raw.settings)) {
      if (!/^[A-Za-z0-9_]+$/.test(name)) bad(`settings.${name}`, 'a name of letters, digits and "_"');
      if (!record(v) || typeof v.description !== 'string' || !v.description.trim()) return bad(`settings.${name}`, 'a mapping with description and an optional default');
      const extraSetting = Object.keys(v).filter(k => !['description', 'default'].includes(k));
      if (extraSetting.length) bad(`settings.${name}.${extraSetting[0]}`, 'unknown key');
      if (v.default !== undefined && !['string', 'number', 'boolean'].includes(typeof v.default)) bad(`settings.${name}.default`, 'a string, number or boolean');
      settings[name] = { description: v.description.trim(), ...(v.default !== undefined ? { default: String(v.default) } : {}) };
    }
  }
  const manifest: ToolManifest = {
    id: raw.id as string, version: (raw.version as string).trim(), apiVersion: PLUGIN_API_VERSION, kinds: ['tool'], description: (raw.description as string).trim(),
    agent: { mcp, ...(skill ? { skill } : {}), ...(cli ? { cli } : {}) }, ...(machines ? { machines } : {}), ...(resources ? { resources } : {}), ...(operations ? { operations } : {}),
    ...(settings ? { settings } : {}),
  };
  for (const at of settingStrings(manifest)) for (const m of at.value.matchAll(SETTING_REF)) if (!settings?.[m[1]!]) bad(at.key, `\${setting.${m[1]}} is not declared under settings`);
  return manifest;
}

/** Every string of a manifest a `${setting.x}` may stand in, with where it is. */
function settingStrings(m: ToolManifest): { key: string; value: string; set: (v: string) => void }[] {
  const out: { key: string; value: string; set: (v: string) => void }[] = [];
  const list = (key: string, arr: string[]) => arr.forEach((value, i) => out.push({ key: `${key}[${i}]`, value, set: v => { arr[i] = v; } }));
  for (const [name, s] of Object.entries(m.agent.mcp)) {
    out.push({ key: `agent.mcp.${name}.command`, value: s.command, set: v => { s.command = v; } });
    list(`agent.mcp.${name}.args`, s.args);
    if (s.env_from) list(`agent.mcp.${name}.env_from`, s.env_from);
  }
  if (m.machines?.probe) list('machines.probe', m.machines.probe);
  for (const [name, o] of Object.entries(m.operations ?? {})) if ('cli' in o.run) list(`operations.${name}.run.cli`, o.run.cli);
  return out;
}

/**
 * The manifest with the project's settings put in (`${setting.x}` replaced; a setting the project leaves out takes its default).
 * An `env_from` entry that comes out empty is dropped, so a setting can turn a variable off. Throws when a setting has no value.
 */
export function withSettings(m: ToolManifest, values: Record<string, string>): ToolManifest {
  const copy = structuredClone(m);
  const value = (name: string): string => values[name] ?? m.settings?.[name]?.default ?? (() => { throw new Error(`setting "${name}" has no value and no default`); })();
  for (const at of settingStrings(copy)) if (at.value.includes('${setting.')) at.set(at.value.replace(SETTING_REF, (_, name: string) => value(name)));
  for (const s of Object.values(copy.agent.mcp)) {
    if (!s.env_from) continue;
    s.env_from = s.env_from.filter(Boolean);
    for (const n of s.env_from) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`env_from "${n}" (from a setting) is not an environment variable name`);
  }
  return copy;
}

function readOperation(name: string, o: unknown, mcp: Record<string, ToolServer>, dir: string, here: (x: string) => string, bad: (key: string, message: string) => never): ToolOperation {
  const at = `operations.${name}`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) bad(at, 'an operation name of lower-case letters, digits and "-"');
  if (!record(o)) return bad(at, 'a mapping with description, input, run and output');
  const extra = Object.keys(o).filter(k => !['description', 'input', 'run', 'quote', 'output', 'timeout_minutes'].includes(k));
  if (extra.length) bad(`${at}.${extra[0]}`, 'unknown key');
  if (typeof o.description !== 'string' || !o.description.trim()) bad(`${at}.description`, 'one sentence on what it does');
  // the input schema: written here, or a JSON file of the plugin
  let input: unknown = o.input;
  if (typeof input === 'string') {
    const file = path.resolve(dir, input);
    if (path.relative(dir, file).startsWith('..')) bad(`${at}.input`, 'a schema file inside the plugin folder');
    try { input = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { bad(`${at}.input`, `${o.input}: not a readable JSON file (${(e as Error).message.split('\n')[0]})`); }
  }
  if (!record(input) || input.type !== 'object') bad(`${at}.input`, 'an object schema (type: object, properties, required), written here or as a JSON file');
  if (!record(o.run)) return bad(`${at}.run`, 'a mapping with mcp and tool, or cli');
  let run: ToolOperation['run'];
  if (o.run.cli !== undefined) {
    if (!Array.isArray(o.run.cli) || !o.run.cli.length || o.run.cli.some(x => typeof x !== 'string' || !x.trim())) bad(`${at}.run.cli`, 'a program and its arguments, a list of strings (no shell)');
    if (Object.keys(o.run).length > 1) bad(`${at}.run`, 'cli stands alone (mcp and tool are the other way)');
    run = { cli: (o.run.cli as string[]).map(here) };
  } else {
    const r = o.run;
    const extraRun = Object.keys(r).filter(k => !['mcp', 'tool', 'out_arg'].includes(k));
    if (extraRun.length) bad(`${at}.run.${extraRun[0]}`, 'unknown key');
    if (typeof r.mcp !== 'string' || !mcp[r.mcp]) bad(`${at}.run.mcp`, `a server of agent.mcp (${Object.keys(mcp).join(', ') || 'none declared'})`);
    if (typeof r.tool !== 'string' || !r.tool.trim()) bad(`${at}.run.tool`, 'the MCP tool to call');
    if (r.out_arg !== undefined && (typeof r.out_arg !== 'string' || !r.out_arg.trim())) bad(`${at}.run.out_arg`, 'the name of the argument that gets the output folder');
    run = { mcp: r.mcp as string, tool: (r.tool as string).trim(), ...(r.out_arg ? { out_arg: (r.out_arg as string).trim() } : {}) };
  }
  let quote: ToolOperation['quote'];
  if (o.quote !== undefined) {
    const q = o.quote;
    if (!record(q) || typeof q.unit !== 'string' || !q.unit.trim()) return bad(`${at}.quote`, 'a mapping with unit and fixed or tool');
    const extraQuote = Object.keys(q).filter(k => !['unit', 'fixed', 'tool'].includes(k));
    if (extraQuote.length) bad(`${at}.quote.${extraQuote[0]}`, 'unknown key');
    if ((q.fixed === undefined) === (q.tool === undefined)) bad(`${at}.quote`, 'needs one of fixed (an amount) or tool (an MCP tool that prices the input)');
    if (q.fixed !== undefined && (typeof q.fixed !== 'number' || !Number.isFinite(q.fixed) || q.fixed < 0)) bad(`${at}.quote.fixed`, 'an amount of at least 0');
    if (q.tool !== undefined && (typeof q.tool !== 'string' || !q.tool.trim())) bad(`${at}.quote.tool`, 'an MCP tool name');
    if (q.tool !== undefined && !('mcp' in run)) bad(`${at}.quote.tool`, 'a quote tool needs an operation that runs through mcp (it is called on the same server)');
    quote = { unit: q.unit.trim(), ...(q.fixed !== undefined ? { fixed: q.fixed as number } : {}), ...(q.tool !== undefined ? { tool: (q.tool as string).trim() } : {}) };
  }
  const out = o.output === undefined ? {} : o.output;
  if (!record(out)) return bad(`${at}.output`, 'a mapping with files and/or text');
  const extraOut = Object.keys(out).filter(k => !['files', 'text'].includes(k));
  if (extraOut.length) bad(`${at}.output.${extraOut[0]}`, 'unknown key');
  if (out.files !== undefined && (!Array.isArray(out.files) || out.files.some(x => typeof x !== 'string' || !x.trim()))) bad(`${at}.output.files`, 'a list of file patterns, e.g. ["*.png"]');
  if (out.text !== undefined && (typeof out.text !== 'string' || !/^[^/\\]+$/.test(out.text) || out.text.startsWith('.'))) bad(`${at}.output.text`, 'a file name (no folder)');
  if (out.text !== undefined && !('mcp' in run)) bad(`${at}.output.text`, 'only an operation that runs through mcp has an answer text');
  const timeout = o.timeout_minutes ?? 10;
  if (typeof timeout !== 'number' || !(timeout > 0) || timeout > 24 * 60) bad(`${at}.timeout_minutes`, 'minutes above 0, at most a day');
  return {
    description: (o.description as string).trim(), input: input as JsonSchema, run, ...(quote ? { quote } : {}),
    output: { ...(out.files ? { files: out.files as string[] } : {}), ...(out.text ? { text: out.text as string } : {}) }, timeout_minutes: timeout as number,
  };
}

/** The plugin folders directly under `dir` (each one with an alba-plugin.yaml), sorted by name. */
export function pluginFolders(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).sort().map(name => path.join(dir, name)).filter(d => existsSync(path.join(d, MANIFEST)));
}
