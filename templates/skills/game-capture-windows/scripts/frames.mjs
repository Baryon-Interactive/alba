// Checks captures before they are cited as evidence. Node 18+ and ffmpeg on PATH; no packages.
//   node frames.mjs sheet <clip.mp4 | picture...> --out sheet.png [--every 10] [--tile 3x3] [--width 480]
//       one contact sheet: every Nth frame of a clip, or the pictures in order
//   node frames.mjs luma <clip.mp4 | picture...> [--json]
//       mean luminance (0..1) of each frame, and the change from the frame before
//   node frames.mjs check <clip.mp4 | picture...> [--black 0.04] [--flicker 0.05] [--cuts 12,40] [--json]
//       black frames (mean luminance below --black) and flicker (luminance jumping by more than --flicker between two
//       frames of a clip, except at the frame numbers given as camera cuts); exit 1 when any is found
//   node frames.mjs same <file...>
//       files with identical bytes (one picture under several names); exit 1 when any are found
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const VIDEO = /\.(mp4|mkv|mov|avi|webm|gif)$/i;

function parse(argv) {
  const files = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (k === 'json') opts.json = true; else opts[k] = argv[++i]; }
    else files.push(a);
  }
  return { files, opts };
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`ffmpeg did not start (${r.error.message}); it must be on PATH`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
  return r;
}

/** The input of ffmpeg for a clip, or for pictures copied as a numbered sequence (removed by the caller). */
function input(files) {
  if (files.length === 1 && VIDEO.test(files[0])) return { args: ['-i', files[0]], done() {} };
  const ext = path.extname(files[0]).toLowerCase() || '.png';
  if (files.some(f => (path.extname(f).toLowerCase() || '.png') !== ext)) throw new Error('give pictures of one file type');
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-frames-'));
  try { files.forEach((f, i) => copyFileSync(f, path.join(dir, `f${String(i).padStart(5, '0')}${ext}`))); }
  catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  return { args: ['-framerate', '1', '-i', path.join(dir, `f%05d${ext}`)], done() { rmSync(dir, { recursive: true, force: true }); } };
}

/** Per frame: the mean of a value signalstats prints (YAVG: luminance, 0..255 for 8-bit). */
function stat(files, filter) {
  const src = input(files);
  try {
    const r = ffmpeg([...src.args, '-vf', `${filter}signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-f', 'null', '-']);
    return [...r.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map(m => Number(m[1]) / 255);
  } finally { src.done(); }
}

function luma(files) {
  const values = stat(files, 'format=gray,');
  return values.map((v, i) => ({ frame: i, ...(files.length > 1 ? { file: files[i] } : {}), luma: round(v), change: i ? round(v - values[i - 1]) : 0 }));
}
const round = v => Math.round(v * 10000) / 10000;

function check(files, opts) {
  const black = Number(opts.black ?? 0.04), flicker = Number(opts.flicker ?? 0.05);
  const cuts = new Set(String(opts.cuts ?? '').split(',').filter(Boolean).map(Number));
  const frames = luma(files);
  const blacks = frames.filter(f => f.luma < black);
  const clip = files.length === 1 && VIDEO.test(files[0]);
  const flickers = frames.filter(f => clip && f.frame > 0 && !cuts.has(f.frame) && Math.abs(f.change) > flicker);
  return { frames: frames.length, black: { threshold: black, frames: blacks }, flicker: { threshold: flicker, cuts: [...cuts], frames: flickers }, ok: !blacks.length && !flickers.length };
}

function same(files) {
  const by = new Map();
  for (const f of files) { const h = createHash('sha256').update(readFileSync(f)).digest('hex'); by.set(h, [...(by.get(h) ?? []), f]); }
  return [...by.values()].filter(g => g.length > 1);
}

function sheet(files, opts) {
  if (!opts.out) throw new Error('--out <sheet.png> is needed');
  const [cols, rows] = String(opts.tile ?? '3x3').split('x').map(Number);
  const width = Number(opts.width ?? 480), every = Number(opts.every ?? 10);
  const video = files.length === 1 && VIDEO.test(files[0]);
  const height = Math.round(width * 9 / 16 / 2) * 2;
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  const src = input(files);
  try {
    ffmpeg(['-y', ...src.args, '-vf', `${video ? `select=not(mod(n\\,${every})),` : ''}${fit},tile=${cols}x${rows}`, '-frames:v', '1', '-update', '1', opts.out]);
  } finally { src.done(); }
  return opts.out;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { files, opts } = parse(rest);
  if (!command || !files.length) { console.error('usage: frames.mjs sheet|luma|check|same <files...> (see the top of this file)'); return 2; }
  if (command === 'same') {
    const groups = same(files);
    for (const g of groups) console.log(`same bytes: ${g.join(', ')}`);
    if (!groups.length) console.log(`all ${files.length} files differ`);
    return groups.length ? 1 : 0;
  }
  if (command === 'sheet') { console.log(`saved ${sheet(files, opts)}`); return 0; }
  if (command === 'luma') {
    const frames = luma(files);
    if (opts.json) console.log(JSON.stringify(frames));
    else for (const f of frames) console.log(`${String(f.frame).padStart(5)}  luma ${f.luma.toFixed(4)}  change ${f.change >= 0 ? '+' : ''}${f.change.toFixed(4)}${f.file ? `  ${f.file}` : ''}`);
    return 0;
  }
  if (command === 'check') {
    const r = check(files, opts);
    if (opts.json) console.log(JSON.stringify(r));
    else {
      console.log(`${r.frames} frames`);
      console.log(r.black.frames.length ? `black (luma < ${r.black.threshold}): frames ${r.black.frames.map(f => f.frame).join(', ')}` : 'no black frames');
      console.log(r.flicker.frames.length ? `flicker (luma change > ${r.flicker.threshold}): ${r.flicker.frames.map(f => `frame ${f.frame} ${f.change >= 0 ? '+' : ''}${f.change}`).join(', ')}` : 'no flicker');
    }
    return r.ok ? 0 : 1;
  }
  console.error(`unknown command ${command}`);
  return 2;
}

try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 2; }
