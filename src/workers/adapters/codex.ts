import { generic } from './generic.ts';
import type { WorkerAdapter } from './types.ts';
export const codex: WorkerAdapter = {
  verifierArgs(worker, cwd, prompt, lastFile, mcpServers) {
    const model = worker.model ?? worker.launch?.model;
    return ['exec', '-C', cwd, '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-c', 'features.apps=false', '-c', 'features.plugins=false', ...mcpServers.flatMap(name => ['-c', `mcp_servers.${JSON.stringify(name)}.enabled=false`]), '--json', '--output-last-message', lastFile, ...(model ? ['--model', model] : []), prompt];
  },
  verifierServers(program, cwd, run) {
    const servers: unknown = JSON.parse(run([program, '-C', cwd, 'mcp', 'list', '--json']));
    if (!Array.isArray(servers) || servers.some(s => !s || typeof s.name !== 'string' || !s.name)) throw new Error('Cannot determine configured MCP servers; refusing an unrestricted verifier.');
    return servers.map(s => s.name);
  },
  ...generic, id: 'codex-cli', structured: true,
  prepare(args, c) {
    // Where the template says (a wrapper passes them on to codex), else right after "exec"; the config refuses a template with neither.
    const at = args.indexOf('{engine_flags}');
    if (at >= 0) args.splice(at, 1, ...(args.includes('--json') ? [] : ['--json']));
    else if (!args.includes('--json')) args.splice(Math.max(1, args.indexOf('exec') + 1), 0, '--json');
    return { args, env: c.env, envUnset: c.envUnset };
  },
  usage(text) {
    const match = [...text.matchAll(/^tokens used(?::[ \t]*|[ \t]*\r?\n[ \t]*)([\d,]+)[ \t]*$/gm)].at(-1);
    const total = match ? Number(match[1].replace(/,/g, '')) : NaN;
    return Number.isFinite(total) ? { source: 'codex-log', total_tokens: total } : undefined;
  },
};
