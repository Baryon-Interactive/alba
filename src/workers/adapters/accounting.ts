import type { RunUsage } from '../../api/types.ts';
/** Inclusive/exclusive token conventions belong to the protocols that emitted them. */
export function usageAccounting(source: RunUsage['source']): { inputIncludesCache: boolean; reasoningInOutput: boolean } {
  return { inputIncludesCache: !['opencode-json', 'claude-json', 'grok-end'].includes(source), reasoningInOutput: source !== 'opencode-json' };
}
