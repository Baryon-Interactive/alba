import { spawn } from 'node:child_process';
import type { ProjectConfig } from '../config.ts';
import { McpStdio } from './mcp-client.ts';
import { withSettings } from './manifest.ts';
import { discoverPlugins, type LoadedTool } from './registry.ts';
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

/**
 * Runs a program (no shell) and waits for it without holding this thread: `alba serve` runs the doctor on its main thread, and a
 * probe that takes seconds must not stop other requests meanwhile. Killed after `timeoutMs`.
 */
function runProgram(program: string, args: string[], timeoutMs: number): Promise<{ status: number | null; out: string; error?: string }> {
  return new Promise(resolve => {
    let out = '', settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (v: { status: number | null; out: string; error?: string }) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return done({ status: null, out: '', error: (e as Error).message }); }
    timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done({ status: null, out, error: `no answer within ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
    const keep = (d: Buffer) => { if (out.length < 4000) out += d; };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    child.on('error', e => done({ status: null, out, error: e.message }));
    child.on('close', code => done({ status: code, out }));
  });
}

/** What `alba plugins doctor` checks on this machine: the probe, the named secrets (by name only), and that each MCP server starts and offers the tools the manifest lists. */
export async function doctorTool(tool: LoadedTool, environment: NodeJS.ProcessEnv = process.env, timeoutMs = 20000): Promise<DoctorResult> {
  const m = tool.manifest;
  const checks: DoctorCheck[] = [];
  const probe = m.machines?.probe;
  if (probe?.length) {
    const r = await runProgram(probe[0]!, probe.slice(1), timeoutMs);
    checks.push({ name: 'probe', ok: r.status === 0, detail: r.error ? r.error : r.status === 0 ? `${probe.join(' ')}: ${r.out.trim().split('\n')[0] || 'ok'}` : `${probe.join(' ')} exited with ${r.status}` });
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
    const r = await runProgram(m.agent.cli.program, ['--version'], timeoutMs);
    checks.push({ name: 'cli', ok: !r.error, detail: r.error ? `${m.agent.cli.program}: ${r.error}` : `${m.agent.cli.program} found` });
  }
  return { id: m.id, ok: checks.every(c => c.ok), checks };
}

/**
 * The doctor for a project's tools: the named ones, or the enabled ones without names. An enabled tool is checked with the project's
 * settings; another one with its defaults (a setting without a default is a failed check). The tools are checked one after another,
 * so at most one of their servers runs at a time. It starts servers and lists their tools; it never calls one.
 */
export async function doctorProject(project: ProjectConfig, ids?: readonly string[], environment: NodeJS.ProcessEnv = process.env, timeoutMs = 20000): Promise<DoctorResult[]> {
  const found = discoverPlugins(project.plugins?.sources ?? [], undefined, project.plugins?.replace);
  const list = ids?.length ? [...new Set(ids)] : Object.keys(project.plugins?.tools ?? {});
  const results: DoctorResult[] = [];
  for (const id of list) {
    const raw = found.tools.find(x => x.manifest.id === id);
    let tool = project.plugins?.tools[id] ?? raw;
    if (tool && tool === raw) {
      try { tool = { ...raw, manifest: withSettings(raw.manifest, {}) }; }
      catch (e) { results.push({ id, ok: false, checks: [{ name: 'settings', ok: false, detail: `${(e as Error).message}; enable it and set it under plugins.settings.${id}` }] }); continue; }
    }
    if (!tool) { results.push({ id, ok: false, checks: [{ name: 'manifest', ok: false, detail: found.problems.find(p => p.includes(`/${id}/`)) ?? 'no such plugin' }] }); continue; }
    results.push(await doctorTool(tool, environment, timeoutMs));
  }
  return results;
}
