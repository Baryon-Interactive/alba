import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { workerEnvironment } from '../../run/environment.ts';
import { agyEvent } from '../../workers/adapters/agy-protocol.ts';
import { t } from '../../i18n.ts';
import type { ProducerEngineConfig } from '../../config.ts';
import { PRODUCER_TOOLS, type SessionEngine, type SessionEvent, type SessionStartOptions } from '../session.ts';
import { addUsage, emptyUsage, requestDelta, type SessionUsage } from '../session-usage.ts';
import { codexCommand, writeAtomic } from './codex.ts';

/**
 * The Antigravity CLI (`agy`, run directly; never through OpenCode or a gateway) as a producer engine.
 *
 * agy has no command-line option for MCP servers or a tool list, and `agy mcp add` writes the person's global
 * configuration. The host therefore writes a custom agent into a workspace folder of its own in the state folder
 * (`.agents/agents/<name>.md`, found only when agy runs in that folder) and selects it with `--agent`:
 * - `mcpServers` lists only the producer's MCP server and `inheritMcp: false` keeps the person's own servers from the
 *   agent (agy still connects to them at startup, but refuses calls to them: "tool ... is not enabled for server ...");
 * - `tools: [view_file]` is the only built-in tool listed (MCP calls and resource reads come with agy's MCP support);
 * - `inheritCustomizations: false` leaves out ambient rules, skills and subagents, and the body is the system prompt.
 * A session-only `--settings` file (never saved by agy) adds permission rules on top: the producer's tools are allowed,
 * commands, file writes and web access are denied, and deny rules win over any allow rule in the person's settings.
 * Headless agy denies every action that would ask for approval, and no `--dangerously-skip-permissions` is passed.
 */
export const AGY_SERVER = 'alba-producer';
const DENY = ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'unsandboxed(*)'];

export const agyEffort = (effort: NonNullable<ProducerEngineConfig['effort']>): string => ['none', 'minimal'].includes(effort) ? 'low' : effort;

export interface AgyAgent { name: string; description: string; systemPrompt: string; mcpConfig: string; tools: readonly string[] }
/** One custom agent and the session settings in `dir`, the workspace agy runs in. Returns the settings file. */
export function writeAgyWorkspace(dir: string, agent: AgyAgent): string {
  const servers = JSON.parse(readFileSync(agent.mcpConfig, 'utf8')).mcpServers as Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  // JSON scalars and flow collections are valid YAML, so no value can break out of its field.
  const q = (value: unknown) => JSON.stringify(value);
  const front = [
    `name: ${q(agent.name)}`, `description: ${q(agent.description)}`, 'mainAgent: true', 'subagent: false', 'inheritMcp: false', 'inheritCustomizations: false',
    'tools: ["view_file"]', 'commandExecutionPolicy: "off"', 'mcpServers:',
    ...Object.entries(servers).flatMap(([name, server]) => [`  - name: ${q(name)}`, `    command: ${q(server.command)}`, `    args: ${q(server.args ?? [])}`, `    env: ${q(server.env ?? {})}`]),
  ];
  const agents = path.join(dir, '.agents', 'agents');
  mkdirSync(agents, { recursive: true });
  writeAtomic(path.join(agents, `${agent.name}.md`), `---\n${front.join('\n')}\n---\n${agent.systemPrompt.replace(/\r\n/g, '\n')}\n`);
  const settings = path.join(dir, 'agy-settings.json');
  writeAtomic(settings, JSON.stringify({
    // Default agent mode (not Auto, whose reviewer may approve commands) and review for anything not allowed below.
    agentMode: '', toolPermission: 'request-review',
    permissions: { allow: ['read_file(*)', ...Object.keys(servers).flatMap(server => agent.tools.map(tool => `mcp(${server}/${tool})`))], deny: DENY },
  }, null, 2) + '\n');
  return settings;
}

