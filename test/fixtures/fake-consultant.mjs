// Fake read-only consultant CLI for tests: echoes the question and listed files, never calls a model.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const pidFile = process.env.FAKE_CONSULTANT_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8');

const sleepMs = Number(process.env.FAKE_CONSULTANT_SLEEP_MS ?? 0);
if (sleepMs > 0) {
  await new Promise(resolve => setTimeout(resolve, sleepMs));
}

if (process.env.FAKE_CONSULTANT_TAMPER) {
  writeFileSync(path.join(process.cwd(), process.env.FAKE_CONSULTANT_TAMPER), 'unexpected edit\n', 'utf8');
}

const prompt = argv.find(a => a.includes('Question:\n')) ?? argv.at(-1) ?? '';
const qMatch = /Question:\n([\s\S]*)$/.exec(prompt);
const question = qMatch ? qMatch[1].trim() : prompt.trim();
const filesSection = /Files to inspect:\n((?:- .+\n?)+)/.exec(prompt);
const listedFiles = filesSection
  ? filesSection[1].trim().split(/\r?\n/).map(l => l.replace(/^- /, '').trim())
  : [];
const contents = listedFiles.map(f => {
  const full = path.join(process.cwd(), f);
  return existsSync(full) ? `${f}:${readFileSync(full, 'utf8').trim()}` : `${f}:missing`;
});
const answer = `Asked="${question}" Files=[${listedFiles.join(',')}] Read=[${contents.join(';')}]`;

const format = process.env.FAKE_CONSULTANT_FORMAT ?? 'plain';
const lastIdx = argv.indexOf('--output-last-message');
const lastFile = lastIdx >= 0 ? argv[lastIdx + 1] : undefined;

if (format === 'claude') {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: answer,
    total_cost_usd: 0.0125,
    usage: { input_tokens: 400, output_tokens: 120, cache_read_input_tokens: 50 },
  }) + '\n');
} else if (format === 'codex') {
  if (lastFile) writeFileSync(lastFile, answer + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 80 } }) + '\n');
} else {
  if (lastFile) writeFileSync(lastFile, answer + '\n', 'utf8');
  process.stdout.write(answer + '\n');
}
