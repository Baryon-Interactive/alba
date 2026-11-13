import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { workerEnvironment } from './environment.mjs';

const spec = JSON.parse(readFileSync(new URL('./spec.json', import.meta.url), 'utf8'));
const fill = s => s.replaceAll('{tunnel_port}', process.argv[2] ?? '0');
const explicit = Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, fill(value)]));
const args = spec.args.map(fill);
// PowerShell's call operator also resolves npm .cmd launchers in the SSH login's PATH.
// Encode the argv as data rather than interpolating it as shell source.
const data = Buffer.from(JSON.stringify({ program: spec.program, args }), 'utf8').toString('base64');
const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; $OutputEncoding=[Console]::OutputEncoding; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json; $argv=@($v.args); & $v.program @argv; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`;
const child = spawn(process.platform === 'win32' ? 'powershell' : spec.program, process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : args, {
  cwd: spec.worktree, env: workerEnvironment(process.env, explicit, spec.env_unset),
  stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
});
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
