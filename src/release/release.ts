import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { UserError, releaseText as text } from '../i18n.ts';
import { auditBuild } from './audit.ts';
import { publicCommand, type BuildCommand } from './build.ts';
import type { ReleaseConfig, ReleaseEngine, ReleaseTarget } from './config.ts';
import { projectDirectory } from './paths.ts';
import { runBuild } from './runner.ts';
import { onPath } from './tools.ts';
import { unrealCrypto } from './unreal.ts';

export interface TargetBuild { target: ReleaseTarget; build: BuildCommand }

function printable(word: string): string {
  if (/^[\w./:=+-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`;
}

export function vesperArgs(build: BuildCommand, app: string, target: ReleaseTarget, version: string): string[] {
  return ['pack', '--input', build.outputDir, '--output', `${build.outputDir}-vesper`, '--app-id', app,
    '--platform', target, '--version', version, '--release-tag', `v${version}-${target}`];
}

export const vesperLine = (args: string[]): string => ['vesper', ...args.map(printable)].join(' ');

export async function packageTargets(project: ProjectConfig, config: ReleaseConfig, engine: ReleaseEngine, version: string,
  builds: TargetBuild[], options: { skipAudit: boolean; vesperPack: boolean }): Promise<{ code: number; output: string }> {
  let code = 0;
  const output: string[] = [];
  const excludedEnv = config.godot.encryption_key_env ? [config.godot.encryption_key_env] : [];
  for (const { target, build } of builds) {
    const targetDir = path.dirname(build.outputDir);
    try {
      projectDirectory(project.root, path.dirname(targetDir));
      try { mkdirSync(targetDir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') text.existingRelease({ dir: targetDir });
        throw error;
      }
      mkdirSync(build.outputDir);
    } catch (error) {
      output.push(error instanceof UserError ? error.message : text.outputFailed({ dir: targetDir }));
      code = 1;
      continue;
    }

    for (const notice of build.notices) console.warn(notice());
    if (options.skipAudit) console.warn(text.skipAudit({ target }));
    const started = new Date().toISOString();
    let exit_code = 1;
    let build_error: string | undefined;
    try {
      const secrets = engine === 'unreal' ? unrealCrypto(project.root, config.unreal) : [];
      exit_code = await runBuild(build, { engineLog: engine === 'unity', secrets, excludedEnv });
    } catch (error) {
      build_error = error instanceof UserError ? error.message : text.buildLogFailed({ file: build.logFile });
      output.push(build_error);
      if (!existsSync(build.logFile)) writeFileSync(build.logFile, `${build_error}\n`, { flag: 'wx' });
    }

    const audit = options.skipAudit ? { skipped: true as const } : await auditBuild(build.outputDir, engine, config.audit, config.unreal.sign_pak)
      .catch(error => ({ error: error instanceof UserError ? error.message : text.auditFailed({ dir: build.outputDir }) }));
    if ('error' in audit) output.push(audit.error);
    if ('findings' in audit) output.push(formatAudit(audit));
    const report = {
      engine, target, version, command: publicCommand(build), started, finished: new Date().toISOString(), exit_code,
      ...(build_error && { build_error }), audit, hardening: { ...build.hardening, audit_allow: config.audit.allow },
    };
    const file = path.join(targetDir, 'release.json');
    const draft = `${file}.tmp`;
    writeFileSync(draft, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    renameSync(draft, file);
    output.push(text.releaseReport({ target, exit: exit_code, file }));
    if (exit_code || 'error' in audit || ('summary' in audit && audit.summary.fail)) {
      code = 1;
      continue;
    }
    if (!config.vesper) continue;

    const args = vesperArgs(build, config.vesper.app_id, target, version);
    console.log(vesperLine(args));
    if (!options.vesperPack) continue;
    const vesper = onPath('vesper');
    if (!vesper) {
      output.push(text.vesperMissing());
      code = 1;
      continue;
    }
    const logFile = path.join(targetDir, 'vesper.log');
    const packCode = await runBuild({ command: vesper, args, env: {}, cwd: project.root, logFile }, { excludedEnv }).catch(() => 1);
    output.push(text.vesperResult({ target, exit: packCode, file: logFile }));
    if (packCode) code = 1;
  }
  return { code, output: output.join('\n') };
}

export function formatAudit(result: Awaited<ReturnType<typeof auditBuild>>): string {
  return [
    text.auditSummary(result.summary),
    ...result.findings.flatMap(finding => [
      `[${finding.severity === 'fail' ? text.auditFail() : text.auditWarn()}] ${finding.id}: ${finding.advice}`,
      ...(finding.reason ? [text.auditAllowed({ reason: finding.reason })] : []),
      ...finding.files.map(file => `  ${file}${finding.excerpts?.[file] ? ` (${finding.excerpts[file]})` : ''}`),
    ]),
  ].join('\n');
}
