import type { DecisionEntry, NewDecisionRequest } from '@api';

/** Entries that contain every word of the query (in the id, text or source), of one section of the file when `topic` is given, newest first. */
export function searchDecisions(items: DecisionEntry[], query: string, kind: DecisionEntry['sourceKind'] | '' = '', topic = ''): DecisionEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter(d => (!kind || d.sourceKind === kind) && (!topic || d.topic === topic) && words.every(w => `${d.id} ${d.displayId ?? ''} ${d.text} ${d.source}`.toLowerCase().includes(w)))
    .sort((a, b) => b.number - a.number);
}

export type DecisionForm = { text: string; mode: 'quote' | 'default'; source: string; id: string; date: string };

/** A decision needs words and a source: the user's own words, or the fixed "default, not overruled". Returns the request, or what is missing. */
export function buildDecisionRequest(f: DecisionForm): { ok: true; body: Omit<NewDecisionRequest, 'project'> } | { ok: false; missing: 'text' | 'source' } {
  const text = f.text.trim();
  if (!text) return { ok: false, missing: 'text' };
  const base = { text, ...(f.id.trim() ? { id: f.id.trim() } : {}), ...(f.date.trim() ? { date: f.date.trim() } : {}) };
  if (f.mode === 'default') return { ok: true, body: { ...base, default: true } };
  const source = f.source.trim();
  if (!source) return { ok: false, missing: 'source' };
  return { ok: true, body: { ...base, source } };
}
