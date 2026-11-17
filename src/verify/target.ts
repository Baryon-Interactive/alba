import {
  meanAbsoluteLuminanceDifference,
  meanLuminance,
  pictureStats,
  type DecodedPng,
  type PixelRegion,
} from './png.ts';
import { parseOrderSections } from './verify.ts';

export type FractionalRegion = [number, number, number, number];
export type TargetMetric = 'luminance' | 'saturation' | 'histogram' | 'structure' | 'motion';
export type TargetTrend = 'closer' | 'farther' | 'flat';
export type TargetBlockTrend = 'closer' | 'farther' | 'flat' | 'stalled';

export type TargetBoundSpec =
  | { kind: 'within'; tolerance: number }
  | { kind: 'between'; min: number; max: number }
  | { kind: 'range'; min?: number; max?: number };

export interface TargetRule {
  metric: TargetMetric;
  raw: string;
  region?: FractionalRegion;
  cells?: [number, number];
  motionFrom?: string;
  motionTo?: string;
  bound: TargetBoundSpec;
  needsReference: boolean;
}

export interface ParsedTargetBlock {
  shot: string;
  reference?: string;
  rows: TargetRule[];
  unmeasured?: string;
}

export interface ParsedTargetSection {
  blocks: ParsedTargetBlock[];
  warnings: string[];
}

export interface TargetRow {
  metric: TargetMetric;
  label: string;
  value: number;
  reference?: number;
  bound: string;
  pass: boolean;
  trend?: TargetTrend;
}

export interface TargetResult {
  shot: string;
  reference: string;
  revision: string;
  rows: TargetRow[];
  pass: boolean;
  unmeasured?: string;
  sheet: string;
  round: number;
  trend?: TargetBlockTrend;
  stalled?: boolean;
}

const SHOT_NAME = /^[A-Za-z0-9_-]+$/;
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)';

function parseFractionalRegion(text: string): FractionalRegion | undefined {
  const parts = text.split(',').map(s => Number(s.trim()));
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return undefined;
  const [x, y, w, h] = parts as [number, number, number, number];
  if (x < 0 || y < 0 || x >= 1 || y >= 1 || w <= 0 || h <= 0) return undefined;
  if (x + w > 1 + 1e-9 || y + h > 1 + 1e-9) return undefined;
  return [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)];
}

function stripOptionalRegion(rest: string): { region?: FractionalRegion; remaining: string } | undefined {
  const trimmed = rest.trim();
  if (!/^region\b/i.test(trimmed)) return { remaining: trimmed };
  const m = /^region\s+(\S+)\s+(.+)$/i.exec(trimmed);
  if (!m) return undefined;
  const region = parseFractionalRegion(m[1]!);
  if (!region) return undefined;
  return { region, remaining: m[2]!.trim() };
}

