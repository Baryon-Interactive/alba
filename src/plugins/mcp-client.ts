import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolServer } from './manifest.ts';

/** One block of a `tools/call` answer. */
export interface McpContent { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string } }
export interface McpCallResult { content?: McpContent[]; structuredContent?: unknown; isError?: boolean }

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/**
 * A client of one MCP server over stdio (newline-delimited JSON-RPC 2.0): the server is a program with arguments (no shell), started
 * by `open` and stopped by `close`. It inherits this process's environment, as a worker's would.
 */
export class McpStdio {
  private child: ChildProcess;
  private buffer = '';
  private stderr = '';
  private next = 1;
  private pending = new Map<number, Pending>();
  private gone?: string;

  private constructor(server: ToolServer, cwd?: string) {
    this.child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(cwd ? { cwd } : {}) });
    this.child.on('error', e => this.fail(e.message));
    this.child.on('exit', code => this.fail(`the server exited (code ${code})${this.tail()}`));
    this.child.stderr!.on('data', d => { this.stderr = (this.stderr + d).slice(-2000); });
    this.child.stdout!.on('data', d => {
      this.buffer += d;
      let at: number;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).trim(); this.buffer = this.buffer.slice(at + 1);
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
        if (!p) continue;
        this.pending.delete(msg.id!); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))); else p.resolve(msg.result);
      }
    });
  }

  /** Starts the server and does the MCP handshake. */
  static async open(server: ToolServer, timeoutMs: number, cwd?: string): Promise<McpStdio> {
    const s = new McpStdio(server, cwd);
    try {
      await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'alba', version: '1' } }, timeoutMs, 'initialize');
      s.notify('notifications/initialized');
      return s;
    } catch (e) { s.close(); throw e; }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number, label = method): Promise<unknown> {
    if (this.gone) return Promise.reject(new Error(this.gone));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`no answer to ${label} within ${Math.round(timeoutMs / 1000)} s${this.tail()}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject: e => reject(new Error(`${label}: ${e.message}`)), timer });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async listTools(timeoutMs: number): Promise<string[]> {
    const r = await this.request('tools/list', {}, timeoutMs) as { tools?: { name: string }[] };
    return (r?.tools ?? []).map(x => x.name);
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult> {
    return await this.request('tools/call', { name, arguments: args }, timeoutMs, `tools/call ${name}`) as McpCallResult;
  }

  close(): void {
    this.gone ??= 'closed';
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    try { this.child.stdin?.end(); } catch { /* gone */ }
    try { this.child.kill(); } catch { /* gone */ }
  }

  private notify(method: string): void { this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
  private tail(): string { const last = this.stderr.trim().split('\n').at(-1); return last ? ` (${last})` : ''; }
  private fail(message: string): void {
    if (this.gone) return;
    this.gone = message;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
  }
}

/** The text of an answer, its text blocks joined. */
export const answerText = (r: McpCallResult): string => (r.content ?? []).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
