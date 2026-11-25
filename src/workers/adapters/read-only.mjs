import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readlinkSync, readSync } from 'node:fs';
import path from 'node:path';

/** Feature switches of every read-only Codex run. The MCP listing must use the same ones: with plugins on, Codex also lists
 * plugin-provided servers (e.g. the desktop app's codex_app), and an `enabled=false` override for a server the run does not
 * define creates a stub entry without a transport, which makes Codex refuse to start ("invalid transport"). */
export const codexReadOnlyFeatures = ['-c', 'features.apps=false', '-c', 'features.plugins=false'];

export function codexVerifierServers(program, cwd, run) {
  const servers = JSON.parse(run([program, '-C', cwd, ...codexReadOnlyFeatures, 'mcp', 'list', '--json']));
  if (!Array.isArray(servers) || servers.some(s => !s || typeof s.name !== 'string' || !s.name)) throw new Error('Cannot determine configured MCP servers; refusing an unrestricted verifier.');
  return servers.map(s => s.name);
}

export const disableServers = names => names.flatMap(name => ['-c', `mcp_servers.${JSON.stringify(name)}.enabled=false`]);

/** Include HEAD, the index, tracked changes and untracked file contents, including a dirty starting checkout. */
export function worktreeFingerprint(cwd) {
  // Porcelain v2 carries HEAD and each changed path's index object id and modes.
  const status = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--no-renames', '-z', '--untracked-files=all'],
    { cwd, timeout: 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const entry of status.toString().split('\0')) {
    if (!entry || entry.startsWith('# branch.upstream ') || entry.startsWith('# branch.ab ')) continue;
    hash.update(entry).update('\0');
    // Ordinary, unmerged and untracked entries have different fixed-width prefixes.
    const name = /^(?:1 (?:\S+ ){7}|u (?:\S+ ){9}|\? )([\s\S]+)$/.exec(entry)?.[1];
    if (!name) continue;
    const file = path.join(cwd, name);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) hash.update(JSON.stringify(readlinkSync(file)));
    else if (stat?.isFile()) {
      const content = createHash('sha256');
      const fd = openSync(file, 'r');
      try {
        let bytes;
        while ((bytes = readSync(fd, buffer)) > 0) content.update(buffer.subarray(0, bytes));
      } finally { closeSync(fd); }
      hash.update(content.digest());
    }
  }
  return hash.digest('hex');
}
