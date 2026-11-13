// An MCP server over stdio for an OpenAI-compatible images endpoint. Node only, no packages.
//   node server.mjs --base-url <url> --model <model> --key-env <VARIABLE NAME or "">
// The key is read from the named environment variable at call time and sent only to the endpoint; it is never printed or written.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const arg = (name, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; };
const BASE = arg('base-url', 'https://api.openai.com').replace(/\/+$/, '').replace(/\/v1$/, '');
const MODEL = arg('model', 'gpt-image-1');
const KEY_ENV = arg('key-env', 'OPENAI_API_KEY');
const TIMEOUT_MS = 10 * 60 * 1000;

const tools = [{
  name: 'image_generate',
  description: 'Generates pictures from a prompt (or edits them from reference pictures when refs are given) and saves them as files in out_dir. Answers the files with their real pixel size: the model may return another size than asked.',
  inputSchema: {
    type: 'object', required: ['prompt', 'out_dir'],
    properties: {
      prompt: { type: 'string', description: 'What to draw. Write it in full; it is sent as it is.' },
      out_dir: { type: 'string', description: 'Absolute folder for the files (made if missing).' },
      name: { type: 'string', description: 'File name without extension; with n > 1 a number is added. Default: image.' },
      size: { type: 'string', description: 'WxH, e.g. 1024x1024, 1536x1024, 1024x1536, or auto.' },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
      background: { type: 'string', enum: ['opaque', 'transparent', 'auto'], description: 'Give it explicitly: transparent for cut-out figures, opaque for scenes.' },
      n: { type: 'integer', minimum: 1, maximum: 8 },
      model: { type: 'string', description: `Default: ${MODEL}.` },
      refs: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of reference pictures (.png, .jpg, .jpeg, .webp); the call becomes an edit.' },
    },
  },
}, {
  name: 'image_price',
  description: 'Prices a call for Alba\'s quote: one per picture asked (n, default 1). Calls nothing.',
  inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 8 } } },
}];
const priceOf = input => Math.min(8, Math.max(1, Number.isInteger(input?.n) ? input.n : 1));
/** A failure before anything paid was asked: the answer says `spent: 0`, so Alba books nothing (without it Alba books the most the call may have cost). */
const unspent = message => Object.assign(new Error(message), { spent: 0 });
const PICTURE = /\.(png|jpe?g|webp)$/i;

/** Width and height of a PNG, JPEG or WebP, read from its header. */
function pictureSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: '.png' };
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), ext: '.webp' };
    if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff), ext: '.webp' }; }
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, ext: '.webp' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), ext: '.jpg' };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { width: 0, height: 0, ext: '.jpg' };
  }
  return { width: 0, height: 0, ext: '.bin' };
}

async function generate(a) {
  if (typeof a.prompt !== 'string' || !a.prompt.trim()) throw unspent('prompt is required');
  if (typeof a.out_dir !== 'string' || !path.isAbsolute(a.out_dir)) throw unspent('out_dir must be an absolute folder');
  const refs = Array.isArray(a.refs) ? a.refs : [];
  // Only picture files that are pictures by their first bytes are sent: a ref is a path from an order or a session, and any other file would leave the machine.
  for (const r of refs) { if (typeof r !== 'string' || !PICTURE.test(r) || !existsSync(r)) throw unspent(`reference picture not found or not a .png/.jpg/.webp file: ${r}`); if (pictureSize(readFileSync(r)).ext === '.bin') throw unspent(`not a picture: ${r}`); }
  const key = KEY_ENV ? process.env[KEY_ENV] : '';
  if (KEY_ENV && !key) throw unspent(`the environment variable ${KEY_ENV} is not set (setting key_env of image-gateway)`);
  const model = typeof a.model === 'string' && a.model.trim() ? a.model.trim() : MODEL;
  const fields = { model, prompt: a.prompt, ...(a.size ? { size: String(a.size) } : {}), ...(a.quality ? { quality: String(a.quality) } : {}), ...(a.background ? { background: String(a.background) } : {}), ...(a.n ? { n: Number(a.n) } : {}) };
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  let response;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  if (refs.length) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    for (const r of refs) form.append('image[]', new Blob([readFileSync(r)], { type: r.toLowerCase().endsWith('.png') ? 'image/png' : r.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg' }), path.basename(r));
    response = await fetch(`${BASE}/v1/images/edits`, { method: 'POST', headers, body: form, signal });
  } else {
    response = await fetch(`${BASE}/v1/images/generations`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(fields), signal });
  }
  const body = await response.text();
  // The endpoint refused it (4xx): nothing was made, nothing is charged. A server error may have charged: Alba books it as unknown.
  if (!response.ok) { const message = `${refs.length ? 'edits' : 'generations'} answered ${response.status}: ${body.slice(0, 400)}`; throw response.status < 500 ? unspent(message) : new Error(message); }
  let data;
  try { data = JSON.parse(body).data; } catch { throw new Error(`the endpoint answered no JSON: ${body.slice(0, 200)}`); }
  if (!Array.isArray(data) || !data.length) throw new Error('the endpoint answered no pictures');
  mkdirSync(a.out_dir, { recursive: true });
  const base = typeof a.name === 'string' && /^[\w.-]+$/.test(a.name) ? a.name.replace(/\.(png|jpe?g|webp)$/i, '') : 'image';
  const files = [];
  for (const [i, item] of data.entries()) {
    const raw = item.b64_json ? Buffer.from(item.b64_json, 'base64') : item.url ? Buffer.from(await (await fetch(item.url, { signal: AbortSignal.timeout(TIMEOUT_MS) })).arrayBuffer()) : undefined;
    if (!raw) continue;
    const size = pictureSize(raw);
    const file = path.join(a.out_dir, `${base}${data.length > 1 ? `-${i + 1}` : ''}${size.ext}`);
    writeFileSync(file, raw);
    files.push({ file: file.replace(/\\/g, '/'), width: size.width, height: size.height, bytes: raw.length });
  }
  if (!files.length) throw new Error('the endpoint answered no picture data (b64_json or url)');
  const text = [`${files.length} picture(s) from ${model}${refs.length ? ` with ${refs.length} reference(s)` : ''}${a.size ? `; asked ${a.size}` : ''}:`, ...files.map(f => `${f.file}  ${f.width}x${f.height}`)].join('\n');
  return { content: [{ type: 'text', text }], structuredContent: { model, files } };
}

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
  if (id === undefined) return;
  if (method === 'initialize') send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'image-gateway', version: '1.0.0' } } });
  else if (method === 'tools/list') send({ id, result: { tools } });
  else if (method === 'tools/call' && params?.name === 'image_generate') generate(params.arguments ?? {}).then(result => send({ id, result }), e => send({ id, result: { isError: true, content: [{ type: 'text', text: e.message }], ...(e.spent !== undefined ? { structuredContent: { spent: e.spent } } : {}) } }));
  else if (method === 'tools/call' && params?.name === 'image_price') { const amount = priceOf(params.arguments); send({ id, result: { content: [{ type: 'text', text: JSON.stringify({ amount }) }], structuredContent: { amount } } }); }
  else if (method === 'ping') send({ id, result: {} });
  else send({ id, error: { code: -32601, message: `unknown method ${method}${params?.name ? ` (${params.name})` : ''}` } });
});
