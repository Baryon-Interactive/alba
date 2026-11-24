import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import type { orderPhases } from '../orders/phases.ts';
import { fenceUntrusted } from './fence.ts';

export function phasePrompt(phases: ReturnType<typeof orderPhases>): string {
  if (!phases) return '';
  const sections = phases.list.slice(0, phases.index).flatMap(phase => {
    const plan = phases.planOf(phase);
    return plan ? [`## Plan from phase ${phase.id} (${plan.run.worker}, ${plan.run.model ?? 'default'})`,
      fenceUntrusted('phase plan', plan.text, 24 * 1024)] : [];
  });
  if (sections.length) sections.push('The plan is guidance. Deviate when the code says otherwise and say why in your report.');
  if (phases.current.mode === 'read-only') sections.push(`This is the read-only planning phase "${phases.current.id}". Inspect the order and its worktree. Leave all files untouched. End with a normal report block in your final message, with a one-line summary and the Markdown plan in the JSON "plan" field (at most 24 KiB).`);
  return '\n' + sections.join('\n\n') + '\n';
}

/** Include HEAD, the index, tracked changes and untracked file contents, including a dirty starting checkout. */
export function worktreeFingerprint(cwd: string): string {
  const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd, timeout: 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const hash = createHash('sha256');
  hash.update(git('rev-parse', 'HEAD'));
  hash.update(git('ls-files', '-s', '-z'));
  hash.update(git('diff', '--no-ext-diff', '--no-textconv', '--binary'));
  for (const name of git('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean)) {
    const file = path.join(cwd, name);
    const stat = lstatSync(file);
    hash.update(JSON.stringify([name, stat.mode]));
    if (stat.isSymbolicLink()) hash.update(readlinkSync(file));
    else if (stat.isFile()) hash.update(git('hash-object', '--no-filters', '--', name));
  }
  return hash.digest('hex');
}
