import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrderDoc } from '../orders/model.ts';
import { verifierArgs } from '../review/independent.ts';
import type { RunContext } from '../run/launch.ts';
import { excludeLocally } from '../skills/mount.ts';
import type { Price } from '../usage/usage.ts';
import { workerAdapter } from '../workers/adapters/index.ts';
import type { WorkerConfig } from '../workers/config.ts';
import { chooseConsultant, consultEnabledForOrder } from './choose.ts';
import { consultsFileOf } from './config.ts';

export const CONSULT_ENV = 'ALBA_CONSULT';
export const CONSULT_TOKEN_ENV = 'ALBA_CONSULT_TOKEN';

export interface ConsultSpec {
  version: 1;
  project: string;
  state_dir: string;
  state_backend: 'sqlite' | 'files';
  tag: string;
  title: string;
  run: string;
  run_key: string;
  worktree: string;
  consultant: string;
  engine: string;
  model: string;
  model_family: string;
  price?: Price;
  command: {
    program: string;
    args: string[];
    env: Record<string, string>;
    env_unset: string[];
  };
  limits: {
    max_per_run: number;
    timeout_minutes: number;
    review_runs_per_day?: number;
  };
  records_file: string;
  runtime_module: string;
  token: string;
}

export interface PreparedConsult {
  specPath: string;
  worktree: string;
  spec: ConsultSpec;
}

const slash = (p: string) => p.replace(/\\/g, '/');

export function resolveConsultRuntimeModule(): string {
  const jsRuntime = fileURLToPath(new URL('./runtime.js', import.meta.url));
  const tsRuntime = fileURLToPath(new URL('./runtime.ts', import.meta.url));
  return existsSync(jsRuntime) ? jsRuntime : tsRuntime;
}

export function consultSpecPath(stateDir: string, tag: string, runId: string): string {
  return slash(path.join(stateDir, 'runs', `${tag}-${runId}.consult.json`));
}

export function installConsultHelper(worktree: string): string {
  const binDir = path.join(worktree, '.alba', 'bin');
  const to = path.join(binDir, 'consult.mjs');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(fileURLToPath(new URL('./consult-helper.mjs', import.meta.url)), to);
  writeFileSync(path.join(binDir, 'consult-origin.json'), JSON.stringify({ runtime_module: resolveConsultRuntimeModule() }) + '\n', 'utf8');
  excludeLocally(worktree, ['.alba/bin/']);
  return to;
}

export function writeConsultSpec(specPath: string, spec: ConsultSpec): void {
  mkdirSync(path.dirname(specPath), { recursive: true });
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function resolveConsultantEnv(rawEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [
    k,
    v.replace(/\{skill_names\}|\{skill_allow\}/g, '').replace(/\$\{(\w+)\}/g, (m, name: string) => process.env[name] ?? m),
  ]));
}

export function buildConsultSpec(input: {
  ctx: Pick<RunContext, 'project' | 'probes'>;
  doc: OrderDoc;
  runId: string;
  worktree: string;
  consultant: WorkerConfig;
  token?: string;
}): ConsultSpec {
  const { ctx, doc, runId, worktree, consultant } = input;
  const { project, probes } = ctx;
  const cfg = project.consult!;
  const named = resolveConsultantEnv(consultant.launch!.env);
  const adapter = workerAdapter(consultant.engine);
  const environment = adapter.verifierEnvironment?.(project.state_dir, consultant.id, named, consultant.launch!.env_unset)
    ?? { env: named, envUnset: consultant.launch!.env_unset };
  const mcpServers = adapter.verifierServers?.(
    consultant.launch!.program,
    worktree,
    command => probes.runCommand(command, 30, { cwd: worktree, ...environment }),
  ) ?? [];
  const args = verifierArgs(consultant, worktree, '{prompt}', '{last_file}', mcpServers);
  const model = consultant.model ?? consultant.launch?.model ?? '';
  return {
    version: 1,
    project: project.id,
    state_dir: project.state_dir,
    state_backend: project.state.backend,
    tag: doc.order.tag,
    title: doc.order.title,
    run: runId,
    run_key: `${doc.order.tag}:${runId}`,
    worktree,
    consultant: consultant.id,
    engine: consultant.engine,
    model,
    model_family: consultant.model_family?.trim() ?? '',
    ...(consultant.price ? { price: consultant.price } : {}),
    command: {
      program: consultant.launch!.program,
      args,
      env: environment.env,
      env_unset: environment.envUnset,
    },
    limits: {
      max_per_run: cfg.max_per_run,
      timeout_minutes: cfg.timeout_minutes,
      ...(project.producer.budgets.review_runs_per_day !== undefined
        ? { review_runs_per_day: project.producer.budgets.review_runs_per_day }
        : {}),
    },
    records_file: slash(consultsFileOf(project.state_dir, doc.order.tag, runId)),
    runtime_module: resolveConsultRuntimeModule(),
    token: input.token ?? randomBytes(24).toString('hex'),
  };
}

export function prepareConsultRun(
  ctx: Pick<RunContext, 'project' | 'orders' | 'workers' | 'probes'>,
  doc: OrderDoc,
  runningWorker: WorkerConfig,
  runId: string,
  worktree: string,
  runsDir: string,
  warnings: string[],
): PreparedConsult | undefined {
  if (!consultEnabledForOrder(ctx.project, doc)) return undefined;
  const chosen = chooseConsultant(ctx, runningWorker.id);
  if (!chosen.worker) {
    if (chosen.reason) warnings.push(`consult unavailable: ${chosen.reason}`);
    return undefined;
  }
  try {
    const spec = buildConsultSpec({ ctx, doc, runId, worktree, consultant: chosen.worker });
    const specPath = slash(path.join(runsDir, `${doc.order.tag}-${runId}.consult.json`));
    return { specPath, worktree, spec };
  } catch (error) {
    warnings.push(`consult unavailable: ${(error as Error).message}`);
    return undefined;
  }
}

export function commitConsultRun(prepared: PreparedConsult): void {
  writeConsultSpec(prepared.specPath, prepared.spec);
  installConsultHelper(prepared.worktree);
}

export function consultPrompt(spec: Pick<ConsultSpec, 'consultant' | 'model' | 'limits'>): string {
  const who = spec.model ? `${spec.consultant} (${spec.model})` : spec.consultant;
  return [
    '',
    '## Consulting another model',
    '',
    `When you are stuck after two attempts, face a design choice with lasting impact, or hit something your own model cannot read, ask \`${who}\` read-only in this worktree:`,
    '',
    '    node .alba/bin/consult.mjs --question "<question>" [--file <path>]... [--json]',
    '',
    `Limit: at most ${spec.limits.max_per_run} consult(s) in this run (timeout ${spec.limits.timeout_minutes} min each). The answer is advice, not an order: verify every claim against the code and tests yourself.`,
    '',
  ].join('\n');
}
