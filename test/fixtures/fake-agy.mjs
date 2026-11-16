// A stand-in for the Antigravity CLI (`agy -p <prompt> --output-format stream-json ...`), used by test/agy.test.ts.
// Prints the stream-json lines agy 1.5.9 prints (shapes copied from real runs), records how it was started in FAKE_AGY_PROOF,
// and plays the scenario named in FAKE_AGY_MODE: ok (a report block), region, auth, model, quota.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const mode = process.env.FAKE_AGY_MODE ?? 'ok';
const model = value('--model') ?? 'gemini-3.8-flash-high';
const conversation = value('--conversation') ?? 'conv-fake-1';
if (process.env.FAKE_AGY_PROOF) writeFileSync(process.env.FAKE_AGY_PROOF, JSON.stringify({ args, cwd: process.cwd() }), 'utf8');

const out = event => process.stdout.write(JSON.stringify(event) + '\n');
const step = (index, fields) => out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: index, ...fields } });
const usage = (input, output) => ({ input_tokens: input, output_tokens: output, thinking_tokens: 5, cache_read_tokens: 10, total_tokens: input + output });
const zero = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };

if (mode === 'model') {
  process.stderr.write(`agy.exe : error: invalid model selection (--model "${model}" --effort ""): model ${model} is not recognized as a known model or custom model in settings\n`);
  out({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: `invalid model selection (--model "${model}" --effort ""): model ${model} is not recognized as a known model or custom model in settings`, duration_seconds: 0, num_turns: 0, usage: zero, finished_reason: 'error' } });
  process.exit(1);
}

out({ event: 'init', conversation_id: conversation, init: { model, cwd: process.cwd(), tools: ['read_file', 'run_command', 'write_to_file'], permission_mode: 'always-proceed' } });
step(0, { state: 'DONE', step_type: 'user_input' });
const errors = {
  region: 'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
  auth: 'UNAUTHENTICATED (code 401): not signed in; run agy to sign in',
  quota: 'RESOURCE_EXHAUSTED (code 429): You have exhausted your capacity on this model. Your quota will reset after 3h.',
};
if (errors[mode]) {
  step(1, { state: 'DONE', step_type: 'error_message' });
  out({ event: 'result', result: { conversation_id: conversation, status: 'ERROR', response: '', error: errors[mode], duration_seconds: 0, num_turns: 1, usage: zero } });
  process.exit(1);
}

step(1, { state: 'DONE', step_type: 'agent_response', duration_seconds: 1.2, usage: usage(100, 20) });
const prompt = value('-p') ?? '';
const file = /Read the UTF-8 file (\S+) in full/.exec(prompt)?.[1] ?? '';
step(2, { state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: file } } });
step(2, { state: 'DONE', step_type: 'tool', tool_name: 'read_file', duration_seconds: 0.01, tool_info: { name: 'read_file', parameters: { Path: file }, output: '1 lines, 81 bytes' } });
step(3, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Looking at the repository first.' });
step(3, { state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: usage(200, 30) });
step(4, { state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'git status --short' } } });
step(4, { state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.2, tool_info: { name: 'run_command', parameters: { CommandLine: 'git status --short' }, output: '' } });
const block = '--- alba-report ---\n{"status":"waiting","summary":"Fake agy worker finished","question":"Continue?","evidence":[],"commits":[]}\n--- end ---';
const final = `Fake agy worker finished.\n\n${block}\n`;
for (const piece of final.match(/[\s\S]{1,40}/g)) step(5, { state: 'ACTIVE', step_type: 'agent_response', text_delta: piece });
step(5, { state: 'DONE', step_type: 'agent_response', usage: usage(300, 40) });
out({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: final, duration_seconds: 2.5, num_turns: 3, usage: { input_tokens: 600, output_tokens: 90, thinking_tokens: 15, cache_read_tokens: 30, total_tokens: 690 } } });
