import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../config.ts';
import { DesignError } from '../design/model.ts';
import { checkIntake, exportDesignDoc, getDesignDoc, importDesignDoc, intakeOutputAlbaDir, listDesignDocs, setDesignDoc } from '../design/docs.ts';
import { stableJson } from '../design/library.ts';
import { reviewIntakeSystems } from '../design/intake-review.ts';
import type { Orders } from '../orders/service.ts';
import { createOrder } from '../service/new-order.ts';

export interface IntakeCliValues { json?: boolean; out?: string; id?: string; docs?: string; tag?: string; dir?: string; accept?: string; reject?: string; drop?: string; note?: string; order?: string; status?: string }
/** Where this alba is installed (the folder with bin/, docs/, schema/), with forward slashes for prompts. */
export const albaRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..').split(path.sep).join('/');
const quote = (p: string) => /[\s"]/.test(p) ? `"${p}"` : p;
/** The command a worker runs to reach this project's alba: the same installation, the same project file, from any folder. */
export const albaCommand = (project: ProjectConfig): string => `node ${quote(`${albaRoot()}/bin/alba.mjs`)} --project ${quote(path.resolve(project.file).split(path.sep).join('/'))}`;
const template = (project: ProjectConfig): string => {
  const file = path.join(project.root, 'templates', 'intake.md');
  const fallback = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/intake.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : readFileSync(fallback, 'utf8');
};
export function runDesignDocs(project: ProjectConfig, command: string | undefined, args: string[], values: IntakeCliValues): string {
  if (command === 'list' || command === undefined) return stableJson(listDesignDocs(project));
  if (command === 'show') { if (!args[0]) throw new DesignError('Usage: alba design-docs show <id> [--version n].'); return stableJson(getDesignDoc(project, args[0], values.order ? Number(values.order) : undefined)); }
  if (command === 'import') { if (!args[0]) throw new DesignError('Usage: alba design-docs import <md> [--id x].'); return stableJson(importDesignDoc(project, args[0], values.id)); }
  if (command === 'export') { if (!args[0] || !values.out) throw new DesignError('Usage: alba design-docs export <id> --out <file>.'); return stableJson({ out: exportDesignDoc(project, args[0], values.out) }); }
  if (command === 'set') { if (!args[0] || values.order === undefined || !values.status) throw new DesignError('Usage: alba design-docs set <id> --order n --status approved|draft|retired.'); return stableJson(setDesignDoc(project, args[0], Number(values.order), values.status as never)); }
  throw new DesignError('Usage: alba design-docs list | show <id> [--version n] | import <md> [--id x] | export <id> --out <file> | set <id> --order n --status approved|draft|retired.');
}

export function createIntake(project: ProjectConfig, orders: Orders, values: IntakeCliValues): unknown {
  const allDocs = listDesignDocs(project), requested = values.docs?.split(',').map(x => x.trim()).filter(Boolean) ?? [];
  const unknown = requested.filter(id => !allDocs.some(doc => doc.id === id)); if (unknown.length) throw new DesignError(`Unknown design document(s): ${unknown.join(', ')}.`, 404);
  const docs = allDocs.filter(d => d.status !== 'retired').filter(d => !requested.length || requested.includes(d.id)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (!docs.length) throw new DesignError('No active design documents were selected.');
  const tag = values.tag ?? `INTAKE-${Date.now()}`;
  const documents = docs.map(d => `- ${d.id}: order ${d.order}, status ${d.status}, version ${d.version}`).join('\n');
  const body = template(project).replaceAll('{tag}', tag).replace('{documents}', documents).replace('{snapshot}', `.alba/design/snapshot.json (written in the worker worktree at run start)`).replaceAll('{min_targets}', String(project.intake?.min_targets_per_system ?? project.design?.min_targets_per_system ?? 3))
    .replaceAll('{alba_root}', albaRoot()).replaceAll('{alba_command}', albaCommand(project));
  const made = createOrder(project, orders, { tag, title: `Import design documents (${docs.map(d => d.id).join(', ')})`, kind: 'intake', body, slug: 'intake' });
  orders.store.appendEvent({ at: new Date().toISOString(), tag, type: 'intake-created', by: 'cli', data: { documents: docs.map(d => `${d.id}@${d.version}`) } });
  return made.doc.order.tag;
}

export function runIntake(project: ProjectConfig, orders: Orders, command: string | undefined, args: string[], values: IntakeCliValues, setExitCode: (code: number) => void): string {
  if (command === 'check') {
    // --dir is a path as typed, from the current folder (a worker runs this in its worktree); without it, the order's worker tree or the project's.
    const result = checkIntake(project, orders, values.dir ? path.resolve(values.dir) : args[0] ? intakeOutputAlbaDir(project, orders, args[0]) : path.join(project.root, '.alba'));
    if (!result.ok) setExitCode(1);
    return values.json ? JSON.stringify(result, null, 2) : [...result.issues.map(i => `${i.code}: ${i.message}`), `${result.issues.length} issues; ${result.classified}/${result.blocks} blocks classified`].join('\n');
  }
  if (command === 'review') {
    if (!args[0]) throw new DesignError('Usage: alba intake review <TAG> [--accept SYS,..] [--reject SYS --note text] [--drop SYS --note text].');
    const tag = args[0], events = reviewIntakeSystems(project, orders, tag, { accept: values.accept?.split(',').map(x => x.trim()).filter(Boolean), reject: values.reject?.split(',').map(x => x.trim()).filter(Boolean), drop: values.drop?.split(',').map(x => x.trim()).filter(Boolean), note: values.note });
    return values.json ? JSON.stringify({ tag, events }, null, 2) : events.map((e: any) => `${e.system}: ${e.status}`).join('\n');
  }
  return JSON.stringify(createIntake(project, orders, values), null, 2);
}
