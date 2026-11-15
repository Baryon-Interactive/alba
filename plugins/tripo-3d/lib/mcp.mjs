// A small MCP toolkit over stdio (newline-delimited JSON-RPC 2.0) for this plugin's programs. Node only, no packages.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** `--name value` from the command line ('' when absent). */
export const arg = (name, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; };

/** Serves tools: `handlers[name](args)` returns `{ text, structured? }` or throws; a throw answers `isError` with the message. */
export function serve(info, tools, handlers) {
  const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    const { id, method, params } = request;
    if (id === undefined) return;
    if (method === 'initialize') send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: info } });
    else if (method === 'tools/list') send({ id, result: { tools } });
    else if (method === 'tools/call' && handlers[params?.name]) {
      Promise.resolve().then(() => handlers[params.name](params.arguments ?? {})).then(
        r => send({ id, result: { content: [{ type: 'text', text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}) } }),
        e => send({ id, result: { isError: true, content: [{ type: 'text', text: e.message }], ...(e.structured ? { structuredContent: e.structured } : {}) } }));
    } else if (method === 'ping') send({ id, result: {} });
    else send({ id, error: { code: -32601, message: `unknown method ${method}${params?.name ? ` (${params.name})` : ''}` } });
  });
}

/** Starts an MCP server (a program and arguments, no shell) and does the handshake. */
export async function connect(command, args, { env = process.env, timeoutMs = 180000 } = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
  let buffer = '', stderr = '', next = 1, gone;
  const pending = new Map();
  const fail = message => { if (gone) return; gone = message; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } pending.clear(); };
  const tail = () => { const last = stderr.trim().split('\n').at(-1); return last ? ` (${last})` : ''; };
  child.on('error', e => fail(e.message));
  child.on('exit', code => fail(`the Tripo server exited (code ${code})${tail()}`));
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.stdout.on('data', d => {
    buffer += d;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))); else p.resolve(msg.result);
    }
  });
  const request = (method, params, ms = timeoutMs) => gone ? Promise.reject(new Error(gone)) : new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no answer to ${method}${params?.name ? ` ${params.name}` : ''} within ${Math.round(ms / 1000)} s${tail()}`)); }, ms);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const close = () => { fail('closed'); try { child.stdin.end(); } catch { /* gone */ } try { child.kill(); } catch { /* gone */ } };
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'alba-tripo-3d', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  } catch (e) { close(); throw e; }
  /** Calls a tool; its answer as one value: the structured content, else the text parsed as JSON, else the text. */
  const call = async (name, args, ms) => {
    const r = await request('tools/call', { name, arguments: args }, ms);
    const text = (r?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    let value = r?.structuredContent;
    if (value === undefined) { try { value = JSON.parse(text); } catch { value = text; } }
    if (r?.isError) throw new Error(`${name}: ${text.slice(0, 600) || 'error'}`);
    return { value, text };
  };
  /** The server's tool list (name, description, inputSchema). */
  const list = async () => (await request('tools/list', {}))?.tools ?? [];
  return { call, list, close };
}

/** The first value under `key` anywhere in `value` (breadth first). */
export function find(value, key) {
  const queue = [value];
  while (queue.length) {
    const v = queue.shift();
    if (!v || typeof v !== 'object') continue;
    if (!Array.isArray(v) && Object.hasOwn(v, key) && v[key] !== null && v[key] !== undefined) return v[key];
    queue.push(...(Array.isArray(v) ? v : Object.values(v)));
  }
  return undefined;
}
