import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { validateProject } from './state-helper.ts';
import { producerWorkConfig } from '../src/config.ts';
import { ProducerSessionManager, producerSessionTurns, sessionEngine, ClaudeCodeEngine, producerAct, mcpConfig } from '../src/producer/session.ts';
import { producerCases, producerActions, type ProducerCase } from '../src/producer/producer.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { producerUsage, requestDelta, recordRequestUsage, addUsage, emptyUsage } from '../src/producer/session-usage.ts';
import { CodexEngine, codexExecArgs } from '../src/producer/engines/codex.ts';
import { markWorksShown, pollProducerWorks, producerWorks, startProducerWork, workResult } from '../src/producer/work-sessions.ts';
import { producerLog } from '../src/producer/activity.ts';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fake engine timed out.'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function fakeEngine(file: string, mode: 'app-server' | 'exec-resume'): void {
  writeFileSync(file, `import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2), app=args.includes('app-server');
if(args.includes('debug')) { console.log(JSON.stringify({models:[{slug:'model-sample',apply_patch_tool_type:'freeform',shell_type:'unified_exec'}]})); process.exit(0); }
const log=value=>appendFileSync('fake-calls.jsonl',JSON.stringify(value)+'\\n');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
log({args,pid:process.pid});
if(app && ${JSON.stringify(mode)}==='exec-resume') process.exit(2);
let turn=0;
if(app) createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); log(r);
 if(r.method==='initialize') emit({id:r.id,result:{}});
 if(r.method==='thread/start') emit({id:r.id,result:{thread:{id:'thread-demo'}}});
 if(r.method==='turn/start'){
   turn++; emit({id:r.id,result:{turn:{id:'turn-'+turn}}});
   emit({method:'item/completed',params:{item:{type:'agentMessage',text:'reply '+turn}}});
   const tokenUsage={total:{inputTokens:turn*1000,cachedInputTokens:turn*800,outputTokens:turn*100,reasoningOutputTokens:turn*40},last:{inputTokens:1000,cachedInputTokens:800,outputTokens:100,reasoningOutputTokens:40}};
   emit({method:'thread/tokenUsage/updated',params:{threadId:'thread-demo',turnId:'turn-'+turn,tokenUsage}});
   emit({method:'thread/tokenUsage/updated',params:{threadId:'thread-demo',turnId:'turn-'+turn,tokenUsage}});
   emit({method:'turn/completed',params:{turn:{id:'turn-'+turn,status:'completed'}}});
 }
});
else createInterface({input:process.stdin}).on('close',()=>{
 const turn=args.includes('resume')?2:1;
 emit({type:'thread.started',thread_id:'thread-demo'});
 emit({type:'item.completed',item:{type:'agent_message',text:'reply'}});
 emit({type:'turn.completed',usage:{input_tokens:turn*1000,cached_input_tokens:turn*800,output_tokens:turn*100,reasoning_output_tokens:turn*40}});
});
`);
}

