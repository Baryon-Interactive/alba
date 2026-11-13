// The detached capture process owns the worker. Codex events need a receipt timestamp.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const [program, args] = JSON.parse(process.argv[2]);
const child = spawn(program, args, { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true });
createInterface({ input: child.stdout }).on('line', line => {
  try { process.stdout.write(JSON.stringify({ ...JSON.parse(line), alba_at: new Date().toISOString() }) + '\n'); }
  catch { process.stderr.write(line + '\n'); }
});
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
