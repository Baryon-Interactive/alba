import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

function encoding(req: IncomingMessage): 'br' | 'gzip' | undefined {
  const accepted = new Map(String(req.headers['accept-encoding'] ?? '').toLowerCase().split(',').map(part => {
    const [name, ...params] = part.trim().split(';');
    const q = params.find(p => p.trim().startsWith('q='));
    return [name, q ? Number(q.trim().slice(2)) : 1];
  }));
  const br = accepted.get('br') ?? accepted.get('*') ?? 0, gzip = accepted.get('gzip') ?? accepted.get('*') ?? 0;
  return br > 0 && br >= gzip ? 'br' : gzip > 0 ? 'gzip' : undefined;
}

/** Buffered JSON/static responses only. SSE and ranged project files keep their streaming behavior. */
export function sendBody(req: IncomingMessage, res: ServerResponse, status: number, body: Buffer | string, headers: Record<string, string>, validator = false): void {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const out: Record<string, string> = { ...headers, vary: headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding' };
  if (validator && req.method === 'GET' && status === 200) {
    const tag = `W/"${createHash('sha256').update(bytes).digest('base64url')}"`;
    out.etag = tag;
    const supplied = String(req.headers['if-none-match'] ?? '').split(',').map(s => s.trim().replace(/^W\//, ''));
    if (supplied.includes('*') || supplied.includes(tag.replace(/^W\//, ''))) { res.writeHead(304, out); res.end(); return; }
  }
  const format = bytes.length > 1024 ? encoding(req) : undefined;
  const payload = format === 'br' ? brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : format === 'gzip' ? gzipSync(bytes) : bytes;
  if (format) out['content-encoding'] = format;
  out['content-length'] = String(payload.length);
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  sendBody(res.req, res, status, JSON.stringify(value), {
    'content-type': 'application/json; charset=utf-8', 'cache-control': res.req.method === 'GET' && status === 200 ? 'private, no-cache' : 'no-store',
    'x-content-type-options': 'nosniff', vary: 'x-alba-lang, Accept-Language',
  }, true);
}
