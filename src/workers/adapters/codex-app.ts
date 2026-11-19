import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../../i18n.ts';
import { liveMessagesEnabled } from '../config.ts';
import { codex } from './codex.ts';
import { generic } from './generic.ts';
import type { WorkerAdapter } from './types.ts';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface CodexAppFlags {
  config: string[];
  model?: string;
  sandbox?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
}

const SANDBOX_MODES = new Set<string>(['read-only', 'workspace-write', 'danger-full-access']);
const APPROVAL_POLICIES = new Set<string>(['untrusted', 'on-request', 'never']);
const RUNNER_PATH = fileURLToPath(new URL('./codex-app-run.mjs', import.meta.url));

/**
 * Maps `codex exec` template flags from `launch.args` to `codex app-server` parameters.
 * Refuses any flag it cannot map with a clear error at config load time.
 */
export function parseCodexAppFlags(args: readonly string[], where = 'codex-app'): CodexAppFlags {
  const out: CodexAppFlags = { config: [] };
  const takeValue = (flag: string, inline: string | undefined, idx: number): { value: string; next: number } => {
    if (inline !== undefined) {
      if (!inline) fail('{where}: flag "{flag}" requires a value.', { where, flag });
      return { value: inline, next: idx };
    }
    const v = args[idx + 1];
    if (v === undefined) fail('{where}: flag "{flag}" requires a value.', { where, flag });
    return { value: v, next: idx + 1 };
  };

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (!raw) continue;
    if (!raw.startsWith('-')) {
      // Positional words from exec templates (`exec`, `resume`, `{session_args}`, prompt text) are handled by the driver.
      continue;
    }
    const eq = raw.indexOf('=');
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;

    if (flag === '-c' || flag === '--config') {
      const r = takeValue(flag, inline, i);
      i = r.next;
      out.config.push(r.value);
      continue;
    }
    if (flag === '-m' || flag === '--model') {
      const r = takeValue(flag, inline, i);
      i = r.next;
      if (r.value && r.value !== '{model}') out.model = r.value;
      continue;
    }
    if (flag === '-s' || flag === '--sandbox') {
      const r = takeValue(flag, inline, i);
      i = r.next;
      if (!SANDBOX_MODES.has(r.value)) {
        fail('{where}: unsupported sandbox mode "{value}" for codex-app (allowed: read-only, workspace-write, danger-full-access).', { where, value: r.value });
      }
      out.sandbox = r.value as CodexSandboxMode;
      continue;
    }
    if (flag === '-a' || flag === '--ask-for-approval') {
      const r = takeValue(flag, inline, i);
      i = r.next;
      if (!APPROVAL_POLICIES.has(r.value)) {
        fail('{where}: unsupported approval policy "{value}" for codex-app (allowed: untrusted, on-request, never).', { where, value: r.value });
      }
      out.approvalPolicy = r.value as CodexApprovalPolicy;
      continue;
    }
    if (flag === '--full-auto') {
      out.approvalPolicy = 'on-request';
      out.sandbox = 'workspace-write';
      continue;
    }
    if (flag === '--dangerously-bypass-approvals-and-sandbox') {
      out.approvalPolicy = 'never';
      out.sandbox = 'danger-full-access';
      continue;
    }
    if (flag === '-C' || flag === '--cd' || flag === '-o' || flag === '--output-last-message') {
      const r = takeValue(flag, inline, i);
      i = r.next;
      continue;
    }
    if (flag === '--json' || flag === '--skip-git-repo-check' || flag === '-') {
      continue;
    }
    fail('{where}: engine codex-app cannot map flag "{flag}" to codex app-server.', { where, flag });
  }
  return out;
}

export const codexApp: WorkerAdapter = {
  ...generic,
  id: 'codex-app',
  structured: true,
  nativeResume: true,
  verifierArgs: codex.verifierArgs,
  verifierServers: codex.verifierServers,
  usage: codex.usage,
  prepare(args, c) {
    const parsed = parseCodexAppFlags([...(c.extraArgs ?? []), ...args], `worker "${c.worker.id}"`);
    const model = c.worker.model ?? c.worker.launch?.model ?? parsed.model;
    const specFile = c.promptFile.endsWith('.prompt.md')
      ? c.promptFile.slice(0, -'.prompt.md'.length) + '.codex-app.json'
      : path.join(c.stateDir, 'runs', `codex-app-${randomUUID()}.json`);
    mkdirSync(path.dirname(specFile), { recursive: true });
    const spec = {
      codexProgram: c.program ?? c.worker.launch?.program ?? 'codex',
      config: parsed.config,
      cwd: c.cwd ?? process.cwd(),
      promptFile: c.promptFile,
      lastFile: c.lastFile,
      ...(model ? { model } : {}),
      ...(parsed.approvalPolicy ? { approvalPolicy: parsed.approvalPolicy } : {}),
      ...(parsed.sandbox ? { sandbox: parsed.sandbox } : {}),
      ...(c.resume ? { resume: c.resume } : {}),
      liveMessages: liveMessagesEnabled(c.worker) && !c.remote,
    };
    writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    const driverArgs = [RUNNER_PATH, '--spec', specFile];
    args.splice(0, args.length, ...driverArgs);
    return { program: process.execPath, args: driverArgs, env: c.env, envUnset: c.envUnset };
  },
};
