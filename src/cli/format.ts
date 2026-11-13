/** Display width of a string in a terminal: wide (CJK) characters take two columns. */
export function width(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return w;
}

function clip(text: string, max: number): string {
  if (width(text) <= max) return text;
  let out = '';
  for (const ch of text) { if (width(out + ch) > max - 1) break; out += ch; }
  return out + '…';
}

/** Plain-text table. Cells longer than `maxCell` columns are cut. */
export function table(header: string[], rows: string[][], maxCell = 48): string {
  const clipped = rows.map(r => r.map(c => clip(c.replace(/\s+/g, ' '), maxCell)));
  const widths = header.map((h, i) => Math.max(width(h), ...clipped.map(r => width(r[i] ?? ''))));
  const line = (cells: string[]) => cells.map((c, i) => c + ' '.repeat(widths[i] - width(c))).join('  ').trimEnd();
  return [line(header), line(widths.map(w => '-'.repeat(w))), ...clipped.map(line)].join('\n');
}
