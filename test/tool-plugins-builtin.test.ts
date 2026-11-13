import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { readManifest, withSettings } from '../src/plugins/manifest.ts';
import { createToolJob, runToolJob, toolJobs } from '../src/plugins/jobs.ts';
import { withToolServers } from '../src/plugins/tools.ts';
import { doctorTool } from '../src/plugins/doctor.ts';

/** The header of a PNG of the given size (enough for the size check). */
const png = (w: number, h: number) => { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
function project(dir: string, plugins: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  return validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), plugins, ...extra }, path.join(dir, 'alba.yaml'));
}

test('settings: put into commands, arguments and env_from; an empty one drops the variable; unknown or undeclared ones are refused', () => {
  const m = readManifest(path.resolve('plugins/image-gateway/alba-plugin.yaml'));
  assert.deepEqual(m.agent.mcp.image!.env_from, ['${setting.key_env}']);
  const defaults = withSettings(m, {});
  assert.deepEqual(defaults.agent.mcp.image!.env_from, ['OPENAI_API_KEY']);
  assert.deepEqual(defaults.agent.mcp.image!.args.slice(1), ['--base-url', 'https://api.openai.com', '--model', 'gpt-image-1', '--key-env', 'OPENAI_API_KEY']);
  const gateway = withSettings(m, { base_url: 'http://127.0.0.1:3425', key_env: '' });
  assert.deepEqual(gateway.agent.mcp.image!.env_from, [], 'no key for a gateway that needs none');
  assert.equal(m.agent.mcp.image!.args[2], '${setting.base_url}', 'the manifest itself is unchanged');
  const { dir } = tempOrders();
  const bad = (plugins: unknown, pattern: RegExp) => assert.throws(() => project(dir, plugins as Record<string, unknown>), pattern);
  bad({ enable: ['image-gateway'], settings: { 'image-gateway': { modle: 'x' } } }, /plugins\.settings\.image-gateway\.modle": the tool has no such setting \(it has: base_url, model, key_env\)/);
  bad({ enable: ['image-gateway'], settings: { 'tripo-3d': { ceiling: 5 } } }, /"tripo-3d" is not in plugins\.enable/);
  bad({ enable: ['image-gateway'], settings: { 'image-gateway': { key_env: 'not a name' } } }, /env_from "not a name" \(from a setting\) is not an environment variable name/);
  const cfg = project(dir, { enable: ['image-gateway', 'tripo-3d'], settings: { 'image-gateway': { key_env: '' }, 'tripo-3d': { ceiling: 40 } } });
  assert.deepEqual(cfg.plugins!.tools['tripo-3d']!.settings, { ceiling: '40' });
  assert.ok(cfg.plugins!.tools['tripo-3d']!.manifest.agent.mcp['tripo-ops']!.args.includes('40'));
  // An undeclared ${setting.x} is refused when the manifest is read.
  const pdir = path.join(dir, 'p', 'odd'); mkdirSync(pdir, { recursive: true });
  writeFileSync(path.join(pdir, 'alba-plugin.yaml'), 'id: odd\nversion: 1\napiVersion: 1\nkinds: [tool]\ndescription: Odd.\nagent:\n  mcp:\n    odd: { command: node, args: ["${setting.nope}"] }\n');
  assert.throws(() => readManifest(path.join(pdir, 'alba-plugin.yaml')), /agent\.mcp\.odd\.args\[0\]: \$\{setting\.nope\} is not declared under settings/);
});

test('a server marked workers: false is for operations only: workers never get it', () => {
  const { dir } = tempOrders();
  const cfg = project(dir, { enable: ['tripo-3d'] });
  const role = withToolServers({ id: 'default', definition: { sources: {} } } as never, [cfg.plugins!.tools['tripo-3d']!]);
  assert.deepEqual(Object.keys(role.definition!.mcp!), ['tripo']);
});

test('image-gateway: a generate job posts to the images endpoint, saves the picture with its real size; refs make an edit', async () => {
  const seen: { url: string; type: string; auth: string; body: string }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ url: req.url!, type: String(req.headers['content-type']), auth: String(req.headers.authorization ?? ''), body: body.slice(0, 2000) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: png(1254, 1254).toString('base64') }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { dir, orders } = tempOrders();
    process.env.ALBA_TEST_IMAGE_KEY = 'test-key-value';
    const cfg = project(dir, { enable: ['image-gateway'], auto_approve: { images: 2 }, settings: { 'image-gateway': { base_url: base, model: 'test/image-model', key_env: 'ALBA_TEST_IMAGE_KEY' } } });
    orders.add({ tag: 'ART1', title: 'Art', kind: 'art' });
    const job = await runToolJob(cfg, orders, createToolJob(cfg, orders, { tool: 'image-gateway', operation: 'generate', order: 'ART1', input: { prompt: 'a red infantry piece', size: '2048x2048', background: 'transparent', name: 'hero' } }).id);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(job.files, [`${job.out}/hero.png`]);
    assert.match(job.text!, /1 picture\(s\) from test\/image-model; asked 2048x2048:\n.*hero\.png {2}1254x1254/);
    assert.equal(seen[0]!.url, '/v1/images/generations');
    assert.deepEqual(JSON.parse(seen[0]!.body), { model: 'test/image-model', prompt: 'a red infantry piece', size: '2048x2048', background: 'transparent' });
    assert.equal(seen[0]!.auth, 'Bearer test-key-value');
    // Priced one image per picture asked, approved by Alba within auto_approve, and booked on the order's quote.
    assert.deepEqual([job.quote?.unit, job.quote?.amount, job.quote?.auto], ['images', 1, true]);
    assert.equal(orders.get('ART1').quotes!.find(q => q.id === job.quote!.id)!.ledger.reduce((n, x) => n + x.amount, 0), 1);
    // Three pictures are over the auto-approval: the job waits for a person and calls nothing.
    const three = await runToolJob(cfg, orders, createToolJob(cfg, orders, { tool: 'image-gateway', operation: 'generate', order: 'ART1', input: { prompt: 'x', n: 3 } }).id);
    assert.equal(three.status, 'waiting-quote');
    assert.equal(seen.length, 1);
    const ref = path.join(dir, 'sheet.png'); writeFileSync(ref, png(16, 16));
    const edit = await runToolJob(cfg, orders, createToolJob(cfg, orders, { tool: 'image-gateway', operation: 'generate', order: 'ART1', input: { prompt: 'its back', refs: [ref], background: 'transparent' } }).id);
    assert.equal(edit.status, 'done', edit.error);
    assert.equal(seen[1]!.url, '/v1/images/edits');
    assert.match(seen[1]!.type, /^multipart\/form-data; boundary=/);
    assert.match(seen[1]!.body, /name="image\[\]"; filename="sheet\.png"/);
    // The key went to the endpoint only: not into the job, its events or its files.
    const state = JSON.stringify(toolJobs(cfg));
    assert.ok(!state.includes('test-key-value') && !JSON.stringify(orders.store.events({})).includes('test-key-value'));
    // A key variable that is not set fails the job before any call.
    delete process.env.ALBA_TEST_IMAGE_KEY;
    const missing = await runToolJob(cfg, orders, createToolJob(cfg, orders, { tool: 'image-gateway', operation: 'generate', order: 'ART1', input: { prompt: 'x' } }).id);
    assert.equal(missing.status, 'failed'); assert.match(missing.error!, /not set in Alba's environment: ALBA_TEST_IMAGE_KEY/);
    assert.equal(seen.length, 2);
  } finally { server.close(); delete process.env.ALBA_TEST_IMAGE_KEY; }
});

