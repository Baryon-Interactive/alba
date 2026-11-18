import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';

const TEXT_LIMIT = 5_000_000;
const BINARY_LIMIT = 200_000_000;
const WINDOW = 64 * 1024;
const builtIns = [
  /-----BEGIN (?:[A-Z\d]+ )*PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/,
  /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/, /sk-[A-Za-z0-9_-]{40,}/,
  /xox[a-z]-[A-Za-z0-9-]{10,}/,
];
const textExt = /\.(?:txt|md|rst|ini|cfg|conf|config|jsonl?|xml|ya?ml|toml|csv|tsv|properties|log|js|mjs|cjs|ts|cs|gd|py|sh|bat|cmd|ps1|html?|css|pem|sql|plist)$/i;
const secretFile = /(?:^|\/)\.env(?:\.[^/]+)?$|\.(?:pfx|p12|key)$/i;
const masked = (value: string) => `${Array.from(value.slice(0, 8)).slice(0, 4).join('').replace(/[^\x20-\x7e]/g, '?')}***`;

export function secretScanner(extraPatterns: string[]) {
  const patterns = [...builtIns, ...extraPatterns.map(source => new RegExp(source, 'u'))];
  function match(text: string): string | undefined {
    for (const pattern of patterns) {
      const hit = pattern.exec(text)?.[0];
      if (hit) return masked(hit);
    }
  }

  return async (file: string, relative: string, size: number): Promise<string | undefined> => {
    if (secretFile.test(relative)) return masked(path.basename(relative));
    if (size === 0 || size >= BINARY_LIMIT) return;
    let encoding: BufferEncoding = 'utf8';
    let text = textExt.test(relative);
    if (!text) {
      const fd = await open(file, 'r');
      const sample = Buffer.alloc(Math.min(size, 4096));
      try { await fd.read(sample, 0, sample.length, 0); } finally { await fd.close(); }
      if (sample[0] === 0xff && sample[1] === 0xfe) { text = true; encoding = 'utf16le'; }
      else text = !sample.includes(0) && !/[\x01-\x08\x0b\x0e-\x1f]/.test(sample.toString('latin1'));
    }
    if (text) return size < TEXT_LIMIT ? match(await readFile(file, encoding)) : undefined;

    // Printable runs are split on binary bytes. Retain a fixed window across chunk boundaries.
    let overlap = '';
    for await (const chunk of createReadStream(file, { encoding: 'latin1', highWaterMark: WINDOW })) {
      const runs = (overlap + chunk).split(/[^\x09\x0a\x0d\x20-\x7e]+/);
      for (const run of runs) {
        const hit = match(run);
        if (hit) return hit;
      }
      overlap = runs.at(-1)!.slice(-WINDOW);
    }
  };
}