for (const mode of ['app-server', 'exec-resume'] as const) test(`Codex router preserves a thread for two turns in ${mode}, attaches MCP and splits cached usage`, async () => {
  const f = await fixture({ populate: false, project: dir => ({ producer: { enabled: true, session: { enabled: true, engine: 'codex', model: 'model-sample', cli: path.join(dir, 'fake.mjs'), ...(mode === 'exec-resume' ? { profile: 'sample' } : {}), config: ['model_provider="provider_sample"'], max_turns: 100, rollover_tokens: 1500 } } }) });
  const p = f.board.ctx.projects[0]; fakeEngine(p.producer.session.cli!, mode);
  const manager = new ProducerSessionManager(p, f.orders);
  try {
    assert.equal((await manager.start()).state, 'running'); assert.equal(manager.status().mode, mode);
    for (let i = 0; i < 2; i++) { await manager.sendBatch([`message ${i}`]); await until(() => producerSessionTurns(p).filter(t => t.requests?.length).length === i + 1 && !manager.status().active); }
    const turns = producerSessionTurns(p);
    assert.deepEqual(turns.map(t => t.usage.total_tokens), [1100, 1100]);
    assert.ok(turns.every(t => t.requests?.[0].engine === 'codex' && t.requests?.[0].model === 'model-sample'));
    assert.equal(manager.status().modelUsage?.requests, 2); assert.equal(manager.status().modelUsage?.cacheHitRate, .8);
    const rows = producerUsage(p); assert.equal(rows[0].requests, 2); assert.equal(rows[0].uncachedInput, 400); assert.equal(rows[0].cacheRead, 1600); assert.equal(rows[0].output, 200);
    const calls = readFileSync(path.join(p.root, 'fake-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const processes = calls.filter(r => r.args);
    for (const call of processes) {
      assert.ok(call.args.includes('model_provider="provider_sample"'));
      const config = call.args.find((v: string) => v.startsWith('mcp_servers='));
      assert.match(config, /alba-producer/); assert.match(config, /ALBA_PRODUCER_READ_ONLY.*0/);
      assert.ok(call.args.includes('approval_policy="never"')); assert.ok(call.args.includes('sandbox_mode="read-only"'));
    }
    if (mode === 'app-server') { assert.equal(processes.length, 1); assert.equal(calls.filter(r => r.method === 'thread/start').length, 1); assert.deepEqual(calls.filter(r => r.method === 'turn/start').map(r => r.params.threadId), ['thread-demo', 'thread-demo']); }
    else { assert.equal(processes.length, 3); assert.ok(processes[2].args.includes('resume')); assert.ok(processes[2].args.includes('thread-demo')); assert.ok(processes.slice(1).every(r => r.args.includes('--skip-git-repo-check') && r.args.at(-1) === '-' && r.args.indexOf('-p') > r.args.indexOf('exec'))); }
  } finally { await manager.stop(); }
});

test('engine configuration defaults to Claude, validates keys, and isolates work overrides on engine changes', async t => {
  const f = await fixture({ populate: false, project: () => ({ producer: { session: { enabled: true } } }) });
  const p = f.board.ctx.projects[0]; assert.equal(p.producer.session.engine, 'claude'); assert.ok(sessionEngine(p) instanceof ClaudeCodeEngine);
  const config = (session: unknown, work?: unknown) => validateProject({ id: 'demo', name: 'Demo', root: p.root, work_orders: p.work_orders, state_dir: p.state_dir, producer: { session, ...(work ? { work } : {}) } }, p.file);
  for (const session of [{ engine: 'other' }, { config: ['wrong'] }, { config: [1] }, { effort: 'extreme' }, { profile: '' }]) assert.throws(() => config(session), /producer.session/);
  assert.throws(() => config({}, { invalid: true }), /producer.work/);
  assert.deepEqual(producerWorkConfig(config({ engine: 'claude', cli: 'fake-claude', model: 'sample-claude' }, { engine: 'codex', model: 'sample-codex', config: ['model_provider="provider_sample"'] })), { engine: 'codex', model: 'sample-codex', config: ['model_provider="provider_sample"'] });
  const warnings = t.mock.method(console, 'warn', () => {});
  config({ engine: 'codex', cli: 'shim.cmd' }, { cli: 'other.bat' });
  assert.ok(warnings.mock.calls.some(call => /producer.session.cli.*batch shim.*\.exe/.test(call.arguments[0])));
  assert.ok(warnings.mock.calls.some(call => /producer.work.cli.*batch shim.*\.exe/.test(call.arguments[0])));
});

test('work final blocks tolerate fences, trailing text and earlier drafts while reporting exact invalid fields', () => {
  const block = (value: unknown) => `--- alba-producer-work ---\n${JSON.stringify(value)}\n--- end ---`;
  const result = { summary: 'Review done', action: { kind: 'note', note: 'See evidence' } };
  assert.deepEqual(workResult('```text\n' + block({ summary: 'earlier', finding: 'earlier' }) + '\n' + block(result) + '\n```\nTrailing text', 'review').result, result);
  assert.match(workResult(block({ ...result, action: { ...result.action, invented: 1 } }), 'review').error ?? '', /actions\[0\].invented is an unknown field/);
  assert.match(workResult(block({ summary: 'Draft' }), 'draft').error ?? '', /requires action/);
  assert.match(workResult('--- alba-producer-work ---\n{bad}\n--- end ---', 'work').error ?? '', /JSON/);
  assert.deepEqual(workResult(`--- alba-producer-work ---\n\x60\x60\x60json\n${JSON.stringify(result)}\n\x60\x60\x60\n--- end ---`, 'review').result, result);
  const malformed = '--- alba-producer-work ---\n{malformedLast}\n--- end ---';
  assert.deepEqual(workResult(block(result) + '\n' + malformed, 'review'), workResult(malformed, 'review'));
  assert.match(workResult(block(result) + '\n' + malformed, 'review').error!, /JSON/);
  assert.equal(workResult(JSON.stringify(result), 'work').result, undefined);
});

test('Codex work applies its result through the gate, exposes validation errors and allows one durable retry per hour', async () => {
  const f = await fixture({ populate: false, project: dir => ({ producer: { enabled: true, session: { engine: 'claude' }, work: { engine: 'codex', model: 'sample-worker', cli: path.join(dir, 'worker.mjs') }, rules: [{ id: 'note', action: 'note', instruction: 'Record findings', mode: 'auto' }] } }) });
  const p = f.board.ctx.projects[0], at = new Date().toISOString();
  fakeEngine(p.producer.work!.cli!, 'exec-resume');
  const card: ProducerCase = { id: 'case-demo', key: 'blocked/SAMPLE', project: p.id, trigger: 'blocked', status: 'open', revision: 1, openedAt: at, updatedAt: at, facts: {}, card: { trigger: 'blocked', summary: 'Inspect facts', pointers: [], untrusted: [] } };
  writeStateFile(p, '_producer-cases.json', JSON.stringify([card]));
  let now = new Date();
  const probes = { ...f.board.ctx.probes, now: () => now, processStartedAt: () => '2026-01-01T00:00:00Z', readText: (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } } };
  const run = startProducerWork(p, f.orders, card.key, 'work', '', probes);
  assert.equal(run.engine, 'codex'); assert.equal(f.spawned[0].program, process.execPath); assert.ok(f.spawned[0].args.includes('read-only')); assert.match(f.spawned[0].args.find(a => a.startsWith('mcp_servers='))!, /ALBA_PRODUCER_READ_ONLY.*1/);
  assert.equal(f.spawned[0].args.at(-1), '-'); assert.match(readFileSync(run.prompt, 'utf8'), /"case":"blocked\/SAMPLE"/);
  const result = { summary: 'Findings ready', action: { kind: 'note', note: 'Stored evidence checked' } };
  const output = (value: unknown) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `--- alba-producer-work ---\n${JSON.stringify(value)}\n--- end ---\nTrailing text` } }) + '\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100 } }) + '\n';
  writeFileSync(run.log, output({ ...result, action: { ...result.action, invented: 3 } })); pollProducerWorks(p, probes);
  const failure = producerWorks(p)[0]; assert.equal(failure.status, 'failed'); assert.match(failure.reason!, /invented/); assert.match(producerLog(p, f.orders).rows[0].children![0].note, /invented/);
  const retry = startProducerWork(p, f.orders, card.key, 'work', '', probes); assert.notEqual(retry.id, run.id); assert.equal(retry.retryOf, run.id);
  writeFileSync(retry.log, output({ summary: '' })); pollProducerWorks(p, probes);
  assert.equal(startProducerWork(p, f.orders, card.key, 'work', '', probes).id, retry.id);
  now = new Date(now.getTime() + 3600001);
  const next = startProducerWork(p, f.orders, card.key, 'work', '', probes); writeFileSync(next.log, output(result)); pollProducerWorks(p, probes);
  assert.equal(producerWorks(p).at(-1)?.status, 'done'); assert.equal(producerCases(p).length, 1);
  markWorksShown(p, [next.id]);
  const action = producerAct(p, f.orders, card.key, 'note', { work: next.id }); assert.equal(action.note, result.action.note); assert.equal(action.status, 'done'); assert.equal(action.result, result.action.note); assert.equal(producerActions(p).length, 1);
});

