import type { RunUsage } from '../../api/types.ts';
import { generic } from './generic.ts';
import type { WorkerAdapter } from './types.ts';
export const opencode: WorkerAdapter = {
  ...generic, id: 'opencode', structured: true,
  usage: (text, cut) => openCodeUsage(text, cut),
  finalMessagePrompt(worker, lastFile) {
    if (worker.launch?.args.some(a => a.includes('{last_file}'))) return '';
    return `\nWhen you stop, also save your final message, ending with the report block, to the file ${lastFile} (UTF-8, create the folder if needed). The tool reads the report from that file first.\n`;
  },
  prepare(args, c) {
    if (!args.includes('--format')) args.splice(Math.max(1, args.indexOf('run') + 1), 0, '--format', 'json');
    return { args, env: c.env, envUnset: c.envUnset };
  },
};

const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const clean = (u: RunUsage): RunUsage => Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) as unknown as RunUsage;
export function openCodeUsage(text: string, cut?: boolean): RunUsage | undefined {
  let found = false, input = 0, output = 0, cached = 0, cost = 0, steps = 0, total = 0;
  for (const raw of text.split(/\r?\n/).slice(cut ? 1 : 0)) {
    const line = raw.trim();
    if (!line.startsWith('{') || !/step[-_]finish/.test(line)) continue;
    let event: { type?: unknown; part?: { type?: unknown; tokens?: unknown; cost?: unknown }; tokens?: unknown; cost?: unknown };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    // `{"type":"step_finish","part":{...}}` as the CLI prints it, or the bare part as the session store keeps it
    const part = event.part && /step[-_]finish/.test(String(event.part.type ?? event.type)) ? event.part : /step[-_]finish/.test(String(event.type)) ? event : undefined;
    const tokens = (part as { tokens?: { total?: unknown; input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } } | undefined)?.tokens;
    if (!part || !tokens) continue;
    found = true;
    steps++;
    const stepIn = num(tokens.input) ?? 0, stepOut = (num(tokens.output) ?? 0) + (num(tokens.reasoning) ?? 0), stepCached = num(tokens.cache?.read) ?? 0;
    total += num(tokens.total) ?? stepIn + stepOut + stepCached;
    input += stepIn;
    output += stepOut;
    cached += stepCached;
    cost += num((part as { cost?: unknown }).cost) ?? 0;
  }
  if (!found) return undefined;
  return clean({ source: 'opencode-json', total_tokens: total, input_tokens: input, output_tokens: output, cached_tokens: cached, turns: steps, cost_usd: cost > 0 ? cost : undefined });
}

