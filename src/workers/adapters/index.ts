import { codex } from './codex.ts';
import { claude } from './claude.ts';
import { opencode } from './opencode.ts';
import { grok } from './grok.ts';
import { agy } from './agy.ts';
import { script } from './script.ts';
import { generic } from './generic.ts';
import type { WorkerAdapter } from './types.ts';
export type { WorkerAdapter, LaunchContext, EngineFailure } from './types.ts';
export const adapters: readonly WorkerAdapter[] = [codex, claude, opencode, agy, grok, script];
/** Unknown engines use an explicit launch template and plain report files. */
export const workerAdapter = (id: string): WorkerAdapter => adapters.find(a => a.id === id) ?? generic;

// Public protocol interface: dispatch and monitoring callers do not import engine modules.
export { parseStreamLog } from './stream.ts';
export { LiveFold } from './activity.ts';
export { UsageFold, tokenUsage, totalUsage } from './usage-fold.ts';
export type { Turn } from './usage-fold.ts';
export { openCommand, textSessionId } from './codex-log.ts';
export { mountRole } from './role-mount.ts';
export type { RoleMount } from './role-mount.ts';
export { parseActions, idleStretches, failedExit, codexCommandText, errorSignature, squash } from './actions.ts';
export type { Action, ParsedLog, LogFormat } from './actions.ts';
export { usageAccounting } from './accounting.ts';
export { remoteTarget, writeRemoteSpec } from './remote.ts';
