import { selectTestBackend } from './state-helper.ts';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli/main.ts');

/** A project folder with a alba.yaml (extra yaml text appended) on a temporary directory. */
export function projectDir(dir: string, extraYaml = ''): string {
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const file = path.join(dir, 'alba.yaml');
  writeFileSync(file, `id: demo\nname: Demo\nroot: .\nwork_orders: orders\nstate_dir: state\n${extraYaml}`);
  return file;
}

/** Runs the real command line (`alba ...`) and returns what it printed and its exit code. */
export function alba(project: string, args: string[], env: Record<string, string> = {}): { code: number | null; out: string; err: string } {
  selectTestBackend(project);
  // CLI fixtures must not inherit the host's project or worker configuration.
  const fixtureEnv = { ...process.env };
  delete fixtureEnv.ALBA_PROJECT;
  delete fixtureEnv.ALBA_WORKERS;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, '--project', project, ...args], { encoding: 'utf8', env: { ...fixtureEnv, ALBA_LANG: 'en', ...env }, timeout: 60000 });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
