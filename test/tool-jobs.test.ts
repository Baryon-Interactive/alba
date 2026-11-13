import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { runTools, toolInput } from '../src/cli/tools.ts';
import { readManifest } from '../src/plugins/manifest.ts';
import { schemaProblem } from '../src/plugins/schema.ts';
import { continueToolJobs, createToolJob, runToolJob, toolJob, toolJobs } from '../src/plugins/jobs.ts';
import { acquireToolLeases, releaseToolLeases } from '../src/resources/leases.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { producerAct, runProducerAction, type ProducerCase } from '../src/producer/producer.ts';
import { validateProducerToolCall } from '../src/producer/tool-schemas.ts';
import type { ProducerExecutionEnv } from '../src/producer/producer.ts';

/** A project with the built-in example-echo tool and a project tool `maker` whose operation is a program and holds a resource. */
function fixture(extra: Record<string, unknown> = {}) {
  const { dir, orders } = tempOrders();
  const tools = path.join(dir, 'tools', 'maker');
  mkdirSync(tools, { recursive: true });
  writeFileSync(path.join(tools, 'make.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const [input, out] = process.argv.slice(2);",
    "const { name, fail } = JSON.parse(readFileSync(input, 'utf8'));",
    "if (fail) { console.error('asked to fail'); process.exit(3); }",
    "writeFileSync(`${out}/${name}.png`, 'png'); writeFileSync(`${out}/notes.log`, 'log');",
    "console.log(`made ${name}`);",
  ].join('\n'));
  writeFileSync(path.join(tools, 'alba-plugin.yaml'), [
    'id: maker', 'version: 0.1.0', 'apiVersion: 1', 'kinds: [tool]', 'description: Makes a picture.',
    'resources: { gpu: { slots: 1 } }',
    'operations:',
    '  make:',
    '    description: Makes one picture.',
    '    input: { type: object, required: [name], properties: { name: { type: string }, fail: { type: boolean } } }',
    '    run: { cli: [node, "${plugin}/make.mjs", "{input}", "{out}"] }',
    '    output: { files: ["*.png"] }',
  ].join('\n') + '\n');
  mkdirSync(path.join(dir, 'orders'));
  const project = validateProject({
    id: 'demo', name: 'Demo', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'),
    plugins: { enable: ['example-echo', 'maker'], sources: [{ path: 'tools' }] }, ...extra,
  }, path.join(dir, 'alba.yaml'));
  return { dir, orders, project };
}
const events = (orders: ReturnType<typeof tempOrders>['orders'], tag: string) => orders.store.events({ tag }).map(e => e.type);

test('manifest operations: an MCP call, a program, a quote; broken ones are refused by name', () => {
  const m = readManifest(path.resolve('plugins/example-echo/alba-plugin.yaml'));
  assert.deepEqual(Object.keys(m.operations!), ['echo', 'echo-paid']);
  assert.deepEqual(m.operations!.echo!.run, { mcp: 'echo', tool: 'echo' });
  assert.deepEqual(m.operations!['echo-paid']!.quote, { unit: 'credits', tool: 'echo_price' });
  assert.equal(m.operations!.echo!.timeout_minutes, 10);
  const { dir } = fixture();
  const file = path.join(dir, 'tools', 'maker', 'alba-plugin.yaml');
  const text = readFileSync(file, 'utf8');
  assert.deepEqual(readManifest(file).operations!.make!.run, { cli: ['node', `${path.resolve(dir, 'tools', 'maker').replace(/\\/g, '/')}/make.mjs`, '{input}', '{out}'] });
  assert.equal(readManifest(file).agent.skill, undefined, 'a tool with operations only needs no agent face');
  const refused = (changed: string, pattern: RegExp) => { writeFileSync(file, changed); assert.throws(() => readManifest(file), pattern); };
  refused(text.replace('run: { cli', 'quote: { unit: credits, tool: price }\n    run: { cli'), /operations\.make\.quote\.tool: a quote tool needs an operation that runs through mcp/);
  refused(text.replace('run: { cli: [node, "${plugin}/make.mjs", "{input}", "{out}"] }', 'run: { mcp: nope, tool: make }'), /operations\.make\.run\.mcp: a server of agent\.mcp \(none declared\)/);
  refused(text.replace('input: { type: object,', 'input: { type: array,'), /operations\.make\.input: an object schema/);
  refused(text.replace('    output:', '    retries: 2\n    output:'), /operations\.make\.retries: unknown key/);
  refused(text.replace('run: { cli', 'quote: { unit: credits }\n    run: { cli'), /needs one of fixed \(an amount\) or tool/);
});

