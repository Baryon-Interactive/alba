import type { EngineModule } from './types.ts';
import { suggestion } from '../capabilities.ts';

/** Both editor modules emit a version per line followed by an explicit completion marker. */
export const parseEditor: EngineModule['parse'] = output => {
  const lines = output.trim().split(/\r?\n/);
  if (!lines.includes('end')) throw new Error('Incomplete editor scan.');
  return { versions: [...new Set(lines.filter(l => /^\d+(?:\.\d+)+/.test(l.trim())).map(l => l.trim()))].sort(), features: {} };
};
export const editorSuggestions = (name: string): EngineModule['suggest'] => (_os, result) => result.error ? { roles: [], missing: [] }
  : result.versions.length ? { roles: [suggestion('package', '{engine} {version} editor is installed.', { engine: name, version: result.versions.at(-1)! })], missing: [] }
    : { roles: [], missing: [{ what: `${name} editor`, for: 'package' }] };
