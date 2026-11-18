import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

const TEXT_LIMIT = 5_000_000;
const BINARY_LIMIT = 200_000_000;
const WINDOW = 64 * 1024;
const builtIns = [
  /-----BEGIN (?:[A-Z\d]+ )*PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/,
  /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/, /sk-[A-Za-z0-9_-]{40,}/,
  /(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10,}/,
];
const textExt = /\.(?:txt|md|rst|ini|cfg|conf|config|jsonl?|xml|ya?ml|toml|csv|tsv|properties|log|js|mjs|cjs|ts|cs|gd|py|sh|bat|cmd|ps1|html?|css|pem|sql|plist)$/i;
const binaryExt = /\.(?:exe|dll|so|dylib|bin|wasm|x86_64|arm64|pak|utoc|ucas|pck|zip|pdb|png|jpe?g|webp|mp3|wav|mp4)$/i;
const secretFile = /(?:^|\/)\.env(?:\.[^/]+)?$|\.(?:pfx|p12|key)$/i;
const masked = (value: string) => `${Array.from(value.slice(0, 8)).slice(0, 4).join('').replace(/[\x00-\x1f\x7f]/g, '?')}***`;
const bom = (bytes: Buffer): 'utf-16le' | 'utf-16be' | undefined => bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
  : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : undefined;

async function prefix(file: string, size: number): Promise<Buffer> {
  const fd = await open(file, 'r');
  const bytes = Buffer.alloc(size);
  try {
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await fd.read(bytes, offset, size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  }
  finally { await fd.close(); }
}

export function secretScanner(extraPatterns: string[]) {
  const patterns = [...builtIns, ...extraPatterns.map(source => new RegExp(source, 'u'))];
  function match(text: string): string | undefined {
    for (const pattern of patterns) {
      const hit = pattern.exec(text)?.[0];
      if (hit) return Array.from(hit.slice(0, 10)).length > 4 ? masked(hit) : '***';
    }
  }

  return async (file: string, relative: string, size: number): Promise<string | undefined> => {
    if (secretFile.test(relative)) return masked(path.basename(relative));
    if (size === 0 || size >= BINARY_LIMIT) return;
    let text = textExt.test(relative);
    if (!text && !binaryExt.test(relative)) {
      const sample = await prefix(file, Math.min(size, 4096));
      text = !!bom(sample) || !/[\x00-\x08\x0b\x0e-\x1f]/.test(sample.toString('latin1'));
    }
    if (text) {
      if (size >= TEXT_LIMIT) return;
      const bytes = await prefix(file, size);
      return match(new TextDecoder(bom(bytes) ?? 'utf8').decode(bytes));
    }

    // Printable runs are split on binary bytes. Retain a fixed window across chunk boundaries.
    let overlap = '';
    for await (const chunk of createReadStream(file, { encoding: 'latin1', highWaterMark: WINDOW, end: size - 1 })) {
      const runs = (overlap + chunk).split(/[^\x09\x0a\x0d\x20-\x7e]+/);
      for (const run of runs) {
        const hit = match(run);
        if (hit) return hit;
      }
      overlap = runs.at(-1)!.slice(-WINDOW);
    }
  };
}
