export interface DiffComment {
  /** Path of the file the comment is on. */
  file: string;
  /** Line number in the new file (`side: 'new'`) or the old one (`'old'`). */
  line: number;
  side: 'old' | 'new';
  text: string;
}

/**
 * Builds the note that goes to the next run from the comments left on the diff and a free-form remark.
 * Comments are grouped by file, in file and line order; empty ones are dropped. Returns '' when there is nothing to say.
 */
export function buildReworkNote(general: string, comments: DiffComment[]): string {
  const parts: string[] = [];
  const g = general.trim();
  if (g) parts.push(g);
  const byFile = new Map<string, DiffComment[]>();
  for (const c of comments) {
    if (!c.text.trim()) continue;
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
  }
  if (byFile.size) {
    const lines: string[] = [];
    for (const file of [...byFile.keys()].sort()) {
      lines.push(`${file}:`);
      for (const c of byFile.get(file)!.sort((a, b) => a.line - b.line || a.side.localeCompare(b.side))) {
        lines.push(`- line ${c.line}${c.side === 'old' ? ' (before the change)' : ''}: ${c.text.trim().replace(/\s*\n\s*/g, ' ')}`);
      }
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}
