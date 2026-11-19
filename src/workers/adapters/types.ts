import type { WorkerConfig } from '../config.ts';
import type { SelectedSkill } from '../../skills/registry.ts';
import type { RunUsage } from '../../api/types.ts';
export interface LaunchContext { remote?: boolean; worker: WorkerConfig; stateDir: string; skills: SelectedSkill[]; resume?: string; env: Record<string, string>; envUnset: string[]; promptFile: string; lastFile: string; cwd?: string; inboxHook?: string; program?: string; extraArgs?: string[] }
/**
 * Why a run could not work at all, as the engine says it (signed out, region, unknown model, quota used up). `retry`: it may go away
 * by itself, so the run is resumed like after a transient error until the resumes run out; `limit`: a used-up quota (handed over on
 * `on_limit: rotate`). Otherwise the order is blocked with the question for a person.
 */
export interface EngineFailure { kind: string; why: string; summary: string; question: string; retry?: boolean; limit?: boolean }
export interface WorkerAdapter {
  id: string;
  structured: boolean;
  nativeResume: boolean;
  finalMessagePrompt?(worker: WorkerConfig, lastFile: string): string;
  prepare(args: string[], context: LaunchContext): { program?: string; args: string[]; env: Record<string, string>; envUnset: string[] };
  verifierArgs?(worker: WorkerConfig, cwd: string, prompt: string, lastFile: string, mcpServers: string[]): string[];
  verifierEnvironment?(stateDir: string, workerId: string, env: Record<string, string>, envUnset: string[]): { env: Record<string, string>; envUnset: string[] };
  verifierServers?(program: string, cwd: string, run: (command: string[]) => string): string[];
  usage(text: string, cut?: boolean): RunUsage | undefined;
  /** An engine-specific reason the run failed, read from the error text at its end (stderr and error events only, never the agent's own output). */
  failure?(errorText: string, worker?: WorkerConfig): EngineFailure | undefined;
}
