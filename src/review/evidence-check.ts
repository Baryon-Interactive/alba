import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import { decodePng, imageFormat, summarizePng } from '../verify/png.ts';
import { decodeJpegBlocks } from '../verify/jpeg.ts';

/** What is wrong with the pictures a delivery names: copies of one file given as different views, and flat (one-colour) captures. */
export interface EvidenceProblems { identical: string[][]; flat: string[] }

const IMAGE = /\.(png|jpe?g|bmp|webp)$/i;

/**
 * The images named in the latest report's evidence (found in the order's worktree or the project root), checked for byte-identical
 * copies under different names (a worker described four copies of one capture as four camera moments) and, for PNG and JPEG, for a single flat
 * colour (a black or blank capture). Undefined when there is nothing to say.
 */
export function evidenceProblems(project: ProjectConfig, doc: OrderDoc): EvidenceProblems | undefined {
  const report = [...doc.reports].sort((a, b) => b.seq - a.seq)[0];
  const bases = [doc.order.worktree, project.root].filter((b): b is string => !!b);
  const files = [...new Set((report?.evidence ?? []).filter(e => IMAGE.test(e)))].flatMap(e => {
    const found = (path.isAbsolute(e) ? [e] : bases.map(b => path.resolve(b, e))).find(f => existsSync(f) && statSync(f).isFile() && statSync(f).size <= 64 * 1024 * 1024);
    return found ? [{ name: e, file: found }] : [];
  });
  const byHash = new Map<string, string[]>();
  const flat: string[] = [];
  for (const f of files) {
    const data = readFileSync(f.file);
    const hash = createHash('sha256').update(data).digest('hex');
    byHash.set(hash, [...(byHash.get(hash) ?? []), f.name]);
    const format = imageFormat(data);
    if (format === 'PNG' || format === 'JPEG') {
      // A JPEG is read at one value per 8x8 block, enough to see that it is one flat colour.
      const decoded = format === 'PNG' ? decodePng(data) : decodeJpegBlocks(data);
      if (decoded.status === 'ok' && summarizePng(decoded.image).luminanceStddev < 0.004) flat.push(f.name);
    }
  }
  const identical = [...byHash.values()].filter(names => names.length > 1);
  return identical.length || flat.length ? { identical, flat } : undefined;
}

/** The note that sends such a delivery back. */
export function evidenceBounceNote(p: EvidenceProblems): string {
  return [
    'The pictures this delivery names as evidence do not show what the report says:',
    ...p.identical.map(names => `- ${names.join(', ')} are the same file, byte for byte: they cannot show different moments or views.`),
    ...p.flat.map(name => `- ${name} is a single flat colour (a black or blank capture).`),
    '',
    'Capture each view again and look at every picture before you name it (open the file; do not describe it from its name). Captures of a game window must come from your own window: another order may have a game open on the same desktop. Then commit and end with a new report block.',
  ].join('\n');
}
