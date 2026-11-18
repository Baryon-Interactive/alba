import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

async function readAt(file: FileHandle, offset: number, length: number): Promise<Buffer | undefined> {
  if (offset < 0) return;
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await file.read(bytes, read, length - read, offset + read);
    if (!result.bytesRead) return;
    read += result.bytesRead;
  }
  return bytes;
}

async function inspect<T>(name: string, read: (file: FileHandle, size: number) => Promise<T>): Promise<T | undefined> {
  try {
    const file = await open(name, 'r');
    try { return await read(file, (await file.stat()).size); }
    finally { await file.close(); }
  } catch { return undefined; }
}

export async function pakEncrypted(name: string): Promise<boolean | undefined> {
  return inspect(name, async (file, size) => {
    const tail = await readAt(file, Math.max(0, size - 222), Math.min(222, size));
    if (!tail) return;
    // FPakInfo has a 61-byte prefix, then compression names and, in v9, a frozen-index byte.
    for (const [length, versions] of [[221, [8, 10, 11]], [222, [9]], [189, [8]]] as const) {
      const start = tail.length - length;
      if (start < 0 || tail.readUInt32LE(start + 17) !== 0x5a6f12e1) continue;
      const version = tail.readUInt32LE(start + 21);
      const encrypted = tail[start + 16];
      if (!versions.some(candidate => candidate === version) || encrypted > 1) continue;
      const index = tail.readBigUInt64LE(start + 25);
      const indexSize = tail.readBigUInt64LE(start + 33);
      if (index + indexSize <= BigInt(size - length)) return encrypted === 1;
    }
  });
}

export async function ioStoreEncrypted(name: string): Promise<boolean | undefined> {
  return inspect(name, async (file, size) => {
    const head = await readAt(file, 0, 81);
    if (!head || head.toString('ascii', 0, 16) !== '-==--==--==--==-') return;
    const length = head.readUInt32LE(20);
    if (length >= head.length && length <= size) return !!(head[80] & 2);
  });
}

const PCK_MAGIC = 0x43504447;

export async function pckEncrypted(name: string, embedded = false): Promise<boolean | undefined> {
  return inspect(name, async (file, size) => {
    let offset = 0, length = size;
    if (embedded) {
      const end = await readAt(file, size - 12, 12);
      if (!end || end.readUInt32LE(8) !== PCK_MAGIC) return;
      const packSize = end.readBigUInt64LE(0);
      if (packSize > BigInt(size - 12)) return;
      length = Number(packSize);
      offset = size - 12 - length;
    }
    if (length < 20) return;
    const head = await readAt(file, offset, Math.min(24, length));
    if (!head || head.readUInt32LE(0) !== PCK_MAGIC) return;
    const version = head.readUInt32LE(4);
    if (version === 1) return false;
    if (version >= 2 && version <= 4 && head.length === 24) return !!(head.readUInt32LE(20) & 1);
  });
}
