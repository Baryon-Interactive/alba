import { readFileSync } from 'node:fs';
import path from 'node:path';

export function checkChangelog(root = path.resolve(import.meta.dirname, '..')) {
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const headings = [...readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').matchAll(/^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$/gm)];
  if (!headings.some(match => match[1] === version)) throw new Error(`CHANGELOG.md needs an entry for package version ${version}.`);
  return version;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try { console.log(`Changelog covers ${checkChangelog()}.`); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
