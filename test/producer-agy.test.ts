import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { validateProject } from './state-helper.ts';
import { ProducerSessionManager, producerSessionTurns, sessionEngine } from '../src/producer/session.ts';
import { producerUsage, requestDelta, addUsage, emptyUsage } from '../src/producer/session-usage.ts';
import { AgyEngine } from '../src/producer/engines/agy.ts';
import { pollProducerWorks, producerWorks, startProducerWork } from '../src/producer/work-sessions.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import type { ProducerCase } from '../src/producer/producer.ts';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fake agy timed out.'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
/**
 * A fake agy: records its arguments, folder, custom agent and settings, answers each stdin turn with the agy 1.5
 * stream-json shape (one producer_read call, a streamed answer, a finished step with usage, a cumulative result) and,
 * when `exitAfterFirst` is set, ends after its first turn like a process that went away between turns.
 */
function fakeAgy(file: string, exitAfterFirst = false): void {
  writeFileSync(file, `import {appendFileSync, readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2), at=flag=>args[args.indexOf(flag)+1];
const agent=readFileSync('.agents/agents/'+at('--agent')+'.md','utf8'), settings=JSON.parse(readFileSync(at('--settings'),'utf8'));
appendFileSync(${JSON.stringify(path.join(path.dirname(file), 'agy-calls.jsonl'))},JSON.stringify({args,cwd:process.cwd(),agent,settings})+'\\n');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const id=args.includes('--conversation')?at('--conversation'):'conv-demo';
let step=args.includes('--conversation')?10:0, total=0, turns=0;
emit({event:'init',conversation_id:id,init:{model:at('--model'),cwd:process.cwd(),agent:at('--agent'),tools:['view_file','run_command']}});
createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line); if(message.event!=='user') throw new Error('bad input '+line);
  turns++;
  const update=(fields)=>emit({event:'step_update',step_update:{conversation_id:id,step_index:step++,...fields}});
  update({state:'DONE',step_type:'user_input'});
  update({state:'DONE',step_type:'agent_response',usage:{input_tokens:1000,output_tokens:40,thinking_tokens:10,cache_read_tokens:3000,total_tokens:1040}});
  const call={name:'call_mcp_tool',parameters:{ServerName:'alba-producer',ToolName:'producer_read',Arguments:{kind:'cases'}}};
  emit({event:'step_update',step_update:{conversation_id:id,step_index:step,state:'ACTIVE',step_type:'tool',tool_name:'call_mcp_tool',tool_info:call}});
  update({state:'DONE',step_type:'tool',tool_name:'call_mcp_tool',tool_info:{...call,output:'two open cases'}});
  update({state:'ACTIVE',step_type:'agent_response',text_delta:'Answer to '});
  emit({event:'step_update',step_update:{conversation_id:id,step_index:step,state:'ACTIVE',step_type:'agent_response',text_delta:message.message.content.split('\\n').at(-1)}});
  update({state:'DONE',step_type:'agent_response',text_delta:'',usage:{input_tokens:200,output_tokens:60,thinking_tokens:20,cache_read_tokens:4000,total_tokens:260}});
  total+=1300;
  emit({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'Answer',num_turns:turns,usage:{input_tokens:total,output_tokens:100,total_tokens:total+100}}});
  if(${exitAfterFirst} && !args.includes('--conversation')) process.exit(0);
});
`);
}
const calls = (dir: string) => readFileSync(path.join(dir, 'agy-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('agy router runs a session-only custom agent with only the producer MCP server, records turns and usage, and resumes', async () => {
  const f = await fixture({ populate: false, project: dir => ({ producer: { enabled: true, session: { enabled: true, engine: 'agy', model: 'model-sample', effort: 'minimal', cli: path.join(dir, 'agy.mjs'), max_turns: 100 } } }) });
  const p = f.board.ctx.projects[0]; fakeAgy(p.producer.session.cli!, true);
  assert.ok(sessionEngine(p) instanceof AgyEngine);
  const manager = new ProducerSessionManager(p, f.orders);
  try {
    assert.equal((await manager.start()).state, 'running');
    for (let i = 0; i < 2; i++) { await manager.sendBatch([`message ${i}`]); await until(() => producerSessionTurns(p).filter(t => t.answer.endsWith(`message ${i}`)).length === 1 && !manager.status().active); }
    const turns = producerSessionTurns(p);
    // Two finished steps per turn: (1000 + 3000 + 40) + (200 + 4000 + 60); the cumulative result is never charged again.
    assert.deepEqual(turns.map(t => t.usage.total_tokens), [8300, 8300]);
    assert.deepEqual(turns.map(t => t.usage.cache_read_input_tokens), [7000, 7000]);
    assert.ok(turns.every(t => t.requests?.length === 2 && t.requests.every(r => r.engine === 'agy' && r.model === 'model-sample')));
    assert.deepEqual(turns[0].tools.map(tool => [tool.name, tool.input, tool.result]), [['mcp__alba-producer__producer_read', '{"kind":"cases"}', 'two open cases']]);
    assert.equal(turns[1].answer, 'Answer to message 1'); assert.equal(turns[1].error, undefined);
    const rows = producerUsage(p); assert.equal(rows[0].engine, 'agy'); assert.equal(rows[0].requests, 4); assert.equal(rows[0].cacheRead, 14000); assert.equal(rows[0].uncachedInput, 2400); assert.equal(rows[0].output, 200);
    assert.equal(manager.status().engine, 'agy');

    const [first, second] = calls(path.dirname(p.producer.session.cli!));
    // The first process ended after its turn; the second batch resumed the same conversation instead of failing the session.
    assert.equal(second.args[second.args.indexOf('--conversation') + 1], 'conv-demo'); assert.ok(!first.args.includes('--conversation'));
    for (const call of [first, second]) {
      const a: string[] = call.args, at = (flag: string) => a[a.indexOf(flag) + 1];
      assert.equal(at('--input-format'), 'stream-json'); assert.equal(at('--output-format'), 'stream-json'); assert.equal(at('--agent'), 'alba-producer');
      assert.equal(at('--model'), 'model-sample'); assert.equal(at('--effort'), 'low'); assert.equal(at('--add-dir'), p.root); assert.equal(a.at(-1), '-p=');
      assert.ok(a.includes('--disable-slash-commands')); assert.ok(!a.includes('--dangerously-skip-permissions'));
      // Its own folder in the state folder, never the person's global agy configuration.
      assert.equal(path.resolve(call.cwd), path.join(p.state_dir, 'producer-agy')); assert.ok(path.resolve(at('--settings')).startsWith(path.resolve(p.state_dir)));
      assert.match(call.agent, /^---\nname: "alba-producer"\n/); assert.match(call.agent, /\ninheritMcp: false\n/); assert.match(call.agent, /\ninheritCustomizations: false\n/);
      assert.match(call.agent, /\ntools: \["view_file"\]\n/); assert.match(call.agent, /\ncommandExecutionPolicy: "off"\n/);
      assert.deepEqual([...call.agent.matchAll(/^ {2}- name: (.*)$/gm)].map(m => JSON.parse(m[1])), ['alba-producer']);
      assert.match(call.agent, /"ALBA_PRODUCER_READ_ONLY":"0"/); assert.match(call.agent, /---\nYou are the persistent Alba producer router/);
      assert.deepEqual(call.settings.permissions.allow, ['read_file(*)', 'mcp(alba-producer/producer_read)', 'mcp(alba-producer/producer_act)', 'mcp(alba-producer/producer_notes)', 'mcp(alba-producer/producer_review)', 'mcp(alba-producer/producer_draft)', 'mcp(alba-producer/producer_direction_propose)', 'mcp(alba-producer/producer_work)']);
      for (const rule of ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)']) assert.ok(call.settings.permissions.deny.includes(rule));
      assert.equal(call.settings.agentMode, ''); assert.equal(call.settings.toolPermission, 'request-review');
      assert.equal(call.settings.mcpServers, undefined);
    }
    assert.ok(!calls(path.dirname(p.producer.session.cli!)).some(call => call.args[0] === 'mcp'), 'never runs agy mcp, which writes the global configuration');
  } finally { await manager.stop(); }
});

