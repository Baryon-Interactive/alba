import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ScreenshotVerifyConfig } from '../config.ts';
import { processStartedAtAsync } from '../monitor/process.ts';
import { writeFileAtomic } from '../orders/store.ts';
import { sheetFromFiles } from '../review/sheet.ts';
import { stopTreeAsync, type TreeTarget } from '../run/kill-tree.ts';
import { decodePng, imageFormat, summarizePng } from '../verify/png.ts';
import { expandCaptureCommand, expandCaptureString, shotFinalTemplate, type CapturePlaceholders } from './config.ts';
import { evaluateCaptureGates, type DecodedCaptureShot } from './gates.ts';
import type { CaptureManifest, CaptureManifestShot, CaptureRecipe } from './types.ts';

export interface CaptureRunnerJob {
  tag: string;
  report: number | null;
  trial: string | null;
  branch: string;
  revision: string;
  worktree: string;
  outDir: string;
  albaDir: string;
  dirty: string[];
  recipe: CaptureRecipe;
  screenshots: ScreenshotVerifyConfig | 'off';
  spawnedAt: number;
  pidFile: string;
}

const slash = (p: string) => p.replace(/\\/g, '/');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

interface ExecOutcome {
  exitCode: number | null;
  spawnError?: Error;
  timedOut: boolean;
  stoppedAfterFile: boolean;
  durationMs: number;
  startedIso: string;
}

let activeTarget: TreeTarget | undefined;

