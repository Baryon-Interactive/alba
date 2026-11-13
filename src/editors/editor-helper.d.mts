export interface EditorSpec {
  pool: string; port: number; program: string; args: string[]; url: string; match: string; log: string; ready_minutes: number;
  /** The argument that names the worktree (the project file): an editor counts as this run's only with both. */
  match_worktree?: string;
  desktop?: boolean; state_file?: string;
  /** Run in the worktree before the editor starts (editors.<pool>.prepare), with its output in `log`. */
  prepare?: {
    command: string[]; cwd: string; log: string; skip_if_newer?: { outputs: string[]; inputs: string[] };
    retry_exit_codes: number[]; retries: number; retry_seconds: number; timeout_minutes: number;
  };
}
export function prepareEditor(spec: EditorSpec): Promise<'skipped' | 'done' | undefined>;
export function editorSaid(log: string): string | undefined;
export function findEditors(spec: EditorSpec): number[];
export function stopEditorsNow(spec: EditorSpec): number[];
export function stopEditors(spec: EditorSpec, waitMs?: number): Promise<number[]>;
export function answers(url: string, timeoutMs?: number): Promise<boolean>;
export function startEditor(spec: EditorSpec): Promise<void>;
export function readSpec(file: string): EditorSpec;
