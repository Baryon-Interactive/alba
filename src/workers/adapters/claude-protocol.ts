import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mountSkills } from '../../skills/mount.ts';
import type { SelectedSkill } from '../../skills/registry.ts';

/** Shared by the producer and detached Claude workers. */
export function eventText(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.result === 'string') return raw.result;
  if (typeof raw.text === 'string') return raw.text;
  const content = (raw.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.filter(b => b && typeof b === 'object' && b.type === 'text').map(b => String(b.text ?? ''));
    return parts.length ? parts.join('\n') : undefined;
  }
  return undefined;
}

export function claudeContent(event: Record<string, any>): Record<string, any>[] {
  const content = event.message?.content;
  return Array.isArray(content) ? content.filter(c => c && typeof c === 'object') : [];
}

export const toolResultText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => typeof c?.text === 'string' ? c.text : '').filter(Boolean).join('\n') : '';

/** Only explicitly named environment values and selected skills enter this worker's own Claude home. */
export function claudeEnvironment(stateDir: string, worker: string, named: Record<string, string>, unset: readonly string[], skills: readonly SelectedSkill[]) {
  const configDir = path.join(stateDir, 'workers', worker, 'claude');
  mkdirSync(configDir, { recursive: true });
  const env = Object.fromEntries(Object.entries(named).filter(([name]) => name !== 'CLAUDE_CONFIG_DIR' && !unset.includes(name)));
  writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ env }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  mountSkills(configDir, ['skills'], skills);
  const inherited = Object.keys(process.env).filter(name => /^(CLAUDE_CODE_|ANTHROPIC_)/i.test(name) && !(name in env));
  return { env: { ...env, CLAUDE_CONFIG_DIR: configDir }, envUnset: [...new Set([...unset.filter(name => name !== 'CLAUDE_CONFIG_DIR'), ...inherited])] };
}
