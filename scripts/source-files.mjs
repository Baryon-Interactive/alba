import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';

/** Inspect the working release tree, including new files, without dependencies or local state. */
export function sourceFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const files = [...new Set(output.split('\0').filter(Boolean))].sort();
  for (const file of files) {
    const full = path.join(root, file);
    let stat;
    try { stat = lstatSync(full); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Release tree contains a symbolic link: ${file}`);
  }
  return files;
}
