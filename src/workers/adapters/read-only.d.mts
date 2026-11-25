export function worktreeFingerprint(cwd: string): string;
export const codexReadOnlyFeatures: string[];
export function codexVerifierServers(program: string, cwd: string, run: (command: string[]) => string): string[];
export function disableServers(names: string[]): string[];