test('input: --input and --arg make the input; the operation schema checks it', () => {
  const { dir } = fixture();
  writeFileSync(path.join(dir, 'in.json'), '\uFEFF{ "text": "a", "n": 1 }');
  assert.deepEqual(toolInput(path.join(dir, 'in.json'), ['n=2', 'flag=true', 'name=plain text', 'list=[1,2]']), { text: 'a', n: 2, flag: true, name: 'plain text', list: [1, 2] });
  const schema = { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 3 }, n: { type: 'integer', minimum: 1 }, size: { enum: ['s', 'm'] } } };
  assert.equal(schemaProblem(schema, { text: 'abc', n: 2, size: 'm' }), undefined);
  assert.equal(schemaProblem(schema, {}), 'input.text is required');
  assert.equal(schemaProblem(schema, { text: 'abcd' }), 'input.text must have at most 3 characters');
  assert.equal(schemaProblem(schema, { text: 'a', n: 0 }), 'input.n must be at least 1');
  assert.equal(schemaProblem(schema, { text: 'a', size: 'xl' }), 'input.size must be one of "s", "m"');
  assert.match(schemaProblem(schema, { text: 'a', other: 1 })!, /input\.other is not an input of this operation \(known: text, n, size\)/);
});

test('alba tools: a free MCP operation runs at once, keeps its answer as a file and records each step', async () => {
  const { orders, project } = fixture();
  const listed = JSON.parse(await runTools(project, orders, 'list', [], { json: true }));
  assert.deepEqual(listed.map((x: { tool: string }) => x.tool), ['example-echo', 'maker']);
  assert.deepEqual(listed[0].operations[1].paid, { unit: 'credits', priced_by_tool: true });
  let code = 0;
  const job = JSON.parse(await runTools(project, orders, 'run', ['example-echo', 'echo'], { json: true, arg: ['text=hello there'] }, c => { code = c; }));
  assert.equal(code, 0);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.id, 'J1'); assert.equal(job.text, 'hello there');
  assert.deepEqual(job.files, [`${job.out}/echo.txt`]);
  assert.equal(readFileSync(path.join(job.out, 'echo.txt'), 'utf8'), 'hello there');
  assert.deepEqual(events(orders, 'tool:J1'), ['tool-job-queued', 'tool-job-started', 'tool-job-done']);
  assert.throws(() => createToolJob(project, orders, { tool: 'example-echo', operation: 'echo', input: { words: 'x' } }), /The input of example-echo\/echo does not fit: input\.text is required/);
  assert.throws(() => createToolJob(project, orders, { tool: 'example-echo', operation: 'shout', input: {} }), /has no operation "shout". Its operations: echo, echo-paid/);
  assert.throws(() => createToolJob(project, orders, { tool: 'tripo-3d', operation: 'x', input: {} }), /does not enable the tool "tripo-3d"/);
  assert.match(await runTools(project, orders, 'jobs', [], { json: false }), /^J1 +done +example-echo\/echo/);
});

test('a paid operation is priced, waits for a person to approve the quote on the order, then runs and books the spend', async () => {
  const { orders, project } = fixture();
  orders.add({ tag: 'ART1', title: 'Concepts', kind: 'art' });
  assert.throws(() => createToolJob(project, orders, { tool: 'example-echo', operation: 'echo-paid', input: { text: 'x' } }), /is paid \(credits\): name the order it is for/);
  let code = 0;
  const waiting = JSON.parse(await runTools(project, orders, 'run', ['example-echo', 'echo-paid'], { json: true, order: 'art1', arg: [`text=${'y'.repeat(150)}`] }, c => { code = c; }));
  assert.equal(code, 0, 'waiting for a quote is not a failure');
  assert.equal(waiting.status, 'waiting-quote');
  assert.deepEqual(waiting.quote, { unit: 'credits', amount: 2, id: 'C1' });
  assert.match(waiting.waiting, /quote C1 of ART1 \(2 credits\) waits for approval: alba credits approve ART1 C1 --cap 2/);
  const quote = orders.get('ART1').quotes![0]!;
  assert.equal(quote.status, 'pending'); assert.equal(quote.cap_requested, 2); assert.equal(quote.service, 'tool example-echo/echo-paid');
  assert.equal(existsSync(waiting.out), false, 'nothing ran');
  // Resuming before a decision changes nothing; the tick does not start it either.
  assert.equal((await runToolJob(project, orders, 'J1')).status, 'waiting-quote');
  const started: string[][] = [];
  const spawn = ((_p: string, args: string[]) => { started.push(args); return 999999; }) as never;
  assert.deepEqual(continueToolJobs(project, orders, spawn), []);
  orders.decideQuote('ART1', 'C1', { approve: true, cap: 2 });
  assert.deepEqual(continueToolJobs(project, orders, spawn), ['tool job J1: started again (its quote was decided)']);
  assert.deepEqual(started[0]!.slice(1, 4), ['tools', 'resume', 'J1']);
  // The detached `alba tools resume J1` (pid 999999 is not alive, so this process may take it).
  const done = await runToolJob(project, orders, 'J1');
  assert.equal(done.status, 'done', done.error);
  assert.deepEqual(orders.get('ART1').quotes![0]!.ledger.map(e => [e.amount, e.what]), [[2, 'tool job J1 (example-echo/echo-paid)']]);
  assert.deepEqual(events(orders, 'ART1').filter(e => e.startsWith('tool-job') || e.startsWith('quote')), ['tool-job-queued', 'quote-made', 'tool-job-waiting', 'quote-approved', 'quote-held', 'tool-job-started', 'quote-spent', 'tool-job-done']);
  // A rejected quote: the job is refused and never runs.
  const second = createToolJob(project, orders, { tool: 'example-echo', operation: 'echo-paid', input: { text: 'z' }, order: 'ART1' });
  assert.equal((await runToolJob(project, orders, second.id)).status, 'waiting-quote');
  orders.decideQuote('ART1', 'C2', { approve: false, note: 'not now' });
  const refused = await runToolJob(project, orders, second.id);
  assert.equal(refused.status, 'refused'); assert.match(refused.error!, /Quote C2 of ART1 was rejected; do not spend/);
});