function parseBoundSpec(text: string, maxAllowed: number, allowWithin: boolean): { bound: TargetBoundSpec; needsReference: boolean } | undefined {
  const s = text.trim();
  if (allowWithin) {
    const w = new RegExp(`^within\\s+(${NUM})$`, 'i').exec(s);
    if (w) {
      const tol = Number(w[1]);
      if (!Number.isFinite(tol) || tol < 0 || tol > maxAllowed) return undefined;
      return { bound: { kind: 'within', tolerance: tol }, needsReference: true };
    }
  }
  const b = new RegExp(`^between\\s+(${NUM})\\s+and\\s+(${NUM})$`, 'i').exec(s);
  if (b) {
    const min = Number(b[1]), max = Number(b[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > maxAllowed || min > max) return undefined;
    return { bound: { kind: 'between', min, max }, needsReference: false };
  }
  const both = new RegExp(`^min\\s+(${NUM})\\s+max\\s+(${NUM})$`, 'i').exec(s);
  if (both) {
    const min = Number(both[1]), max = Number(both[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > maxAllowed || min > max) return undefined;
    return { bound: { kind: 'range', min, max }, needsReference: false };
  }
  const onlyMin = new RegExp(`^min\\s+(${NUM})$`, 'i').exec(s);
  if (onlyMin) {
    const min = Number(onlyMin[1]);
    if (!Number.isFinite(min) || min < 0 || min > maxAllowed) return undefined;
    return { bound: { kind: 'range', min }, needsReference: false };
  }
  const onlyMax = new RegExp(`^max\\s+(${NUM})$`, 'i').exec(s);
  if (onlyMax) {
    const max = Number(onlyMax[1]);
    if (!Number.isFinite(max) || max < 0 || max > maxAllowed) return undefined;
    return { bound: { kind: 'range', max }, needsReference: false };
  }
  return undefined;
}

function normalizeRepoPath(rawPath: string): string | undefined {
  const cleaned = rawPath.trim().replace(/^`|`$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) return undefined;
  const parts = cleaned.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return undefined;
  return cleaned;
}

export function formatBoundSpec(bound: TargetBoundSpec): string {
  if (bound.kind === 'within') return `within ${bound.tolerance}`;
  if (bound.kind === 'between') return `between ${bound.min} and ${bound.max}`;
  if (bound.min !== undefined && bound.max !== undefined) return `min ${bound.min} max ${bound.max}`;
  if (bound.min !== undefined) return `min ${bound.min}`;
  return `max ${bound.max ?? 0}`;
}

export function describeRegion(region?: FractionalRegion): string {
  if (!region) return '';
  const [x, y, w, h] = region;
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  if (eq(x, 0) && eq(y, 0) && eq(w, 1) && eq(h, 1)) return '';
  if (eq(x, 0) && eq(y, 0) && eq(w, 1) && eq(h, 0.5)) return 'top half';
  if (eq(x, 0) && eq(y, 0.5) && eq(w, 1) && eq(h, 0.5)) return 'bottom half';
  if (eq(x, 0) && eq(y, 0) && eq(w, 0.5) && eq(h, 1)) return 'left half';
  if (eq(x, 0.5) && eq(y, 0) && eq(w, 0.5) && eq(h, 1)) return 'right half';
  if (eq(x, 0.25) && eq(y, 0.25) && eq(w, 0.5) && eq(h, 0.5)) return 'centre';
  return `region ${region.join(',')}`;
}

export function ruleLabel(rule: TargetRule): string {
  const reg = describeRegion(rule.region);
  if (rule.metric === 'luminance') return reg ? `${reg} mean luminance` : 'mean luminance';
  if (rule.metric === 'saturation') return reg ? `${reg} mean saturation` : 'mean saturation';
  if (rule.metric === 'histogram') return reg ? `${reg} histogram` : 'histogram';
  if (rule.metric === 'structure') {
    const [c, r] = rule.cells ?? [16, 9];
    return `structure ${c}x${r}`;
  }
  const pair = `${rule.motionFrom ?? '?'} -> ${rule.motionTo ?? '?'}`;
  return reg ? `motion ${pair} (${reg})` : `motion ${pair}`;
}

/** Parse extracted bullet/text lines of a `## Target` section into target blocks and warnings. */
export function parseTargetLines(lines: readonly string[]): ParsedTargetSection {
  const blocks: ParsedTargetBlock[] = [];
  const warnings: string[] = [];
  let current: ParsedTargetBlock | undefined;

  const finalize = (block: ParsedTargetBlock | undefined) => {
    if (!block || block.unmeasured) return;
    const missingRefRule = block.rows.find(r => r.needsReference && !block.reference);
    if (missingRefRule) {
      const msg = `Target block "${block.shot}" requires a reference for ${missingRefRule.metric} (${formatBoundSpec(missingRefRule.bound)}).`;
      warnings.push(msg);
      block.unmeasured = msg;
      return;
    }
    if (!block.rows.length) {
      block.unmeasured = `Target block "${block.shot}" declares no metrics.`;
    }
  };

  const unknownLine = (line: string) => {
    const warn = `Target line not understood: ${line}`;
    warnings.push(warn);
    if (!current) {
      current = { shot: 'target', rows: [], unmeasured: warn };
      blocks.push(current);
    } else if (!current.unmeasured) {
      current.unmeasured = warn;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const shotMatch = /^shot\s*:\s*(.*)$/i.exec(line);
    if (shotMatch) {
      finalize(current);
      const name = shotMatch[1]!.trim();
      if (!SHOT_NAME.test(name)) {
        const warn = `Target line not understood: ${line}`;
        warnings.push(warn);
        current = { shot: name || 'target', rows: [], unmeasured: warn };
      } else {
        current = { shot: name, rows: [] };
      }
      blocks.push(current);
      continue;
    }

    if (!current) {
      unknownLine(line);
      continue;
    }

    const refMatch = /^reference\s*:\s*(.*)$/i.exec(line);
    if (refMatch) {
      const refPath = normalizeRepoPath(refMatch[1]!);
      if (!refPath || current.reference !== undefined) {
        unknownLine(line);
      } else {
        current.reference = refPath;
      }
      continue;
    }

    const lumSat = /^(luminance|saturation)\s*:\s*(.+)$/i.exec(line);
    if (lumSat) {
      const metric = lumSat[1]!.toLowerCase() as 'luminance' | 'saturation';
      const stripped = stripOptionalRegion(lumSat[2]!);
      const parsed = stripped ? parseBoundSpec(stripped.remaining, 1, true) : undefined;
      if (!stripped || !parsed) {
        unknownLine(line);
      } else {
        current.rows.push({
          metric,
          raw: line,
          ...(stripped.region ? { region: stripped.region } : {}),
          bound: parsed.bound,
          needsReference: parsed.needsReference,
        });
      }
      continue;
    }

    const hist = /^histogram\s*:\s*(.+)$/i.exec(line);
    if (hist) {
      const stripped = stripOptionalRegion(hist[1]!);
      const maxMatch = stripped ? new RegExp(`^max\\s+(${NUM})$`, 'i').exec(stripped.remaining) : null;
      const maxVal = maxMatch ? Number(maxMatch[1]) : NaN;
      if (!stripped || !maxMatch || !Number.isFinite(maxVal) || maxVal < 0 || maxVal > 1) {
        unknownLine(line);
      } else {
        current.rows.push({
          metric: 'histogram',
          raw: line,
          ...(stripped.region ? { region: stripped.region } : {}),
          bound: { kind: 'range', max: maxVal },
          needsReference: true,
        });
      }
      continue;
    }

    const struct = /^structure\s*:\s*(.+)$/i.exec(line);
    if (struct) {
      const m = new RegExp(`^(?:cells\\s+(\\d+)x(\\d+)\\s+)?max\\s+(${NUM})$`, 'i').exec(struct[1]!.trim());
      if (!m) {
        unknownLine(line);
        continue;
      }
      const cols = m[1] ? Number(m[1]) : 16;
      const rows = m[2] ? Number(m[2]) : 9;
      const maxVal = Number(m[3]);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 256 || rows < 1 || rows > 256 || !Number.isFinite(maxVal) || maxVal < 0 || maxVal > 1) {
        unknownLine(line);
      } else {
        current.rows.push({
          metric: 'structure',
          raw: line,
          cells: [cols, rows],
          bound: { kind: 'range', max: maxVal },
          needsReference: true,
        });
      }
      continue;
    }

    const motion = /^motion\s*:\s*([A-Za-z0-9_-]+)\s*->\s*([A-Za-z0-9_-]+)\s+(.+)$/i.exec(line);
    if (motion) {
      const from = motion[1]!;
      const to = motion[2]!;
      const stripped = stripOptionalRegion(motion[3]!);
      const parsed = stripped ? parseBoundSpec(stripped.remaining, 255, false) : undefined;
      if (!stripped || !parsed) {
        unknownLine(line);
      } else {
        current.rows.push({
          metric: 'motion',
          raw: line,
          motionFrom: from,
          motionTo: to,
          ...(stripped.region ? { region: stripped.region } : {}),
          bound: parsed.bound,
          needsReference: false,
        });
      }
      continue;
    }

    unknownLine(line);
  }

  finalize(current);
  return { blocks, warnings };
}

/** Parse the `## Target` section of a work-order Markdown file. */
export function parseTargetSection(markdown: string): ParsedTargetSection {
  const sections = parseOrderSections(markdown);
  return parseTargetLines(sections.target ?? []);
}

/** Convert a fractional 0..1 region `[x, y, w, h]` into integer pixel bounds `[x, y, w, h]` on `image`. */
export function fractionalRegionToPixels(image: DecodedPng, region?: FractionalRegion): PixelRegion {
  if (!region) return [0, 0, image.width, image.height];
  const [fx, fy, fw, fh] = region;
  const left = Math.max(0, Math.min(image.width - 1, Math.round(fx * image.width)));
  const top = Math.max(0, Math.min(image.height - 1, Math.round(fy * image.height)));
  const right = Math.max(left + 1, Math.min(image.width, Math.round((fx + fw) * image.width)));
  const bottom = Math.max(top + 1, Math.min(image.height, Math.round((fy + fh) * image.height)));
  return [left, top, right - left, bottom - top];
}

/** Mean Rec.709 luminance (0..1) over an optional fractional region. */
export function measureLuminance(image: DecodedPng, region?: FractionalRegion): number {
  return meanLuminance(image, region ? fractionalRegionToPixels(image, region) : undefined);
}

/** Mean HSV saturation (0..1, matching `pictureStats`) over an optional fractional region. */
export function measureSaturation(image: DecodedPng, region?: FractionalRegion): number {
  if (!region) return pictureStats(image).meanSaturation;
  const [x, y, w, h] = fractionalRegionToPixels(image, region);
  let sum = 0;
  let count = 0;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * image.width + px) * image.channels;
      const r = image.pixels[i]!;
      const g = image.pixels[i + 1]!;
      const b = image.pixels[i + 2]!;
      const max = Math.max(r, g, b);
      if (max) sum += (max - Math.min(r, g, b)) / max;
      count++;
    }
  }
  const value = count ? sum / count : 0;
  return Math.abs(value - Math.round(value)) < 1e-12 ? Math.round(value) : value;
}

