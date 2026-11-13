import type { ProjectConfig } from '../config.ts';
import { DesignError } from './model.ts';
import { relativePath } from './files.ts';

export function validateMeasure(value: unknown, project: ProjectConfig): void {
  if (value === undefined || value === null) return;
  const fail = (reason: string): never => { throw new DesignError(`measure: ${reason}`); };
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !v.includes('\0');
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
  const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!obj(value) || Object.keys(value).some(k => !['argv', 'cwd', 'timeout_minutes', 'uses', 'kind', 'value', 'when'].includes(k))) fail('unknown fields or invalid object.');
  const m = value as Record<string, unknown>;
  if (!Array.isArray(m.argv) || !text(m.argv[0]) || m.argv.some(v => typeof v !== 'string' || v.includes('\0'))) fail('argv must be a nonempty list of strings.');
  if (!positive(m.timeout_minutes)) fail('timeout_minutes must be positive and finite.');
  if (m.cwd !== undefined && (typeof m.cwd !== 'string' || (m.cwd !== '.' && !relativePath(m.cwd)))) fail('cwd must stay inside the project.');
  if (m.uses !== undefined && (!strings(m.uses) || m.uses.some(n => !project.resources?.[n]))) fail('uses must name declared resources.');
  if (m.kind !== undefined && (!text(m.kind) || !Object.hasOwn(project.dispatch.caps, m.kind))) fail('kind must name a configured cap.');
  if (!obj(m.when) || Object.keys(m.when).some(k => !['after_merge_paths', 'every_hours'].includes(k))) fail('when needs scheduling fields.');
  const when = m.when as Record<string, unknown>;
  if (when.every_hours !== undefined && !positive(when.every_hours)) fail('every_hours must be positive and finite.');
  if (when.after_merge_paths !== undefined && (!strings(when.after_merge_paths) || when.after_merge_paths.some(g => !relativePath(g)))) fail('after_merge_paths must be project-relative globs.');
  if (!obj(m.value)) fail('value needs json_pointer or regex/group.');
  const v = m.value as Record<string, unknown>;
  if ('json_pointer' in v) {
    if (Object.keys(v).some(k => !['json_pointer', 'file'].includes(k)) || typeof v.json_pointer !== 'string' || (v.json_pointer !== '' && !v.json_pointer.startsWith('/')) || /~(?:[^01]|$)/.test(v.json_pointer)) fail('invalid JSON pointer.');
    if (v.file !== undefined && (typeof v.file !== 'string' || !relativePath(v.file))) fail('value.file must stay inside cwd.');
  } else {
    if (Object.keys(v).some(k => !['regex', 'group'].includes(k)) || !text(v.regex) || !Number.isSafeInteger(v.group) || (v.group as number) < 0) fail('value needs regex and a nonnegative group.');
    try { new RegExp(v.regex as string); } catch { fail('invalid regex.'); }
  }
}
