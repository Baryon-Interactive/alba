import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { ProjectConfig } from '../config.ts';
import { listEvidence } from '../evidence/evidence.ts';
import type { Orders } from '../orders/service.ts';
import type { Probes } from '../tick/gather.ts';
import { decodePng, pictureStats, subjectStats, summarizePng, type DecodedPng } from '../verify/png.ts';
import { cellLuminance } from '../verify/target.ts';

/**
 * One picture on the sheet, with what a reviewer checks first: is it black, flat, or the size it should be; then its range (highlights,
 * p5/p95), colour and, when a `<name>.mask.png` lies next to it, how far the subject stands out from its surround.
 */
export interface SheetImage {
  index: number; file: string; from: string; width?: number; height?: number; meanLuminance?: number; luminanceStddev?: number; darkFraction?: number; skipped?: string;
  highlightFraction?: number; p5?: number; p95?: number; meanSaturation?: number;
  /** The subject mask that was read, and what it gave (or why it could not be used). */
  mask?: string; maskSkipped?: string;
  subjectMeanLuminance?: number; surroundMeanLuminance?: number; subjectContrast?: number; subjectHeight?: number;
}
export interface Sheet { tag: string; out?: string; columns: number; cell: number; images: SheetImage[] }

const MAX_IMAGES = 36;
const MASK = /\.mask\.png$/i;

/** The subject numbers from `<name>.mask.png` next to the picture, when there is one. */
function maskFields(file: string, image: DecodedPng): Partial<SheetImage> {
  const mask = file.replace(/\.png$/i, '.mask.png');
  if (mask === file || !existsSync(mask)) return {};
  const at = mask.replace(/\\/g, '/');
  let decoded;
  try { decoded = decodePng(readFileSync(mask)); } catch (e) { return { mask: at, maskSkipped: (e as Error).message }; }
  if (decoded.status !== 'ok') return { mask: at, maskSkipped: decoded.reason };
  const subject = subjectStats(image, decoded.image);
  if (subject.status !== 'ok') return { mask: at, maskSkipped: subject.reason };
  const s = subject.stats;
  return { mask: at, subjectMeanLuminance: s.subjectMeanLuminance, ...(s.surroundMeanLuminance !== undefined ? { surroundMeanLuminance: s.surroundMeanLuminance, subjectContrast: s.subjectContrast } : {}), subjectHeight: s.subjectHeight };
}

/** A PNG of 8-bit RGB pixels (filter 0 on every row). */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Box-averaged copy of `image` that fits a cell of `cell` x `cellHeight`, centred, on a dark grey ground; RGB. */
function fit(image: DecodedPng, cell: number, cellHeight: number, into: Buffer, sheetWidth: number, left: number, top: number): void {
  const scale = Math.min(cell / image.width, cellHeight / image.height, 1);
  const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
  const ox = left + Math.floor((cell - w) / 2), oy = top + Math.floor((cellHeight - h) / 2);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * image.height / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * image.height / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * image.width / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * image.width / w));
      let r = 0, g = 0, b = 0, n = 0;
      // At most 4 x 4 samples per output pixel: enough for a review sheet, fast on 4K captures.
      const sy = Math.max(1, Math.floor((y1 - y0) / 4)), sx = Math.max(1, Math.floor((x1 - x0) / 4));
      for (let yy = y0; yy < y1; yy += sy) for (let xx = x0; xx < x1; xx += sx) {
        const i = (yy * image.width + xx) * image.channels;
        r += image.pixels[i]; g += image.pixels[i + 1]; b += image.pixels[i + 2]; n++;
      }
      const o = ((oy + y) * sheetWidth + ox + x) * 3;
      into[o] = r / n; into[o + 1] = g / n; into[o + 2] = b / n;
    }
  }
}

function buildSheet(tag: string, source: readonly { path: string; from: string }[], options: { out?: string; columns?: number; cell?: number }): Sheet {
  const columns = Math.max(1, Math.min(8, options.columns ?? 4)), cell = Math.max(64, Math.min(1024, options.cell ?? 320));
  const images: SheetImage[] = [];
  const decoded: DecodedPng[] = [];
  for (const f of source) {
    const entry: SheetImage = { index: images.length + 1, file: f.path, from: f.from };
    images.push(entry);
    if (!/\.png$/i.test(f.path)) { entry.skipped = 'not a PNG'; continue; }
    let result;
    try { result = decodePng(readFileSync(f.path)); } catch (e) { entry.skipped = (e as Error).message; continue; }
    if (result.status !== 'ok') { entry.skipped = result.reason; continue; }
    const s = summarizePng(result.image);
    const p = pictureStats(result.image);
    Object.assign(entry, { width: result.image.width, height: result.image.height, meanLuminance: s.meanLuminance, luminanceStddev: s.luminanceStddev, darkFraction: s.darkFraction, highlightFraction: p.highlightFraction, p5: p.p5, p95: p.p95, meanSaturation: p.meanSaturation }, maskFields(f.path, result.image));
    decoded.push(result.image);
  }
  const sheet: Sheet = { tag, columns, cell, images };
  if (options.out && decoded.length) {
    // Cells are `cell` wide and as tall as the tallest picture needs (wide captures do not leave half the sheet empty).
    const gap = 8, cols = Math.min(columns, decoded.length), rows = Math.ceil(decoded.length / cols);
    const cellHeight = Math.min(cell * 2, Math.max(16, Math.round(Math.max(...decoded.map(d => cell * d.height / d.width)))));
    const width = cols * cell + (cols + 1) * gap, height = rows * cellHeight + (rows + 1) * gap;
    const rgb = Buffer.alloc(width * height * 3, 24);
    decoded.forEach((image, i) => fit(image, cell, cellHeight, rgb, width, gap + (i % cols) * (cell + gap), gap + Math.floor(i / cols) * (cellHeight + gap)));
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, encodePng(width, height, rgb));
    sheet.out = options.out.replace(/\\/g, '/');
  }
  return sheet;
}

