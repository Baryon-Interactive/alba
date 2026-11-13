import type { DecodedPng } from './png.ts';

/**
 * The first component (the luma of a colour JPEG, or its only channel) of a JPEG at one pixel per 8x8 block: each block's mean
 * value, read from its DC coefficient. Enough to tell a flat (black or blank) capture and to compare pictures, without an IDCT.
 * Baseline and extended Huffman JPEGs decode every scan; a progressive one decodes its first DC scan. Arithmetic-coded and lossless
 * JPEGs are not read.
 */
export type JpegDecodeResult = { status: 'ok'; image: DecodedPng } | { status: 'unsupported'; reason: string };

interface Huffman { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array }
interface Component { id: number; h: number; v: number; tq: number; blocksX: number; blocksY: number; dc?: Int32Array }

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let length = 1; length <= 16; length++) {
    valptr[length] = k; mincode[length] = code;
    code += counts[length - 1]; k += counts[length - 1];
    maxcode[length] = counts[length - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, values };
}

class Bits {
  private bit = 0;
  private byte = 0;
  /** Set when the scan's data ends (a marker follows). */
  ended = false;
  private readonly data: Buffer;
  pos: number;
  constructor(data: Buffer, pos: number) { this.data = data; this.pos = pos; }
  read(): number {
    if (this.bit === 0) {
      if (this.pos >= this.data.length) { this.ended = true; return 0; }
      const value = this.data[this.pos];
      if (value === 0xff) {
        const next = this.data[this.pos + 1];
        if (next === 0x00) { this.pos += 2; }
        else { this.ended = true; return 0; } // a marker: no more data in this interval
      } else this.pos++;
      this.byte = value; this.bit = 8;
    }
    this.bit--;
    return (this.byte >> this.bit) & 1;
  }
  receive(count: number): number { let v = 0; for (let i = 0; i < count; i++) v = (v << 1) | this.read(); return v; }
  /** Drop the rest of the byte and step over an RSTn marker. */
  restart(): void {
    this.bit = 0; this.ended = false;
    while (this.pos + 1 < this.data.length && !(this.data[this.pos] === 0xff && this.data[this.pos + 1] >= 0xd0 && this.data[this.pos + 1] <= 0xd7)) this.pos++;
    this.pos += 2;
  }
}

const decode = (bits: Bits, table: Huffman): number => {
  let code = bits.read(), length = 1;
  while (code > table.maxcode[length]) {
    code = (code << 1) | bits.read();
    if (++length > 16) throw new Error('bad Huffman code');
  }
  return table.values[table.valptr[length] + code - table.mincode[length]];
};
const extend = (value: number, size: number) => (size && value < 1 << (size - 1) ? value - (1 << size) + 1 : value);

