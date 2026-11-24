import { readFileSync } from 'node:fs';
import { worktreeFingerprint } from '../workers/adapters/read-only.mjs';
export { worktreeFingerprint };
import type { orderPhases } from '../orders/phases.ts';
import { t } from '../i18n.ts';
import { fenceUntrusted } from './fence.ts';

export function phasePrompt(phases: ReturnType<typeof orderPhases>): string {
  if (!phases) return '';
  const latest = phases.list.slice(0, phases.index).map(phases.planOf).findLast(plan => plan !== undefined);
  const sections = latest ? [
    `## Plan from phase ${latest.run.phase} (${latest.run.worker}, ${latest.run.model ?? 'default'})`,
    fenceUntrusted('phase plan', latest.text, 24 * 1024),
    'The plan is guidance. Deviate when the code says otherwise and say why in your report.',
  ] : [];
  if (phases.current.mode === 'read-only') sections.push(`This is the read-only planning phase "${phases.current.id}". Inspect the order and its worktree. Leave all files untouched. End with a normal report block in your final message, with a one-line summary and the Markdown plan in the JSON "plan" field (at most 24 KiB).`);
  return '\n' + sections.join('\n\n') + '\n';
}

export function readOnlyChange(run: { cwd?: string; worktree_fingerprint?: string; remote_phase_check?: string }): string | undefined {
  if (run.remote_phase_check) {
    try {
      if (readFileSync(run.remote_phase_check, 'utf8') !== 'unchanged') return t('The worktree changed during a read-only phase.');
    } catch { return t('Could not verify the remote read-only worktree.'); }
  }
  if (!run.worktree_fingerprint) return;
  try { if (run.cwd && run.worktree_fingerprint === worktreeFingerprint(run.cwd)) return; } catch { /* a missing checkout cannot pass */ }
  return t('The worktree changed during a read-only phase.');
}
