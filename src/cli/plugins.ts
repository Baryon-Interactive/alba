import type { ProjectConfig } from '../config.ts';
import { fail } from '../i18n.ts';
import { adapters } from '../workers/adapters/index.ts';
import { ENGINE_IDS } from '../machines/engines/index.ts';
import { doctorProject } from '../plugins/doctor.ts';
import { discoverPlugins, type LoadedTool } from '../plugins/registry.ts';

/** The tool ids of `--tools a,b`, each one enabled in the project (an empty value clears the list). */
export function enabledTools(project: ProjectConfig, csv: string): string[] {
  const ids = [...new Set(csv.split(',').map(s => s.trim()).filter(Boolean))];
  const enabled = Object.keys(project.plugins?.tools ?? {});
  const unknown = ids.filter(id => !enabled.includes(id));
  if (unknown.length) fail('The project does not enable the tool(s): {names}. Enabled under "plugins.enable": {known}.', { names: unknown.join(', '), known: enabled.join(', ') || '-' });
  return ids;
}

const view = (tool: LoadedTool, enabled: boolean) => ({
  id: tool.manifest.id, version: tool.manifest.version, kinds: tool.manifest.kinds, origin: tool.origin, enabled, description: tool.manifest.description,
  folder: tool.dir.replace(/\\/g, '/'), mcp: tool.manifest.agent.mcp, ...(tool.manifest.agent.skill ? { skill: tool.manifest.agent.skill } : {}),
  ...(tool.manifest.agent.cli ? { cli: tool.manifest.agent.cli } : {}), ...(tool.manifest.machines ? { machines: tool.manifest.machines } : {}),
  ...(tool.manifest.resources ? { resources: tool.manifest.resources } : {}),
  ...(tool.manifest.settings ? { settings: tool.manifest.settings } : {}), ...(tool.manifest.operations ? { operations: Object.keys(tool.manifest.operations) } : {}),
});

/** `alba plugins list | show <id> | doctor [<id>]`. */
export async function runPlugins(project: ProjectConfig, command: string | undefined, rest: string[], json: boolean, setExitCode: (code: number) => void = () => {}): Promise<string> {
  const found = discoverPlugins(project.plugins?.sources ?? [], undefined, project.plugins?.replace);
  const enabled = new Set(Object.keys(project.plugins?.tools ?? {}));
  const byKind = Object.entries(project.plugins?.by_kind ?? {});
  if (command === undefined || command === 'list') {
    const tools = found.tools.map(x => view(x, enabled.has(x.manifest.id)));
    const builtIn = { engines: adapters.map(a => a.id), game_engines: ENGINE_IDS };
    if (json) return JSON.stringify({ tools, built_in: builtIn, by_kind: Object.fromEntries(byKind), problems: found.problems }, null, 2);
    const lines = ['Tools:'];
    if (!tools.length) lines.push('  (none)');
    for (const x of tools) lines.push(`  ${x.enabled ? '*' : ' '} ${x.id}@${x.version}  ${x.origin}  ${x.description}`);
    lines.push('  (* enabled in this project)');
    if (byKind.length) lines.push('', 'By kind:', ...byKind.map(([k, ids]) => `  ${k}: ${ids.join(', ')}`));
    lines.push('', `Built in (not loadable as plugins yet): engines ${builtIn.engines.join(', ')}; game engines ${builtIn.game_engines.join(', ')}`);
    if (found.problems.length) lines.push('', 'Problems:', ...found.problems.map(p => `  ${p}`));
    return lines.join('\n');
  }
  if (command === 'show') {
    if (!rest[0]) fail('Usage: {usage}', { usage: 'alba plugins show <id> [--json]' });
    const tool = found.tools.find(x => x.manifest.id === rest[0]);
    if (!tool) fail('No plugin "{id}". Known: {known}.', { id: rest[0]!, known: found.tools.map(x => x.manifest.id).join(', ') || '-' });
    const v = view(tool!, enabled.has(tool!.manifest.id));
    if (json) return JSON.stringify(v, null, 2);
    const lines = [`${v.id}@${v.version} (${v.origin}${v.enabled ? ', enabled' : ', not enabled'})`, v.description, `folder: ${v.folder}`];
    for (const [name, s] of Object.entries(v.mcp)) lines.push(`mcp ${name}: ${[s.command, ...s.args].join(' ')}${s.tools ? `  tools: ${s.tools.join(', ')}` : ''}${s.env_from ? `  env: ${s.env_from.join(', ')}` : ''}${s.engines ? `  engines: ${s.engines.join(', ')}` : ''}`);
    if (v.skill) lines.push(`skill: ${v.skill}`);
    if (v.cli) lines.push(`cli: ${v.cli.program}${v.cli.fallback ? ' (fallback)' : ''}`);
    if (v.machines?.probe) lines.push(`probe: ${v.machines.probe.join(' ')}`);
    if (v.settings) lines.push(...Object.entries(v.settings).map(([n, x]) => `setting ${n}: ${project.plugins?.tools[v.id]?.settings?.[n] ?? (x.default !== undefined ? `${JSON.stringify(x.default)} (default)` : '(not set)')}  ${x.description}`));
    if (v.operations) lines.push(`operations: ${v.operations.join(', ')} (alba tools list)`);
    if (v.resources) lines.push(`resources: ${Object.entries(v.resources).map(([n, r]) => `${n} (${r.slots} slot${r.slots === 1 ? '' : 's'})`).join(', ')}`);
    const kinds = byKind.filter(([, ids]) => ids.includes(v.id)).map(([k]) => k);
    if (kinds.length) lines.push(`used by kinds: ${kinds.join(', ')}`);
    return lines.join('\n');
  }
  if (command === 'doctor') {
    const ids = rest.length ? rest : [...enabled];
    if (!ids.length) return json ? '[]' : 'No tool is enabled in this project; name one: alba plugins doctor <id>.';
    const results = await doctorProject(project, ids);
    if (results.some(r => !r.ok)) setExitCode(1);
    if (json) return JSON.stringify(results, null, 2);
    return results.map(r => [`${r.ok ? 'ok  ' : 'FAIL'} ${r.id}`, ...r.checks.map(c => `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)].join('\n')).join('\n');
  }
  return fail('Usage: {usage}', { usage: 'alba plugins list | show <id> | doctor [<id>...] [--json]' });
}
