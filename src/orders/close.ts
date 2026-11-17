import { execFileSync } from 'node:child_process';
import type { ProjectConfig } from '../config.ts';
import { UserError, fail, t, withLang } from '../i18n.ts';
import { orderBaseRef } from '../review/readiness.ts';
import type { OrderDoc } from './model.ts';
import type { Orders } from './service.ts';
import { actionProblem } from './stage.ts';

export type CloseHow = 'merged-elsewhere' | 'done-by-lead';

export interface CloseOptions {
  how: CloseHow;
  commit?: string;
  note?: string;
}

function gitRead(cwd: string, args: string[]): { ok: true; out: string } | { ok: false; err: string } {
  try {
    const out = execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return { ok: false, err: String(err.stderr ?? err.message ?? '').trim().split(/\r?\n/)[0] ?? '' };
  }
}

/**
 * Closes an order as terminal merged without writing an accept file or counting a worker run:
 * either its work landed on the base branch in another commit (`merged-elsewhere`), or the lead
 * finished it by hand (`done-by-lead`). All git checks are read-only in `project.root`.
 */
export function closeOrder(project: ProjectConfig, orders: Orders, tag: string, options: CloseOptions): OrderDoc {
  if (options.how !== 'merged-elsewhere' && options.how !== 'done-by-lead') {
    fail('Close needs how: merged-elsewhere or done-by-lead.');
  }
  const doc = orders.get(tag);
  const stage = orders.stage(doc).stage;
  const openRun = doc.runs.find(r => r.ended === undefined);
  if (openRun && stage !== 'running' && stage !== 'monitoring') {
    fail('Run {run} of {tag} is still open; stop the run first before closing.', { run: openRun.id, tag: doc.order.tag });
  }
  const problem = actionProblem(stage, options.how);
  if (problem) {
    throw new UserError(t('{tag}: {problem}', { tag: doc.order.tag, problem }), `${doc.order.tag}: ${withLang('en', () => actionProblem(stage, options.how))}`);
  }

  const rawCommit = options.commit?.trim() || undefined;
  const note = options.note?.trim() || undefined;
  if (options.how === 'merged-elsewhere' && !rawCommit) {
    fail('{tag}: closing with merged-elsewhere needs a commit or ref on the base branch.', { tag: doc.order.tag });
  }
  if (options.how === 'done-by-lead' && (note?.length ?? 0) < 10) {
    fail('{tag}: closing with done-by-lead needs a note of at least 10 characters.', { tag: doc.order.tag });
  }

  let sha: string | undefined;
  if (rawCommit !== undefined) {
    if (rawCommit.startsWith('-')) {
      fail('{tag}: "{ref}" is not a valid commit or ref.', { tag: doc.order.tag, ref: rawCommit });
    }
    const baseRef = orderBaseRef(project, doc.order);
    const baseCheck = gitRead(project.root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    if (!baseCheck.ok || !baseCheck.out) {
      fail('Base ref {ref} does not exist in {root}; set "dispatch.base_ref" in the project file to the branch work starts from.', { ref: baseRef, root: project.root });
    }
    const resolved = gitRead(project.root, ['rev-parse', '--verify', `${rawCommit}^{commit}`]);
    if (!resolved.ok || !resolved.out) {
      fail('{tag}: commit or ref "{ref}" could not be resolved in {root}.', { tag: doc.order.tag, ref: rawCommit, root: project.root });
    }
    sha = resolved.out;
    const onBase = gitRead(project.root, ['merge-base', '--is-ancestor', sha, baseRef]);
    if (!onBase.ok) {
      fail('{tag}: commit {sha} is not an ancestor of {base}.', { tag: doc.order.tag, sha, base: baseRef });
    }
  }

  return orders.act(doc.order.tag, options.how, { note, commit: sha });
}
