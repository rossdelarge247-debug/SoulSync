/**
 * Data (BACKLOG "Data visualiser: the decoded audio as numbers and bits",
 * step 1; boards 30a–30i): the samples the browser decoded, as numbers and
 * bits, drawn on Classic's canvas. A visual of its own ("Data" in the
 * panel's families, after Classic) and a layer under Classic's spectrum and
 * scope ("Data underneath", off by default, kept per visual).
 *
 * What's real: the analyser hands over the latest block of float samples
 * (−1 to +1) at the AudioContext's rate, after the equalizer, about 60 times
 * a second. Each frame the core adds one row: the newest sample of each
 * channel (so "one row in every 735" at 44.1 kHz and 60 frames a second;
 * worked out from the measured frame rate, not assumed). Values are shown
 * as the file's integers: × 32,768 at 16-bit, × 8,388,608 at 24-bit; a
 * lossy file or a stream (no bit depth of its own) is shown at 16 bits and
 * the readout says so. When the context runs at another rate than the file,
 * the readout says both ("44.1 kHz file · playing at 48 kHz"): the values
 * are then the browser's resampled ones.
 *
 * Everything here is pure or draws on a 2D context it's handed, so the
 * controller owns the loop, the frame-rate rules (none while the tab is
 * hidden; one still block a second under reduced motion) and the audio tap.
 */

export type DataNumbers = 'hex' | 'dec';
export type DataColour = 'accent' | 'phosphor' | 'white';

export const DATA_COLOURS: readonly DataColour[] = ['accent', 'phosphor', 'white'];
export const DATA_COLOUR_NAMES: Record<DataColour, string> = {
  accent: 'Accent',
  phosphor: 'Phosphor',
  white: 'White',
};
/** 30h: Phosphor's green, and the amber full-scale values show in */
export const PHOSPHOR = '110, 231, 160';
export const WHITE = '255, 255, 255';
export const AMBER = '#fbbf24';

const MINUS = '−';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = "'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// ── numbers ──────────────────────────────────────────────────────────────

/** A float sample as the file's integer (253): round(v × 2^(bits−1)), clamped. */
export function toInt(v: number, bits: 16 | 24): number {
  const scale = bits === 24 ? 8388608 : 32768;
  if (!Number.isFinite(v)) return 0;
  const n = Math.round(v * scale);
  return Math.max(-scale, Math.min(scale - 1, n));
}

/** "0x1F3A", "−0x1F3A" (the true signed value, 30e): 4 digits at 16-bit, 6 at 24. */
export function hexSigned(n: number, bits: 16 | 24): string {
  const digits = bits === 24 ? 6 : 4;
  const body = Math.abs(n).toString(16).toUpperCase().padStart(digits, '0');
  return n < 0 ? `${MINUS}0x${body}` : `0x${body}`;
}

/** "−7,994": thousands separated, a true minus sign. */
export function decSigned(n: number): string {
  const body = Math.abs(n).toLocaleString('en-GB');
  return n < 0 ? `${MINUS}${body}` : body;
}

/** At full scale (0x7FFF or −0x8000 at 16-bit), shown in amber (30f). */
export function isFullScale(n: number, bits: 16 | 24): boolean {
  const scale = bits === 24 ? 8388608 : 32768;
  return n >= scale - 1 || n <= -scale;
}

/**
 * The bits as size (30e): a sign cell (lit for negative), then the
 * magnitude's bits from the high bit down, so a quiet sample lights only
 * the right-hand cells and a peak lights nearly all.
 */
export function bitCells(n: number, bits: 16 | 24): { sign: boolean; cells: boolean[] } {
  const width = bits - 1;
  const max = 2 ** width - 1;
  const mag = Math.min(max, Math.abs(n));
  const cells: boolean[] = [];
  for (let b = width - 1; b >= 0; b -= 1) cells.push(Math.floor(mag / 2 ** b) % 2 === 1);
  return { sign: n < 0, cells };
}

