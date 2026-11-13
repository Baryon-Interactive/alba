import type { ArtRef, ArtSetting, PickSet, SpendQuote } from '@api';
import type { Tone } from '@/components/ui/badge';
import { t } from '@/i18n';

/** What a choice looks like after one more click: a single-choice set keeps one key, a multi-choice set toggles. */
export function toggleChoice(selected: readonly string[], key: string, multi: boolean): string[] {
  if (!multi) return selected.length === 1 && selected[0] === key ? [] : [key];
  return selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key];
}

/** The sets of each state, in the order of the page: waiting first. */
export function pickGroups(sets: readonly PickSet[]): { pending: PickSet[]; chosen: PickSet[]; decided: PickSet[] } {
  return { pending: sets.filter(s => s.state === 'pending'), chosen: sets.filter(s => s.state === 'chosen'), decided: sets.filter(s => s.state === 'decided') };
}

export interface PickImage { optionKey: string; label: string; path: string; exists: boolean }

/** Every picture of a set in the order a person goes through them: option by option. */
export function pickImages(set: PickSet): PickImage[] {
  return set.options.flatMap(o => o.images.map(i => ({ optionKey: o.key, label: o.label, path: i.path, exists: i.exists })));
}

/** The words of what is chosen: `A: Round, B: Square`. */
export function choiceText(set: PickSet, keys: readonly string[]): string {
  return keys.map(k => `${k}: ${set.options.find(o => o.key === k)?.label ?? k}`).join(', ');
}

/** The reference cards that carry every one of the tags (and whose text holds the query). Selecting more tags narrows, never widens. */
export function filterRefs(refs: readonly ArtRef[], tags: readonly string[], query = ''): ArtRef[] {
  const q = query.trim().toLowerCase();
  return refs.filter(r => tags.every(tag => r.tags.includes(tag)) && (!q || [r.title, r.work ?? '', r.learn ?? '', r.tags.join(' ')].some(x => x.toLowerCase().includes(q))));
}

/** The tags still worth offering after the ones selected: those of the cards that remain, with how many carry each. */
export function tagsLeft(refs: readonly ArtRef[], selected: readonly string[], query = ''): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of filterRefs(refs, selected, query)) for (const tag of r.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export const settingStatusTone = (s: ArtSetting): Tone => (!s.standard ? 'warning' : s.status === 'final' ? 'success' : s.status === 'sheets' ? 'primary' : s.status === 'text-approved' ? 'primary' : 'neutral');

/** The confirmation of a setting's text in a word: confirmed, changed since, or not confirmed. */
export function confirmationText(s: ArtSetting): { text: string; tone: Tone } {
  if (s.confirmed) return { text: t('text confirmed'), tone: 'success' };
  if (s.confirmation && !s.confirmation.valid) return { text: t('text changed after it was confirmed'), tone: 'warning' };
  return { text: t('text not confirmed'), tone: 'neutral' };
}

/** A setting whose words may be confirmed here: it has its text, and its status says the words are still being written. */
export const canConfirm = (s: ArtSetting): boolean => s.body !== undefined && !s.confirmed && /^(text-draft|draft|concept|proposed|idea)$/i.test(s.status);

export const quoteStateTone: Record<SpendQuote['state'], Tone> = { pending: 'warning', approved: 'success', stale: 'danger' };
export const quoteStateText = (s: SpendQuote['state']): string => (s === 'pending' ? t('waiting for approval') : s === 'approved' ? t('approved') : t('changed after it was approved'));

/** Spent against the approved cap, in percent (0 when nothing is approved). */
export const spentPercent = (q: SpendQuote): number => (q.approval && !q.approval.stale && q.approval.cap > 0 ? Math.min(100, (q.spent / q.approval.cap) * 100) : 0);

export const shortSha = (sha: string | undefined): string => (sha ?? '').slice(0, 10);
