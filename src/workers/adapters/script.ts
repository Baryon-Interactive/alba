import { generic } from './generic.ts';
import type { WorkerAdapter } from './types.ts';
/** Local scripts read the prompt and write an Alba report to the supplied file. */
export const script: WorkerAdapter = {
  ...generic, id: 'script',
  prepare: (args, c) => ({ args, env: { ...c.env, ALBA_PROMPT_FILE: c.promptFile, ALBA_LAST_FILE: c.lastFile }, envUnset: c.envUnset.filter(k => !['ALBA_PROMPT_FILE', 'ALBA_LAST_FILE'].includes(k)) }),
};
