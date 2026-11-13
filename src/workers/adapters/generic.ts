import type { WorkerAdapter } from './types.ts';
export const generic: WorkerAdapter = {
  id: 'generic', structured: false, nativeResume: false,
  prepare: (args, c) => ({ args, env: c.env, envUnset: c.envUnset }),
  usage: () => undefined,
};