test('plugins.auto_approve: a quote within the cap is approved by Alba; a named quote is checked by the gate', async () => {
  const { orders, project } = fixture({ plugins: { enable: ['example-echo', 'maker'], sources: [{ path: 'tools' }], auto_approve: { credits: 1 } } });
  orders.add({ tag: 'ART1', title: 'Concepts', kind: 'art' });
  const small = await runToolJob(project, orders, createToolJob(project, orders, { tool: 'example-echo', operation: 'echo-paid', input: { text: 'x' }, order: 'ART1' }).id);
  assert.equal(small.status, 'done', small.error);
  assert.equal(small.quote!.auto, true);
  const q = orders.get('ART1').quotes![0]!;
  assert.equal(q.status, 'approved'); assert.match(q.approval!.note!, /approved by Alba: tool jobs up to 1 credits each, 10 a day \(plugins\.auto_approve\)/);
  assert.match(small.quote!.autoAt!, /^2026-01-01T/, 'when Alba approved it: the day it counts in');
  const big = await runToolJob(project, orders, createToolJob(project, orders, { tool: 'example-echo', operation: 'echo-paid', input: { text: 'x'.repeat(101) }, order: 'ART1' }).id);
  assert.equal(big.status, 'waiting-quote', 'over the cap: a person decides');
  // A quote approved beforehand is used instead of making one; the gate refuses when too little is left.
  orders.quote('ART1', { id: 'BATCH', service: 'echo batch', unit: 'credits', cap_requested: 3 });
  orders.decideQuote('ART1', 'BATCH', { approve: true, cap: 3 });
  const named = await runToolJob(project, orders, createToolJob(project, orders, { tool: 'example-echo', operation: 'echo-paid', input: { text: 'x'.repeat(250) }, order: 'ART1', quote: 'batch' }).id);
  assert.equal(named.status, 'done', named.error);
  assert.equal(named.quote!.id, 'BATCH');
  const over = await runToolJob(project, orders, createToolJob(project, orders, { tool: 'example-echo', operation: 'echo-paid', input: { text: 'x' }, order: 'ART1', quote: 'BATCH' }).id);
  assert.equal(over.status, 'refused'); assert.match(over.error!, /Quote BATCH of ART1 has 0 credits left, 1 are needed/);
  assert.throws(() => createToolJob(project, orders, { tool: 'example-echo', operation: 'echo', input: { text: 'x' }, order: 'ART1', quote: 'BATCH' }), /is free; it needs no quote/);
});

