import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hookCommand } from '../../run/inbox.ts';
import { liveMessagesEnabled } from '../config.ts';
import { UsageFold, totalUsage } from './usage-fold.ts';
import { claudeEnvironment } from './claude-protocol.ts';
import { generic } from './generic.ts';
import type { WorkerAdapter } from './types.ts';
export const claude: WorkerAdapter = {
  verifierArgs(worker, _cwd, prompt, _lastFile, _mcpServers) {
    const model = worker.model ?? worker.launch?.model;
    return ['-p', prompt, '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--disallowedTools', 'Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Task,Skill', ...(model ? ['--model', model] : [])];
  },
  verifierEnvironment: (stateDir, workerId, env, envUnset) => claudeEnvironment(stateDir, workerId, env, envUnset, []),
  ...generic, id: 'claude-cli', structured: true, nativeResume: true,
  // A background command that ends after the final message starts one more turn, and that turn's message (without the block) becomes the last one.
  finalMessagePrompt: () => '\nBefore your final message, wait for or stop every background command you started: one that ends after it makes you answer once more, and that answer, not your report, becomes your last message. Put the report block in the final message itself, not only in a file.\n',
  usage(text, cut) {
    const fold = new UsageFold();
    for (const line of text.split(/\r?\n/).slice(cut ? 1 : 0)) {
      try { const event = JSON.parse(line); if (event.type === 'assistant' || event.type === 'result') fold.event(event, ''); } catch { /* partial or plain line */ }
    }
    return totalUsage(fold.turns);
  },
  prepare(args, c) {
    const add = (...values: string[]) => args.splice(Math.max(0, args.length - 1), 0, ...values);
    for (const flag of ['-p', '--verbose']) if (!args.includes(flag)) add(flag);
    const set = (flag: string, value: string) => { const i = args.indexOf(flag); if (i >= 0) args.splice(i, 2, flag, value); else add(flag, value); };
    set('--output-format', 'stream-json'); set('--permission-mode', 'bypassPermissions');
    const model = c.worker.model ?? c.worker.launch?.model;
    if (model) set('--model', model);
    if (c.resume) set('--resume', c.resume);
    if (!c.remote && c.inboxHook && liveMessagesEnabled(c.worker)) {
      const hookPath = path.resolve(c.inboxHook);
      const settingsFile = c.promptFile.endsWith('.prompt.md')
        ? c.promptFile.slice(0, -'.prompt.md'.length) + '.claude-settings.json'
        : path.join(c.stateDir, 'runs', `claude-hooks-${randomUUID()}.json`);
      mkdirSync(path.dirname(settingsFile), { recursive: true });
      const settings = {
        hooks: {
          PostToolUse: [{ hooks: [{ type: 'command', command: hookCommand(hookPath, 'claude', 'post-tool-use'), timeout: 10 }] }],
          Stop: [{ hooks: [{ type: 'command', command: hookCommand(hookPath, 'claude', 'stop'), timeout: 10 }] }],
        },
      };
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      set('--settings', settingsFile.replace(/\\/g, '/'));
    }
    return { args, ...(c.remote ? { env: c.env, envUnset: c.envUnset } : claudeEnvironment(c.stateDir, c.worker.id, c.env, c.envUnset, c.skills)) };
  },
};