function rgbHistogram512(image: DecodedPng, region?: FractionalRegion): Float64Array {
  const [x, y, w, h] = fractionalRegionToPixels(image, region);
  const bins = new Float64Array(512);
  let count = 0;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * image.width + px) * image.channels;
      const r = image.pixels[i]! >>> 5;
      const g = image.pixels[i + 1]! >>> 5;
      const b = image.pixels[i + 2]! >>> 5;
      bins[(r << 6) | (g << 3) | b]++;
      count++;
    }
  }
  if (count > 0) {
    for (let k = 0; k < 512; k++) bins[k] /= count;
  }
  return bins;
}

/** RGB 8x8x8 (512-bin) normalised histogram distance: half the L1 difference (0 same colours, 1 none shared). */
export function histogramDistance(a: DecodedPng, b: DecodedPng, region?: FractionalRegion): number {
  const ha = rgbHistogram512(a, region);
  const hb = rgbHistogram512(b, region);
  let l1 = 0;
  for (let k = 0; k < 512; k++) l1 += Math.abs(ha[k]! - hb[k]!);
  const dist = 0.5 * l1;
  if (Math.abs(dist) < 1e-12) return 0;
  if (Math.abs(dist - 1) < 1e-12) return 1;
  return dist;
}

/** Mean Rec.709 luminance (0..1) for each cell of a `cols x rows` grid over `image`. */
export function cellLuminance(image: DecodedPng, cols: number, rows: number): number[] {
  const out = new Array<number>(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.min(image.height - 1, Math.floor((cy * image.height) / rows));
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor(((cy + 1) * image.height) / rows)));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.min(image.width - 1, Math.floor((cx * image.width) / cols));
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor(((cx + 1) * image.width) / cols)));
      out[cy * cols + cx] = meanLuminance(image, [x0, y0, x1 - x0, y1 - y0]);
    }
  }
  return out;
}

