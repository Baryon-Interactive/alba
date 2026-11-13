import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { fail } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { ResolvedRole, RoleServer } from '../roles/config.ts';
import { folderSize, readFrontMatter, type RegistrySkill } from '../skills/registry.ts';
import type { LoadedTool } from './registry.ts';

/** The servers a worker gets: all but those only for operations (`workers: false`). */
export const workerServers = (tool: LoadedTool) => Object.entries(tool.manifest.agent.mcp).filter(([, s]) => s.workers !== false);

export interface OrderTools { tools: LoadedTool[]; problems: string[] }

/** The tools a run of the order gets: the ones it names (`tools`) and the ones of its kind (`plugins.by_kind`), each once. */
export function orderTools(project: ProjectConfig, doc: OrderDoc, kind = doc.order.kind): OrderTools {
  const enabled = project.plugins?.tools ?? {};
  const ids = [...new Set([...(doc.order.tools ?? []), ...(project.plugins?.by_kind[kind] ?? [])])];
  const tools: LoadedTool[] = [], problems: string[] = [];
  for (const id of ids) {
    const tool = Object.hasOwn(enabled, id) ? enabled[id] : undefined;
    if (tool) tools.push(tool);
    else problems.push(`the order uses the tool "${id}", which is not enabled under "plugins.enable" in ${project.file}`);
  }
  return { tools, problems };
}

/** The resources the order's tools hold while a run uses them. */
export const toolResources = (tools: readonly LoadedTool[]): string[] => [...new Set(tools.flatMap(t => Object.keys(t.manifest.resources ?? {})))];

/**
 * The role with the tools' MCP servers added, for the role mount. A tool server never replaces a role server of the same name: that
 * would silently change what a role was set up to get.
 */
export function withToolServers(role: ResolvedRole, tools: readonly LoadedTool[]): ResolvedRole {
  if (!tools.some(t => workerServers(t).length)) return role;
  const mcp: Record<string, RoleServer> = { ...role.definition?.mcp };
  for (const tool of tools) for (const [name, s] of workerServers(tool)) {
    if (Object.hasOwn(mcp, name)) fail('tool {tool}: the MCP server name "{server}" is already used by role {role} or another tool.', { tool: tool.manifest.id, server: name, role: role.id ?? '-' });
    mcp[name] = { command: s.command, args: s.args, ...(s.env_from ? { env_from: s.env_from } : {}), ...(s.engines ? { engines: s.engines } : {}), ...(s.tools ? { tools: s.tools } : {}) };
  }
  return { ...role, definition: { sources: {}, ...role.definition, mcp } };
}

/** Fails before launch, by name only, when a tool's server needs an environment variable that is not set. */
export function checkToolEnvironment(tools: readonly LoadedTool[], engine: string, environment: NodeJS.ProcessEnv = process.env): void {
  for (const tool of tools) for (const [name, s] of workerServers(tool)) {
    if (s.engines?.length && !s.engines.includes(engine)) continue;
    for (const key of s.env_from ?? []) if (environment[key] === undefined) fail('tool {tool}: agent.mcp.{server} needs the environment variable {name}, which is not set.', { tool: tool.manifest.id, server: name, name: key });
  }
}

/** The tools' skill folders as registry entries, so they are mounted like any other skill. They have no tags: only the tool brings them. */
export function toolSkills(tools: readonly LoadedTool[]): { skill: RegistrySkill; tool: string }[] {
  return tools.filter(t => t.manifest.agent.skill).map(t => {
    const dir = t.manifest.agent.skill!;
    const skillFile = path.join(dir, 'SKILL.md');
    const front = readFrontMatter(readFileSync(skillFile, 'utf8'));
    const size = folderSize(dir);
    const skill: RegistrySkill = { name: front.name ?? path.basename(dir), description: front.description ?? t.manifest.description, tags: [], source: `plugin:${t.manifest.id}`, dir, files: size.files, bytes: size.bytes, skillFile: skillFile.replace(/\\/g, '/'), core: false, scope: 'project', engines: front.engines, applicable: true };
    return { skill, tool: t.manifest.id };
  });
}

/** The prompt section that lists the run's tools: what each is for, how to reach it, and what it holds. */
export function toolsPrompt(tools: readonly LoadedTool[], engine: string, mounted: readonly string[]): string {
  if (!tools.length) return '';
  const lines = ['', '## Tools of this run', ''];
  for (const tool of tools) {
    const m = tool.manifest;
    const ways: string[] = [];
    for (const [name, s] of workerServers(tool)) {
      if (s.engines?.length && !s.engines.includes(engine)) continue;
      ways.push(mounted.includes(name) ? `MCP server \`${name}\`${s.tools ? ` (tools: ${s.tools.join(', ')})` : ''}` : `MCP server \`${name}\` is not available to this engine`);
    }
    if (m.agent.cli) ways.push(`command \`${m.agent.cli.program}\`${m.agent.cli.fallback ? ' (when the MCP server cannot do it, or the order or a note asks for it)' : ''}`);
    if (m.agent.skill) ways.push(`its skill \`${path.basename(m.agent.skill)}\` says how to use it`);
    const holds = Object.keys(m.resources ?? {});
    lines.push(`- **${m.id}**: ${m.description} ${ways.join('; ')}.${holds.length ? ` A run holds ${holds.join(', ')} while it uses it.` : ''}`);
  }
  lines.push('', 'Quote a paid call before making it, and stay inside the order\'s credit cap. An order or a note may change how a tool is used; it wins over the tool\'s skill.', '');
  return lines.join('\n');
}
