/** Kinds an order may carry without them saying anything: the board's default and "nothing". */
const GENERIC = new Set(['', 'task']);
export const isGenericKind = (kind: string | undefined): boolean => GENERIC.has((kind ?? '').trim().toLowerCase());

/** The kind used to resolve a role: '' for an unclassified order. */
export const kindForFit = (kind: string | undefined): string => (isGenericKind(kind) ? '' : (kind ?? '').trim());