test('agy router reports a process that dies during a turn and a failed result as errors', async () => {
  const f = await fixture({ populate: false }), p = f.board.ctx.projects[0], cli = path.join(p.root, 'agy.mjs');
  fakeAgy(cli);
  writeFileSync(cli, readFileSync(cli, 'utf8').replace("turns++;", "turns++; if(message.message.content==='die'){process.stderr.write('model quota exhausted'); process.exit(3);} if(message.message.content==='fail'){emit({event:'result',result:{conversation_id:id,status:'ERROR',error:'invalid model selection'}}); return;}"));
  const { mcpConfig } = await import('../src/producer/session.ts');
  const engine = new AgyEngine(), events: any[] = [];
  try {
    await engine.start({ cli, cwd: p.root, mcpConfig: mcpConfig(p), systemPrompt: 'fixed' });
    const reading = (async () => { for await (const e of engine.readEvents()) events.push(e); })();
    await engine.sendBatch(['fail']); await until(() => events.some(e => e.type === 'result'));
    assert.deepEqual(events.find(e => e.type === 'result').raw, { type: 'result', is_error: true, result: 'invalid model selection' });
    await engine.sendBatch(['die']); await until(() => events.some(e => e.type === 'process_exit'));
    assert.match(events.find(e => e.type === 'process_exit').text, /agy exited \(3\): model quota exhausted/);
    await engine.stop(); await reading;
  } finally { await engine.stop(); }
});