async function runProcess(
  command: string[],
  cwd: string,
  logFile: string,
  timeoutMs: number,
  watchOutFile?: string,
): Promise<ExecOutcome> {
  mkdirSync(path.dirname(logFile), { recursive: true });
  writeFileSync(logFile, '', 'utf8');
  const notBefore = Date.now();
  const startedIso = new Date(notBefore).toISOString();

  let spawnError: Error | undefined;
  let exitCode: number | null = null;
  let exited = false;
  let timedOut = false;
  let stoppedAfterFile = false;

  const child = spawn(command[0], command.slice(1), {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const appendLog = (chunk: Buffer | string) => {
    try { appendFileSync(logFile, chunk); } catch { /* ignore log write races */ }
  };
  const stdoutDone = new Promise<void>(resolve => {
    if (!child.stdout) { resolve(); return; }
    child.stdout.on('data', appendLog);
    child.stdout.once('end', () => resolve());
    child.stdout.once('error', () => resolve());
  });
  const stderrDone = new Promise<void>(resolve => {
    if (!child.stderr) { resolve(); return; }
    child.stderr.on('data', appendLog);
    child.stderr.once('end', () => resolve());
    child.stderr.once('error', () => resolve());
  });

  const target = (): TreeTarget | undefined => child.pid
    ? { pid: child.pid, notBefore, ownsRoot: !exited && child.exitCode === null && child.signalCode === null }
    : undefined;

  activeTarget = target();

  const exitPromise = new Promise<void>(resolve => {
    child.once('error', err => {
      spawnError = err;
      exited = true;
      appendLog(`${err.message}\n`);
      resolve();
    });
    child.once('exit', code => {
      exitCode = code;
      exited = true;
      resolve();
    });
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>(resolve => {
    timeoutHandle = setTimeout(() => resolve('timeout'), Math.max(1, Math.ceil(timeoutMs)));
  });

  let watchCancelled = false;
  const watchPromise = watchOutFile
    ? (async (): Promise<'file' | 'exited'> => {
        let lastSize = -1;
        let stableSince = 0;
        while (!exited && !watchCancelled) {
          if (existsSync(watchOutFile)) {
            try {
              const data = readFileSync(watchOutFile);
              if (data.length > 0) {
                if (decodePng(data).status === 'ok') return 'file';
                if (data.length !== lastSize) {
                  lastSize = data.length;
                  stableSince = Date.now();
                } else if (Date.now() - stableSince >= 250) {
                  return 'file';
                }
              }
            } catch { /* file still being written */ }
          }
          await pause(50);
        }
        return 'exited';
      })()
    : new Promise<'exited'>(() => {});

  const winner = await Promise.race([
    exitPromise.then(() => 'exit' as const),
    timeoutPromise,
    watchPromise,
  ]);

  watchCancelled = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (winner === 'file') {
    stoppedAfterFile = true;
    const t = target();
    if (t) await stopTreeAsync(t, 15_000);
    await Promise.race([exitPromise, pause(1000)]);
  } else if (winner === 'timeout') {
    timedOut = true;
    const t = target();
    if (t) await stopTreeAsync(t, 15_000);
    await Promise.race([exitPromise, pause(1000)]);
  }

  activeTarget = undefined;
  await Promise.race([Promise.all([stdoutDone, stderrDone]), pause(150)]);
  return { exitCode, spawnError, timedOut, stoppedAfterFile, durationMs: Date.now() - notBefore, startedIso };
}

async function runJob(job: CaptureRunnerJob): Promise<number> {
  const waitedMs = Math.max(0, Date.now() - job.spawnedAt);
  const launchedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  mkdirSync(path.dirname(job.pidFile), { recursive: true });
  writeFileSync(job.pidFile, JSON.stringify({ pid: process.pid, launchedAt }), 'utf8');

  const pidAbort = new AbortController();
  processStartedAtAsync(process.pid, pidAbort.signal).then(startedAt => {
    if (startedAt && existsSync(job.pidFile)) {
      try { writeFileSync(job.pidFile, JSON.stringify({ pid: process.pid, startedAt, launchedAt }), 'utf8'); } catch { /* ignore */ }
    }
  }).catch(() => {});

  const startedAtIso = new Date().toISOString();
  mkdirSync(job.outDir, { recursive: true });

  const baseVars: CapturePlaceholders = {
    tag: job.tag,
    worktree: slash(job.worktree),
    out_dir: slash(job.outDir),
    revision: job.revision,
    alba: slash(job.albaDir),
    alba_skills: slash(path.join(job.albaDir, 'templates', 'skills')),
  };

  let buildRecord: CaptureManifest['build'] = null;
  let artifactRecord: CaptureManifest['artifact'] = null;
  const failures: string[] = [];
  let buildStartedMs: number | undefined;

  try {
    if (job.recipe.build) {
      if (job.recipe.artifact) {
        const candidate = path.resolve(job.worktree, expandCaptureString(job.recipe.artifact, baseVars));
        if (existsSync(candidate)) await pause(15);
      }
      buildStartedMs = Date.now();
      const buildCmd = expandCaptureCommand(job.recipe.build, baseVars);
      const buildOutcome = await runProcess(
        buildCmd,
        job.worktree,
        path.join(job.outDir, 'build.log'),
        job.recipe.build_timeout_minutes * 60_000,
      );
      buildRecord = { code: buildOutcome.exitCode, duration_ms: buildOutcome.durationMs, log: 'build.log' };
      if (buildOutcome.spawnError) {
        failures.push(`Build could not start: ${buildOutcome.spawnError.message}`);
      } else if (buildOutcome.timedOut) {
        failures.push(`Build timed out after ${job.recipe.build_timeout_minutes} min (stopped)`);
      } else if (buildOutcome.exitCode !== 0) {
        failures.push(`Build exited with code ${buildOutcome.exitCode ?? 'signal'}`);
      }
    }

    if (!failures.length && job.recipe.artifact) {
      const expandedArtifact = expandCaptureString(job.recipe.artifact, baseVars);
      const artifactAbs = path.resolve(job.worktree, expandedArtifact);
      const relArtifact = slash(path.relative(job.worktree, artifactAbs));
      if (!existsSync(artifactAbs) || !statSync(artifactAbs).isFile()) {
        failures.push(`Artifact ${relArtifact} does not exist after build`);
      } else {
        const info = statSync(artifactAbs);
        const mtimeIso = new Date(info.mtimeMs).toISOString();
        artifactRecord = { path: relArtifact, mtime: mtimeIso, sha256: sha256File(artifactAbs) };
        if (buildStartedMs !== undefined && info.mtimeMs < buildStartedMs) {
          failures.push(`Artifact ${relArtifact} is stale (mtime ${mtimeIso} is older than build start ${new Date(buildStartedMs).toISOString()})`);
        }
      }
    }

    const shotResults: CaptureManifestShot[] = [];
    const decodedShots: DecodedCaptureShot[] = [];

    if (!failures.length) {
      const shotsDeadline = Date.now() + job.recipe.timeout_minutes * 60_000;
      for (const shot of job.recipe.shots) {
        const fileRel = `${shot.name}.png`;
        const outAbs = path.join(job.outDir, fileRel);
        const logAbs = path.join(job.outDir, `${shot.name}.log`);
        rmSync(outAbs, { force: true });

        const remainingMs = shotsDeadline - Date.now();
        if (remainingMs <= 0) {
          const reason = `no picture after ${job.recipe.timeout_minutes * 60} s recipe budget (stopped)`;
          shotResults.push({ name: shot.name, file: fileRel, status: 'failed', reason, exit_code: null, started: new Date().toISOString(), duration_ms: 0 });
          continue;
        }

        const shotTimeoutMs = Math.min(shot.timeout_seconds * 1000, remainingMs);
        const usedSeconds = shotTimeoutMs === shot.timeout_seconds * 1000 ? shot.timeout_seconds : Math.max(0.1, Math.round(shotTimeoutMs / 100) / 10);
        const shotVars: CapturePlaceholders = { ...baseVars, out: slash(outAbs), shot: shot.name };
        const cmd = expandCaptureCommand(shotFinalTemplate(job.recipe, shot), shotVars);
        const mode = shot.done ?? job.recipe.done;

        const outcome = await runProcess(
          cmd,
          job.worktree,
          logAbs,
          shotTimeoutMs,
          mode === 'file' ? outAbs : undefined,
        );

        if (outcome.spawnError) {
          shotResults.push({
            name: shot.name, file: fileRel, status: 'failed',
            reason: `the program could not start: ${outcome.spawnError.message}`,
            exit_code: null, started: outcome.startedIso, duration_ms: outcome.durationMs,
          });
          continue;
        }

        if (outcome.timedOut && !outcome.stoppedAfterFile) {
          shotResults.push({
            name: shot.name, file: fileRel, status: 'failed',
            reason: `no picture after ${usedSeconds} s (stopped)`,
            exit_code: outcome.exitCode, started: outcome.startedIso, duration_ms: outcome.durationMs,
          });
          continue;
        }

        if (!existsSync(outAbs) || statSync(outAbs).size === 0) {
          const reason = outcome.exitCode !== 0 && outcome.exitCode !== null
            ? `exited with code ${outcome.exitCode} before writing the picture`
            : 'exited without writing the picture';
          shotResults.push({
            name: shot.name, file: fileRel, status: 'failed',
            reason, exit_code: outcome.exitCode, started: outcome.startedIso, duration_ms: outcome.durationMs,
          });
          continue;
        }

        if (!outcome.stoppedAfterFile && outcome.exitCode !== 0) {
          shotResults.push({
            name: shot.name, file: fileRel, status: 'failed',
            reason: `exited with code ${outcome.exitCode ?? 'signal'}`,
            exit_code: outcome.exitCode, started: outcome.startedIso, duration_ms: outcome.durationMs,
          });
          continue;
        }

        const data = readFileSync(outAbs);
        const bytes = data.length;
        const sha256 = createHash('sha256').update(data).digest('hex');
        const fmt = imageFormat(data);
        const effectiveExit = outcome.stoppedAfterFile ? 0 : (outcome.exitCode ?? 0);

        if (fmt !== 'PNG') {
          shotResults.push({
            name: shot.name, file: fileRel, status: 'failed',
            reason: `not a PNG (${fmt})`,
            exit_code: effectiveExit, started: outcome.startedIso, duration_ms: outcome.durationMs, bytes, sha256,
          });
          continue;
        }

        const decoded = decodePng(data);
        if (decoded.status !== 'ok') {
          shotResults.push({
            name: shot.name, file: fileRel, status: 'failed',
            reason: `not decodable (${decoded.reason})`,
            exit_code: effectiveExit, started: outcome.startedIso, duration_ms: outcome.durationMs, bytes, sha256,
          });
          continue;
        }

        const summary = summarizePng(decoded.image);
        shotResults.push({
          name: shot.name, file: fileRel, status: 'ok', reason: '',
          exit_code: effectiveExit, started: outcome.startedIso, duration_ms: outcome.durationMs,
          bytes, sha256, width: decoded.image.width, height: decoded.image.height,
          mean_luminance: summary.meanLuminance, luminance_stddev: summary.luminanceStddev, dark_fraction: summary.darkFraction,
        });
        decodedShots.push({ name: shot.name, file: fileRel, sha256, image: decoded.image, summary });
      }
    }

    let sheetRel: string | null = null;
    if (decodedShots.length > 0) {
      const sheetOut = path.join(job.outDir, 'sheet.png');
      const built = sheetFromFiles(decodedShots.map(s => path.join(job.outDir, s.file)), { tag: job.tag, out: sheetOut });
      if (built.out) sheetRel = 'sheet.png';
    }

    const gates = decodedShots.length > 0 ? evaluateCaptureGates(decodedShots, job.recipe, job.screenshots) : [];

    for (const s of shotResults) {
      if (s.status === 'failed') failures.push(`Shot ${s.name}: ${s.reason}`);
    }
    for (const g of gates) {
      if (g.status === 'fail') failures.push(`Gate ${g.name}: ${g.detail}`);
    }

    const status = failures.length ? 'failed' : 'passed';
    const manifest: CaptureManifest = {
      version: 1,
      tag: job.tag,
      recipe: job.recipe.name,
      report: job.report,
      trial: job.trial,
      branch: job.branch,
      revision: job.revision,
      dirty: job.dirty,
      lock: { name: job.recipe.lock, waited_ms: waitedMs },
      build: buildRecord,
      artifact: artifactRecord,
      started: startedAtIso,
      ended: new Date().toISOString(),
      status,
      reason: failures.join('; '),
      shots: shotResults,
      gates,
      sheet: sheetRel,
    };

    writeFileAtomic(path.join(job.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return status === 'passed' ? 0 : 1;
  } finally {
    pidAbort.abort();
    if (activeTarget) {
      await stopTreeAsync(activeTarget, 10_000).catch(() => {});
      activeTarget = undefined;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      const t = activeTarget;
      activeTarget = undefined;
      if (t) stopTreeAsync(t, 10_000).finally(() => process.exit(130));
      else process.exit(130);
    });
  }
  const jobFile = process.argv[2];
  if (!jobFile || !existsSync(jobFile)) {
    process.stderr.write('usage: runner.ts <job.json>\n');
    process.exitCode = 2;
  } else {
    const job = JSON.parse(readFileSync(jobFile, 'utf8')) as CaptureRunnerJob;
    process.exitCode = await runJob(job);
  }
}
