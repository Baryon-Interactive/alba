import { globToRegExp } from '../check/general.ts';
import { DEFAULT_SCREENSHOT_THRESHOLDS, type LuminanceGate, type MotionGate, type ScreenshotVerifyConfig } from '../config.ts';
import { meanAbsoluteLuminanceDifference, meanLuminance, regionError, type DecodedPng, type ImageSummary, type PixelRegion } from '../verify/png.ts';
import type { CaptureGateResult, CaptureRecipe } from './types.ts';

export interface DecodedCaptureShot {
  name: string;
  file: string;
  sha256: string;
  image: DecodedPng;
  summary: ImageSummary;
}

function namedGlob(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith('{name}', i)) { out += '(.+)'; i += 5; continue; }
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      out += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
      if (g[i + 2] === '/') i += 2; else i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function matchNamedShot(shotFile: string, glob: string): string | undefined {
  const m = namedGlob(glob).exec(shotFile);
  return m ? (m[1] ?? '') : undefined;
}

export function evaluateCaptureGates(
  shots: readonly DecodedCaptureShot[],
  recipe: CaptureRecipe,
  screenshots: ScreenshotVerifyConfig | 'off',
): CaptureGateResult[] {
  if (!shots.length) return [];
  const config: ScreenshotVerifyConfig = screenshots === 'off' ? DEFAULT_SCREENSHOT_THRESHOLDS : screenshots;
  const gates: CaptureGateResult[] = [];
  const allNames = shots.map(s => s.name).join(', ');

  // 1. identical: same sha256 or 16x16 thumbnail difference below duplicate_diff
  const identicalPairs: string[] = [];
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      const a = shots[i], b = shots[j];
      if (a.sha256 === b.sha256) {
        identicalPairs.push(`${a.name} = ${b.name}`);
      } else {
        const diff = a.summary.thumbnail.reduce((sum, value, index) => sum + Math.abs(value - b.summary.thumbnail[index]), 0) / 256;
        if (diff < config.duplicate_diff) {
          identicalPairs.push(`${a.name} ~ ${b.name} (${(diff * 100).toFixed(2)}%)`);
        }
      }
    }
  }
  gates.push({
    name: 'identical',
    status: identicalPairs.length ? 'fail' : 'pass',
    detail: identicalPairs.length ? `Identical shots: ${identicalPairs.join('; ')}.` : `Distinct shots: ${allNames}.`,
  });

  // 2. blank: luminance stddev below blank_std
  const blankShots = shots.filter(s => s.summary.luminanceStddev < config.blank_std);
  gates.push({
    name: 'blank',
    status: blankShots.length ? 'fail' : 'pass',
    detail: blankShots.length
      ? `Blank shots (stddev below ${config.blank_std}): ${blankShots.map(s => `${s.name} (${s.summary.luminanceStddev.toFixed(4)})`).join(', ')}.`
      : `Non-blank shots: ${shots.map(s => `${s.name} (${s.summary.luminanceStddev.toFixed(4)})`).join(', ')}.`,
  });

  // 3. dark: mean below dark_mean or darkFraction above dark_fraction -> warns
  const darkShots = shots.filter(s => s.summary.meanLuminance < config.dark_mean || s.summary.darkFraction > config.dark_fraction);
  gates.push({
    name: 'dark',
    status: darkShots.length ? 'warn' : 'pass',
    detail: darkShots.length
      ? `Dark shots: ${darkShots.map(s => `${s.name} (mean ${s.summary.meanLuminance.toFixed(4)}, dark ${(s.summary.darkFraction * 100).toFixed(1)}%)`).join(', ')}.`
      : `Brightness ok: ${shots.map(s => `${s.name} (mean ${s.summary.meanLuminance.toFixed(4)})`).join(', ')}.`,
  });

  // 4. size: every shot must match recipe.size when configured
  if (recipe.size) {
    const [expectedW, expectedH] = recipe.size;
    const wrongSize = shots.filter(s => s.image.width !== expectedW || s.image.height !== expectedH);
    gates.push({
      name: 'size',
      status: wrongSize.length ? 'fail' : 'pass',
      detail: wrongSize.length
        ? `Wrong size (expected ${expectedW}x${expectedH}): ${wrongSize.map(s => `${s.name} (${s.image.width}x${s.image.height})`).join(', ')}.`
        : `Size ${expectedW}x${expectedH}: ${allNames}.`,
    });
  }

  // 5. baseline: every other shot must differ from baseline by at least min_change (0..255)
  if (recipe.baseline) {
    const base = shots.find(s => s.name === recipe.baseline);
    if (!base) {
      gates.push({
        name: 'baseline',
        status: 'fail',
        detail: `Baseline shot ${recipe.baseline} was not captured.`,
      });
    } else {
      const others = shots.filter(s => s.name !== recipe.baseline);
      const failures: string[] = [];
      const diffs: string[] = [];
      for (const s of others) {
        if (s.image.width !== base.image.width || s.image.height !== base.image.height) {
          failures.push(`${s.name} (${s.image.width}x${s.image.height}) differs in size from ${base.name} (${base.image.width}x${base.image.height})`);
          continue;
        }
        const diff = meanAbsoluteLuminanceDifference(s.image, base.image);
        diffs.push(`${s.name} vs ${base.name} (${diff.toFixed(2)})`);
        if (diff < recipe.min_change) {
          failures.push(`${s.name} looks like ${base.name} (diff ${diff.toFixed(2)} < ${recipe.min_change})`);
        }
      }
      gates.push({
        name: 'baseline',
        status: failures.length ? 'fail' : 'pass',
        detail: failures.length
          ? `Baseline ${base.name}: ${failures.join('; ')}.`
          : `Baseline ${base.name} (min ${recipe.min_change}): ${diffs.join(', ') || base.name}.`,
      });
    }
  }

  // 6. luminance rules (match against <shot>.png)
  const luminanceRules: LuminanceGate[] = screenshots === 'off' ? [] : screenshots.luminance ?? [];
  if (luminanceRules.length) {
    const failures: string[] = [], warnings: string[] = [], measurements: string[] = [];
    for (const rule of luminanceRules) {
      const re = globToRegExp(rule.match);
      const selected = shots.filter(s => re.test(s.file));
      if (!selected.length) {
        warnings.push(`Luminance rule ${rule.match} matched no shot (${allNames}).`);
        continue;
      }
      for (const s of selected) {
        const regionProblem = regionError(s.image, rule.region as PixelRegion | undefined);
        if (regionProblem) { failures.push(`${s.name} (${s.file}): ${regionProblem}.`); continue; }
        const value = meanLuminance(s.image, rule.region as PixelRegion | undefined);
        measurements.push(`${s.name} (${s.file}): mean luminance ${value.toFixed(4)}${rule.mean_min !== undefined ? ` (minimum ${rule.mean_min})` : ''}${rule.mean_max !== undefined ? ` (maximum ${rule.mean_max})` : ''}.`);
        if (rule.mean_min !== undefined && value < rule.mean_min) failures.push(`${s.name} (${s.file}): mean luminance ${value.toFixed(4)} is below ${rule.mean_min}.`);
        if (rule.mean_max !== undefined && value > rule.mean_max) failures.push(`${s.name} (${s.file}): mean luminance ${value.toFixed(4)} is above ${rule.mean_max}.`);
      }
    }
    gates.push({
      name: 'luminance',
      status: failures.length ? 'fail' : warnings.length ? 'warn' : 'pass',
      detail: [...failures, ...warnings, ...measurements].join(' '),
    });
  }

  // 7. motion rules (a and b against <shot>.png)
  const motionRules: MotionGate[] = screenshots === 'off' ? [] : screenshots.motion ?? [];
  if (motionRules.length) {
    const failures: string[] = [], warnings: string[] = [], measurements: string[] = [];
    for (const rule of motionRules) {
      const as = shots.map(s => ({ s, key: matchNamedShot(s.file, rule.a) })).filter((x): x is { s: DecodedCaptureShot; key: string } => x.key !== undefined);
      if (!as.length) {
        warnings.push(`Motion rule ${rule.a} / ${rule.b} matched no shot (${allNames}).`);
        continue;
      }
      for (const { s: a, key } of as) {
        const b = shots.find(candidate => candidate.name !== a.name && matchNamedShot(candidate.file, rule.b) === key);
        if (!b) {
          warnings.push(`Motion rule ${rule.a} / ${rule.b} has no pair for ${a.name} (${a.file}).`);
          continue;
        }
        const regionProblem = regionError(a.image, rule.region as PixelRegion | undefined) ?? regionError(b.image, rule.region as PixelRegion | undefined);
        if (regionProblem) { failures.push(`${a.name} / ${b.name}: ${regionProblem}.`); continue; }
        let value: number;
        try { value = meanAbsoluteLuminanceDifference(a.image, b.image, rule.region as PixelRegion | undefined); }
        catch (error) { failures.push(`${a.name} / ${b.name}: ${(error as Error).message}.`); continue; }
        measurements.push(`${a.name} / ${b.name}: motion ${value.toFixed(4)}${rule.min !== undefined ? ` (minimum ${rule.min})` : ''}${rule.max !== undefined ? ` (maximum ${rule.max})` : ''}.`);
        if (rule.min !== undefined && value < rule.min) failures.push(`${a.name} / ${b.name}: motion ${value.toFixed(4)} is below ${rule.min}.`);
        if (rule.max !== undefined && value > rule.max) failures.push(`${a.name} / ${b.name}: motion ${value.toFixed(4)} is above ${rule.max}.`);
      }
    }
    gates.push({
      name: 'motion',
      status: failures.length ? 'fail' : warnings.length ? 'warn' : 'pass',
      detail: [...failures, ...warnings, ...measurements].join(' '),
    });
  }

  return gates;
}
