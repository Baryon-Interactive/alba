import { spawnSync } from 'node:child_process';
import { McpStdio } from './mcp-client.ts';
import type { LoadedTool } from './registry.ts';
import type { ToolServer } from './manifest.ts';

export interface DoctorCheck { name: string; ok: boolean; detail: string }
export interface DoctorResult { id: string; ok: boolean; checks: DoctorCheck[] }

/**
 * Starts an MCP server over stdio, asks for its tools and stops it. The server gets the named environment variables only from this
 * process's environment; nothing is written anywhere.
 */
export async function listServerTools(server: ToolServer, timeoutMs = 20000): Promise<{ tools?: string[]; error?: string }> {
  let session: McpStdio | undefined;
  try { session = await McpStdio.open(server, timeoutMs); return { tools: await session.listTools(timeoutMs) }; }
  catch (e) { return { error: (e as Error).message }; }
  finally { session?.close(); }
}

/** What `alba plugins doctor` checks on this machine: the probe, the named secrets (by name only), and that each MCP server starts and offers the tools the manifest lists. */
export async function doctorTool(tool: LoadedTool, environment: NodeJS.ProcessEnv = process.env, timeoutMs = 20000): Promise<DoctorResult> {
  const m = tool.manifest;
  const checks: DoctorCheck[] = [];
  const probe = m.machines?.probe;
  if (probe?.length) {
    const r = spawnSync(probe[0]!, probe.slice(1), { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    checks.push({ name: 'probe', ok: r.status === 0, detail: r.error ? r.error.message : r.status === 0 ? `${probe.join(' ')}: ${(r.stdout || r.stderr || '').trim().split('\n')[0] || 'ok'}` : `${probe.join(' ')} exited with ${r.status}` });
  }
  const names = [...new Set(Object.values(m.agent.mcp).flatMap(s => s.env_from ?? []))];
  if (names.length) {
    const missing = names.filter(n => environment[n] === undefined || environment[n] === '');
    checks.push({ name: 'environment', ok: !missing.length, detail: missing.length ? `not set: ${missing.join(', ')}` : `set: ${names.join(', ')}` });
  }
  for (const [name, server] of Object.entries(m.agent.mcp)) {
    if ((server.env_from ?? []).some(n => environment[n] === undefined || environment[n] === '')) {
      checks.push({ name: `mcp ${name}`, ok: false, detail: 'not started: a variable it needs is not set' });
      continue;
    }
    const listed = await listServerTools(server, timeoutMs);
    if (listed.error) { checks.push({ name: `mcp ${name}`, ok: false, detail: listed.error }); continue; }
    const absent = (server.tools ?? []).filter(x => !listed.tools!.includes(x));
    checks.push({ name: `mcp ${name}`, ok: !absent.length, detail: absent.length ? `the server does not offer: ${absent.join(', ')}` : `offers ${listed.tools!.length} tool(s)${server.tools ? `; the ${server.tools.length} listed are there` : ''}` });
  }
  if (m.agent.cli) {
    const r = spawnSync(m.agent.cli.program, ['--version'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    checks.push({ name: 'cli', ok: !r.error, detail: r.error ? `${m.agent.cli.program}: ${r.error.message}` : `${m.agent.cli.program} found` });
  }
  return { id: m.id, ok: checks.every(c => c.ok), checks };
}
