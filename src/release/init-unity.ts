import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fail, releaseText as text } from '../i18n.ts';
import { projectDirectory } from './paths.ts';

export function initUnity(root: string, force: boolean): string {
  const template = readFileSync(new URL('../../templates/release/unity/AlbaReleaseBuild.cs', import.meta.url));
  const dir = path.join(root, 'Assets', 'Editor', 'Alba');
  projectDirectory(root, dir);
  const file = path.join(dir, 'AlbaReleaseBuild.cs');
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile()) fail(text.unsafeFolder, { dir: file });
    if (readFileSync(file).equals(template)) return file;
    if (!force) fail(text.templateChanged, { file });
  }
  writeFileSync(file, template, { flag: stat ? 'w' : 'wx' });
  return file;
}
