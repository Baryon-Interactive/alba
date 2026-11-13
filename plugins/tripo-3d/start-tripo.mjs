// Starts the Tripo Studio MCP server (the MIT package tripo-studio-plugin) on this process's stdio.
//   node start-tripo.mjs --server <path to its mcp/bootstrap.mjs, or ""> --package <npm spec> [--check]
// With --server: that local copy runs in this process (for example the Codex plugin cache). Without: the npm package through npx.
// The member's Tripo Studio session lives in the plugin's own data folder (%LOCALAPPDATA%\TripoStudioPlugin on Windows); nothing
// here reads or writes it. --check only says whether the server can be started, and exits 0 or 1.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { arg } from './lib/mcp.mjs';

const server = arg('server');
const pkg = arg('package', 'tripo-studio-plugin@0.3.13');

/** npx as `node npx-cli.js` (no shell: on Windows `npx` is a .cmd file), or plain `npx` elsewhere. */
function npx() {
  const dir = path.dirname(process.execPath);
  for (const cli of [path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')]) if (existsSync(cli)) return [process.execPath, [cli]];
  return process.platform === 'win32' ? undefined : ['npx', []];
}

if (process.argv.includes('--check')) {
  if (server) {
    if (!existsSync(server)) { console.error(`tripo-3d: the server ${server} (setting server) does not exist`); process.exit(1); }
    console.log(`tripo-3d: local server ${server}`);
    process.exit(0);
  }
  const found = npx();
  if (!found) { console.error('tripo-3d: npx was not found next to node; set the setting server to a local mcp/bootstrap.mjs'); process.exit(1); }
  console.log(`tripo-3d: ${pkg} through npx`);
  process.exit(0);
}

if (server) {
  if (!existsSync(server)) { console.error(`tripo-3d: the server ${server} (setting server) does not exist`); process.exit(1); }
  await import(pathToFileURL(server).href);
} else {
  const found = npx();
  if (!found) { console.error('tripo-3d: npx was not found next to node; set the setting server to a local mcp/bootstrap.mjs'); process.exit(1); }
  const child = spawn(found[0], [...found[1], '--yes', '--ignore-scripts', `--package=${pkg}`, 'tripo-studio'], { stdio: 'inherit', windowsHide: true });
  child.on('exit', code => process.exit(code ?? 1));
  child.on('error', e => { console.error(`tripo-3d: ${e.message}`); process.exit(1); });
}
