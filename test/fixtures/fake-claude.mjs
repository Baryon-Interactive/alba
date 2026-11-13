// A headless CLI stand-in: no network, credentials or model calls.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const config = process.env.CLAUDE_CONFIG_DIR;
const settings = JSON.parse(readFileSync(path.join(config, 'settings.json'), 'utf8'));
writeFileSync(process.env.FAKE_CLAUDE_PROOF, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), config,
  configFiles: readdirSync(config).sort(), settingsKeys: Object.keys(settings).sort(),
  envKeys: Object.keys(settings.env).sort(),
  authFingerprint: createHash('sha256').update(process.env.ANTHROPIC_AUTH_TOKEN ?? '').digest('hex'),
  inheritedRemoved: !('ALBA_TEST_AUTH' in process.env) && !('ANTHROPIC_API_KEY' in process.env) && !('CLAUDE_CODE_PERSONAL' in process.env),
  skillFiles: readdirSync(path.join(config, 'skills')).sort(),
}));
const fixture = readFileSync(new URL('./claude-stream.jsonl', import.meta.url), 'utf8');
process.stdout.write(fixture);
const text = '--- alba-report ---\n' + JSON.stringify({ status: 'waiting', summary: 'Fake worker finished', question: 'Continue?', evidence: [], commits: [] }) + '\n--- end ---';
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'test-session', result: text }) + '\n');