/** Flags shared by the router and detached work: everything before the prompt, Go-style. */
export function agyArgs(options: Pick<SessionStartOptions, 'model' | 'effort'> & { agent: string; settings: string; addDirs: string[] }): string[] {
  return ['--output-format', 'stream-json', '--agent', options.agent, '--settings', options.settings, '--disable-slash-commands',
    ...(options.model ? ['--model', options.model] : []), ...(options.effort ? ['--effort', agyEffort(options.effort)] : []), ...options.addDirs.flatMap(dir => ['--add-dir', dir])];
}

export const AGY_ROUTER_AGENT = 'alba-producer';
/** The router's workspace: a folder of its own next to the MCP configuration, with the project root added for reading. */
export const agyRouterWorkspace = (options: SessionStartOptions): string => path.join(path.dirname(options.mcpConfig), 'producer-agy');

/**
 * One `agy --input-format stream-json` process: every stdin line `{"event":"user","message":{...}}` is one turn with its
 * own result. A process that ends cleanly before it started on the next turn is not a lost session: the next batch, or
 * the turns it had not begun, go to a new process that resumes the same conversation with `--conversation` (once per turn).
 */
export class AgyEngine implements SessionEngine {
  private options!: SessionStartOptions;
  private settings = '';
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  private queue: SessionEvent[] = [];
  private waiters: ((event: IteratorResult<SessionEvent>) => void)[] = [];
  private used: SessionUsage = emptyUsage();
  private totals = new Map<string, SessionUsage>();
  private stderr = '';
  /** Messages written to the current process whose result has not arrived, oldest first. */
  private unanswered: string[] = [];
  /** agy reported a step since the last result, so the oldest unanswered turn has started and cannot be sent again. */
  private progressed = false;
  private resumes = 0;
  /** The conversation agy reported in its init and result events; a relaunch resumes it. */
  conversationId?: string;
  private push(event: SessionEvent): void { const waiter = this.waiters.shift(); if (waiter) waiter({ value: event, done: false }); else this.queue.push(event); }
  args(): string[] {
    // `-p=` with an empty prompt: the turns come from stdin. agy parses flags Go-style, so it is the last argument.
    return ['--input-format', 'stream-json', ...agyArgs({ ...this.options, agent: AGY_ROUTER_AGENT, settings: this.settings, addDirs: [this.options.cwd] }), ...(this.conversationId ? ['--conversation', this.conversationId] : []), '-p='];
  }
  async start(options: SessionStartOptions): Promise<void> {
    this.options = options; this.stopped = false;
    const workspace = agyRouterWorkspace(options);
    this.settings = writeAgyWorkspace(workspace, { name: AGY_ROUTER_AGENT, description: 'Alba producer router: routes producer cards through the Alba producer MCP tools.', mcpConfig: options.mcpConfig, tools: PRODUCER_TOOLS,
      systemPrompt: `${options.systemPrompt}\nProject files are under ${options.cwd.replace(/\\/g, '/')}; read them with absolute paths.` });
    await this.launch();
  }
  private launch(): Promise<void> {
    const command = codexCommand(this.options.cli || 'agy');
    const child = spawn(command.program, [...command.prefix, ...this.args()], { cwd: agyRouterWorkspace(this.options), env: workerEnvironment(process.env, {}, []), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child; this.stderr = '';
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let n: number;
      while ((n = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, n).trim(); buffer = buffer.slice(n + 1); if (line) this.line(line); }
    });
    child.stderr.on('data', (chunk: Buffer | string) => { this.stderr = (this.stderr + String(chunk)).slice(-2000); });
    // Writing to a process that already exited raises EPIPE on stdin; without a handler it would crash serve.
    child.stdin.on('error', (error: Error) => { if (!this.stopped) this.push({ type: 'stderr', text: `stdin: ${error.message}` }); });
    child.once('close', (code, signal) => {
      if (buffer.trim()) this.line(buffer.trim());
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      const again = this.unanswered.splice(0);
      if (code === 0 && this.conversationId && !this.progressed) {
        if (!again.length) return;
        if (this.resumes++ < 1) { void this.launch().then(() => this.write(again)).catch((error: Error) => this.push({ type: 'process_exit', text: `agy could not resume: ${error.message}` })); return; }
      }
      this.push({ type: 'process_exit', text: `agy exited (${code ?? signal ?? 'unknown'})${this.stderr.trim() ? `: ${this.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')}` : ''}`, raw: { code, signal } });
    });
    return new Promise((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
  }
  private line(line: string): void {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(line); } catch { this.push({ type: 'stderr', text: line, raw: line }); return; }
    const event = agyEvent(raw);
    if (!event) { this.push({ type: 'stderr', text: line, raw }); return; }
    if (event.kind === 'init') { this.conversationId = event.conversationId ?? this.conversationId; return; }
    if (event.kind === 'result') {
      this.conversationId = event.result.conversationId || this.conversationId;
      this.unanswered.shift(); this.progressed = false; this.resumes = 0;
      const failed = event.result.status !== 'SUCCESS';
      const text = failed ? event.result.error || `agy turn ${event.result.status || 'failed'}.` : event.result.response;
      this.push({ type: 'result', text, engine: 'agy', model: this.options.model, raw: { type: 'result', is_error: failed, result: text } });
      return;
    }
    if (event.kind !== 'step') return;
    this.progressed = true;
    const s = event.step;
    if (s.type === 'agent_response' && s.textDelta) this.push({ type: 'stream_event', text: s.textDelta, raw });
    if (s.type === 'tool' && s.tool) {
      const id = `agy:${s.conversationId ?? ''}:${s.index}`, p = s.parameters ?? {};
      // MCP calls are named as in the Claude engine, so the console shows the same producer tool names.
      const name = s.tool === 'call_mcp_tool' && typeof p.ServerName === 'string' && typeof p.ToolName === 'string' ? `mcp__${p.ServerName}__${p.ToolName}` : s.tool;
      const input = s.tool === 'call_mcp_tool' ? p.Arguments ?? {} : p;
      if (s.state === 'ACTIVE') this.push({ type: 'assistant', raw: { message: { content: [{ type: 'tool_use', id, name, input }] } } });
      else {
        const error = s.state !== 'DONE' ? String(((raw.step_update as Record<string, any>)?.tool_info?.error?.message) ?? s.message ?? `agy tool ${s.state}`) : undefined;
        this.push({ type: 'assistant', raw: { message: { content: [{ type: 'tool_use', id, name, input }, { type: 'tool_result', tool_use_id: id, content: error ?? s.output ?? '', is_error: !!error }] } } });
      }
    }
    const request = requestDelta(raw, this.totals);
    if (request && request.usage.total_tokens > 0) { addUsage(this.used, request.usage); this.push({ type: 'usage', usage: request.usage, requestId: request.id, engine: 'agy', model: this.options.model, raw }); }
  }
  async sendBatch(messages: string[]): Promise<void> {
    if (this.stopped) throw new Error(t('The producer session process is not running.'));
    if (!this.child) {
      if (!this.conversationId) throw new Error(t('The producer session process is not running.'));
      await this.launch();
    }
    this.write(messages);
  }
  private write(messages: string[]): void {
    if (!this.child?.stdin.writable) throw new Error(t('The producer session process is not running.'));
    for (const message of messages) { this.unanswered.push(message); this.child.stdin.write(`${JSON.stringify({ event: 'user', message: { role: 'user', content: message } })}\n`); }
  }
  async *readEvents(): AsyncIterable<SessionEvent> {
    while (!this.stopped || this.queue.length) {
      if (this.queue.length) { yield this.queue.shift()!; continue; }
      const event = await new Promise<IteratorResult<SessionEvent>>(resolve => this.waiters.push(resolve));
      if (event.done) return;
      yield event.value;
    }
  }
  /** Closing stdin lets agy end its turn loop and its MCP servers; a process still running after 5 s is killed. */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child; this.child = undefined;
    if (child) {
      const closed = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve()); });
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000); timer.unref();
      await closed; clearTimeout(timer);
    }
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  usage(): SessionUsage { return { ...this.used }; }
}