/** How many of the newest `count` samples are at full scale (256). */
export function countFullScale(
  buf: ArrayLike<number>,
  count: number,
  bits: 16 | 24,
  gain = 1,
): number {
  const n = Math.max(0, Math.min(buf.length, Math.floor(count)));
  let hits = 0;
  for (let i = buf.length - n; i < buf.length; i += 1) {
    if (isFullScale(toInt((buf[i] ?? 0) * gain, bits), bits)) hits += 1;
  }
  return hits;
}

/**
 * The browser scales the element's sound by its volume before the audio
 * graph sees it (measured in Chromium, 30 October: a clipped file read
 * ±0x599A at 70%), so the values are divided by it to be the file's again.
 * Muted or at 0, nothing reaches the analyser: 1, and the readout says Muted.
 */
export function volumeGain(volume: number, muted: boolean): number {
  if (muted || !Number.isFinite(volume) || volume <= 0.001) return 1;
  return 1 / Math.min(1, volume);
}

/** Every value exactly zero: digital silence (30f), not a quiet room. */
export function allZero(rows: readonly DataRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.l === 0 && (r.r === null || r.r === 0));
}

// ── the readout (30i) ────────────────────────────────────────────────────

export interface DataInfo {
  /** "FLAC", "MP3", "AAC" */
  format: string | null;
  /** the file's (or the stream's, when it says) */
  fileRate: number | null;
  /** 16 or 24 for lossless; null for lossy files and streams */
  bitDepth: number | null;
  channels: number | null;
  /** the library's bitrate (a lossy file's, or a stream's) */
  bitrateKbps: number | null;
  /** the file's size over its length; null for streams */
  onDiskKbps: number | null;
  /** a radio station's name: the readout counts from when you tuned in */
  station: string | null;
  lossless: boolean;
}

export const EMPTY_INFO: DataInfo = {
  format: null,
  fileRate: null,
  bitDepth: null,
  channels: null,
  bitrateKbps: null,
  onDiskKbps: null,
  station: null,
  lossless: false,
};

/** The depth the values are shown at: the file's 16 or 24, else 16. */
export function shownDepth(info: DataInfo): 16 | 24 {
  return info.bitDepth && info.bitDepth > 16 ? 24 : 16;
}

export function khzWords(rate: number): string {
  const k = rate / 1000;
  return `${Number.isInteger(k) ? k : Math.round(k * 10) / 10} kHz`;
}

export function channelWords(channels: number | null): string {
  if (channels === 1) return 'mono';
  if (!channels || channels === 2) return 'stereo';
  return `${channels} channels, showing L and R`;
}

export interface Readout {
  line1: string;
  line2: string;
  /** a third line for what's notable: full scale, mono, lossy, silence */
  flag: string | null;
  flagTone: 'warning' | 'meta' | null;
}

/**
 * Lines 1 and 2 (30a, 30i). Line 1: format · rate · depth · channels, with
 * "44.1 kHz file · playing at 48 kHz" when the browser resamples. Line 2:
 * decoded (rate × depth × channels) and on disk; lossy: the bitrate only.
 */
