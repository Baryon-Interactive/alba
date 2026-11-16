export interface NamedLockView { name: string; holder?: number; host?: string; command?: string; cwd?: string; since: string; heldMinutes: number; stale: boolean }
export const lockDirectory: () => string;
export function listNamedLocks(now?: number): NamedLockView[];
export function runNamedLock(argv: string[]): Promise<number>;
export const usage: () => string;