/** Mean absolute per-cell luminance difference (0..1) on a `cols x rows` grid. */
export function structureDistance(a: DecodedPng, b: DecodedPng, cols = 16, rows = 9): number {
  const ca = cellLuminance(a, cols, rows);
  const cb = cellLuminance(b, cols, rows);
  let sum = 0;
  for (let i = 0; i < ca.length; i++) sum += Math.abs(ca[i]! - cb[i]!);
  const dist = ca.length ? sum / ca.length : 0;
  return Math.abs(dist) < 1e-12 ? 0 : dist;
}

/** Mean absolute Rec.709 luminance difference (0..255) between two same-sized capture shots. */
export function measureMotion(a: DecodedPng, b: DecodedPng, region?: FractionalRegion): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`image sizes differ: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  }
  return meanAbsoluteLuminanceDifference(a, b, region ? fractionalRegionToPixels(a, region) : undefined);
}

function checkBound(value: number, bound: TargetBoundSpec, reference?: number): boolean {
  const eps = 1e-9;
  if (bound.kind === 'within') {
    if (reference === undefined) return false;
    return Math.abs(value - reference) <= bound.tolerance + eps;
  }
  if (bound.kind === 'between') {
    return value >= bound.min - eps && value <= bound.max + eps;
  }
  if (bound.min !== undefined && value < bound.min - eps) return false;
  if (bound.max !== undefined && value > bound.max + eps) return false;
  return true;
}

/** Measure a single parsed target rule against decoded images. */
export function evaluateTargetRule(
  rule: TargetRule,
  shotImage: DecodedPng,
  referenceImage?: DecodedPng,
  resolveShot?: (name: string) => DecodedPng,
): TargetRow {
  const label = ruleLabel(rule);
  const bound = formatBoundSpec(rule.bound);

  if (rule.metric === 'luminance') {
    const value = measureLuminance(shotImage, rule.region);
    const refVal = rule.bound.kind === 'within' && referenceImage ? measureLuminance(referenceImage, rule.region) : undefined;
    return {
      metric: 'luminance',
      label,
      value,
      ...(refVal !== undefined ? { reference: refVal } : {}),
      bound,
      pass: checkBound(value, rule.bound, refVal),
    };
  }

  if (rule.metric === 'saturation') {
    const value = measureSaturation(shotImage, rule.region);
    const refVal = rule.bound.kind === 'within' && referenceImage ? measureSaturation(referenceImage, rule.region) : undefined;
    return {
      metric: 'saturation',
      label,
      value,
      ...(refVal !== undefined ? { reference: refVal } : {}),
      bound,
      pass: checkBound(value, rule.bound, refVal),
    };
  }

  if (rule.metric === 'histogram') {
    if (!referenceImage) throw new Error('histogram requires a reference image');
    const value = histogramDistance(referenceImage, shotImage, rule.region);
    return {
      metric: 'histogram',
      label,
      value,
      bound,
      pass: checkBound(value, rule.bound),
    };
  }

  if (rule.metric === 'structure') {
    if (!referenceImage) throw new Error('structure requires a reference image');
    const [cols, rows] = rule.cells ?? [16, 9];
    const value = structureDistance(referenceImage, shotImage, cols, rows);
    return {
      metric: 'structure',
      label,
      value,
      bound,
      pass: checkBound(value, rule.bound),
    };
  }

  const fromImg = rule.motionFrom && resolveShot ? resolveShot(rule.motionFrom) : shotImage;
  const toImg = rule.motionTo && resolveShot ? resolveShot(rule.motionTo) : shotImage;
  const value = measureMotion(fromImg, toImg, rule.region);
  return {
    metric: 'motion',
    label,
    value,
    bound,
    pass: checkBound(value, rule.bound),
  };
}

function distanceAndScale(rule: TargetRule, row: TargetRow): { distance: (v: number) => number; scale: number } {
  const b = rule.bound;
  if (b.kind === 'within') {
    const ref = row.reference ?? 0;
    return { distance: v => Math.abs(v - ref), scale: b.tolerance };
  }
  if (rule.metric === 'histogram' || rule.metric === 'structure') {
    return { distance: v => v, scale: b.kind === 'range' ? (b.max ?? 1) : 1 };
  }
  if (b.kind === 'between') {
    const width = b.max - b.min;
    return {
      distance: v => (v < b.min ? b.min - v : v > b.max ? v - b.max : 0),
      scale: width,
    };
  }
  if (b.min !== undefined && b.max !== undefined) {
    return {
      distance: v => (v < b.min! ? b.min! - v : v > b.max! ? v - b.max! : 0),
      scale: b.max - b.min,
    };
  }
  if (b.min !== undefined) {
    return { distance: v => Math.max(0, b.min! - v), scale: b.min };
  }
  const max = b.max ?? 1;
  return { distance: v => Math.max(0, v - max), scale: max };
}

/** Compare a measured row with its previous round's value: `closer`, `farther`, or `flat` (< 10% of bound). */
export function computeRowTrend(rule: TargetRule, current: TargetRow, previousValue: number): TargetTrend {
  const { distance, scale } = distanceAndScale(rule, current);
  const currDist = distance(current.value);
  const prevDist = distance(previousValue);
  const threshold = Math.max(1e-12, 0.1 * scale);
  if (Math.abs(currDist - prevDist) < threshold) {
    if (currDist === 0 && prevDist === 0 && Math.abs(current.value - previousValue) < threshold) return 'flat';
    return 'flat';
  }
  return currDist < prevDist ? 'closer' : 'farther';
}

/** Summarise row trends into a block trend; two `flat` rounds in a row mark the block `stalled`. */
export function computeBlockTrend(rows: readonly TargetRow[], previousBlockTrend?: TargetBlockTrend): { trend?: TargetBlockTrend; stalled?: boolean } {
  const withTrend = rows.filter(r => r.trend !== undefined);
  if (!withTrend.length) return {};
  const missedWithTrend = withTrend.filter(r => !r.pass);
  const focus = missedWithTrend.length ? missedWithTrend : withTrend;
  let raw: TargetTrend;
  if (focus.every(r => r.trend === 'flat')) {
    raw = 'flat';
  } else {
    const closer = focus.filter(r => r.trend === 'closer').length;
    const farther = focus.filter(r => r.trend === 'farther').length;
    raw = farther > closer ? 'farther' : 'closer';
  }
  if (raw === 'flat' && (previousBlockTrend === 'flat' || previousBlockTrend === 'stalled')) {
    return { trend: 'stalled', stalled: true };
  }
  return { trend: raw };
}
