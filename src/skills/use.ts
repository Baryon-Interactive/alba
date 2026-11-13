import { parse } from 'yaml';
import { validateProject } from '../config.ts';
import { UserError, t } from '../i18n.ts';
import { assign, editYaml, EditRefused, type EditOutcome } from '../yamledit.ts';
import { applicability, filterOf, type RegistrySkill } from './registry.ts';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The lists `skills.include` and `skills.exclude` after the project starts (`use`) or stops using the skill. Throws when the rule cannot do it. */
export function listsAfter(skill: RegistrySkill, use: boolean, now: { engine?: string; include: readonly string[]; exclude: readonly string[] }): { include: string[]; exclude: string[] } {
  if (skill.core || skill.scope === 'project') throw new EditRefused(t('{name} is the tool\'s own or one of the project\'s own skills: it is not filtered. Leave it out of its source folder to stop using it.', { name: skill.name }));
  let include = [...now.include], exclude = [...now.exclude];
  if (!use) {
    if (!exclude.some(x => same(x, skill.name))) exclude.push(skill.name);
    include = include.filter(x => !same(x, skill.name));
    return { include, exclude };
  }
  exclude = exclude.filter(x => !same(x, skill.name));
  if (!applicability(skill, { engine: now.engine, include, exclude }).applicable && !include.some(x => same(x, skill.name))) include.push(skill.name);
  const after = applicability(skill, { engine: now.engine, include, exclude });
  if (!after.applicable) throw new EditRefused(t('{name} stays out: {why}. Change that rule in the project file.', { name: skill.name, why: after.inapplicable ?? '-' }));
  return { include, exclude };
}

/** Writes `skills.include` / `skills.exclude` of the project file so that the project uses (or does not use) the skill. Comments and order of the file are kept. */
export function setSkillUse(file: string, skill: RegistrySkill, use: boolean, project: Parameters<typeof filterOf>[0], options: { dryRun?: boolean; now?: Date } = {}): EditOutcome {
  const filter = filterOf(project);
  const next = listsAfter(skill, use, filter);
  return editYaml(file, doc => {
    const changed: string[] = [];
    const old = { include: [...filter.include], exclude: [...filter.exclude] };
    for (const key of ['include', 'exclude'] as const) changed.push(...assign(doc, ['skills', key], next[key].length ? next[key] : undefined, old[key].length ? old[key] : undefined));
    return changed;
  }, text => {
    try { validateProject(parse(text), file); } catch (e) {
      if (!(e instanceof UserError)) throw e;
      throw new EditRefused(e.message);
    }
  }, options);
}
