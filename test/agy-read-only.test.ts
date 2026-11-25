import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildConsultSpec } from '../src/consult/spec.ts';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { startRun } from '../src/run/launch.ts';
import { readOnlyCommand, verifierArgs } from '../src/review/independent.ts';
import { supportsReadOnly } from '../src/routing/choose.ts';
import { tick } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { AGY_READ_SERVER_PATH, agyReadOnlyFolder, writeAgyReadOnlyAgent } from '../src/workers/adapters/agy-workspace.ts';
import { tempOrders } from './helpers.ts';
import { fixture, probes } from './run-fixture.ts';

const agyWorker = (id: string, model: string, extra: Record<string, unknown> = {}) =>
  ({ id, engine: 'agy-cli', model_family: 'gemini-4', launch: { template: `${id}-v1`, program: 'agy', model, args: [] }, ...extra });
const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const agentFile = (stateDir: string, name: string) => path.join(agyReadOnlyFolder(stateDir), '.agents', 'agents', `${name}.md`);

test('agy read-only launch: a fresh restricted agent, session settings that deny commands, writes and web, never skipped permissions', () => {
  const { dir } = tempOrders();
  const stateDir = path.join(dir, 'state'), tree = path.join(dir, 'tree');
  mkdirSync(tree, { recursive: true });
  const worker = validateWorkers({ workers: [agyWorker('agy-carbon', 'gemini-4-carbon-high')] }, 'workers.yaml').workers[0];
  assert.throws(() => verifierArgs(worker, tree, 'Plan', 'last.txt'), /state folder/);
  const args = verifierArgs(worker, tree, 'Read the plan prompt', 'last.txt', [], undefined, stateDir);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(valueAfter(args, '--output-format'), 'stream-json');
  assert.equal(valueAfter(args, '--model'), 'gemini-4-carbon-high');
  assert.ok(args.includes('--disable-slash-commands'));
  // Go-style flags: the prompt is the value of -p, the last argument.
  assert.deepEqual(args.slice(-2), ['-p', 'Read the plan prompt']);
  assert.equal(valueAfter(args, '--add-dir'), agyReadOnlyFolder(stateDir).replace(/\\/g, '/'));

  const name = valueAfter(args, '--agent');
  assert.match(name, /^alba-read-only-[0-9a-f]{12}$/);
  const agent = readFileSync(agentFile(stateDir, name), 'utf8');
  for (const line of ['inheritMcp: false', 'inheritCustomizations: false', 'tools: ["read_file"]', 'commandExecutionPolicy: "off"', 'mainAgent: true', '  - name: "alba-read"']) assert.ok(agent.includes(`\n${line}\n`), line);
  const serverArgs = JSON.parse(/\n {4}args: (.*)\n/.exec(agent)![1]) as string[];
  assert.deepEqual(serverArgs, [AGY_READ_SERVER_PATH.replace(/\\/g, '/'), '--root', path.resolve(tree).replace(/\\/g, '/')]);

  const settings = JSON.parse(readFileSync(valueAfter(args, '--settings'), 'utf8'));
  assert.equal(settings.toolPermission, 'request-review');
  assert.deepEqual(settings.permissions.allow, ['read_file(*)', 'mcp(alba-read/list_files)', 'mcp(alba-read/search_text)']);
  for (const rule of ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'unsandboxed(*)']) assert.ok(settings.permissions.deny.includes(rule), rule);

  // Each launch has its own name (a worktree cannot plant a same-named agent, which agy would prefer); resuming adds only the conversation.
  const resumed = verifierArgs(worker, tree, 'Read the plan prompt', 'last.txt', [], 'conv-1', stateDir);
  assert.notEqual(valueAfter(resumed, '--agent'), name);
  assert.equal(valueAfter(resumed, '--conversation'), 'conv-1');
  const strip = (list: string[]) => list.filter((a, i) => !['--agent', '--conversation'].includes(a) && !['--agent', '--conversation'].includes(list[i - 1]));
  assert.deepEqual(strip(resumed), strip(args));
  // Nothing is written into the checked folder.
  assert.deepEqual(readdirSync(tree), []);
});

