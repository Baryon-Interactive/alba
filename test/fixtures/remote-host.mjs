// SSH stand-in for the Windows host script when the transport test runs on POSIX.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
const dir = process.argv[2], spec = JSON.parse(readFileSync(path.join(dir, 'spec.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('--git-dir', spec.repo, 'worktree', 'add', '-f', '-B', spec.branch, spec.worktree, `refs/alba/incoming/${spec.branch}`);
git('-C', spec.worktree, 'config', 'user.name', 'Remote Demo');
git('-C', spec.worktree, 'config', 'user.email', 'remote@example.test');
cpSync(path.join(dir, 'overlay'), spec.worktree, { recursive: true });
const result = spawnSync(process.execPath, [path.join(dir, 'worker.mjs'), process.argv[3]], { stdio: 'inherit', env: { ...process.env, ALBA_PROJECT: 'remote-private', ALBA_SERVICE_TOKEN: 'remote-control', CONSOLE_TOKEN: 'remote-console', KEEP: 'ordinary', REMOVE: 'gone' } });
if (result.status !== 0) process.exit(result.status ?? 1);
const out = path.join(dir, 'result'); mkdirSync(out, { recursive: true });
for (const f of git('-C', spec.worktree, 'ls-files', '-m', '-o', '--exclude-standard').split('\n').filter(Boolean)) {
  if (!existsSync(path.join(spec.worktree, f))) continue;
  const dest = path.join(out, 'files', f); mkdirSync(path.dirname(dest), { recursive: true }); cpSync(path.join(spec.worktree, f), dest);
}
writeFileSync(path.join(out, 'deleted.txt'), git('-C', spec.worktree, 'ls-files', '-d'));
cpSync(path.join(spec.worktree, '.alba/order/last.txt'), path.join(out, 'last.txt'));
