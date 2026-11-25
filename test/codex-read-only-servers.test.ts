import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexReadOnlyFeatures, codexVerifierServers, disableServers } from '../src/workers/adapters/read-only.mjs';
import { codex } from '../src/workers/adapters/codex.ts';

// A read-only Codex run (plan phase, verifier, remote read-only) switches apps and plugins off. Plugin-provided MCP servers
// such as the desktop app's codex_app only exist with plugins on; disabling one the run does not define leaves a stub
// without a transport and Codex refuses to start ("invalid transport in mcp_servers.codex_app").
test('the MCP listing for a read-only Codex run uses the same feature switches as the run', () => {
  let seen: string[] = [];
  const names = codexVerifierServers('codex', 'D:/work', command => {
    seen = command;
    const pluginsOff = command.includes('features.plugins=false');
    const all = [{ name: 'node_repl' }, { name: 'unityMCP' }, ...(pluginsOff ? [] : [{ name: 'codex_app' }, { name: 'cua_repl' }])];
    return JSON.stringify(all);
  });
  assert.deepEqual(names, ['node_repl', 'unityMCP']);
  const listAt = seen.indexOf('mcp');
  assert.ok(listAt > 0 && seen[listAt + 1] === 'list', 'lists the MCP servers');
  for (let i = 0; i < codexReadOnlyFeatures.length; i++) assert.equal(seen[seen.indexOf(codexReadOnlyFeatures[0]) + i], codexReadOnlyFeatures[i]);
  assert.ok(seen.indexOf('features.plugins=false') < listAt, 'feature switches are global flags before the subcommand');

  const args = codex.verifierArgs!({ id: 'w', engine: 'codex-cli', launch: { program: 'codex', args: [], env: {} } } as never, 'D:/work', 'Plan it', 'last.txt', names);
  for (const flag of codexReadOnlyFeatures.filter(x => x !== '-c')) assert.ok(args.includes(flag), `run carries ${flag}`);
  assert.deepEqual(args.filter(x => x.startsWith('mcp_servers.')), disableServers(names).filter(x => x !== '-c'));
  assert.ok(!args.some(x => x.includes('codex_app')), 'never disables a server the run does not define');
});