test('agy read-only agents of old runs are removed, recent ones are kept', () => {
  const { dir } = tempOrders();
  const stateDir = path.join(dir, 'state');
  const old = writeAgyReadOnlyAgent(stateDir, [dir]);
  const recent = writeAgyReadOnlyAgent(stateDir, [dir]);
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600_000);
  utimesSync(agentFile(stateDir, old.name), eightDaysAgo, eightDaysAgo);
  const next = writeAgyReadOnlyAgent(stateDir, [dir]);
  assert.ok(!existsSync(agentFile(stateDir, old.name)));
  assert.ok(existsSync(agentFile(stateDir, recent.name)) && existsSync(agentFile(stateDir, next.name)));
});

test('read-only choice: agy qualifies locally, not on an SSH worker, and a remote read-only agy launch is refused', () => {
  const { project } = fixture();
  const [local, remote] = validateWorkers({ workers: [agyWorker('agy-carbon', 'gemini-4-carbon-high'), agyWorker('agy-host', 'gemini-4-carbon-high', { host: 'box' })] }, 'workers.yaml').workers;
  assert.equal(supportsReadOnly(local), true);
  assert.equal(supportsReadOnly(remote), false);
  assert.throws(() => readOnlyCommand({ project, probes: probes() }, local, project.root, 'Plan', 'last.txt', true), /only on this machine/);
});

