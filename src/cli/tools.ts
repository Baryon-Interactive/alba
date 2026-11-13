import { readFileSync } from 'node:fs';
import type { ProjectConfig } from '../config.ts';
import { fail } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { createToolJob, runToolJob, toolJob, toolJobs, toolOperations, type ToolJob } from '../plugins/jobs.ts';

export interface ToolsOptions { json: boolean; order?: string; input?: string; arg?: string[]; quote?: string }

/** `--input file.json` (or `-` for stdin) and `--arg key=value` (a value that reads as JSON is taken as JSON: numbers, true, lists). */
export function toolInput(input: string | undefined, args: string[] = []): Record<string, unknown> {
  let value: unknown = {};
  if (input !== undefined) {
    const text = input === '-' ? readFileSync(0, 'utf8') : readFileSync(input, 'utf8');
    try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { fail('{file} is not JSON: {error}', { file: input, error: (e as Error).message }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('{file} must hold a JSON object (the input of the operation).', { file: input });
  }
  const out = value as Record<string, unknown>;
  for (const a of args) {
    const at = a.indexOf('=');
    if (at < 1) fail('--arg is key=value; got "{arg}".', { arg: a });
    const raw = a.slice(at + 1);
    let v: unknown = raw;
    try { v = JSON.parse(raw); } catch { /* a plain string */ }
    out[a.slice(0, at)] = v;
  }
  return out;
}

export const jobLine = (j: ToolJob): string =>
  `${j.id.padEnd(4)} ${j.status.padEnd(13)} ${j.tool}/${j.operation}${j.order ? `  ${j.order}` : ''}${j.quote?.amount !== undefined ? `  ${j.quote.amount} ${j.quote.unit}${j.quote.id ? ` (${j.quote.id}${j.quote.auto ? ', auto' : ''})` : ''}` : ''}  ${j.created}`;

function jobText(j: ToolJob): string {
  const lines = [jobLine(j), `by: ${j.by}${j.case ? `  case: ${j.case}` : ''}`, `input: ${JSON.stringify(j.input)}`, `output folder: ${j.out}`];
  if (j.waiting) lines.push(`waiting: ${j.waiting}`);
  if (j.error) lines.push(`error: ${j.error}`);
  if (j.files?.length) lines.push('files:', ...j.files.map(f => `  ${f}`));
  if (j.text) lines.push('answer:', ...j.text.split('\n').slice(0, 20).map(l => `  ${l}`));
  return lines.join('\n');
}

/** `alba tools [list] | run <tool> <operation> | resume <job> | jobs | show <job>`. Sets exit code 1 when a run does not end done or waiting. */
export async function runTools(project: ProjectConfig, orders: Orders, command: string | undefined, rest: string[], o: ToolsOptions, setExitCode: (code: number) => void = () => {}): Promise<string> {
  if (command === undefined || command === 'list') {
    const tools = toolOperations(project);
    if (o.json) return JSON.stringify(tools, null, 2);
    if (!tools.length) return 'No enabled tool has operations. Tools are turned on under "plugins.enable"; their operations are in their alba-plugin.yaml.';
    return tools.flatMap(t => [`${t.tool}@${t.version}  ${t.description}`, ...t.operations.map(op => `  ${op.name}${op.paid ? `  (paid, ${op.paid.fixed !== undefined ? `${op.paid.fixed} ` : 'priced per call in '}${op.paid.unit})` : ''}  ${op.description}\n    input: ${JSON.stringify(op.input)}`)]).join('\n');
  }
  if (command === 'jobs') {
    const jobs = toolJobs(project).filter(j => !o.order || j.order?.toLowerCase() === o.order.toLowerCase());
    if (o.json) return JSON.stringify(jobs, null, 2);
    return jobs.length ? jobs.map(jobLine).join('\n') : '(no tool jobs)';
  }
  if (command === 'show') {
    if (!rest[0]) fail('Usage: {usage}', { usage: 'alba tools show <job> [--json]' });
    const j = toolJob(project, rest[0]!);
    return o.json ? JSON.stringify(j, null, 2) : jobText(j);
  }
  const finish = (j: ToolJob): string => {
    if (!['done', 'waiting-quote', 'queued', 'running'].includes(j.status)) setExitCode(1);
    return o.json ? JSON.stringify(j, null, 2) : jobText(j);
  };
  if (command === 'run') {
    if (rest.length < 2) fail('Usage: {usage}', { usage: 'alba tools run <tool> <operation> [--order <TAG>] [--input file.json] [--arg key=value]... [--quote <C1>] [--json]' });
    const job = createToolJob(project, orders, { tool: rest[0]!, operation: rest[1]!, input: toolInput(o.input, o.arg), ...(o.order ? { order: o.order } : {}), ...(o.quote ? { quote: o.quote } : {}) });
    return finish(await runToolJob(project, orders, job.id));
  }
  if (command === 'resume') {
    if (!rest[0]) fail('Usage: {usage}', { usage: 'alba tools resume <job> [--json]' });
    return finish(await runToolJob(project, orders, toolJob(project, rest[0]!).id));
  }
  return fail('Usage: {usage}', { usage: 'alba tools [list] | run <tool> <operation> [--order <TAG>] [--input f.json] [--arg k=v]... [--quote <C1>] | resume <job> | jobs [--order <TAG>] | show <job> [--json]' });
}
