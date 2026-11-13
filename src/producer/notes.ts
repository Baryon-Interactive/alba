import { createHash } from 'node:crypto';
import type { ProjectConfig } from '../config.ts';
import { appendStateFile, readStateFile, stateTransaction, writeStateFile } from '../orders/state-files.ts';
import { t } from '../i18n.ts';

const name = (tag?: string) => tag ? `producer-order-notes-${createHash('sha256').update(tag.toUpperCase()).digest('hex').slice(0, 24)}.md` : 'producer-notes.md';
export const producerNotes = (project: ProjectConfig, tag?: string): string => readStateFile(project, name(tag)) ?? '';
const invisible = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/u;
const injection = /(?:ignore\s+(?:all|any|the)\s+previous|system\s+message|developer\s+message|you\s+are\s+(?:now\s+)?(?:an?|the)\s+model|<\|(?:system|assistant|user)\|>)/iu;

export function writeProducerNotes(project: ProjectConfig, text: string, replace = false, tag?: string): { text: string; written: boolean; archive?: string } {
  if (invisible.test(text)) throw new Error(t('Producer notes cannot contain invisible characters.'));
  if (injection.test(text)) throw new Error(t('Producer notes cannot contain instructions addressed to the model.'));
  const limit = project.producer.session.notes_chars ?? 8000;
  let next = '', archive: string | undefined;
  stateTransaction(project, () => {
    const old = producerNotes(project, tag).trimEnd();
    next = replace ? text.trim() : [old, text.trim()].filter(Boolean).join('\n');
    let rolled = replace && old !== next ? old : '';
    if (next.length > limit) {
      if (tag) throw new Error(t('Order notes are limited to {limit} characters.', { limit }));
      const cut = next.length - limit;
      rolled += (rolled ? '\n' : '') + next.slice(0, cut);
      next = next.slice(cut);
    }
    if (rolled && !tag) {
      archive = `producer-notes-archive-${new Date().toISOString().slice(0, 10)}.md`;
      appendStateFile(project, archive, `${rolled}\n`);
    }
    writeStateFile(project, name(tag), next ? `${next}\n` : '');
  });
  return { text: next, written: true, ...(archive ? { archive } : {}) };
}
