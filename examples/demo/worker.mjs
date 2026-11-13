import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Optional protocol probe used by the environment integration check.
if (process.argv.includes('--check-environment')) {
  for (const name of ['ALBA_PROJECT', 'ALBA_WORKERS', 'ALBA_SERVICE_TOKEN', 'CONSOLE_TOKEN', 'alba_private_probe', 'DEMO_REMOVE']) {
    if (process.env[name] !== undefined) throw new Error(`Unexpected inherited setting: ${name}`);
  }
  if (process.env.ALBA_DEMO_EXPLICIT !== 'explicit' || process.env.DEMO_INHERIT !== 'ordinary') throw new Error('Explicit and ordinary environment values must reach the worker.');
  if (!process.env.ALBA_PROMPT_FILE || !process.env.ALBA_LAST_FILE) throw new Error('Missing explicit protocol paths.');
}
const prompt = readFileSync(process.env.ALBA_PROMPT_FILE, 'utf8');
if (!prompt.includes('DEMO1')) throw new Error('Expected the assigned order in the prompt.');
writeFileSync('greeting.txt', 'Hello from Alba!\n');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
git('add', 'greeting.txt');
git('commit', '-m', 'Add the demo greeting');
const revision = git('rev-parse', 'HEAD');
const report = { status: 'ready', summary: 'Created and committed the greeting in the assigned worktree.', evidence: ['greeting.txt'], commits: [revision], revision };
writeFileSync(process.env.ALBA_LAST_FILE, `--- alba-report ---\n${JSON.stringify(report)}\n--- end ---\n`);
