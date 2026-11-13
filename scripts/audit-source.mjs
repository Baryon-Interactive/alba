import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sourceFiles } from './source-files.mjs';

/** Audit the release working tree without dependencies, generated builds or private local state. */
export function auditSource(root = path.resolve(import.meta.dirname, '..')) {
  const files = sourceFiles(root);
  const problems = [];
  const legacy = /\bg[s]f\b|game-studio-fact[o]ry|studio-o[s]/i;
  const internal = /\b(?:g[s]f|s[o]|al[b]a|a[l])\d+(?:\.\d+)?\b/i;
  const cjk = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/u;
  const drive = /(?:^|["'\s(`=])[A-Za-z]:[\\/]/m;
  const home = /[\\/](?:home|Users)[\\/]/;
  const absolute = /(?:^|["'`\s=])(?:\/(?:tmp|var|private|Volumes|etc|opt|mnt|media|workspace|root|srv)\/|\\\\(?!\\)[A-Za-z0-9.-]+\\(?!\\))/m;
  const username = /\b(?:Tju[S]o|EthanIn[M]el)\b/i;
  const secret = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9_.-]{30,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][A-Za-z0-9_+\/-]{24,}["']/i;
  const numbered = new Set();
  let textFiles = 0;
  for (const file of files) {
    const full = path.join(root, file);
    if (!existsSync(full)) { problems.push(`${file}: tracked path is missing`); continue; }
    if (legacy.test(file) || internal.test(file)) problems.push(`${file}: obsolete identifier in filename`);
    const numberedDoc = /^docs\/(?:[^/]+\/)*(\d{3})-.*\.md$/.exec(file);
    if (numberedDoc) {
      if (numbered.has(numberedDoc[1])) problems.push(`${file}: duplicate documentation number`);
      numbered.add(numberedDoc[1]);
    }
    const bytes = readFileSync(full);
    if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) problems.push(`${file}: UTF-8 BOM`);
    if (/\.(?:png|jpe?g|gif|webp|mp4|woff2?)$/i.test(file)) continue;
    textFiles++;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { problems.push(`${file}: invalid UTF-8 text; remove binary data from text sources or declare a supported binary format`); continue; }
    if (legacy.test(text)) problems.push(`${file}: obsolete product or library name`);
    if (internal.test(text)) problems.push(`${file}: internal ticket identifier`);
    const translation = file === 'src/i18n-zh.ts' || /^ui\/src\/i18n\/(?:zh|machines|design-goals|independent-check|nightly-gates|producer-activity)\.ts$/.test(file);
    if (!translation && cjk.test(text)) problems.push(`${file}: translation outside its catalog`);
    if (drive.test(text) || home.test(text) || absolute.test(text)) problems.push(`${file}: machine-specific absolute path`);
    if (username.test(text)) problems.push(`${file}: private username`);
    if (secret.test(text)) problems.push(`${file}: credential-shaped literal`);
    if (text.includes('\r')) problems.push(`${file}: non-LF line ending`);
  }
  return { files: files.length, textFiles, numberedDocuments: numbered.size, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = auditSource();
  console.log(JSON.stringify(result, null, 2));
  if (result.problems.length) process.exitCode = 1;
}
