import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { workerEnvironment } from '../../run/environment.ts';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SessionEngine, SessionEvent, SessionStartOptions } from '../session.ts';
import { addUsage, emptyUsage, requestDelta, type SessionUsage } from '../session-usage.ts';

/** TOML literals, also used by the exec work-session launcher. No shell interpolation. */
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Concurrent sessions share these files and a starting Codex may be reading one: write a sibling, then rename over it. */
export function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, file);
}
/** Metadata for a model id the bundled catalog lacks: the entry whose slug is the longest prefix of it (a provider
 * alias such as "<model>-sub"), else the longest shared leading run of characters, else the first entry. */
export function catalogEntryFor(models: { slug?: string }[], model: string): { slug?: string } {
  let best = models[0], score = -1;
  for (const entry of models) {
    const slug = entry.slug ?? '';
    const prefix = model.startsWith(slug) ? slug.length + 1000 : [...slug].findIndex((ch, i) => model[i] !== ch);
    const value = prefix === -1 ? Math.min(slug.length, model.length) : prefix;
    if (value > score) { best = entry; score = value; }
  }
  return best;
}
/** One prepared catalog per Codex executable and model for the life of the process (the CLI call takes seconds). */
const preparedCatalogs = new Map<string, string>();
/** Current Codex selects apply_patch from model metadata, not a feature flag. */
function readOnlyCatalog(options: SessionStartOptions): string {
  const command = codexCommand(options.cli);
  const file = options.mcpConfig + '.models.json';
  const key = JSON.stringify([command.program, command.prefix, options.model ?? '', file]);
  const cached = preparedCatalogs.get(key); if (cached && existsSync(cached)) return cached;
  const catalog = JSON.parse(execFileSync(command.program, [...command.prefix, 'debug', 'models', '--bundled'], { cwd: options.cwd, env: workerEnvironment(process.env, {}, []), encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }));
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('Codex must provide a bundled model catalog to disable producer write tools.');
  // Unknown provider model ids still need an explicit, restricted metadata entry, copied from the closest known model.
  if (options.model && !catalog.models.some((model: any) => model.slug === options.model)) catalog.models.push({ ...catalogEntryFor(catalog.models, options.model), slug: options.model });
  for (const model of catalog.models) { model.apply_patch_tool_type = null; model.shell_type = 'disabled'; }
  writeAtomic(file, JSON.stringify(catalog)); preparedCatalogs.set(key, file);
  return file;
}
export function codexConfigArgs(options: SessionStartOptions): string[] {
  const mcp = JSON.parse(readFileSync(options.mcpConfig, 'utf8')).mcpServers;
  // With approval_policy "never" Codex refuses every MCP tool call unless the server pre-approves its tools; the
  // producer server is the only one attached and enforces read-only/action gates itself.
  for (const server of Object.values(mcp) as Record<string, unknown>[]) { server.required = true; server.startup_timeout_sec = 60; server.default_tools_approval_mode = 'approve'; }
  const instructions = options.mcpConfig + '.instructions.md';
  writeAtomic(instructions, options.systemPrompt);
  const overrides = [...(options.config ?? []), ...(options.model ? [`model=${toml(options.model)}`] : []), ...(options.effort ? [`model_reasoning_effort=${toml(options.effort === 'max' ? 'xhigh' : options.effort)}`] : []),
    `model_instructions_file=${toml(instructions)}`, `model_catalog_json=${toml(readOnlyCatalog(options))}`, `mcp_servers=${toml(mcp)}`,
    'sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"',
    'features.shell_tool=false', 'features.unified_exec=false', 'features.multi_agent=false', 'agents.enabled=false', 'features.apps=false', 'features.plugins=false', 'features.remote_plugin=false', 'features.skill_search=false', 'features.image_generation=false', 'features.browser_use=false', 'features.computer_use=false', 'features.sleep_tool=false'];
  return overrides.flatMap(value => ['-c', value]);
}
export function codexExecArgs(options: SessionStartOptions, sessionId?: string): string[] {
  return [...codexConfigArgs(options), '-s', 'read-only', '-a', 'never', 'exec', ...(options.profile ? ['-p', options.profile] : []), ...(sessionId ? ['resume', sessionId] : []), '--skip-git-repo-check', '--json', '-'];
}
/** Node fixtures are executable on Windows without a shell or a batch wrapper. */
export function codexCommand(cli = 'codex'): { program: string; prefix: string[] } {
  return /\.(?:mjs|cjs|js)$/i.test(cli) ? { program: process.execPath, prefix: [cli] } : { program: cli, prefix: [] };
}

