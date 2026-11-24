import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { workerEnvironment } from './environment.mjs';
import { codexVerifierServers, disableServers, worktreeFingerprint } from './read-only.mjs';

const spec = JSON.parse(readFileSync(new URL('./spec.json', import.meta.url), 'utf8'));
const fill = s => s.replaceAll('{tunnel_port}', process.argv[2] ?? '0');
const explicit = Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, fill(value)]));
const args = spec.args.map(fill);
// PowerShell resolves npm .cmd launchers in the SSH login's PATH. Pass argv as data.
function command(program, args) {
  if (process.platform !== 'win32' || (spec.read_only && /\.exe$/i.test(program))) return [program, args];
  // Windows PowerShell 5.1 drops literal quotes when forwarding arguments to native CLIs.
  // Preserve TOML server keys and the strict MCP JSON through npm's PowerShell shim.
  const argv = spec.read_only ? args.map(arg => arg.replace(/(\\*)"/g, '$1$1\\"')) : args;
  const data = Buffer.from(JSON.stringify({ program, args: argv }), 'utf8').toString('base64');
  const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; $OutputEncoding=[Console]::OutputEncoding; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json; $argv=@($v.args); & $v.program @argv; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`;
  return ['powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
}
const options = { cwd: spec.worktree, env: workerEnvironment(process.env, explicit, spec.env_unset), windowsHide: true };
const baseline = spec.read_only && worktreeFingerprint(spec.worktree);
if (spec.read_only === 'codex-cli') {
  const servers = codexVerifierServers(spec.program, spec.worktree, ([program, ...argv]) => {
    const [exe, flags] = command(program, argv);
    return execFileSync(exe, flags, { ...options, encoding: 'utf8', timeout: 30000 });
  });
  args.splice(1, 0, ...disableServers(servers));
} else if (spec.read_only === 'claude-cli') {
  const home = spec.read_only_home;
  mkdirSync(home, { recursive: true });
  for (const key of Object.keys(options.env)) if (/^(CLAUDE_CODE_|ANTHROPIC_)/i.test(key) && !(key in explicit)) delete options.env[key];
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ env: explicit }), { mode: 0o600 });
  options.env.CLAUDE_CONFIG_DIR = home;
}
const [program, argv] = command(spec.program, args);
const child = spawn(program, argv, { ...options, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.on('exit', code => {
  if (baseline) {
    const result = worktreeFingerprint(spec.worktree) === baseline ? 'unchanged' : 'changed';
    writeFileSync(new URL('./result/worktree-check', import.meta.url), result);
  }
  process.exitCode = code ?? 1;
});
