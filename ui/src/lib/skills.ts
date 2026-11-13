import type { SkillsView } from '@api';

type Skill = SkillsView['skills'][number];

export interface SkillColumns {
  /** Global skills the project can use (its engine and its include/exclude let them through), the tool's own included. */
  available: Skill[];
  /** Global skills the project does not use here, each with the reason (`inapplicable`). */
  unused: Skill[];
  /** Skills of the project's own sources. */
  own: Skill[];
}

/** The three columns of the skills page. */
export function skillColumns(skills: Skill[]): SkillColumns {
  return {
    own: skills.filter(s => s.scope === 'project'),
    available: skills.filter(s => s.scope === 'global' && s.applicable),
    unused: skills.filter(s => s.scope === 'global' && !s.applicable),
  };
}

/** Does the skill match a filter text (name, description, source, tags, engines)? */
export const skillMatches = (s: Skill, text: string): boolean => {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [s.name, s.description, s.source, ...s.tags, ...s.engines].join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
};

/** What the one-click button of a skill does: stop using it (it is available), or use it (it is not). The tool's own skill and the project's own have no button. */
export function useAction(s: Skill): 'stop' | 'use' | undefined {
  if (s.scope === 'project' || s.layers.includes('core')) return undefined;
  return s.applicable ? 'stop' : 'use';
}
