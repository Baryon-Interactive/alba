import path from 'node:path';

export interface DraftingConfig {
  when: 'needs-merged' | 'free-slot';
  template?: string;
  examples: number;
  auto_kinds: string[];
}

export function validateDrafting(raw: unknown, base: string): DraftingConfig {
  const v = raw as Record<string, unknown>;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['when', 'template', 'examples', 'auto_kinds'].includes(k))) throw new Error('Invalid drafting configuration.');
  if (v.when !== undefined && !['needs-merged', 'free-slot'].includes(String(v.when))) throw new Error('drafting.when must be needs-merged or free-slot.');
  if (v.template !== undefined && (typeof v.template !== 'string' || !v.template.trim())) throw new Error('drafting.template must be a Markdown file path.');
  if (v.examples !== undefined && (!Number.isInteger(v.examples) || Number(v.examples) < 0 || Number(v.examples) > 20)) throw new Error('drafting.examples must be an integer from 0 to 20.');
  if (v.auto_kinds !== undefined && (!Array.isArray(v.auto_kinds) || v.auto_kinds.some(k => typeof k !== 'string' || !k.trim()))) throw new Error('drafting.auto_kinds must be a list of kinds.');
  return { when: (v.when ?? 'needs-merged') as DraftingConfig['when'], ...(typeof v.template === 'string' ? { template: path.resolve(base, v.template) } : {}), examples: Number(v.examples ?? 3), auto_kinds: (v.auto_kinds ?? []) as string[] };
}