test('Codex cumulative token_count deltas include reasoning once and CLI usage groups engine/model cache rates', async () => {
  const totals = new Map();
  const raw = { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 750, output_tokens: 100, reasoning_output_tokens: 40 } } } };
  assert.equal(requestDelta(raw, totals)?.usage.total_tokens, 1100); assert.equal(requestDelta(raw, totals)?.usage.total_tokens, 0);
  const f = await fixture({ populate: false }), p = f.board.ctx.projects[0];
  p.producer.model_prices = { 'sample-codex': { input: 1, cache_read: .1, cache_write: 0, output: 4 } };
  recordRequestUsage(p, { input_tokens: 1000, cache_read_input_tokens: 750, output_tokens: 100 }, 'sample-codex', new Date(), 'codex');
  recordRequestUsage(p, { input_tokens: 2000, cache_read_input_tokens: 1000, output_tokens: 50 }, 'sample-claude', new Date(), 'claude');
  writeFileSync(p.file, `id: demo\nname: Demo\nroot: ${JSON.stringify(p.root)}\nwork_orders: ${JSON.stringify(p.work_orders)}\nstate_dir: ${JSON.stringify(p.state_dir)}\nstate: {backend: files}\nroles: {default: {}}\n`);
  const cli = (...args: string[]) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.resolve('src/cli/main.ts'), 'producer', 'usage', '--project', p.file, ...args], { encoding: 'utf8' });
  const table = cli('--days', '2'); assert.match(table, /Cache hit rate/); assert.match(table, /75.0%/); assert.match(table, /50.0%/); assert.match(table, /sample-codex/); assert.match(table, /sample-claude/);
  assert.equal(JSON.parse(cli('--json')).length, 2); assert.throws(() => producerUsage(p, 0), /whole number/);
});

