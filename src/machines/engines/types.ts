import type { Machine } from '../config.ts';
import type { Suggestions } from '../capabilities.ts';
import type { InstallPlan, PrepareInstallOptions } from '../install.ts';

/** Engine-specific values stay inside this result, never in the generic capability fields. */
export interface EngineResult {
  versions: string[];
  features: Record<string, string[]>;
  unsupported?: string[];
  error?: string;
}
export interface EngineModule {
  id: string;
  command(os: Machine['os']): string[];
  parse(output: string, os: Machine['os']): EngineResult;
  suggest(os: Machine['os'], result: EngineResult): Suggestions;
  installItems?: string[];
  installPlan?(machine: Machine, item: string, opts: Partial<PrepareInstallOptions>): InstallPlan;
  prepareInstall?(machine: Machine, item: string, opts: PrepareInstallOptions): Promise<InstallPlan>;
}