/** Build a contact sheet PNG from an explicit file list (for example Alba's own captures). */
export function sheetFromFiles(files: readonly string[], options: { tag?: string; out?: string; columns?: number; cell?: number } = {}): Sheet {
  const source = files.filter(f => !MASK.test(f)).slice(0, MAX_IMAGES).map(file => ({ path: file, from: 'capture' }));
  return buildSheet(options.tag ?? 'capture', source, options);
}

/**
 * Side-by-side visual target sheet: reference left, capture middle, and a third panel on the right showing per-cell
 * luminance difference as grey levels (0 black = identical, 255 white = most different).
 */
export function targetSheet(
  reference: DecodedPng,
  capture: DecodedPng,
  out: string,
  options: { cols?: number; rows?: number; cell?: number } = {},
): { out: string; width: number; height: number; cell: number; cellHeight: number; gap: number; panels: 3 } {
  const gridCols = Math.max(1, Math.min(256, options.cols ?? 16));
  const gridRows = Math.max(1, Math.min(256, options.rows ?? 9));
  const refCells = cellLuminance(reference, gridCols, gridRows);
  const capCells = cellLuminance(capture, gridCols, gridRows);
  const diffPixels = Buffer.alloc(capture.width * capture.height * 3);
  for (let y = 0; y < capture.height; y++) {
    const cy = Math.min(gridRows - 1, Math.floor((y * gridRows) / capture.height));
    for (let x = 0; x < capture.width; x++) {
      const cx = Math.min(gridCols - 1, Math.floor((x * gridCols) / capture.width));
      const diff = Math.abs(capCells[cy * gridCols + cx]! - refCells[cy * gridCols + cx]!);
      const level = Math.round(Math.min(1, diff) * 255);
      const o = (y * capture.width + x) * 3;
      diffPixels[o] = level;
      diffPixels[o + 1] = level;
      diffPixels[o + 2] = level;
    }
  }
  const diffImage: DecodedPng = { width: capture.width, height: capture.height, channels: 3, pixels: diffPixels };
  const panels = [reference, capture, diffImage] as const;
  const cell = Math.max(64, Math.min(1024, options.cell ?? 320));
  const gap = 8;
  const cellHeight = Math.min(cell * 2, Math.max(16, Math.round(Math.max(...panels.map(p => (cell * p.height) / p.width)))));
  const width = 3 * cell + 4 * gap;
  const height = cellHeight + 2 * gap;
  const rgb = Buffer.alloc(width * height * 3, 24);
  panels.forEach((panel, i) => fit(panel, cell, cellHeight, rgb, width, gap + i * (cell + gap), gap));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, encodePng(width, height, rgb));
  return { out: out.replace(/\\/g, '/'), width, height, cell, cellHeight, gap, panels: 3 };
}

/**
 * A contact sheet of an order's evidence pictures (the ones its reports name, then the evidence folders; as the evidence list of the
 * order page) and, per picture, its size and mean luminance, its spread, how much of it is near black, its highlight share, p5 and p95
 * luminance and mean saturation, and with a `<name>.mask.png` the subject against its surround. Only PNG is decoded; other files are
 * listed as skipped; masks are not pictures of their own. Without `out` nothing is written.
 */
export function contactSheet(project: ProjectConfig, orders: Orders, probes: Probes, tag: string, options: { out?: string; columns?: number; cell?: number } = {}): Sheet {
  const list = listEvidence(project, orders, probes, tag);
  // A subject mask belongs to its picture: it is read with it, never put on the sheet itself.
  const source = list.files.filter(f => f.kind === 'image' && !MASK.test(f.path)).slice(0, MAX_IMAGES).map(f => ({ path: f.path, from: f.from }));
  return buildSheet(orders.get(tag).order.tag, source, options);
}

/** The sheet as text: the file, then one line per picture in sheet order (left to right, top to bottom). */
export function formatSheet(sheet: Sheet): string {
  const pct = (v?: number) => v === undefined ? '-' : `${Math.round(v * 100)}%`;
  const num = (v?: number) => v === undefined ? '-' : v.toFixed(3);
  const lines = [sheet.out ? `${sheet.tag}: ${sheet.out} (${sheet.columns} per row)` : `${sheet.tag}: no PNG to put on a sheet`];
  let cell = 0;
  for (const i of sheet.images) {
    const at = i.skipped ? '  -' : String(++cell).padStart(3);
    const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
    const subject = i.maskSkipped ? `  mask skipped: ${i.maskSkipped}` : i.subjectMeanLuminance !== undefined
      ? `  subject ${num(i.subjectMeanLuminance)} vs ${num(i.surroundMeanLuminance)}${i.subjectContrast !== undefined ? ` (${signed(i.subjectContrast)})` : ''} ${i.subjectHeight}px` : '';
    lines.push(i.skipped ? `${at}  ${i.file}  skipped: ${i.skipped}` : `${at}  ${i.width}x${i.height}  mean ${num(i.meanLuminance)}  spread ${num(i.luminanceStddev)}  dark ${pct(i.darkFraction)}  high ${pct(i.highlightFraction)}  p5 ${num(i.p5)}  p95 ${num(i.p95)}  sat ${num(i.meanSaturation)}${subject}  ${i.file}`);
  }
  if (!sheet.images.length) lines.push('  (no evidence pictures: none named in a report, none in the evidence folders)');
  return lines.join('\n');
}
