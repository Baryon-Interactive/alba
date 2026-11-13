import { spawn, spawnSync } from 'node:child_process';
export function runRemote(spec: Record<string, any>, transport?: { run?: typeof spawnSync; spawn?: typeof spawn; say?: (text: string) => void }): Promise<number>;