/** Runs a job to its quote, approves the quote as a person would with the cap it asks, and runs it on. */
async function approvedRun(cfg: ReturnType<typeof project>, orders: ReturnType<typeof tempOrders>['orders'], id: string, cap?: number) {
  const waiting = await runToolJob(cfg, orders, id);
  assert.equal(waiting.status, 'waiting-quote', waiting.error);
  orders.decideQuote(waiting.order!, waiting.quote!.id!, { approve: true, cap: cap ?? waiting.quote!.amount! });
  return runToolJob(cfg, orders, id);
}

/** A stand-in for the Tripo Studio MCP server with the answers' shapes of tripo-studio-plugin 0.3.13. */
function fakeTripo(dir: string, opts: { authenticated: boolean; spend: number; taskStatus?: string }): string {
  const file = path.join(dir, 'fake-tripo', 'mcp', 'bootstrap.mjs');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const log = ${JSON.stringify(path.join(dir, 'fake-tripo', 'calls.jsonl'))};
let balance = 1195;
const reply = (id, structuredContent) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-tripo', version: '0' } } }) + '\\n');
  if (method === 'tools/list') return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }) + '\\n');
  const a = params.arguments ?? {};
  appendFileSync(log, JSON.stringify({ name: params.name, args: a, roots: process.env.TRIPO_OUTPUT_ROOTS }) + '\\n');
  switch (params.name) {
    case 'tripo_auth_status': return reply(id, { session: { authenticated: ${opts.authenticated} } });
    case 'tripo_get_payment': return reply(id, { plan: 'Premium', wallet: { balance } });
    case 'tripo_quote_operation': return reply(id, { quote: { kind: a.kind, status: 'unknown', estimated_credits: null, warnings: ['Reviewed pricing contract expired'] } });
    case 'tripo_generate_model': return reply(id, { review_id: '11111111-1111-4111-8111-111111111111', draft_id: 'd1', status: 'pending', next_action: 'wait' });
    case 'tripo_get_configuration_review': balance -= ${opts.spend}; return reply(id, { review: { review_id: a.review_id, status: 'submitted' }, task_id: '22222222-2222-4222-8222-222222222222' });
    case 'tripo_task_wait': return reply(id, { task: { task_id: a.task_id, status: '${opts.taskStatus ?? 'succeeded'}', result: { project_id: 'proj-1' } } });
    case 'tripo_download': writeFileSync(a.path, 'glTF'); return reply(id, { download: { path: a.path.replace(/\\\\/g, '/') } });
    default: return reply(id, { error: 'unexpected ' + params.name });
  }
});
`);
  return file;
}

test('tripo-3d: a model job prices through Tripo (the ceiling when Tripo cannot), follows the form and the task, downloads, and books what the wallet shows', async () => {
  const { dir, orders } = tempOrders();
  const server = fakeTripo(dir, { authenticated: true, spend: 30 }).replace(/\\/g, '/');
  const cfg = project(dir, { enable: ['tripo-3d'], settings: { 'tripo-3d': { server, ceiling: 60 } }, auto_approve: { credits: 60 } });
  assert.equal((await doctorTool(cfg.plugins!.tools['tripo-3d']!)).checks.find(c => c.name === 'probe')!.ok, true);
  orders.add({ tag: 'MOD1', title: 'A model', kind: 'art' });
  const pic = path.join(dir, 'front.png'); writeFileSync(pic, png(8, 8));
  const id = createToolJob(cfg, orders, { tool: 'tripo-3d', operation: 'generate-model', input: { mode: 'image', image_path: pic, face_limit: 10000, name: 'pawn' }, order: 'MOD1' }).id;
  // The ceiling is not a price: within auto_approve or not, a person approves it.
  const waiting = await runToolJob(cfg, orders, id);
  assert.equal(waiting.status, 'waiting-quote');
  assert.deepEqual(waiting.quote, { unit: 'credits', amount: 60, id: 'C1', unpriced: true, manual: 'Alba never approves a quote the tool could not price', note: "Tripo could not price it (quote unknown: Reviewed pricing contract expired); this is the project's ceiling (setting ceiling)" });
  assert.match(waiting.waiting!, /quote C1 of MOD1 \(unpriced, asks 60 credits\) waits for approval: alba credits approve MOD1 C1 --cap 60 \(Alba never approves a quote the tool could not price\)/);
  orders.decideQuote('MOD1', 'C1', { approve: true, cap: 60 });
  const job = await runToolJob(cfg, orders, id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.spent, 30, 'the wallet fell by 30: that is booked, not the ceiling');
  assert.deepEqual(orders.get('MOD1').quotes![0]!.ledger.map(e => [e.amount, e.what]), [[30, 'tool job J1 (tripo-3d/generate-model) as the tool reported']]);
  assert.deepEqual(job.files, [`${job.out}/pawn.glb`]);
  assert.equal(readFileSync(path.join(job.out, 'pawn.glb'), 'utf8'), 'glTF');
  const calls = readFileSync(path.join(dir, 'fake-tripo', 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(calls.map(c => c.name), ['tripo_quote_operation', 'tripo_auth_status', 'tripo_get_payment', 'tripo_generate_model', 'tripo_get_configuration_review', 'tripo_task_wait', 'tripo_download', 'tripo_get_payment']);
  assert.deepEqual(calls[0].args, { kind: 'model.generate', input: { mode: 'image', tier: 'smart_mesh', face_limit: 10000 } }, 'the quote gets only what prices it');
  assert.deepEqual(calls[3].args, { mode: 'image', tier: 'smart_mesh', face_limit: 10000, image_path: pic }, 'generation gets no out_dir, name or format');
  assert.ok(String(calls[6].roots).split(path.delimiter).includes(job.out.replace(/\//g, path.sep)) || String(calls[6].roots).split(path.delimiter).includes(job.out), 'the job folder is an allowed output root');
});

test('tripo-3d: not logged in fails the job before anything is submitted, and nothing is booked', async () => {
  const { dir, orders } = tempOrders();
  const server = fakeTripo(dir, { authenticated: false, spend: 30 }).replace(/\\/g, '/');
  const cfg = project(dir, { enable: ['tripo-3d'], settings: { 'tripo-3d': { server } }, auto_approve: { credits: 100 } });
  orders.add({ tag: 'MOD1', title: 'A model', kind: 'art' });
  const job = await approvedRun(cfg, orders, createToolJob(cfg, orders, { tool: 'tripo-3d', operation: 'generate-model', input: { mode: 'text', prompt: 'a war drum', face_limit: 8000 }, order: 'MOD1' }).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error!, /Tripo Studio is not logged in on this machine.*Alba does not log in/);
  assert.equal(job.spent, 0, 'the plugin says nothing was spent before the submission');
  assert.equal(job.spentUnknown, undefined);
  assert.deepEqual(orders.get('MOD1').quotes![0]!.ledger, []);
  const names = readFileSync(path.join(dir, 'fake-tripo', 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).name);
  assert.ok(!names.includes('tripo_generate_model'));
  assert.equal(existsSync(path.join(job.out, 'model.glb')), false);
});

test('tripo-3d: a task that fails after the submission books what the wallet shows was spent, not the quote', async () => {
  const { dir, orders } = tempOrders();
  const server = fakeTripo(dir, { authenticated: true, spend: 12, taskStatus: 'failed' }).replace(/\\/g, '/');
  const cfg = project(dir, { enable: ['tripo-3d'], settings: { 'tripo-3d': { server } }, auto_approve: { credits: 100 } });
  orders.add({ tag: 'MOD1', title: 'A model', kind: 'art' });
  const job = await approvedRun(cfg, orders, createToolJob(cfg, orders, { tool: 'tripo-3d', operation: 'generate-model', input: { mode: 'text', prompt: 'a war drum', face_limit: 8000 }, order: 'MOD1' }).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error!, /the Tripo task 22222222-2222-4222-8222-222222222222 ended failed/);
  assert.equal(job.spent, 12);
  assert.deepEqual(orders.get('MOD1').quotes![0]!.ledger.map(e => e.amount), [12]);
});
