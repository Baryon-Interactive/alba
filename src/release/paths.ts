import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fail, releaseText as text } from '../i18n.ts';

/** Create directories beneath the project without following symlinks or junctions there. */
export function projectDirectory(root: string, dir: string): void {
  const relative = path.relative(root, dir);
  if (path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') fail(text.unsafeFolder, { dir });
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { mkdirSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!lstatSync(current).isDirectory()) fail(text.unsafeFolder, { dir: current });
  }
}
