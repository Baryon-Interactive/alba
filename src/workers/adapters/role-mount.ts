import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fail } from '../../i18n.ts';
import { excludeLocally } from '../../skills/mount.ts';
import type { ResolvedRole } from '../../roles/config.ts';

export interface RoleMount { args: string[]; env: Record<string, string>; servers: string[]; warnings: string[] }
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const opencodeFile = '.opencode/opencode.json';
const ownerFile = '.alba/role-opencode.sha256';

/** Remove only our unchanged generated OpenCode file, including when a later run has no role. */
function clearOpenCode(cwd: string): void {
  const owner = path.join(cwd, ownerFile), target = path.join(cwd, opencodeFile);
  if (!existsSync(owner)) return;
  if (existsSync(target)) {
    if (digest(readFileSync(target, 'utf8')) !== readFileSync(owner, 'utf8')) fail('Role MCP config {file} was edited; move it before launching again.', { file: target });
    rmSync(target);
  }
  rmSync(owner);
}

/** No values enter argv or config files. env_from is resolved only into the child environment. */
export function mountRole(cwd: string, engine: string, role: ResolvedRole, environment: NodeJS.ProcessEnv = process.env): RoleMount {
  clearOpenCode(cwd);
  const result: RoleMount = { args: [], env: {}, servers: [], warnings: [] };
  const entries = Object.entries(role.definition?.mcp ?? {}).filter(([, s]) => !s.engines?.length || s.engines.includes(engine));
  if (!entries.length) return result;
  if (!['claude-cli', 'codex-cli', 'opencode'].includes(engine)) {
    result.warnings.push(`role ${role.id}: MCP servers not mounted for engine ${engine}`);
    return result;
  }
  for (const [name, server] of entries) for (const key of server.env_from ?? []) {
    if (environment[key] === undefined) fail('role {role}: mcp.{server}.env_from: environment variable {name} is not set.', { role: role.id!, server: name, name: key });
    result.env[key] = environment[key]!;
  }
  result.servers = entries.map(([name]) => name);
  if (engine === 'codex-cli') {
    for (const [name, server] of entries) for (const [key, value] of Object.entries(server.url ? { url: server.url, ...(server.tools ? { enabled_tools: server.tools } : {}) } : { command: server.command, args: server.args, env_vars: server.env_from ?? [], ...(server.tools ? { enabled_tools: server.tools } : {}) })) result.args.push('-c', `mcp_servers.${name}.${key}=${JSON.stringify(value)}`);
    return result;
  }
  mkdirSync(path.join(cwd, '.alba'), { recursive: true });
  excludeLocally(cwd, ['/.alba/']);
  if (engine === 'claude-cli') {
    const file = path.join(cwd, '.alba/role-mcp.json');
    const mcpServers = Object.fromEntries(entries.map(([name, s]) => [name, s.url ? { type: 'http', url: s.url } : { command: s.command, args: s.args, env: Object.fromEntries((s.env_from ?? []).map(n => [n, '${' + n + '}'])) }]));
    writeFileSync(file, JSON.stringify({ mcpServers }, null, 2) + '\n', 'utf8');
    result.args.push('--mcp-config', file, '--allowedTools', entries.flatMap(([n, s]) => s.tools ? s.tools.map(x => `mcp__${n}__${x}`) : [`mcp__${n}__*`]).join(','));
  } else {
    for (const [name, s] of entries) if (s.tools) result.warnings.push(`role ${role.id}: mcp.${name}: OpenCode gets all of the server's tools (no per-server list)`);
    const target = path.join(cwd, opencodeFile);
    if (existsSync(target)) fail('Role MCP config cannot replace existing {file}; move the existing config first.', { file: target });
    mkdirSync(path.dirname(target), { recursive: true });
    excludeLocally(cwd, [`/${opencodeFile}`]);
    const servers = Object.fromEntries(entries.map(([name, s]) => [name, s.url ? { type: 'remote', url: s.url } : { type: 'local', command: [s.command, ...s.args], environment: Object.fromEntries((s.env_from ?? []).map(n => [n, `{env:${n}}`])) }]));
    const text = JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { servers } }, null, 2) + '\n';
    writeFileSync(target, text, 'utf8');
    writeFileSync(path.join(cwd, ownerFile), digest(text), 'utf8');
  }
  return result;
}

