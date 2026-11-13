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