test('a planning phase runs on an agy worker entry with its own model, then the write phase on the usual agy worker', () => {
  const { project, orders } = fixture();
  const workers = validateWorkers({ workers: [agyWorker('agy-direct', 'gemini-4-neon-xhigh'), agyWorker('agy-carbon', 'gemini-4-carbon-high')] }, 'workers.yaml');
  project.phases = { sim: [{ id: 'plan', mode: 'read-only', role: 'planner' }, { id: 'implement', mode: 'write', role: 'developer' }] };
  project.roles = { planner: { workers: { only: ['agy-carbon'] }, sources: {} }, developer: { workers: { prefer: ['agy-direct'] }, sources: {} } };
  const fake = probes();
  const ctx = { project, orders, workers, probes: fake };
  const start = () => {
    const report = tick(project, orders, workers, fake, { record: false }).report;
    const move = report.moves.find(m => m.tag === 'T1');
    assert.ok(move && 'worker' in move, JSON.stringify(report));
    startRun(ctx, 'T1', move.worker);
    return { run: orders.get('T1').runs.at(-1)!, spawned: fake.spawned.at(-1)! };
  };

  const plan = start();
  assert.deepEqual([plan.run.phase, plan.run.worker, plan.run.model], ['plan', 'agy-carbon', 'gemini-4-carbon-high']);
  assert.equal(plan.spawned.program, 'agy');
  assert.equal(plan.spawned.cwd, plan.run.cwd, 'agy runs in the order worktree');
  assert.ok(!plan.spawned.args.includes('--dangerously-skip-permissions'));
  assert.equal(valueAfter(plan.spawned.args, '--model'), 'gemini-4-carbon-high');
  assert.match(valueAfter(plan.spawned.args, '--agent'), /^alba-read-only-/);
  assert.ok(valueAfter(plan.spawned.args, '-p').includes(plan.run.prompt_file!));
  assert.match(readFileSync(plan.run.prompt_file!, 'utf8'), /read-only planning phase/);
  const agent = readFileSync(agentFile(project.state_dir, valueAfter(plan.spawned.args, '--agent')), 'utf8');
  assert.ok(agent.includes(`"--root","${path.resolve(plan.run.cwd!).replace(/\\/g, '/')}"`), agent);

  // agy writes no last file: the final message comes from its stream-json log.
  const block = ['--- alba-report ---', JSON.stringify({ status: 'ready', run: plan.run.id, summary: 'Planned', plan: 'Check the cache key first.' }), '--- end ---'].join('\n');
  const log = [
    { event: 'init', conversation_id: 'c1', init: { model: 'gemini-4-carbon-high' } },
    { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: block, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: block, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(plan.run.log!, log);
  const finishing = probes({ fileTime: file => file === plan.run.log ? plan.run.started : undefined, readText: file => file === plan.run.log ? log : undefined, tail: file => file === plan.run.log ? log : '' });
  applyFinish(orders, findFinishes(project, orders, finishing, workers)[0], project);
  assert.deepEqual(orders.stage(orders.get('T1')), { stage: 'queued', why: 'plan ready, next phase: implement' });
  assert.equal(readFileSync(orders.get('T1').runs.at(-1)!.plan_file!, 'utf8'), 'Check the cache key first.');

  const write = start();
  assert.deepEqual([write.run.phase, write.run.worker], ['implement', 'agy-direct']);
  assert.ok(write.spawned.args.includes('--dangerously-skip-permissions'));
  assert.equal(valueAfter(write.spawned.args, '--model'), 'gemini-4-neon-xhigh');
  assert.ok(readFileSync(write.run.prompt_file!, 'utf8').includes('Check the cache key first.'));
});

test('consult: an agy consultant gets the restricted launch with the question as the -p value', () => {
  const { project, orders } = fixture();
  project.consult = { enabled: true, role: 'consultant', max_per_run: 2, timeout_minutes: 10 };
  const [consultant] = validateWorkers({ workers: [agyWorker('agy-carbon', 'gemini-4-carbon-high')] }, 'workers.yaml').workers;
  const spec = buildConsultSpec({ ctx: { project, probes: probes() }, doc: orders.get('T1'), runId: 'r1', worktree: project.root, consultant });
  const args = spec.command.args;
  assert.equal(spec.command.program, 'agy');
  assert.deepEqual(args.slice(-2), ['-p', '{prompt}']);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(existsSync(agentFile(project.state_dir, valueAfter(args, '--agent'))));
});

test('the read-only search server lists and searches files under its roots only, and never outside them', () => {
  const { dir } = tempOrders();
  const root = path.join(dir, 'tree'), outside = path.join(dir, 'secret');
  mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, 'src', 'cache.ts'), 'export function cacheKey() {}\nconst other = 1;\n');
  writeFileSync(path.join(root, 'src', 'deep', 'notes.md'), 'The cacheKey is stable.\n');
  writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 3, 99, 97, 99, 104, 101]));
  writeFileSync(path.join(outside, 'key.txt'), 'cacheKey secret\n');
  const slash = (p: string) => p.replace(/\\/g, '/');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_files', arguments: { path: slash(root) } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_files', arguments: { path: slash(root), glob: '**/*.md' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_text', arguments: { path: slash(root), pattern: 'cachekey', ignore_case: true } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'search_text', arguments: { path: slash(outside), pattern: 'cacheKey' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_files', arguments: { path: slash(path.join(root, '..', 'secret')) } } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'list_files', arguments: { path: 'src' } } },
  ];
  const run = spawnSync(process.execPath, [AGY_READ_SERVER_PATH, '--root', root], { input: requests.map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const answers = new Map(run.stdout.trim().split('\n').map(line => { const a = JSON.parse(line); return [a.id, a]; }));
  assert.equal(answers.size, 8, 'a notification gets no answer');
  assert.equal(answers.get(1).result.serverInfo.name, 'alba-read');
  assert.deepEqual(answers.get(2).result.tools.map((t: { name: string }) => t.name), ['list_files', 'search_text']);
  const text = (id: number) => answers.get(id).result.content[0].text as string;
  assert.deepEqual(text(3).split('\n').slice(1), ['image.bin', 'src/cache.ts', 'src/deep/notes.md']);
  assert.deepEqual(text(4).split('\n').slice(1), ['src/deep/notes.md']);
  assert.match(text(5), /^2 match\(es\) in 3 file\(s\).*1 binary or large file\(s\) skipped/);
  assert.ok(text(5).includes('src/cache.ts:1: export function cacheKey() {}') && text(5).includes('src/deep/notes.md:1: The cacheKey is stable.'));
  for (const id of [6, 7]) { assert.equal(answers.get(id).result.isError, true); assert.match(text(id), /outside the readable folders/); }
  assert.match(text(8), /must be absolute/);
});
