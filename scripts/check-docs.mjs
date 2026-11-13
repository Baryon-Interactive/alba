import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sourceFiles } from './source-files.mjs';

function anchors(text) {
  const used = new Map(), result = new Set();
  for (const line of text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').split('\n')) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (!heading) continue;
    const base = heading[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/ /g, '-');
    const count = used.get(base) ?? 0;
    used.set(base, count + 1); result.add(base + (count ? `-${count}` : ''));
  }
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  return result;
}

export function checkDocs(root = path.resolve(import.meta.dirname, '..')) {
  const files = sourceFiles(root).filter(file => /\.md$/i.test(file)), problems = [], cache = new Map();
  let links = 0;
  for (const file of files) {
    const raw = readFileSync(path.join(root, file), 'utf8');
    const text = raw.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/`[^`\n]+`/g, '');
    const refs = new Map([...text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)].map(m => [m[1].toLowerCase(), m[2]]));
    const targets = [...text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)].map(m => m[1].replace(/^<|>$/g, ''));
    for (const m of text.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
      const ref = (m[2] || m[1]).toLowerCase();
      if (!refs.has(ref)) problems.push(`${file}: undefined link reference ${ref}`);
      else targets.push(refs.get(ref));
    }
    targets.push(...refs.values());
    for (const target of targets) {
      links++;
      if (/^(?:https?:|mailto:)/i.test(target)) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) { problems.push(`${file}: unsupported link scheme ${target}`); continue; }
      let decoded;
      try { decoded = decodeURIComponent(target); } catch { problems.push(`${file}: invalid URL ${target}`); continue; }
      const [pathname, fragment] = decoded.split('#');
      const full = pathname ? path.resolve(path.dirname(path.join(root, file)), pathname.split('?')[0]) : path.join(root, file);
      const relative = path.relative(root, full);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(full)) { problems.push(`${file}: missing or escaping link ${target}`); continue; }
      if (fragment && statSync(full).isFile() && /\.md$/i.test(full)) {
        if (!cache.has(full)) cache.set(full, anchors(readFileSync(full, 'utf8')));
        if (!cache.get(full).has(fragment)) problems.push(`${file}: missing anchor ${target}`);
      }
    }
  }
  return { documents: files.length, links, problems };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = checkDocs(); console.log(JSON.stringify(result, null, 2)); if (result.problems.length) process.exitCode = 1;
}
