import { readFileSync } from 'node:fs';
import { fail } from '../i18n.ts';
import type { ResolvedRole } from './config.ts';
export { mountRole } from '../workers/adapters/index.ts';
export type { RoleMount } from '../workers/adapters/index.ts';

/** Rules are intentionally read on every launch, including resumed and handed-over conversations. */
export function roleRules(role: ResolvedRole): string | undefined {
  const file = role.definition?.rules;
  if (!file) return undefined;
  try { return readFileSync(file, 'utf8'); }
  catch { return fail('{file}: roles.{role}.rules: cannot read Markdown rules file.', { file, role: role.id! }); }
}
export const withRoleRules = (prompt: string, rules: string | undefined): string => rules === undefined ? prompt : `## Role rules\n\n${rules.trim()}\n\n${prompt}`;
