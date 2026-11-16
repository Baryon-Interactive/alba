import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ImageFormat = 'PNG' | 'JPEG' | 'GIF' | 'WebP' | 'other';
export function imageFormat(data: Buffer): ImageFormat {
  if (data.subarray(0, 8).equals(SIGNATURE)) return 'PNG';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'JPEG';
  if (['GIF87a', 'GIF89a'].includes(data.toString('latin1', 0, 6))) return 'GIF';
  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'WebP';
  return 'other';
}

export interface DecodedPng {
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Buffer;
}

export type PngDecodeResult =
  | { status: 'ok'; image: DecodedPng }
  | { status: 'unsupported'; reason: string };

export interface ImageSummary {
  thumbnail: number[];
  meanLuminance: number;
  luminanceStddev: number;
  darkFraction: number;
}

export type PixelRegion = [number, number, number, number];
export function regionError(image: DecodedPng, region?: PixelRegion): string | undefined {
  if (!region) return undefined;
  const [x, y, w, h] = region;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > image.width || y + h > image.height) {
    return `region [${region.join(', ')}] is outside image size ${image.width}x${image.height}`;
  }
  return undefined;
}
function regionBounds(image: DecodedPng, region?: PixelRegion): [number, number, number, number] {
  const [x, y, w, h] = region ?? [0, 0, image.width, image.height];
  const left = Math.max(0, Math.min(image.width, x)), top = Math.max(0, Math.min(image.height, y));
  const right = Math.max(left, Math.min(image.width, x + w)), bottom = Math.max(top, Math.min(image.height, y + h));
  return [left, top, right, bottom];
}
/** Mean Rec.709 luminance in 0..1, optionally restricted to x,y,w,h pixels. */
export function meanLuminance(image: DecodedPng, region?: PixelRegion): number {
  const [left, top, right, bottom] = regionBounds(image, region); let sum = 0, count = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { const i = (y * image.width + x) * image.channels; sum += 0.2126 * image.pixels[i] + 0.7152 * image.pixels[i + 1] + 0.0722 * image.pixels[i + 2]; count++; }
  const value = count ? sum / count / 255 : 0;
  return Math.abs(value - Math.round(value)) < 1e-12 ? Math.round(value) : value;
}
/** Mean absolute Rec.709 luminance difference on a 0..255 scale. */
export function meanAbsoluteLuminanceDifference(a: DecodedPng, b: DecodedPng, region?: PixelRegion): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`image sizes differ: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  const [left, top, right, bottom] = regionBounds(a, region); let sum = 0, count = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { const p = (y * a.width + x) * a.channels, q = (y * b.width + x) * b.channels; sum += Math.abs((0.2126 * a.pixels[p] + 0.7152 * a.pixels[p + 1] + 0.0722 * a.pixels[p + 2]) - (0.2126 * b.pixels[q] + 0.7152 * b.pixels[q + 1] + 0.0722 * b.pixels[q + 2])); count++; }
  const value = count ? sum / count : 0;
  return Math.abs(value - Math.round(value)) < 1e-12 ? Math.round(value) : value;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** The seven passes of an interlaced (Adam7) PNG: first column and row, then the column and row steps. */
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** Decode PNGs (plain or interlaced) into 8-bit RGB/RGBA for the screenshot summary. */
export function decodePng(data: Buffer): PngDecodeResult {
  if (data.length < 33 || !data.subarray(0, 8).equals(SIGNATURE)) return { status: 'unsupported', reason: 'not a PNG' };
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | undefined, transparency: Buffer | undefined;
  let sawIhdr = false;
  try {
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      const type = data.toString('latin1', offset + 4, offset + 8);
      const start = offset + 8, end = start + length;
      if (end + 4 > data.length) return { status: 'unsupported', reason: 'truncated PNG chunk' };
      const chunk = data.subarray(start, end);
      if (type === 'IHDR') {
        if (length !== 13 || sawIhdr) return { status: 'unsupported', reason: 'invalid IHDR' };
        width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); bitDepth = chunk[8]; colorType = chunk[9]; interlace = chunk[12]; sawIhdr = true;
        if (!width || !height || chunk[10] !== 0 || chunk[11] !== 0) return { status: 'unsupported', reason: 'invalid PNG header' };
        const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (interlace > 1 || !depths[colorType]?.includes(bitDepth)) return { status: 'unsupported', reason: `invalid PNG colour type ${colorType} / bit depth ${bitDepth}` };
      } else if (type === 'PLTE') palette = chunk;
      else if (type === 'tRNS') transparency = chunk;
      else if (type === 'IDAT') idat.push(chunk);
      else if (type === 'IEND') break;
      offset = end + 4;
    }
    if (!sawIhdr || !idat.length) return { status: 'unsupported', reason: 'PNG has no image data' };
    if (colorType === 3 && (!palette || !palette.length || palette.length % 3 || palette.length > 768 || palette.length / 3 > 2 ** bitDepth)) return { status: 'unsupported', reason: 'invalid PNG palette' };
    const samples = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1;
    const channels = colorType === 4 || colorType === 6 || transparency ? 4 : 3;
    const bytesPerPixel = Math.max(1, Math.ceil(samples * bitDepth / 8));
    const outputBytes = width * height * channels;
    const fullRow = Math.ceil(width * samples * bitDepth / 8);
    if (!Number.isSafeInteger(fullRow) || fullRow <= 0 || !Number.isSafeInteger(outputBytes) || outputBytes > 256 * 1024 * 1024) return { status: 'unsupported', reason: 'PNG is too large' };
    // An interlaced image is seven smaller images (Adam7), each filtered on its own; a plain one is a single pass.
    const passes = (interlace === 1 ? ADAM7 : [[0, 0, 1, 1]]).map(([x0, y0, dx, dy]) => {
      const w = width > x0 ? Math.ceil((width - x0) / dx) : 0, h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
      return { x0, y0, dx, dy, w, h, rowBytes: Math.ceil(w * samples * bitDepth / 8) };
    }).filter(p => p.w > 0 && p.h > 0);
    const expected = passes.reduce((n, p) => n + (p.rowBytes + 1) * p.h, 0);
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
    if (raw.length !== expected) return { status: 'unsupported', reason: 'PNG scanlines have an unexpected size' };
    const pixels = Buffer.alloc(outputBytes);
    const maxSample = 2 ** bitDepth - 1;
    const toByte = (value: number) => bitDepth === 16 ? value >>> 8 : Math.round(value * 255 / maxSample);
    let src = 0;
    for (const pass of passes) {
      const rowBytes = pass.rowBytes;
      const scanlines = Buffer.alloc(rowBytes * pass.h);
      for (let y = 0; y < pass.h; y++) {
        const filter = raw[src++];
        const row = scanlines.subarray(y * rowBytes, (y + 1) * rowBytes);
        const prior = y ? scanlines.subarray((y - 1) * rowBytes, y * rowBytes) : undefined;
        for (let x = 0; x < rowBytes; x++) {
          const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
          const up = prior ? prior[x] : 0;
          const upLeft = prior && x >= bytesPerPixel ? prior[x - bytesPerPixel] : 0;
          const value = raw[src++];
          if (filter === 0) row[x] = value;
          else if (filter === 1) row[x] = (value + left) & 0xff;
          else if (filter === 2) row[x] = (value + up) & 0xff;
          else if (filter === 3) row[x] = (value + Math.floor((left + up) / 2)) & 0xff;
          else if (filter === 4) row[x] = (value + paeth(left, up, upLeft)) & 0xff;
          else return { status: 'unsupported', reason: 'unsupported PNG row filter' };
        }
      }
      for (let py = 0; py < pass.h; py++) {
        const row = scanlines.subarray(py * rowBytes, (py + 1) * rowBytes);
        const sample = (index: number) => bitDepth === 16 ? row.readUInt16BE(index * 2) : bitDepth === 8 ? row[index] : (row[Math.floor(index * bitDepth / 8)] >>> (8 - bitDepth - index * bitDepth % 8)) & maxSample;
        const y = pass.y0 + py * pass.dy;
        for (let px = 0; px < pass.w; px++) {
          const x = pass.x0 + px * pass.dx;
          const start = px * samples, out = (y * width + x) * channels;
          if (colorType === 3) {
            const index = sample(start);
            if (index * 3 + 2 >= palette!.length) return { status: 'unsupported', reason: 'PNG palette index out of range' };
            palette!.copy(pixels, out, index * 3, index * 3 + 3);
            if (channels === 4) pixels[out + 3] = transparency?.[index] ?? 255;
          } else if (colorType === 0 || colorType === 4) {
            pixels.fill(toByte(sample(start)), out, out + 3);
            if (channels === 4) pixels[out + 3] = colorType === 4 ? toByte(sample(start + 1)) : transparency?.length === 2 && sample(start) === transparency.readUInt16BE(0) ? 0 : 255;
          } else {
            for (let c = 0; c < 3; c++) pixels[out + c] = toByte(sample(start + c));
            if (channels === 4) pixels[out + 3] = colorType === 6 ? toByte(sample(start + 3)) : transparency?.length === 6 && [0, 1, 2].every(c => sample(start + c) === transparency!.readUInt16BE(c * 2)) ? 0 : 255;
          }
        }
      }
    }
    return { status: 'ok', image: { width, height, channels, pixels } };
  } catch {
    return { status: 'unsupported', reason: 'invalid PNG data' };
  }
}

const luminance = (r: number, g: number, b: number): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Summarize decoded pixels as luminance values and a fixed-size thumbnail. */
export function summarizePng(image: DecodedPng): ImageSummary {
  const values = new Float64Array(image.width * image.height);
  let sum = 0, dark = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * image.channels;
    const l = luminance(image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]);
    values[y * image.width + x] = l;
    sum += l;
    if (l < 0.05) dark++;
  }
  const count = values.length;
  const mean = count ? sum / count : 0;
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  const totals = new Float64Array(256), counts = new Uint32Array(256);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const tx = Math.min(15, Math.floor(x * 16 / image.width)), ty = Math.min(15, Math.floor(y * 16 / image.height));
    const bin = ty * 16 + tx; totals[bin] += values[y * image.width + x]; counts[bin]++;
  }
  const thumbnail = Array.from({ length: 256 }, (_, i) => counts[i] ? totals[i] / counts[i] : 0);
  return { thumbnail, meanLuminance: mean, luminanceStddev: count ? Math.sqrt(variance / count) : 0, darkFraction: count ? dark / count : 1 };
}

/** What a reviewer reads besides the mean: range, highlights, colour, and (with a subject mask) how the subject stands out. Luminance is Rec.709 from 0 to 1. */
export interface PictureStats {
  /** Share of pixels brighter than 230 of 255. */
  highlightFraction: number;
  /** 5th and 95th percentile of luminance. */
  p5: number;
  p95: number;
  /** Mean HSV saturation (0 grey, 1 full colour). */
  meanSaturation: number;
}

export interface SubjectStats {
  subjectMeanLuminance: number;
  /** Mean luminance of the band around the subject (outside the mask); absent when the mask leaves no band. */
  surroundMeanLuminance?: number;
  /** Subject mean minus surround mean. */
  subjectContrast?: number;
  /** Height of the subject's bounding box, in pixels of the picture. */
  subjectHeight: number;
  /** Width of the band around the subject, in pixels. */
  surroundBand: number;
}

export type SubjectResult = { status: 'ok'; stats: SubjectStats } | { status: 'unsupported'; reason: string };

const HIGHLIGHT = 230 / 255;

/** Highlight share, p5/p95 and mean saturation of a decoded picture (alpha is ignored, as in `summarizePng`). */
export function pictureStats(image: DecodedPng): PictureStats {
  const count = image.width * image.height;
  const histogram = new Uint32Array(256);
  let high = 0, saturation = 0;
  for (let p = 0; p < count; p++) {
    const i = p * image.channels, r = image.pixels[i], g = image.pixels[i + 1], b = image.pixels[i + 2];
    const l = luminance(r, g, b);
    histogram[Math.min(255, Math.round(l * 255))]++;
    if (l > HIGHLIGHT) high++;
    const max = Math.max(r, g, b);
    if (max) saturation += (max - Math.min(r, g, b)) / max;
  }
  const percentile = (q: number): number => {
    const rank = Math.max(1, Math.ceil(q * count));
    let seen = 0;
    for (let v = 0; v < 256; v++) { seen += histogram[v]; if (seen >= rank) return v / 255; }
    return 1;
  };
  return { highlightFraction: count ? high / count : 0, p5: count ? percentile(0.05) : 0, p95: count ? percentile(0.95) : 0, meanSaturation: count ? saturation / count : 0 };
}

/** Grow a 0/1 mask by `r` pixels in every direction (a square), with running counts along rows, then columns. */
function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < Math.min(r, width); x++) n += mask[y * width + x];
    for (let x = 0; x < width; x++) {
      if (x + r < width) n += mask[y * width + x + r];
      if (x - r - 1 >= 0) n -= mask[y * width + x - r - 1];
      rows[y * width + x] = n > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    let n = 0;
    for (let y = 0; y < Math.min(r, height); y++) n += rows[y * width + x];
    for (let y = 0; y < height; y++) {
      if (y + r < height) n += rows[(y + r) * width + x];
      if (y - r - 1 >= 0) n -= rows[(y - r - 1) * width + x];
      out[y * width + x] = n > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * The subject against its surround. `mask` is a picture of the same size whose white pixels (luminance at least 0.5, and opaque
 * when it has alpha) mark the subject. The surround is the band of pixels outside the mask within a quarter of the subject's larger
 * box side (at least 2 pixels) of it.
 */
export function subjectStats(image: DecodedPng, mask: DecodedPng): SubjectResult {
  if (mask.width !== image.width || mask.height !== image.height) return { status: 'unsupported', reason: `the mask is ${mask.width}x${mask.height}, the picture ${image.width}x${image.height}` };
  const { width, height } = image, count = width * height;
  const inside = new Uint8Array(count);
  let top = height, bottom = -1, left = width, right = -1, n = 0, sum = 0;
  for (let p = 0; p < count; p++) {
    const m = p * mask.channels;
    if (luminance(mask.pixels[m], mask.pixels[m + 1], mask.pixels[m + 2]) < 0.5 || (mask.channels === 4 && mask.pixels[m + 3] < 128)) continue;
    inside[p] = 1; n++;
    const i = p * image.channels; sum += luminance(image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]);
    const x = p % width, y = (p - x) / width;
    if (y < top) top = y; if (y > bottom) bottom = y; if (x < left) left = x; if (x > right) right = x;
  }
  if (!n) return { status: 'unsupported', reason: 'the mask marks no subject' };
  const subjectHeight = bottom - top + 1;
  const band = Math.max(2, Math.round(Math.max(subjectHeight, right - left + 1) / 4));
  const grown = dilate(inside, width, height, band);
  let around = 0, aroundSum = 0;
  for (let p = 0; p < count; p++) {
    if (!grown[p] || inside[p]) continue;
    const i = p * image.channels; aroundSum += luminance(image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]); around++;
  }
  const subjectMeanLuminance = sum / n;
  const surround = around ? aroundSum / around : undefined;
  return { status: 'ok', stats: { subjectMeanLuminance, ...(surround !== undefined ? { surroundMeanLuminance: surround, subjectContrast: subjectMeanLuminance - surround } : {}), subjectHeight, surroundBand: band } };
}