/** Persistent JSON-RPC thread, or sequential exec processes resuming one durable thread. */
export class CodexEngine implements SessionEngine {
  mode: 'app-server' | 'exec-resume' = 'app-server';
  private options!: SessionStartOptions;
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  private queue: SessionEvent[] = [];
  private waiters: ((event: IteratorResult<SessionEvent>) => void)[] = [];
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private threadId?: string;
  private answer = '';
  private used = emptyUsage();
  private totals = new Map<string, SessionUsage>();
  private busy = false;
  private probing = false;
  private stderr = '';
  private push(event: SessionEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false }); else this.queue.push(event);
  }
  private launch(args: string[], receive: (raw: any) => void, exit: (code: number | null) => void): Promise<void> {
    const command = codexCommand(this.options.cli);
    const child = spawn(command.program, [...command.prefix, ...args], { cwd: this.options.cwd, env: workerEnvironment(process.env, {}, []), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child; this.stderr = '';
    let buffer = '';
    const line = (value: string) => { if (!value.trim()) return; try { receive(JSON.parse(value)); } catch (error) { this.push({ type: 'stderr', text: `Codex event: ${String(error)}` }); } };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let n: number;
      while ((n = buffer.indexOf('\n')) >= 0) { const value = buffer.slice(0, n); buffer = buffer.slice(n + 1); line(value); }
    });
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-2000); });
    child.stdin.on('error', error => { if (!this.probing && !this.stopped) this.push({ type: 'stderr', text: error.message }); });
    child.once('close', code => { line(buffer); if (this.child === child) this.child = undefined; exit(code); });
    child.on('error', error => { if (!this.probing && !this.stopped) this.push({ type: 'process_exit', text: error.message }); });
    return new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  private write(value: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('Codex producer process is not running.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, this.probing ? 5000 : (this.options.timeoutMs ?? 120000));
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  private tokenEvent(raw: Record<string, unknown>): void {
    const request = requestDelta(raw, this.totals);
    if (request && request.usage.total_tokens > 0) { addUsage(this.used, request.usage); this.push({ type: 'usage', usage: request.usage, requestId: request.id, engine: 'codex', model: this.options.model, raw }); }
  }
  private finish(error?: string): void {
    if (!this.busy) return;
    this.busy = false;
    this.push({ type: 'result', text: error ?? this.answer, engine: 'codex', model: this.options.model, raw: { type: 'result', is_error: !!error, result: error ?? this.answer } });
  }
  private appEvent(raw: any): void {
    if (raw.id !== undefined && !raw.method) {
      const p = this.pending.get(raw.id);
      if (p) { this.pending.delete(raw.id); clearTimeout(p.timer); raw.error ? p.reject(new Error(raw.error.message ?? JSON.stringify(raw.error))) : p.resolve(raw.result); }
      return;
    }
    // Never grant interactive approvals or other server-initiated capabilities.
    if (raw.id !== undefined && raw.method) { this.write({ id: raw.id, error: { code: -32601, message: 'Producer approvals and interactive requests are disabled.' } }); return; }
    const p = raw.params ?? {};
    if (raw.method === 'thread/tokenUsage/updated') this.tokenEvent(raw);
    if (raw.method === 'item/completed' && p.item?.type === 'agentMessage') {
      this.answer = p.item.text ?? '';
      this.push({ type: 'assistant', text: this.answer, raw });
    }
    if (['item/started', 'item/completed'].includes(raw.method) && p.item?.type === 'mcpToolCall') {
      const item = p.item, id = item.id;
      const content = raw.method === 'item/started' ? [{ type: 'tool_use', id, name: item.tool, input: item.arguments }] : [{ type: 'tool_result', tool_use_id: id, content: item.result ?? item.error, is_error: !!item.error }];
      this.push({ type: 'assistant', raw: { message: { content } } });
    }
    if (raw.method === 'turn/completed') this.finish(p.turn?.status === 'completed' ? undefined : p.turn?.error?.message ?? `Codex turn ${p.turn?.status ?? 'failed'}.`);
    if (raw.method === 'error' && !p.willRetry) this.finish(p.error?.message ?? 'Codex turn failed.');
  }
  async start(options: SessionStartOptions): Promise<void> {
    this.options = options; this.stopped = false; this.probing = true;
    let spawned = false;
    try {
      await this.launch([...codexConfigArgs(options), 'app-server'], raw => this.appEvent(raw), code => {
        this.rejectPending(new Error(`Codex app-server exited (${code}): ${this.stderr}`));
        if (!this.probing && !this.stopped) this.push({ type: 'process_exit', text: `Codex app-server exited (${code}): ${this.stderr}` });
      });
      spawned = true;
      await this.rpc('initialize', { clientInfo: { name: 'alba_producer', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
    } catch (error) {
      await this.stopChild();
      if (!spawned) throw error;
      this.mode = 'exec-resume'; this.probing = false;
      this.push({ type: 'stderr', text: `Codex app-server unavailable; using exec/resume: ${(error as Error).message}` });
      return;
    }
    // A provider/config/MCP error is actionable; it must not silently start another paid request.
    this.probing = false;
    if (options.profile) throw new Error('Codex app-server does not support profile; select the provider/account through producer.session.config (for example model_provider="provider_sample").');
    const response = await this.rpc('thread/start', { model: options.model, cwd: options.cwd, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: options.systemPrompt });
    this.threadId = response.thread?.id;
    if (!this.threadId) throw new Error('Codex thread/start returned no thread id.');
  }
  async sendBatch(messages: string[]): Promise<void> {
    if (this.stopped || this.busy) throw new Error('Codex producer is stopped or has an outstanding turn.');
    this.busy = true; this.answer = '';
    try {
      if (this.mode === 'app-server') { await this.rpc('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: messages.join('\n\n'), text_elements: [] }], ...(this.options.effort ? { effort: this.options.effort === 'max' ? 'xhigh' : this.options.effort } : {}) }); return; }
      let complete = false;
      await this.launch(codexExecArgs(this.options, this.threadId), raw => {
        if (raw.type === 'thread.started') this.threadId = raw.thread_id;
        if (raw.type === 'item.completed' && raw.item?.type === 'agent_message') { this.answer = raw.item.text ?? ''; this.push({ type: 'assistant', text: this.answer, raw }); }
        if (raw.type === 'turn.completed') { this.tokenEvent({ ...raw, thread_id: this.threadId }); complete = true; }
        if (raw.type === 'turn.failed') { complete = true; this.finish(raw.error?.message ?? 'Codex exec turn failed.'); }
        if (raw.type === 'error') this.push({ type: 'stderr', text: raw.message });
      }, code => {
        if (this.stopped) return;
        this.finish(code === 0 && complete && this.threadId ? undefined : `Codex exec failed (${code}): ${this.stderr || 'missing turn completion or thread id'}`);
      });
      this.child!.stdin.end(messages.join('\n\n'));
    } catch (error) { this.busy = false; throw error; }
  }
  async *readEvents(): AsyncIterable<SessionEvent> {
    while (!this.stopped || this.queue.length) {
      if (this.queue.length) { yield this.queue.shift()!; continue; }
      const event = await new Promise<IteratorResult<SessionEvent>>(resolve => this.waiters.push(resolve));
      if (event.done) return;
      yield event.value;
    }
  }
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdin.end(); child.kill();
    await closed;
  }
  async stop(): Promise<void> {
    this.stopped = true; this.rejectPending(new Error('Codex producer stopped.'));
    await this.stopChild();
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  usage(): SessionUsage { return { ...this.used }; }
}
