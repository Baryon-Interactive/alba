import { parseStreamLog } from './stream.ts';
import { generic } from './generic.ts';
import type { WorkerAdapter } from './types.ts';
export const grok: WorkerAdapter = {
  ...generic, id: 'grok-cli', structured: true,
  usage(text, cut) {
    const log = parseStreamLog(text, { cut });
    if (log.tokens === undefined && log.costUsd === undefined) return undefined;
    return { source: 'grok-end', total_tokens: log.tokens, input_tokens: log.usage?.input, output_tokens: log.usage?.output, cached_tokens: log.usage?.cached, turns: log.turns, cost_usd: log.costUsd };
  },
  prepare(args, c) {
    if (!args.includes('--output-format')) args.splice(Math.max(0, args.length - 1), 0, '--output-format', 'streaming-json');
    return { args, env: c.env, envUnset: c.envUnset };
  },
};