export function readout(
  info: DataInfo,
  contextRate: number,
  extra: { fullScale: number; silent: boolean },
): Readout {
  const parts: string[] = [];
  parts.push(info.format || 'Audio');
  const fileRate = info.fileRate;
  if (fileRate && contextRate && Math.abs(fileRate - contextRate) > 1)
    parts.push(`${khzWords(fileRate)} file · playing at ${khzWords(contextRate)}`);
  else parts.push(khzWords(fileRate || contextRate || 48000));
  if (info.bitDepth && info.lossless) parts.push(`${info.bitDepth}-bit`);
  parts.push(channelWords(info.channels));
  if (info.station) parts.push(info.station);
  const line1 = parts.join(' · ');

  let line2: string;
  const lossy = !info.lossless || !info.bitDepth;
  if (info.station) {
    line2 = `${info.bitrateKbps ? `${info.bitrateKbps.toLocaleString('en-GB')} kbps stream · ` : ''}decoded to floating point, shown at 16 bits`;
  } else if (!lossy) {
    const rate = fileRate || contextRate;
    const decoded = Math.round((rate * (info.bitDepth ?? 16) * (info.channels || 2)) / 1000);
    line2 = `${decoded.toLocaleString('en-GB')} kbps decoded${
      info.onDiskKbps ? ` · ${info.onDiskKbps.toLocaleString('en-GB')} kbps on disk` : ''
    }`;
  } else if (info.bitrateKbps) {
    line2 = `${info.bitrateKbps.toLocaleString('en-GB')} kbps decoded${info.onDiskKbps ? ' and on disk' : ''}`;
  } else {
    line2 = 'decoded to floating point, shown at 16 bits';
  }

  let flag: string | null = null;
  let flagTone: Readout['flagTone'] = null;
  const depth = shownDepth(info);
  if (extra.fullScale > 0) {
    flag = `At full scale: ${depth === 24 ? '0x7FFFFF' : '0x7FFF'} reached ${extra.fullScale.toLocaleString('en-GB')} ${
      extra.fullScale === 1 ? 'time' : 'times'
    }`;
    flagTone = 'warning';
  } else if (extra.silent) {
    flag = 'Silence';
    flagTone = 'meta';
  } else if (info.channels === 1) {
    flag = 'Mono: one channel, shown once';
    flagTone = 'meta';
  } else if (lossy) {
    flag = 'Lossy: no bit depth of its own · shown at 16 bits';
    flagTone = 'meta';
  }
  return { line1, line2, flag, flagTone };
}

/** "4,512,768 samples played per channel" (mono: "samples played"). */
export function counterWords(samples: number, channels: number | null, stream: boolean): string {
  const n = Math.max(0, Math.floor(samples)).toLocaleString('en-GB');
  const tail = channels === 1 ? '' : ' per channel';
  return `${n} samples ${stream ? 'since you tuned in' : 'played'}${tail}`;
}

/** 30a's foot: "one row in every 735, 60 times a second" (255). */
export function sliceWords(contextRate: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const every = Math.max(1, Math.round(contextRate / f));
  return `The newest sample is at the bottom; one row in every ${every.toLocaleString('en-GB')}, ${f} times a second`;
}

// ── drawing ──────────────────────────────────────────────────────────────

export interface DataRow {
  l: number;
  /** null for a mono file (one column) */
  r: number | null;
}

export interface DataDrawOptions {
  numbers: DataNumbers;
  bits: boolean;
  texture: boolean;
  /** "r, g, b" of the colour (the accent-light, Phosphor or white) */
  rgb: string;
  depth: 16 | 24;
  mono: boolean;
  /** one still block, all at full strength (reduced motion, 30g) */
  snapshot: boolean;
  phone: boolean;
  /** landscape on a phone: one readout line */
  short: boolean;
  readout: Readout;
  counter: string;
  /** "Snapshot · every 1 s" or "Paused" */
  tag: string | null;
  slice: string | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The core's row height and the rows that fit (30a: 22px rows). */
export const ROW_H = 22;
export const CORE_W = 880;

/** Rows that fit under the header row; on a phone, L and R pairs (two lines each). */
export function rowsThatFit(h: number, phone: boolean, mono: boolean): number {
  const lines = Math.max(4, Math.min(phone ? 24 : 20, Math.floor((h - 24) / ROW_H)));
  return phone && !mono ? Math.floor(lines / 2) : lines;
}

/**
 * The texture (30a, 30d): 10px mono values edge to edge, drawn into an
 * offscreen canvas a row at a time and scrolled, so a frame costs one
 * bitmap copy (258), not two thousand glyphs.
 */
export class DataTexture {
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private w = 0;
  private h = 0;
  private rgbKey = '';
  readonly lineH = 14;
  private cellW = 0;
  /** the mode's texture is drawn under a radial dim (30a); kept composed, so a frame is one copy */
  private out: HTMLCanvasElement | OffscreenCanvas | null = null;
  private dim = false;