test('exec cumulative totals share one thread key, reset on decrease, and never become context size', () => {
  const totals = new Map(), total = emptyUsage();
  const event = (input: number, cached: number, output: number, id: string) => ({ type: 'turn.completed', thread_id: 'demo', request_id: id, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } });
  for (const raw of [event(1000, 600, 100, 'turn-1'), event(2100, 1500, 220, 'turn-2'), event(400, 200, 30, 'turn-3')]) {
    const u = requestDelta(raw, totals)!.usage; addUsage(total, u); assert.equal(u.context_tokens, undefined);
  }
  assert.equal(totals.size, 1); assert.equal(total.input_tokens, 2500); assert.equal(total.output_tokens, 250); assert.equal(total.uncached_input_tokens, 800); assert.equal(total.context_tokens, undefined);
  const last = requestDelta({ ...event(900, 500, 50, 'turn-4'), last_token_usage: { input_tokens: 500 } }, totals)!.usage;
  assert.equal(last.context_tokens, 500);
});

for (const mode of ['app-server', 'exec-resume'] as const) test(`Codex ${mode} accepts 100k context and does not kill a turn at timeout_ms`, async () => {
  const f = await fixture({ populate: false }), p = f.board.ctx.projects[0], cli = path.join(p.root, 'slow.mjs');
  fakeEngine(cli, mode);
  // Delay the event response while keeping the startup handshake fast.
  let source = readFileSync(cli, 'utf8').replace("const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');", "const emit=value=>{const send=()=>process.stdout.write(JSON.stringify(value)+'\\n'); if(value.method || value.type) setTimeout(send,1500); else send();};");
  source = source.replace("log({args,pid:process.pid});", "log({args,pid:process.pid}); let input=''; if(!app) process.stdin.on('data',chunk=>input+=chunk);");
  source = source.replace("const turn=args.includes('resume')?2:1;", "log({inputLength:input.length}); const turn=args.includes('resume')?2:1;");
  writeFileSync(cli, source);
  const engine = new CodexEngine(), events: any[] = [];
  try {
    await engine.start({ cli, cwd: p.root, mcpConfig: mcpConfig(p), systemPrompt: 'fixed'.repeat(20000), timeoutMs: 1000 });
    const reading = (async () => { for await (const e of engine.readEvents()) events.push(e); })();
    await engine.sendBatch(['x'.repeat(100000)]); await until(() => events.some(e => e.type === 'result'));
    assert.ok(!events.some(e => e.type === 'process_exit')); assert.equal(engine.mode, mode);
    const calls = readFileSync(path.join(p.root, 'fake-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.filter(r => r.args).every(r => JSON.stringify(r.args).length < 10000));
    if (mode === 'app-server') assert.equal(calls.find(r => r.method === 'turn/start').params.input[0].text.length, 100000);
    else assert.equal(calls.find(r => r.inputLength).inputLength, 100000);
    await engine.stop(); await reading;
  } finally { await engine.stop(); }
});

test('Codex rejects app-server profiles and propagates launch failures without falling back', async () => {
  const f = await fixture({ populate: false }), p = f.board.ctx.projects[0], cli = path.join(p.root, 'app.mjs'); fakeEngine(cli, 'app-server');
  const options = { cli, cwd: p.root, mcpConfig: mcpConfig(p), systemPrompt: 'Read only', profile: 'demo' };
  const engine = new CodexEngine();
  try { await assert.rejects(engine.start(options), /app-server does not support profile.*config/); } finally { await engine.stop(); }
  const missing = new CodexEngine();
  try { await assert.rejects(missing.start({ ...options, cli: path.join(p.root, 'missing.exe') }), { code: 'ENOENT' }); assert.equal(missing.mode, 'app-server'); } finally { await missing.stop(); }
  if (process.platform === 'win32') {
    const batch = path.join(p.root, 'shim.cmd'); writeFileSync(batch, '@echo off\r\nexit /b 1\r\n');
    const shim = new CodexEngine();
    try { await assert.rejects(shim.start({ ...options, cli: batch }), { code: 'EINVAL' }); assert.equal(shim.mode, 'app-server'); } finally { await shim.stop(); }
  }
});

test('MCP explicitly inherits producer environment and uses a 60 second Codex startup timeout', async () => {
  const f = await fixture({ populate: false }), p = f.board.ctx.projects[0], cli = path.join(p.root, 'app.mjs'); fakeEngine(cli, 'app-server');
  const saved = process.env.ALBA_WORKERS, savedToken = process.env.ALBA_SERVICE_TOKEN;
  process.env.ALBA_WORKERS = path.join(p.root, 'demo-workers.yaml'); process.env.ALBA_SERVICE_TOKEN = 'private-control-value';
  try {
    const file = mcpConfig(p, true), server = JSON.parse(readFileSync(file, 'utf8')).mcpServers['alba-producer'];
    assert.equal(server.env.ALBA_WORKERS, process.env.ALBA_WORKERS); assert.equal(server.env.ALBA_PRODUCER_READ_ONLY, '1'); assert.equal(server.env.ALBA_LANG, 'en');
    assert.equal(server.env.ALBA_SERVICE_TOKEN, undefined, 'MCP configuration does not serialize inherited control credentials');
    const args = codexExecArgs({ cli, cwd: p.root, mcpConfig: file, systemPrompt: 'fixed', profile: 'demo' }, 'thread-demo');
    assert.match(args.find(a => a.startsWith('mcp_servers='))!, /startup_timeout_sec.*60/);
    assert.match(args.find(a => a.startsWith('mcp_servers='))!, /"default_tools_approval_mode"="approve"/, 'approval policy never would refuse every producer tool call');
    const models = JSON.parse(readFileSync(JSON.parse(args.find(a => a.startsWith('model_catalog_json='))!.split('=').slice(1).join('=')), 'utf8')).models;
    assert.ok(models.every((m: any) => m.apply_patch_tool_type === null && m.shell_type === 'disabled'));
  } finally {
    if (saved === undefined) delete process.env.ALBA_WORKERS; else process.env.ALBA_WORKERS = saved;
    if (savedToken === undefined) delete process.env.ALBA_SERVICE_TOKEN; else process.env.ALBA_SERVICE_TOKEN = savedToken;
  }
});