test('a program operation: {input} and {out}, the output patterns, the tool resource lease, and a failing program', async () => {
  const { orders, project } = fixture();
  assert.deepEqual(project.resources?.gpu?.slots, 1, 'the tool brings its resource');
  // Someone else holds the only gpu slot: the job waits, and goes on once the slot is free.
  assert.equal(acquireToolLeases(project, orders, 'tool:OTHER', ['gpu']), undefined);
  const job = createToolJob(project, orders, { tool: 'maker', operation: 'make', input: { name: 'hero' } });
  const waiting = await runToolJob(project, orders, job.id);
  assert.equal(waiting.status, 'queued'); assert.match(waiting.waiting!, /resource gpu is full \(1\/1, held by tool:OTHER\)/);
  releaseToolLeases(project, orders, 'tool:OTHER');
  const started: string[][] = [];
  assert.deepEqual(continueToolJobs(project, orders, ((_p: string, a: string[]) => { started.push(a); return 999999; }) as never), ['tool job J1: started again (it waited for a resource)']);
  const done = await runToolJob(project, orders, job.id);
  assert.equal(done.status, 'done', done.error);
  assert.deepEqual(done.files, [`${done.out}/hero.png`], 'only the files the patterns name');
  assert.equal(done.text, 'made hero');
  assert.equal(JSON.parse(readFileSync(path.join(project.state_dir, 'tool-jobs', 'J1.input.json'), 'utf8')).name, 'hero');
  assert.deepEqual(events(orders, 'tool:J1'), ['tool-job-queued', 'tool-job-waiting', 'lease-acquired', 'tool-job-started', 'tool-job-done', 'lease-released']);
  let code = 0;
  const failed = JSON.parse(await runTools(project, orders, 'run', ['maker', 'make'], { json: true, arg: ['name=x', 'fail=true'] }, c => { code = c; }));
  assert.equal(failed.status, 'failed'); assert.equal(code, 1);
  assert.match(failed.error, /node exited with 3: asked to fail/);
  // A job whose process died while it ran is marked failed by the tick, nothing booked.
  writeStateFile(project, '_tool-jobs.json', JSON.stringify(toolJobs(project).map(j => j.id === 'J2' ? { ...j, status: 'running', pid: 999999 } : j)));
  assert.deepEqual(continueToolJobs(project, orders, (() => 1) as never), ['tool job J2: its process is gone; marked failed']);
  assert.match(toolJob(project, 'J2').error!, /the process that ran it is gone/);
});

test('producer tool-call: checked when proposed, starts a detached job when accepted; the read lists the operations', async () => {
  const { orders, project } = fixture({ producer: { enabled: true, rules: [], session: { enabled: false } } });
  orders.add({ tag: 'ART1', title: 'Concepts', kind: 'art' });
  const card: ProducerCase = { id: 'case-1', key: 'question/ART1', project: project.id, trigger: 'question', status: 'open', revision: 1, openedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', order: 'ART1', facts: {}, card: { trigger: 'question', summary: 'Which look?', pointers: [], untrusted: [] } };
  writeStateFile(project, '_producer-cases.json', JSON.stringify([card]));
  assert.throws(() => validateProducerToolCall('producer_act', { actions: [{ case: 'case-1', kind: 'tool-call' }] }), /Invalid producer_act call/);
  validateProducerToolCall('producer_act', { actions: [{ case: 'case-1', kind: 'tool-call', tool: { id: 'example-echo', operation: 'echo-paid', input: { text: 'a' } } }] });
  assert.throws(() => producerAct(project, orders, 'case-1', 'tool-call', { tool: { id: 'example-echo', operation: 'echo', input: { nope: 1 } } }), /does not fit: input\.text is required/);
  const action = producerAct(project, orders, 'case-1', 'tool-call', { tool: { id: 'example-echo', operation: 'echo-paid', input: { text: 'a look' } }, reason: 'price a concept' });
  assert.equal(action.status, 'proposed', 'a tool-call is a proposal unless a rule says auto');
  assert.equal(action.target, 'ART1');
  const spawned: string[][] = [];
  const env = { probes: { spawnDetached: (_p: string, args: string[]) => { spawned.push(args); return 999999; } } } as unknown as ProducerExecutionEnv;
  const ran = runProducerAction(project, orders, action.id, undefined, env);
  assert.equal(ran.status, 'done', ran.refusal);
  assert.equal(ran.job, 'J1'); assert.match(ran.result!, /tool job J1 started \(example-echo\/echo-paid\)/);
  assert.deepEqual(spawned[0]!.slice(1, 4), ['tools', 'resume', 'J1']);
  const job = toolJob(project, 'J1');
  assert.equal(job.by, 'producer'); assert.equal(job.order, 'ART1'); assert.equal(job.case, 'question/ART1'); assert.equal(job.action, action.id);
  assert.equal((await runToolJob(project, orders, 'J1')).status, 'waiting-quote', 'the producer never approves its own spend');
  const { callProducerTool } = await import('../src/producer/mcp.ts');
  const read = callProducerTool(project, orders, 'producer_read', { kind: 'tools' }) as { tools: { tool: string }[]; jobs: { id: string; status: string }[] };
  assert.deepEqual(read.tools.map(x => x.tool), ['example-echo', 'maker']);
  assert.deepEqual(read.jobs.map(j => [j.id, j.status]), [['J1', 'waiting-quote']]);
});