  constructor(
    private readonly make: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas | null,
  ) {}

  /** (Re)size; true when it's new and needs filling. */
  ensure(w: number, h: number, rgb: string, alpha: number, dim = false): boolean {
    const key = `${rgb}|${alpha}|${dim}`;
    if (this.canvas && this.w === w && this.h === h && this.rgbKey === key) return false;
    this.canvas = this.make(Math.max(1, w), Math.max(1, h));
    this.dim = dim;
    this.out = dim ? this.make(Math.max(1, w), Math.max(1, h)) : null;
    this.ctx = (this.canvas?.getContext('2d') as CanvasRenderingContext2D | null) ?? null;
    this.w = w;
    this.h = h;
    this.rgbKey = key;
    if (this.ctx) {
      this.ctx.font = `400 10px ${MONO}`;
      this.cellW = Math.ceil(this.ctx.measureText('−0x0000').width + 10);
      this.ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
      this.ctx.textBaseline = 'top';
    }
    return true;
  }

  get columns(): number {
    return this.cellW ? Math.ceil(this.w / this.cellW) : 0;
  }

  get lines(): number {
    return Math.ceil(this.h / this.lineH);
  }

  /** Scroll up one line and write `values` (as hex) along the bottom. */
  push(values: readonly number[], depth: 16 | 24): void {
    this.line(values, depth);
    this.compose();
  }

  private line(values: readonly number[], depth: 16 | 24): void {
    const c = this.ctx;
    if (!c || !this.canvas) return;
    const y = this.h - this.lineH;
    // copy the canvas onto itself one line up (a self-blit is defined for 2D canvases)
    c.globalCompositeOperation = 'copy';
    c.drawImage(this.canvas as CanvasImageSource, 0, -this.lineH);
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, y, this.w, this.lineH);
    for (let i = 0; i < values.length; i += 1)
      c.fillText(hexSigned(values[i]!, depth), i * this.cellW + 4, y + 2);
  }

  /** Fill every line at once (a new size, a still texture). */
  fill(values: (i: number) => readonly number[], depth: 16 | 24): void {
    for (let i = 0; i < this.lines; i += 1) this.line(values(i), depth);
    this.compose();
  }

  private compose(): void {
    if (!this.dim || !this.out || !this.canvas) return;
    const o = this.out.getContext('2d') as CanvasRenderingContext2D | null;
    if (!o) return;
    const { w, h } = this;
    o.clearRect(0, 0, w, h);
    o.drawImage(this.canvas as CanvasImageSource, 0, 0);
    const g = o.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.15,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.6,
    );
    g.addColorStop(0, 'rgba(0, 0, 0, 0.85)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.2)');
    o.fillStyle = g;
    o.fillRect(0, 0, w, h);
  }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const src = this.dim ? this.out : this.canvas;
    if (src) ctx.drawImage(src as CanvasImageSource, x, y);
  }
}

function cellLayout(colW: number, valueW: number, depth: 16 | 24) {
  const cells = depth - 1;
  const gap = 3;
  const signGap = 8;
  const room = colW - valueW - 16 - signGap;
  const size = Math.max(4, Math.min(12, Math.floor((room - gap * cells) / (cells + 1))));
  return { cells, gap, signGap, size };
}

