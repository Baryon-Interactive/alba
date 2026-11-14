import { parse, parseDocument } from 'yaml';
import { readFileSync } from 'node:fs';
import { validateProject, type ProjectConfig } from './config.ts';
import { UserError, t } from './i18n.ts';
import { effectiveRoles } from './roles/config.ts';
import { validateWorkers, type WorkersFile } from './workers/config.ts';
import { assign, editYaml, EditRefused, plainAt, type EditOutcome } from './yamledit.ts';

/** Which file an edit goes to: the project's `alba.yaml` or the shared workers file. */
export type ConfigTarget = 'project' | 'workers';

/** One change: the value at `path` becomes `value`; no `value` removes the key. */
export interface ConfigEdit { path: (string | number)[]; value?: unknown }

/**
 * What the console may change, by file: the first one or two keys of a path. Identity and places (`id`, `root`, `state_dir`,
 * `work_orders`, `workers`) stay out; so do the workers themselves, which have their own editor (src/workers/edit.ts).
 */
export const EDITABLE: Record<ConfigTarget, readonly string[][]> = {
  project: [
    ['routing'], ['roles'], ['resources'], ['budget'], ['usage_warnings'], ['clean'],
    ['skills', 'always'], ['skills', 'by_kind'], ['skills', 'max_per_order'], ['lessons', 'kind_tags'],
    ...['caps', 'rework_reserve', 'stall_minutes', 'long_command_minutes', 'start_receipt_minutes', 'commit_nudge_minutes', 'min_free_ram_gb', 'merge',
      'on_loop', 'loop_idle_minutes', 'loop_repeat', 'loop_alternate', 'on_lingering', 'lingering_minutes', 'long_commands'].map(k => ['dispatch', k]),
  ],
  workers: [['routing'], ['roles'], ['quota_sources']],
};

const allowed = (target: ConfigTarget, path: (string | number)[]) => EDITABLE[target].some(prefix => prefix.every((k, i) => path[i] === k));

/** The editable sections of a file as they are written there (no defaults filled in), for the console's forms. */
export function readEditable(file: string, target: ConfigTarget): Record<string, unknown> {
  const doc = parseDocument(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const out: Record<string, unknown> = {};
  for (const prefix of EDITABLE[target]) {
    const value = plainAt(doc, prefix);
    if (value === undefined) continue;
    let at = out;
    for (const key of prefix.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>;
    at[prefix[prefix.length - 1]] = value;
  }
  return out;
}

/**
 * Applies `edits` to one configuration file in one write, keeping its comments and order (src/yamledit.ts), after checking that
 * every path is one the console may change and that the result loads: the file on its own (`validateProject` / `validateWorkers`),
 * and the routing it forms with the other file (`effectiveRoles`: unknown groups, members that are no worker, two defaults).
 * `others`: for a project file, the workers file; for the workers file, every project that uses it.
 */
export function editConfig(file: string, target: ConfigTarget, edits: readonly ConfigEdit[], others: { workers?: WorkersFile; projects?: readonly ProjectConfig[] }, options: { dryRun?: boolean; now?: Date } = {}): EditOutcome {
  if (!edits.length) throw new EditRefused(t('Nothing to change.'));
  for (const e of edits) {
    if (!Array.isArray(e.path) || !e.path.length || e.path.some(k => typeof k !== 'string' && typeof k !== 'number')) throw new EditRefused(t('Each change needs a path: a list of keys.'));
    if (!allowed(target, e.path)) throw new EditRefused(t('{path} cannot be changed from the console.', { path: e.path.join('.') }));
  }
  return editYaml(file, doc => edits.flatMap(e => assign(doc, e.path, e.value, plainAt(doc, e.path))), text => {
    try {
      if (target === 'project') {
        const project = validateProject(parse(text), file);
        effectiveRoles(project, others.workers);
      } else {
        const workers = validateWorkers(parse(text), file);
        for (const project of others.projects ?? []) effectiveRoles(project, workers);
        if (!others.projects?.length) effectiveRoles({}, workers);
      }
    } catch (e) {
      if (!(e instanceof UserError) || e instanceof EditRefused) throw e;
      throw new EditRefused(e.message);
    }
  }, options);
}
