/** Comma-list flags given more than once add up (`--needs A --needs B` is `--needs A,B`); otherwise the last one would silently win. */
const LIST_FLAGS = ['needs', 'tags', 'skills'];
export function mergeListFlags(argv: readonly string[]): string[] {
  const out: string[] = [], at: Record<string, number> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]!);
    const name = m?.[1];
    if (!m || !name || !LIST_FLAGS.includes(name) || (m[2] === undefined && (i + 1 >= argv.length || argv[i + 1]!.startsWith('--')))) { out.push(argv[i]!); continue; }
    const value = m[2] ?? argv[++i]!;
    if (at[name] === undefined) { at[name] = out.length + 1; out.push(`--${name}`, value); }
    else out[at[name]!] = [out[at[name]!], value].filter(Boolean).join(',');
  }
  return out;
}
