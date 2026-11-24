import type { ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import { chooseReviewerFromPool } from '../review/independent.ts';
import { effectiveRoles, resolveRole, type ResolvedRole } from '../roles/config.ts';
import type { Choice } from '../routing/choose.ts';
import { routingOf } from '../routing/classify.ts';
import type { RunContext } from '../run/launch.ts';
import { ownerOf } from '../usage/spend.ts';
import type { WorkerConfig, WorkersFile } from '../workers/config.ts';

export function consultEnabledForOrder(project: Pick<ProjectConfig, 'consult' | 'kinds'>, doc: OrderDoc): boolean {
  if (!project.consult?.enabled) return false;
  if (project.consult.kinds?.length) {
    const kind = routingOf(project as ProjectConfig, doc).kind || doc.order.kind;
    return project.consult.kinds.includes(kind);
  }
  return true;
}

export function resolveConsultRole(project: ProjectConfig, workers?: WorkersFile): ResolvedRole {
  const roles = effectiveRoles(project, workers);
  const wanted = project.consult?.role ?? 'consultant';
  if (Object.hasOwn(roles, wanted)) return resolveRole(roles, { role: wanted, kind: 'review' });
  if (Object.hasOwn(roles, 'verifier')) return resolveRole(roles, { role: 'verifier', kind: 'review' });
  return { id: wanted, source: 'default', definition: { sources: {} } };
}

export function chooseConsultant(
  ctx: Pick<RunContext, 'project' | 'orders' | 'workers' | 'probes'>,
  runningWorkerId: string,
): { worker?: WorkerConfig; role: ResolvedRole; choice?: Choice; reason?: string } {
  const role = resolveConsultRole(ctx.project, ctx.workers);
  const running = ownerOf(ctx.workers.workers, runningWorkerId);
  if (!running) {
    return { role, reason: `Running worker "${runningWorkerId}" cannot be resolved.` };
  }
  const runningFamily = running.model_family?.trim();
  if (!runningFamily) {
    return { role, reason: `Set model_family on ${running.id} to allow consulting another model.` };
  }
  const { choice, worker } = chooseReviewerFromPool(ctx, role, w => {
    if (w.config.id === running.id) return false;
    const fam = w.config.model_family?.trim();
    if (!fam) return false;
    return fam.toLowerCase() !== runningFamily.toLowerCase();
  });
  if (!worker) {
    return { role, choice, reason: `No eligible consultant outside model_family ${runningFamily}: ${choice.why}` };
  }
  return { worker, role, choice };
}
