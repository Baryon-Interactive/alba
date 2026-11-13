import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { ProjectConfig } from '../config.ts';
import { listEvidence } from '../evidence/evidence.ts';
import type { Orders } from '../orders/service.ts';
import type { Probes } from '../tick/gather.ts';
import { decodePng, summarizePng, type DecodedPng } from '../verify/png.ts';

/** One picture on the sheet, with what a reviewer checks first: is it black, flat, or the size it should be. */
export interface SheetImage { index: number; file: string; from: string; width?: number; height?: number; meanLuminance?: number; luminanceStddev?: number; darkFraction?: number; skipped?: string }
export interface Sheet { tag: string; out?: string; columns: number; cell: number; images: SheetImage[] }

const MAX_IMAGES = 36;

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

/**
 * A contact sheet of an order's evidence pictures (the ones its reports name, then the evidence folders; as the evidence list of the
 * order page) and, per picture, its size and mean luminance, its spread and how much of it is near black. Only PNG is decoded; other
 * files are listed as skipped. Without `out` nothing is written.
 */
export function contactSheet(project: ProjectConfig, orders: Orders, probes: Probes, tag: string, options: { out?: string; columns?: number; cell?: number } = {}): Sheet {
  const list = listEvidence(project, orders, probes, tag);
  const columns = Math.max(1, Math.min(8, options.columns ?? 4)), cell = Math.max(64, Math.min(1024, options.cell ?? 320));
  const images: SheetImage[] = [];
  const decoded: DecodedPng[] = [];
  for (const f of list.files.filter(f => f.kind === 'image').slice(0, MAX_IMAGES)) {
    const entry: SheetImage = { index: images.length + 1, file: f.path, from: f.from };
    images.push(entry);
    if (!/\.png$/i.test(f.path)) { entry.skipped = 'not a PNG'; continue; }
    let result;
    try { result = decodePng(readFileSync(f.path)); } catch (e) { entry.skipped = (e as Error).message; continue; }
    if (result.status !== 'ok') { entry.skipped = result.reason; continue; }
    const s = summarizePng(result.image);
    Object.assign(entry, { width: result.image.width, height: result.image.height, meanLuminance: s.meanLuminance, luminanceStddev: s.luminanceStddev, darkFraction: s.darkFraction });
    decoded.push(result.image);
  }
  const sheet: Sheet = { tag: orders.get(tag).order.tag, columns, cell, images };
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

/** The sheet as text: the file, then one line per picture in sheet order (left to right, top to bottom). */
export function formatSheet(sheet: Sheet): string {
  const pct = (v?: number) => v === undefined ? '-' : `${Math.round(v * 100)}%`;
  const num = (v?: number) => v === undefined ? '-' : v.toFixed(3);
  const lines = [sheet.out ? `${sheet.tag}: ${sheet.out} (${sheet.columns} per row)` : `${sheet.tag}: no PNG to put on a sheet`];
  let cell = 0;
  for (const i of sheet.images) {
    const at = i.skipped ? '  -' : String(++cell).padStart(3);
    lines.push(i.skipped ? `${at}  ${i.file}  skipped: ${i.skipped}` : `${at}  ${i.width}x${i.height}  mean ${num(i.meanLuminance)}  spread ${num(i.luminanceStddev)}  dark ${pct(i.darkFraction)}  ${i.file}`);
  }
  if (!sheet.images.length) lines.push('  (no evidence pictures: none named in a report, none in the evidence folders)');
  return lines.join('\n');
}
