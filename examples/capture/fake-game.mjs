#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    scene: { type: 'string' },
    size: { type: 'string' },
    delay: { type: 'string' },
    'exit-before': { type: 'string' },
    hang: { type: 'boolean' },
    'keep-running': { type: 'boolean' },
    'ignore-scene': { type: 'boolean' },
    black: { type: 'boolean' },
    marker: { type: 'string' },
  },
  strict: true,
});

const markerFile = values.marker ?? process.env.FAKE_GAME_MARKER;
if (markerFile) {
  mkdirSync(path.dirname(path.resolve(markerFile)), { recursive: true });
  writeFileSync(markerFile, `${process.pid} ${values.scene ?? 'menu'}\n`, { encoding: 'utf8', flag: 'a' });
}

function encodePng(width, height, rgb) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function setPixel(rgb, width, height, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const o = (y * width + x) * 3;
  rgb[o] = r;
  rgb[o + 1] = g;
  rgb[o + 2] = b;
}

function fillRect(rgb, width, height, x0, y0, w, h, r, g, b) {
  const xEnd = Math.min(width, x0 + w);
  const yEnd = Math.min(height, y0 + h);
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    for (let x = Math.max(0, x0); x < xEnd; x++) {
      setPixel(rgb, width, height, x, y, r, g, b);
    }
  }
}

function drawBlackWithStripedBox(width, height) {
  const rgb = Buffer.alloc(width * height * 3, 0);
  const bw = Math.max(4, Math.floor(width / 16));
  const bh = Math.max(4, Math.floor(height / 16));
  const bx = Math.floor((width - bw) / 2);
  const by = Math.floor((height - bh) / 2);
  for (let y = 0; y < bh; y++) {
    if (y % 2 === 1) continue;
    for (let x = 0; x < bw; x++) {
      setPixel(rgb, width, height, bx + x, by + y, 60, 60, 60);
    }
  }
  return rgb;
}

function drawScene(sceneName, width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  if (sceneName === 'menu') {
    for (let y = 0; y < height; y++) {
      const t = y / Math.max(1, height - 1);
      const r = Math.round(52 + 60 * (1 - t));
      const g = Math.round(64 + 56 * (1 - t));
      const b = Math.round(92 + 70 * (1 - t));
      for (let x = 0; x < width; x++) setPixel(rgb, width, height, x, y, r, g, b);
    }
    const bw = Math.max(8, Math.floor(width * 0.42));
    const bh = Math.max(4, Math.floor(height * 0.1));
    const bx = Math.floor(width * 0.12);
    fillRect(rgb, width, height, bx, Math.floor(height * 0.25), bw, bh, 232, 198, 112);
    fillRect(rgb, width, height, bx, Math.floor(height * 0.44), bw, bh, 206, 214, 228);
    fillRect(rgb, width, height, bx, Math.floor(height * 0.63), bw, bh, 178, 190, 210);
    return rgb;
  }

  if (sceneName === 'day') {
    const horizon = Math.floor(height * 0.56);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (y < horizon) {
          const t = y / Math.max(1, horizon);
          setPixel(rgb, width, height, x, y, Math.round(125 + 65 * t), Math.round(185 + 45 * t), 245);
        } else {
          const band = ((Math.floor(x / 12) + Math.floor(y / 10)) % 2) * 24;
          setPixel(rgb, width, height, x, y, 96 + band, 152 + band, 74 + Math.floor(band / 2));
        }
      }
    }
    fillRect(rgb, width, height, Math.floor(width * 0.72), Math.floor(height * 0.12), Math.max(6, Math.floor(width * 0.14)), Math.max(6, Math.floor(height * 0.22)), 252, 244, 168);
    return rgb;
  }

  if (sceneName === 'night') {
    const horizon = Math.floor(height * 0.54);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (y < horizon) {
          setPixel(rgb, width, height, x, y, 48, 66, 118);
        } else {
          const tile = ((Math.floor(x / 10) + Math.floor(y / 8)) % 2) * 22;
          setPixel(rgb, width, height, x, y, 58 + tile, 72 + tile, 98 + tile);
        }
      }
    }
    fillRect(rgb, width, height, Math.floor(width * 0.14), Math.floor(height * 0.12), Math.max(6, Math.floor(width * 0.12)), Math.max(6, Math.floor(height * 0.2)), 236, 232, 196);
    fillRect(rgb, width, height, Math.floor(width * 0.45), Math.floor(height * 0.62), Math.max(8, Math.floor(width * 0.22)), Math.max(6, Math.floor(height * 0.18)), 228, 164, 88);
    return rgb;
  }

  const digest = createHash('sha256').update(sceneName).digest();
  const baseR = 55 + (digest[0] % 95);
  const baseG = 55 + (digest[1] % 95);
  const baseB = 55 + (digest[2] % 95);
  const cellW = 8 + (digest[3] % 16);
  const cellH = 8 + (digest[4] % 16);
  for (let y = 0; y < height; y++) {
    const gy = Math.round((y / Math.max(1, height - 1)) * 55);
    for (let x = 0; x < width; x++) {
      const checker = ((Math.floor((x + digest[5]) / cellW) + Math.floor((y + digest[6]) / cellH)) % 2) * 38;
      setPixel(rgb, width, height, x, y, Math.min(245, baseR + gy + checker), Math.min(245, baseG + checker), Math.min(245, baseB + (55 - gy)));
    }
  }
  for (let k = 0; k < 3; k++) {
    const o = 7 + k * 5;
    const rx = Math.floor(((digest[o] / 255) * 0.68) * width);
    const ry = Math.floor(((digest[o + 1] / 255) * 0.68) * height);
    const rw = Math.max(6, Math.floor((0.14 + (digest[o + 2] / 255) * 0.18) * width));
    const rh = Math.max(6, Math.floor((0.14 + (digest[o + 3] / 255) * 0.18) * height));
    const bright = k % 2 === 0 ? 235 : 42;
    fillRect(rgb, width, height, rx, ry, rw, rh, bright, Math.min(250, bright + (digest[o + 4] % 30)), Math.max(35, bright - (digest[o + 4] % 40)));
  }
  return rgb;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const sizeMatch = /^(\d+)x(\d+)$/i.exec(values.size ?? '320x180');
if (!sizeMatch) {
  process.stderr.write(`invalid --size "${values.size}" (expected WxH)\n`);
  process.exit(2);
}
const width = Number(sizeMatch[1]);
const height = Number(sizeMatch[2]);
if (!width || !height) {
  process.stderr.write('size dimensions must be positive\n');
  process.exit(2);
}

const delayMs = values.delay ? Number(values.delay) : 0;
if (delayMs > 0) await pause(delayMs);

if (values['exit-before'] !== undefined) {
  const code = Number(values['exit-before']);
  process.exit(Number.isInteger(code) ? code : 1);
}

if (values.hang) {
  setInterval(() => {}, 60_000);
} else {
  if (!values.out) {
    process.stderr.write('--out <png> is required\n');
    process.exit(2);
  }
  const effectiveScene = values['ignore-scene'] ? 'menu' : (values.scene ?? 'menu');
  const pixels = values.black ? drawBlackWithStripedBox(width, height) : drawScene(effectiveScene, width, height);
  const outPath = path.resolve(values.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, encodePng(width, height, pixels));
  if (values['keep-running']) {
    setInterval(() => {}, 60_000);
  }
}
