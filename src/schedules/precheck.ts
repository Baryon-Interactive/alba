import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';

export type PrecheckRunner = (command: string | string[], project: ProjectConfig, timeout: number) => { code: number; output: string };

/** Capture interleaved stdout/stderr without imposing a maxBuffer limit on the running command. */
export const runPrecheck: PrecheckRunner = (command, project, timeout) => {
  mkdirSync(project.state_dir, { recursive: true });
  const dir = mkdtempSync(path.join(project.state_dir, 'precheck-'));
  try {
    const fd = openSync(path.join(dir, 'output'), 'w+');
    try {
      const result = spawnSync(typeof command === 'string' ? command : command[0], typeof command === 'string' ? [] : command.slice(1), {
        cwd: project.root, shell: typeof command === 'string', timeout, killSignal: 'SIGKILL', windowsHide: true, stdio: ['ignore', fd, fd],
      });
      if (result.error) throw result.error;
      if (result.status === null) throw new Error(`precheck stopped by ${result.signal ?? 'an unknown signal'}`);
      let offset = fstatSync(fd).size;
      const chunks: Buffer[] = [];
      let lines = 0;
      while (result.status !== 0 && offset > 0 && lines <= 20) {
        const chunk = Buffer.alloc(Math.min(offset, 8192));
        offset -= chunk.length;
        const bytes = readSync(fd, chunk, 0, chunk.length, offset);
        const data = chunk.subarray(0, bytes);
        for (const byte of data) if (byte === 10) lines++;
        chunks.unshift(data);
      }
      return { code: result.status, output: Buffer.concat(chunks).toString('utf8') };
    } finally { closeSync(fd); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
