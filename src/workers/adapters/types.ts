import type { WorkerConfig } from '../config.ts';
import type { SelectedSkill } from '../../skills/registry.ts';
import type { RunUsage } from '../../api/types.ts';
export interface LaunchContext { remote?: boolean; worker: WorkerConfig; stateDir: string; skills: SelectedSkill[]; resume?: string; env: Record<string, string>; envUnset: string[]; promptFile: string; lastFile: string }
export interface WorkerAdapter {
  id: string;
  structured: boolean;
  nativeResume: boolean;
  finalMessagePrompt?(worker: WorkerConfig, lastFile: string): string;
  prepare(args: string[], context: LaunchContext): { args: string[]; env: Record<string, string>; envUnset: string[] };
  verifierArgs?(worker: WorkerConfig, cwd: string, prompt: string, lastFile: string, mcpServers: string[]): string[];
  verifierEnvironment?(stateDir: string, workerId: string, env: Record<string, string>, envUnset: string[]): { env: Record<string, string>; envUnset: string[] };
  verifierServers?(program: string, cwd: string, run: (command: string[]) => string): string[];
  usage(text: string, cut?: boolean): RunUsage | undefined;
}
