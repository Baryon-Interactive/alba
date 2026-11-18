import path from 'node:path';
import type { parseReleaseArgs } from '../cli/args.ts';
import { loadProject } from '../config.ts';
import { fail, releaseText as text } from '../i18n.ts';
import { auditBuild } from './audit.ts';
import { buildCommand, publicCommand } from './build.ts';
import { isReleaseEngine, isReleaseTarget, RELEASE_TARGETS, validVersion, validateRelease } from './config.ts';
import { initUnity } from './init-unity.ts';
import { formatAudit, packageTargets, vesperArgs, vesperLine } from './release.ts';
import { resolveBuildTools } from './tools.ts';

export const releaseHelp = (): string => [text.helpPlan, text.helpBuild, text.helpAudit, text.helpInit]
  .map(line => `  ${line()}`).join('\n');

type Flags = ReturnType<typeof parseReleaseArgs>['values'];
const acceptedFlags: Record<string, readonly string[]> = {
  audit: ['engine', 'json'], 'init-unity': ['force'], plan: ['target', 'version'],
  build: ['target', 'version', 'skip-audit', 'dry-run', 'vesper-pack'],
};

export async function runReleaseCli(command: string | undefined, args: string[], flags: Flags, file?: string): Promise<{ code: number; output: string }> {
  if (!command || !Object.hasOwn(acceptedFlags, command) || args.length !== (command === 'audit' ? 1 : 0)) return text.releaseUsage();
  for (const flag of Object.keys(flags)) {
    if (flag !== 'project' && !acceptedFlags[command].includes(flag)) return text.releaseFlag({ flag, command });
  }
  const project = file ? loadProject(file) : undefined;
  if (command === 'audit') {
    const engine = flags.engine;
    if (engine !== undefined && !isReleaseEngine(engine)) return text.releaseEngineOption();
    const result = await auditBuild(path.resolve(args[0]), engine, project?.release?.audit, project?.release?.unreal.sign_pak);
    return { code: result.summary.fail ? 1 : 0, output: flags.json ? JSON.stringify(result, null, 2) : formatAudit(result) };
  }
  if (!project) fail('No project file. Pass --project <alba.yaml> or set ALBA_PROJECT.');
  if (command === 'init-unity') return { code: 0, output: text.templateReady({ file: initUnity(project.root, !!flags.force) }) };
  const engine = project.engine;
  if (!engine || !isReleaseEngine(engine)) return text.releaseEngine({ file: project.file });
  const config = project.release ?? validateRelease({}, project.file);
  const version = flags.version ?? config.version ?? '0.0.0';
  if (!validVersion(version)) return text.releaseVersion({ expected: text.version() });
  const targets = [...new Set(flags.target ?? config.targets)].map(target => {
    if (!isReleaseTarget(target)) return text.releaseTarget({ targets: RELEASE_TARGETS.join(', ') });
    return target;
  });
  if (!targets.length) return text.noReleaseTargets();
  if (flags['vesper-pack'] && !config.vesper) return text.noVesperConfig();

  const tools = resolveBuildTools(project, config, engine);
  const builds = targets.map(target => ({ target, build: buildCommand(project, config, engine, target, version, tools) }));
  if (command === 'plan' || flags['dry-run']) {
    const plans = builds.map(({ target, build }) => ({
      engine, target, version, ...publicCommand(build), logFile: build.logFile, outputDir: build.outputDir,
      hardening: build.hardening, notices: build.notices.map(notice => notice()),
      ...(config.vesper && { vesper: vesperLine(vesperArgs(build, config.vesper.app_id, target, version)) }),
    }));
    return { code: 0, output: JSON.stringify(plans, null, 2) };
  }
  return packageTargets(project, config, engine, version, builds, { skipAudit: !!flags['skip-audit'], vesperPack: !!flags['vesper-pack'] });
}