export function decodeJpegBlocks(data: Buffer): JpegDecodeResult {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return { status: 'unsupported', reason: 'not a JPEG' };
  const dcTables: (Huffman | undefined)[] = [], acTables: (Huffman | undefined)[] = [], quant: number[] = [];
  let frame: { precision: number; width: number; height: number; progressive: boolean; components: Component[]; hmax: number; vmax: number } | undefined;
  let restartInterval = 0, decodedScan = false;
  let pos = 2;
  try {
    while (pos + 4 <= data.length) {
      if (data[pos] !== 0xff) { pos++; continue; }
      const marker = data[pos + 1];
      if (marker === 0xff) { pos++; continue; }
      if (marker === 0xd9) break;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
      const length = data.readUInt16BE(pos + 2), start = pos + 4, end = pos + 2 + length;
      if (length < 2 || end > data.length) return { status: 'unsupported', reason: 'truncated JPEG segment' };
      const seg = data.subarray(start, end);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const count = seg[5];
        if (count !== 1 && count !== 3) return { status: 'unsupported', reason: `JPEG with ${count} components` };
        const components: Component[] = [];
        for (let i = 0; i < count; i++) components.push({ id: seg[6 + i * 3], h: seg[7 + i * 3] >> 4, v: seg[7 + i * 3] & 15, tq: seg[8 + i * 3], blocksX: 0, blocksY: 0 });
        const width = seg.readUInt16BE(3), height = seg.readUInt16BE(1);
        if (!width || !height) return { status: 'unsupported', reason: 'JPEG without a size' };
        const hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v));
        if (!hmax || !vmax) return { status: 'unsupported', reason: 'invalid JPEG sampling' };
        for (const c of components) { c.blocksX = Math.ceil(Math.ceil(width * c.h / hmax) / 8); c.blocksY = Math.ceil(Math.ceil(height * c.v / vmax) / 8); }
        if (components[0].blocksX * components[0].blocksY > 16 * 1024 * 1024) return { status: 'unsupported', reason: 'JPEG is too large' };
        components[0].dc = new Int32Array(components[0].blocksX * components[0].blocksY);
        frame = { precision: seg[0], width, height, progressive: marker === 0xc2, components, hmax, vmax };
      } else if ((marker >= 0xc3 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { status: 'unsupported', reason: 'arithmetic-coded or lossless JPEG' };
      } else if (marker === 0xc4) {
        let p = 0;
        while (p < seg.length) {
          const tc = seg[p] >> 4, th = seg[p] & 15, counts = seg.subarray(p + 1, p + 17);
          const total = counts.reduce((n, c) => n + c, 0);
          const table = buildHuffman(counts, seg.subarray(p + 17, p + 17 + total));
          (tc === 0 ? dcTables : acTables)[th] = table;
          p += 17 + total;
        }
      } else if (marker === 0xdb) {
        let p = 0;
        while (p < seg.length) {
          const pq = seg[p] >> 4, tq = seg[p] & 15;
          quant[tq] = pq ? seg.readUInt16BE(p + 1) : seg[p + 1]; // only the DC entry (the first) is needed
          p += 1 + (pq ? 128 : 64);
        }
      } else if (marker === 0xdd) {
        restartInterval = seg.readUInt16BE(0);
      } else if (marker === 0xda) {
        if (!frame) return { status: 'unsupported', reason: 'JPEG scan before its frame' };
        const count = seg[0];
        const scan = Array.from({ length: count }, (_, i) => ({ component: frame!.components.find(c => c.id === seg[1 + i * 2])!, td: seg[2 + i * 2] >> 4, ta: seg[2 + i * 2] & 15 }));
        const ss = seg[1 + count * 2], se = seg[2 + count * 2], ah = seg[3 + count * 2] >> 4, al = seg[3 + count * 2] & 15;
        const bits = new Bits(data, end);
        // A progressive JPEG: only its first DC scan is read; the others refine detail the block means do not need.
        const wanted = !frame.progressive || (ss === 0 && ah === 0);
        if (wanted && scan.every(s => s.component) && scan.some(s => s.component === frame!.components[0])) {
          decodeScan(bits, frame, scan, { dcTables, acTables, restartInterval, progressive: frame.progressive, se, al });
          decodedScan = true;
        }
        // Step to the next marker that is not a stuffed byte or a restart.
        let p = Math.max(end, bits.pos);
        while (p + 1 < data.length && !(data[p] === 0xff && data[p + 1] !== 0x00 && !(data[p + 1] >= 0xd0 && data[p + 1] <= 0xd7))) p++;
        pos = p;
        if (frame.progressive && decodedScan) break;
        continue;
      }
      pos = end;
    }
  } catch (error) {
    return { status: 'unsupported', reason: `invalid JPEG data (${(error as Error).message})` };
  }
  if (!frame || !decodedScan) return { status: 'unsupported', reason: 'JPEG has no image data' };
  const luma = frame.components[0];
  const q = quant[luma.tq];
  if (q === undefined) return { status: 'unsupported', reason: 'JPEG without its quantization table' };
  const max = (1 << frame.precision) - 1, offset = 1 << (frame.precision - 1);
  const pixels = Buffer.alloc(luma.blocksX * luma.blocksY * 3);
  for (let i = 0; i < luma.dc!.length; i++) {
    const mean = Math.max(0, Math.min(max, luma.dc![i] * q / 8 + offset));
    pixels.fill(Math.round(mean * 255 / max), i * 3, i * 3 + 3);
  }
  return { status: 'ok', image: { width: luma.blocksX, height: luma.blocksY, channels: 3, pixels } };
}

function decodeScan(bits: Bits, frame: { components: Component[]; hmax: number; vmax: number; width: number; height: number }, scan: { component: Component; td: number; ta: number }[],
  o: { dcTables: (Huffman | undefined)[]; acTables: (Huffman | undefined)[]; restartInterval: number; progressive: boolean; se: number; al: number }): void {
  const predictors = new Int32Array(scan.length);
  const block = (index: number, x: number, y: number) => {
    const { component, td, ta } = scan[index];
    const dcTable = o.dcTables[td];
    if (!dcTable) throw new Error('missing DC table');
    const size = decode(bits, dcTable);
    predictors[index] += extend(bits.receive(size), size);
    if (component.dc && x < component.blocksX && y < component.blocksY) component.dc[y * component.blocksX + x] = predictors[index] << (o.progressive ? o.al : 0);
    if (o.progressive) return; // a DC-only scan has no AC coefficients
    const acTable = o.acTables[ta];
    if (!acTable) throw new Error('missing AC table');
    for (let k = 1; k <= 63;) {
      const rs = decode(bits, acTable), run = rs >> 4, s = rs & 15;
      if (s === 0) { if (run !== 15) break; k += 16; continue; }
      bits.receive(s); k += run + 1;
    }
  };
  let mcus: number, perRow: number;
  const single = scan.length === 1;
  if (single) { perRow = scan[0].component.blocksX; mcus = perRow * scan[0].component.blocksY; }
  else { perRow = Math.ceil(frame.width / (8 * frame.hmax)); mcus = perRow * Math.ceil(frame.height / (8 * frame.vmax)); }
  for (let m = 0; m < mcus; m++) {
    if (o.restartInterval && m > 0 && m % o.restartInterval === 0) { bits.restart(); predictors.fill(0); }
    const mx = m % perRow, my = Math.floor(m / perRow);
    if (single) block(0, mx, my);
    else for (const [index, { component }] of scan.entries()) for (let v = 0; v < component.v; v++) for (let h = 0; h < component.h; h++) block(index, mx * component.h + h, my * component.v + v);
    if (bits.ended && m < mcus - 1 && !(o.restartInterval && (m + 1) % o.restartInterval === 0)) throw new Error('scan data ends early');
  }
}