function drawBits(
  ctx: CanvasRenderingContext2D,
  n: number,
  x: number,
  y: number,
  depth: 16 | 24,
  rgb: string,
  alpha: number,
  layout: ReturnType<typeof cellLayout>,
  full: boolean,
): void {
  const { sign, cells } = bitCells(n, depth);
  const dark = `rgba(255, 255, 255, ${0.08 * alpha + 0.02})`;
  const lit = full ? AMBER : `rgba(${rgb}, ${alpha})`;
  const dim = `rgba(${rgb}, ${alpha * 0.55})`;
  const s = layout.size;
  ctx.fillStyle = sign ? lit : dark;
  ctx.fillRect(x, y, s, s);
  let cx = x + s + layout.signGap;
  for (let i = 0; i < cells.length; i += 1) {
    // 24-bit: the 8 lowest dimmer, below what 16-bit can hold (30e)
    const low = depth === 24 && i >= cells.length - 8;
    ctx.fillStyle = cells[i] ? (low && !full ? dim : lit) : dark;
    ctx.fillRect(cx, y, s, s);
    cx += s + layout.gap;
  }
}

/** One channel's column: label, header, rows (newest at the bottom). */
function drawColumn(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  label: string,
  rows: readonly (number | null)[],
  o: DataDrawOptions,
  tags?: readonly string[],
  both = false,
): void {
  const one = o.numbers === 'hex' ? (o.depth === 24 ? 104 : 84) : o.depth === 24 ? 120 : 84;
  const other = o.numbers === 'hex' ? (o.depth === 24 ? 120 : 84) : o.depth === 24 ? 104 : 84;
  const valueW = both ? one + other + 8 : one;
  const layout = cellLayout(rect.w, (tags ? 24 : 0) + valueW, o.depth);
  ctx.textBaseline = 'middle';
  ctx.font = `600 12px ${SANS}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.textAlign = 'left';
  const headY = rect.y + 8;
  ctx.fillText(label.toUpperCase(), rect.x, headY);
  if (o.bits) {
    const bx = rect.x + (tags ? 24 : 0) + valueW + 16;
    const end =
      bx + layout.size + layout.signGap + layout.cells * (layout.size + layout.gap) - layout.gap;
    ctx.fillText(`SIGN · BIT ${o.depth - 1}`, bx, headY);
    ctx.textAlign = 'right';
    ctx.fillText('BIT 0', end, headY);
    ctx.textAlign = 'left';
  }
  const top = rect.y + 24;
  ctx.font = `400 15px ${MONO}`;
  const count = rows.length;
  for (let i = 0; i < count; i += 1) {
    const n = rows[i];
    if (n === null || n === undefined) continue;
    const newest = i === count - 1;
    // the newest row accent-light, older rows fading to 30% (30a); a snapshot is all full
    const alpha = o.snapshot ? 1 : newest ? 1 : 0.3 + 0.55 * (i / Math.max(1, count - 1));
    const y = top + i * ROW_H + ROW_H / 2;
    const full = isFullScale(n, o.depth);
    let x = rect.x;
    if (tags) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
      ctx.font = `600 12px ${SANS}`;
      ctx.fillText(tags[i] ?? '', x, y);
      ctx.font = `400 15px ${MONO}`;
      x += 24;
    }
    ctx.fillStyle = full
      ? AMBER
      : newest && !o.snapshot
        ? `rgb(${o.rgb})`
        : `rgba(255, 255, 255, ${0.62 + 0.38 * alpha})`;
    if (both) {
      // hex, then decimal right-aligned beside it (or the other way round)
      const first = o.numbers === 'dec' ? decSigned(n) : hexSigned(n, o.depth);
      const second = o.numbers === 'dec' ? hexSigned(n, o.depth) : decSigned(n);
      ctx.fillText(first, x, y);
      ctx.textAlign = 'right';
      ctx.fillText(second, x + valueW - 8, y);
      ctx.textAlign = 'left';
    } else if (o.numbers === 'dec') {
      ctx.textAlign = 'right';
      ctx.fillText(decSigned(n), x + valueW - 8, y);
      ctx.textAlign = 'left';
    } else ctx.fillText(hexSigned(n, o.depth), x, y);
    if (o.bits)
      drawBits(ctx, n, x + valueW + 16, y - layout.size / 2, o.depth, o.rgb, alpha, layout, full);
  }
}

/** The readout at the top (30a): line 1 at 16/600, line 2 at 14, the counter in mono. */
function drawReadout(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  o: DataDrawOptions,
): number {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (o.short) {
    ctx.font = `600 14px ${SANS}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(`${o.readout.line1} · ${o.counter.replace(/ samples.*/, '')}`, cx, y);
    return y + 22;
  }
  ctx.font = `600 16px ${SANS}`;
  ctx.fillStyle = '#fff';
  ctx.fillText(o.readout.line1, cx, y);
  let at = y + 22;
  if (!o.phone) {
    ctx.font = `400 14px ${SANS}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.fillText(o.readout.line2, cx, at);
    at += 20;
  }
  ctx.font = `400 14px ${MONO}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.fillText(o.counter, cx, at);
  at += 20;
  if (o.readout.flag || o.tag) {
    ctx.font = `600 14px ${SANS}`;
    const words = [o.readout.flag, o.tag].filter(Boolean).join(' · ');
    ctx.fillStyle = o.readout.flagTone === 'warning' ? AMBER : 'rgba(255, 255, 255, 0.72)';
    ctx.fillText(words, cx, at);
    at += 20;
  }
  return at + 12;
}

