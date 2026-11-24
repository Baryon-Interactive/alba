import { fail } from '../i18n.ts';
import { parseTemplateFileSections } from './sections.ts';
import type { ProjectConfig } from '../config.ts';

export interface Subtask { key: string; title: string; kind: string; body: string; needs?: string[] }

export function childKinds(project: ProjectConfig): string[] {
  return [...new Set(['task', ...(project.kinds ?? []).filter(k => !k.tag_only).map(k => k.id), ...Object.keys(project.phases ?? {}), ...Object.keys(project.orders?.templates ?? {})])]
    .filter(kind => !project.phases?.[kind]?.some(p => p.mode === 'split'));
}

export function validateSubtasks(value: unknown, kinds?: readonly string[]): Subtask[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) fail('A split needs two to eight subtasks.');
  const tasks = new Map<string, Subtask>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(k => !['key', 'title', 'kind', 'body', 'needs'].includes(k))
      || ['key', 'title', 'kind', 'body'].some(k => typeof item[k] !== 'string' || !item[k].trim())) fail('Each subtask needs a key, title, kind and body.');
    const { key, title, kind, body, needs } = item;
    if (tasks.has(key)) fail('Duplicate subtask key: {key}', { key });
    if (kinds && !kinds.includes(kind)) fail('Unknown or nested split child kind: {kind}', { kind });
    if (Buffer.byteLength(body) >= 16 * 1024 || !parseTemplateFileSections(body).acceptance.length) fail('A subtask body needs Acceptance bullets and must be under 16 KiB.');
    if (needs !== undefined && (!Array.isArray(needs) || needs.some(n => typeof n !== 'string'))) fail('Subtask needs must list sibling keys.');
    tasks.set(key, { key, title, kind, body, ...(needs ? { needs: [...new Set<string>(needs)] } : {}) });
  }
  const done = new Set<string>();
  function visit(key: string, path: Set<string>) {
    if (done.has(key)) return;
    const task = tasks.get(key);
    if (!task) fail('Unknown sibling key: {key}', { key });
    if (path.has(key)) fail('Cyclic subtask needs at {key}.', { key });
    for (const need of task.needs ?? []) visit(need, new Set(path).add(key));
    done.add(key);
  }
  for (const key of tasks.keys()) visit(key, new Set());
  return [...tasks.values()];
}
