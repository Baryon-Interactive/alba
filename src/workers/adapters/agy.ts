import path from 'node:path';
import { t } from '../../i18n.ts';
import { agyFailureKind, agyLine } from './agy-protocol.ts';
import { writeAgyReadOnlyAgent } from './agy-workspace.ts';
import { generic } from './generic.ts';
import type { WorkerAdapter } from './types.ts';

/**
 * The Antigravity CLI, run directly (official binary, its own Google sign-in; no OpenCode, gateway or other wrapper):
 * `agy -p "<prompt>" --output-format stream-json --dangerously-skip-permissions --print-timeout 8h --model <id> [--conversation <id>]`.
 * agy parses flags Go-style, so every flag goes before any bare argument; `-p` takes the prompt as its value.
 */
export const agy: WorkerAdapter = {
  ...generic, id: 'agy-cli', structured: true, nativeResume: true,
  /**
   * Read-only: a fresh custom agent in `<state_dir>/agy-read-only` (added with `--add-dir`; agy also finds agents there) with only
   * `read_file` and Alba's read-only search server for this worktree, and a session `--settings` file that denies commands, file
   * writes and web access. Never `--dangerously-skip-permissions`: headless agy refuses whatever would ask for approval.
   * The run stays in the worktree, so the worktree checks before and after it see exactly what agy saw.
   */
  verifierArgs(worker, cwd, prompt, _lastFile, _mcpServers, resume, stateDir) {
    if (!stateDir) throw new Error('The agy read-only launch needs the project state folder.');
    const agent = writeAgyReadOnlyAgent(stateDir, [cwd]);
    const model = worker.model ?? worker.launch?.model;
    const slash = (p: string) => path.resolve(p).replace(/\\/g, '/');
    // Go-style flags: all before -p, whose value is the prompt.
    return ['--output-format', 'stream-json', '--agent', agent.name, '--settings', slash(agent.settings), '--disable-slash-commands', '--print-timeout', '8h',
      ...(model ? ['--model', model] : []), '--add-dir', slash(agent.folder), ...(resume ? ['--conversation', resume] : []), '-p', prompt];
  },
  verifierLocalOnly: true,
  prepare(args, c) {
    const has = (...flags: string[]) => args.some(a => flags.includes(a) || flags.some(f => a.startsWith(`${f}=`)));
    const set = (flag: string, value: string) => {
      const i = args.findIndex(a => a === flag || a.startsWith(`${flag}=`));
      if (i >= 0) args.splice(i, args[i] === flag ? 2 : 1, flag, value); else args.push(flag, value);
    };
    // Appended, not put first: the template's first arguments may belong to a wrapper that starts agy.
    if (!has('-p', '--print', '--prompt')) args.push('-p', `Read the UTF-8 file ${c.promptFile} in full and follow it exactly.`);
    set('--output-format', 'stream-json');
    if (!has('--dangerously-skip-permissions')) args.push('--dangerously-skip-permissions');
    // agy's own default is to wait for ever; a run that hangs is ended by the tool's run limits anyway, this is the engine's own bound.
    if (!has('--print-timeout')) args.push('--print-timeout', '8h');
    const model = c.worker.model ?? c.worker.launch?.model;
    if (model) set('--model', model);
    if (c.resume) set('--conversation', c.resume);
    // The prompt file lives in the state folder, outside the worktree (the workspace agy opens): add its folder.
    const promptDir = path.dirname(c.promptFile).replace(/\\/g, '/');
    if (!args.some((a, i) => args[i - 1] === '--add-dir' && a.replace(/\\/g, '/') === promptDir)) args.push('--add-dir', promptDir);
    return { args, env: c.env, envUnset: c.envUnset };
  },
  usage(text, cut) {
    let found = false, input = 0, output = 0, cached = 0, thinking = 0, total = 0, turns = 0;
    let result: { input: number; output: number; cached: number; thinking: number; total: number; turns?: number } | undefined;
    for (const line of text.split(/\r?\n/).slice(cut ? 1 : 0)) {
      const e = agyLine(line);
      if (e?.kind === 'step' && e.step.usage && e.step.state === 'DONE') {
        const u = e.step.usage;
        found = true; turns++;
        input += u.input_tokens ?? 0; output += u.output_tokens ?? 0; cached += u.cache_read_tokens ?? 0; thinking += u.thinking_tokens ?? 0;
        total += u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      }
      if (e?.kind === 'result' && e.result.usage) {
        const u = e.result.usage;
        result = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: u.cache_read_tokens ?? 0, thinking: u.thinking_tokens ?? 0, total: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0), turns: e.result.turns };
      }
    }
    // The result's usage is the sum of the run's steps; a cut log has only some of the steps, so the result wins when present.
    if (result) return { source: 'agy-json', total_tokens: result.total, input_tokens: result.input, output_tokens: result.output, cached_tokens: result.cached, reasoning_tokens: result.thinking, turns: result.turns ?? turns };
    if (!found) return undefined;
    return { source: 'agy-json', total_tokens: total, input_tokens: input, output_tokens: output, cached_tokens: cached, reasoning_tokens: thinking, turns };
  },
  failure(text, worker) {
    const kind = agyFailureKind(text);
    const model = worker?.model ?? worker?.launch?.model ?? '';
    switch (kind) {
      case 'region': return { kind, retry: true, why: t('agy: Gemini refused the location of this machine (region block)'), summary: t('agy: Gemini says the user location is not supported; the proxy exit node is probably in a region Gemini does not serve'), question: t('Switch the proxy exit node to a region Gemini serves (US, JP, SG), then queue the order again?') };
      case 'auth': return { kind, why: t('agy is not signed in'), summary: t('agy is not signed in on this machine'), question: t('Sign agy in (run agy once in a terminal and finish the Google sign-in), then queue the order again?') };
      case 'model': return { kind, why: t('agy does not know the model {model}', { model }), summary: t('agy does not know the model {model}', { model }), question: t('Set the worker\'s model to one that "agy models" lists, then queue the order again?') };
      case 'quota': return { kind, limit: true, why: t('agy: the account\'s quota is used up'), summary: t('agy: the account\'s quota is used up; work already committed is kept'), question: t('Wait for the agy quota to reset, or give the order to another worker?') };
      default: return undefined;
    }
  },
};