/**
 * The mode (30a–30c): texture behind a radial dim, the readout, and the
 * core: Left and Right side by side (880px), one Mono column, or on a phone
 * L and R interleaved in one column.
 */
export function drawDataMode(
  ctx: CanvasRenderingContext2D,
  stage: Rect,
  rows: readonly DataRow[],
  o: DataDrawOptions,
  texture: DataTexture | null,
): void {
  // the texture comes composed with its radial dim (DataTexture, 258)
  if (o.texture && texture) texture.draw(ctx, stage.x, stage.y);
  const cx = stage.x + stage.w / 2;
  let y = drawReadout(ctx, cx, stage.y + (o.phone ? 12 : 24), o);
  // without the bits the values need less room (30b): the two columns close in
  const coreW = Math.min(o.bits ? CORE_W : 560, stage.w - (o.phone ? 24 : 80));
  const x0 = cx - coreW / 2;
  const coreH = stage.y + stage.h - y - (o.slice && !o.phone ? 36 : 12);
  if (o.mono) {
    const n = rowsThatFit(coreH, o.phone, true);
    // one column, twice as wide, with decimal beside hex in the full mode (30f)
    const w = Math.min(coreW, o.phone ? coreW : 640);
    drawColumn(
      ctx,
      { x: cx - w / 2, y, w, h: coreH },
      'Mono',
      rows.slice(-n).map((r) => r.l),
      o,
      undefined,
      !o.phone,
    );
    y += 24 + n * ROW_H;
  } else if (o.phone) {
    const pairs = rowsThatFit(coreH, true, false);
    const vals: number[] = [];
    const tags: string[] = [];
    for (const r of rows.slice(-pairs)) {
      vals.push(r.l, r.r ?? 0);
      tags.push('L', 'R');
    }
    drawColumn(ctx, { x: x0, y, w: coreW, h: coreH }, 'L and R', vals, o, tags);
    y += 24 + vals.length * ROW_H;
  } else {
    const n = rowsThatFit(coreH, false, false);
    const colW = (coreW - 40) / 2;
    const recent = rows.slice(-n);
    drawColumn(
      ctx,
      { x: x0, y, w: colW, h: coreH },
      'Left',
      recent.map((r) => r.l),
      o,
    );
    drawColumn(
      ctx,
      { x: x0 + colW + 40, y, w: colW, h: coreH },
      'Right',
      recent.map((r) => r.r ?? 0),
      o,
    );
    y += 24 + n * ROW_H;
  }
  // the foot line only where it fits under the rows
  if (o.slice && !o.phone && !o.short && y + 12 + 20 <= stage.y + stage.h) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `400 14px ${SANS}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
    ctx.fillText(o.slice, cx, y + 12);
  }
}