test('agy work sessions attach only the read-only producer server and are accounted from their stream log', async () => {
  const f = await fixture({ populate: false, project: dir => ({ producer: { enabled: true, session: { engine: 'claude' }, work: { engine: 'agy', model: 'sample-worker', cli: path.join(dir, 'agy.exe') }, rules: [{ id: 'note', action: 'note', instruction: 'Record findings', mode: 'auto' }] } }) });
  const p = f.board.ctx.projects[0], at = new Date().toISOString();
  const card: ProducerCase = { id: 'case-demo', key: 'blocked/SAMPLE', project: p.id, trigger: 'blocked', status: 'open', revision: 1, openedAt: at, updatedAt: at, facts: {}, card: { trigger: 'blocked', summary: 'Inspect facts', pointers: [], untrusted: [] } };
  writeStateFile(p, '_producer-cases.json', JSON.stringify([card]));
  const probes = { ...f.board.ctx.probes, processStartedAt: () => '2026-01-01T00:00:00Z', readText: (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } } };
  const run = startProducerWork(p, f.orders, card.key, 'work', '', probes);
  assert.equal(run.engine, 'agy'); assert.equal(f.spawned[0].program, p.producer.work!.cli);
  const a = f.spawned[0].args, flag = (name: string) => a[a.indexOf(name) + 1];
  assert.equal(flag('--agent'), 'alba-producer-work'); assert.equal(flag('--model'), 'sample-worker'); assert.equal(flag('--output-format'), 'stream-json'); assert.equal(flag('--add-dir'), p.root);
  assert.deepEqual(a.slice(-2), ['-p', `Read the UTF-8 file ${run.prompt.split(path.sep).join('/')} in full and perform its task.`]);
  assert.ok(!a.includes('--dangerously-skip-permissions') && !a.includes('--input-format'));
  const agent = readFileSync(path.join(run.cwd, '.agents', 'agents', 'alba-producer-work.md'), 'utf8'), settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'));
  assert.match(agent, /"ALBA_PRODUCER_READ_ONLY":"1"/); assert.match(agent, /\ninheritMcp: false\n/); assert.match(agent, /isolated, read-only Alba work session/);
  assert.deepEqual(settings.permissions.allow, ['read_file(*)', 'mcp(alba-producer/producer_read)', 'mcp(alba-producer/producer_notes)']);
  assert.ok(settings.permissions.deny.includes('command(*)') && settings.permissions.deny.includes('write_file(*)'));
  const block = `--- alba-producer-work ---\n${JSON.stringify({ summary: 'Findings ready', finding: 'The facts were checked.' })}\n--- end ---`;
  writeFileSync(run.log, [
    { event: 'init', conversation_id: 'work-demo', init: { model: 'sample-worker' } },
    { event: 'step_update', step_update: { conversation_id: 'work-demo', step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 500, output_tokens: 50, cache_read_tokens: 1500, total_tokens: 550 } } },
    { event: 'result', result: { conversation_id: 'work-demo', status: 'SUCCESS', response: block, num_turns: 1, usage: { input_tokens: 500, output_tokens: 50, total_tokens: 550 } } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  pollProducerWorks(p, probes);
  const done = producerWorks(p)[0];
  assert.equal(done.status, 'done'); assert.equal(done.result?.finding, 'The facts were checked.'); assert.equal(done.usage.total_tokens, 2050); assert.equal(done.usage.cache_read_input_tokens, 1500);
  assert.deepEqual(producerUsage(p).map(row => [row.engine, row.model, row.requests]), [['agy', 'sample-worker', 1]]);
  pollProducerWorks(p, probes); assert.equal(producerWorks(p)[0].usage.total_tokens, 2050, 'a log line is charged once');
});

test('agy configuration validates and agy usage counts finished steps only', async t => {
  const f = await fixture({ populate: false }), p = f.board.ctx.projects[0];
  const config = (session: unknown) => validateProject({ id: 'demo', name: 'Demo', root: p.root, work_orders: p.work_orders, state_dir: p.state_dir, producer: { session } }, p.file);
  assert.equal(config({ engine: 'agy', model: 'gemini-sample' }).producer.session.engine, 'agy');
  assert.throws(() => config({ engine: 'gemini' }), /claude, codex or agy/);
  const warnings = t.mock.method(console, 'warn', () => {});
  config({ engine: 'agy', config: ['a=b'] });
  assert.ok(warnings.mock.calls.some(call => /producer.session.config\/profile are ignored by the agy engine/.test(call.arguments[0])));
  const totals = new Map(), total = emptyUsage();
  const step = (index: number, state: string, usage?: unknown) => ({ event: 'step_update', step_update: { conversation_id: 'c', step_index: index, state, step_type: 'agent_response', ...(usage ? { usage } : {}) } });
  for (const raw of [step(1, 'ACTIVE', { input_tokens: 9 }), step(1, 'DONE', { input_tokens: 100, cache_read_tokens: 900, output_tokens: 30, thinking_tokens: 20 }), step(1, 'DONE', { input_tokens: 100, cache_read_tokens: 900, output_tokens: 30 }), { event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 100, output_tokens: 30 } } }]) {
    const delta = requestDelta(raw, totals); if (delta) addUsage(total, delta.usage);
  }
  // Output already includes thinking; the context is the uncached input plus the cache read.
  assert.deepEqual(total, { input_tokens: 1000, output_tokens: 30, total_tokens: 1030, uncached_input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, context_tokens: 1000 });
  assert.equal(requestDelta({ type: 'assistant', event: 'step_update' }, new Map()), undefined, 'Claude events are not read as agy events');
  assert.ok(!existsSync(path.join(p.state_dir, 'producer-agy')), 'nothing is written before a session starts');
});
