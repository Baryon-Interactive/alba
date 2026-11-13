import type { DiffComment } from './rework.ts';

export type StoredComment = DiffComment & { id: string };
export interface ReviewDraft { general: string; comments: StoredComment[] }

export const emptyDraft = (): ReviewDraft => ({ general: '', comments: [] });
export const draftKey = (project: string, tag: string) => `alba-review:${project}:${tag}`;
export const isEmptyDraft = (d: ReviewDraft) => !d.general.trim() && d.comments.length === 0;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): Store | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

/** The unsent remarks and line comments of an order, as the browser kept them. */
export function loadDraft(key: string, store: Store | undefined = defaultStore()): ReviewDraft {
  try {
    const v = JSON.parse(store?.getItem(key) ?? '') as Partial<ReviewDraft>;
    return { general: typeof v.general === 'string' ? v.general : '', comments: Array.isArray(v.comments) ? v.comments : [] };
  } catch { return emptyDraft(); }
}

/** Keeps a draft that has something in it; an empty one (everything sent, or everything deleted) leaves no trace. */
export function saveDraft(key: string, d: ReviewDraft, store: Store | undefined = defaultStore()): void {
  try {
    if (isEmptyDraft(d)) store?.removeItem(key);
    else store?.setItem(key, JSON.stringify(d));
  } catch { /* storage full or blocked: the draft only lives in the page */ }
}

export const hasDraft = (key: string, store?: Store) => !isEmptyDraft(loadDraft(key, store));
