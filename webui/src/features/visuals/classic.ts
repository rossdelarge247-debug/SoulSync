/**
 * Classic (board 10b): Winamp's own two, drawn by SYNCHRO.S at the screen's
 * size. The 19-bar spectrum with falling peaks (green → yellow → red, the
 * visual's colours, not the UI's) and the oscilloscope (Lines / Dots /
 * Solid). The maths is pure and tested; the two draw functions only paint.
 */

import type { ScopeDraw } from './visuals.types';

export const BAR_COUNT = 19;
export const SEGMENTS = 16;
const F_MIN = 60;
const F_MAX = 16000;

/** The visual's three colours, bottom to top (Winamp's default viscolor ramp). */
export const CLASSIC_GREEN = '#2fb84e';
export const CLASSIC_YELLOW = '#cdd23b';
export const CLASSIC_RED = '#e4532f';
export const CLASSIC_PEAK = 'rgba(255, 255, 255, 0.86)';

/** The colour of a segment by how high it sits (0 bottom, 1 top). */
export function segmentColour(height: number): string {
  if (height < 0.45) return CLASSIC_GREEN;
  if (height < 0.7) return CLASSIC_YELLOW;
  return CLASSIC_RED;
}

/** [lo, hi) FFT bins for each of `count` log-spaced bars. */
export function barBins(
  binCount: number,
  sampleRate: number,
  count = BAR_COUNT,
): [number, number][] {
  const nyquist = sampleRate / 2;
  const hzPerBin = nyquist / binCount;
  const out: [number, number][] = [];
  const ratio = Math.pow(F_MAX / F_MIN, 1 / count);
  let lo = F_MIN;
  for (let i = 0; i < count; i++) {
    const hi = lo * ratio;
    let a = Math.floor(lo / hzPerBin);
    let b = Math.ceil(hi / hzPerBin);
    a = Math.max(0, Math.min(binCount - 1, a));
    b = Math.max(a + 1, Math.min(binCount, b));
    out.push([a, b]);
    lo = hi;
  }
  return out;
}

/** 19 levels 0..1 from a byte spectrum (the analyser's getByteFrequencyData). */
export function barLevels(freq: ArrayLike<number>, bins: readonly [number, number][]): number[] {
  return bins.map(([a, b]) => {
    let peak = 0;
    let sum = 0;
    for (let i = a; i < b; i++) {
      const v = freq[i] ?? 0;
      sum += v;
      if (v > peak) peak = v;
    }
    const avg = sum / Math.max(1, b - a);
    // the loudest bin carries a bar, like Winamp's; a little of the average keeps it steady
    const v = (peak * 0.7 + avg * 0.3) / 255;
    return Math.min(1, Math.max(0, v));
  });
}

export interface BarsState {
  levels: number[];
  peaks: number[];
  /** seconds a peak has waited before falling, then its falling speed */
  hold: number[];
  speed: number[];
}

export function newBarsState(count = BAR_COUNT): BarsState {
  return {
    levels: Array.from({ length: count }, () => 0),
    peaks: Array.from({ length: count }, () => 0),
    hold: Array.from({ length: count }, () => 0),
    speed: Array.from({ length: count }, () => 0),
  };
}

/** How fast a bar falls (levels a second) and how a peak hangs, then drops. */
export const BAR_FALL = 2.2;
export const PEAK_HOLD = 0.35;
export const PEAK_GRAVITY = 2.6;

/**
 * One frame: a bar jumps up to its level and falls back steadily; a peak
 * marker rides the top, hangs a moment, then falls faster and faster until
 * the bar catches it.
 */
export function stepBars(state: BarsState, target: readonly number[], dt: number): BarsState {
  const t = Math.min(0.1, Math.max(0, dt));
  for (let i = 0; i < state.levels.length; i++) {
    const want = target[i] ?? 0;
    const cur = state.levels[i]!;
    state.levels[i] = want >= cur ? want : Math.max(want, cur - BAR_FALL * t);
    const level = state.levels[i]!;
    if (level >= state.peaks[i]!) {
      state.peaks[i] = level;
      state.hold[i] = 0;
      state.speed[i] = 0;
    } else if (state.hold[i]! < PEAK_HOLD) {
      state.hold[i] = state.hold[i]! + t;
    } else {
      state.speed[i] = state.speed[i]! + PEAK_GRAVITY * t;
      state.peaks[i] = Math.max(level, state.peaks[i]! - state.speed[i]! * t);
    }
  }
  return state;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the bars go: 720px wide at a 1440 window (half the width, kept
 * between 280 and 960), centred in the room the panel leaves, a little
 * above the middle.
 */
export function barsRect(viewW: number, viewH: number, panelW: number): Rect {
  const room = Math.max(0, viewW - panelW);
  const want = Math.min(960, Math.max(280, viewW * 0.5));
  const width = Math.round(Math.max(0, Math.min(want, room - 32)));
  const h = Math.round(Math.min(viewH * 0.46, width * 0.55));
  return {
    x: Math.round((room - width) / 2),
    y: Math.round((viewH - h) / 2 - viewH * 0.03),
    w: width,
    h,
  };
}

export function drawBars(
  ctx: CanvasRenderingContext2D,
  state: BarsState,
  rect: Rect,
  opts: { peaks: boolean; scale?: number },
): void {
  const s = opts.scale ?? 1;
  const n = state.levels.length;
  const gap = Math.max(2, Math.round((rect.w / n) * 0.25));
  const barW = (rect.w - gap * (n - 1)) / n;
  const segGap = Math.max(1, Math.round(2 * s));
  const segH = (rect.h - segGap * (SEGMENTS - 1)) / SEGMENTS;
  for (let i = 0; i < n; i++) {
    const x = rect.x + i * (barW + gap);
    const lit = Math.round(state.levels[i]! * SEGMENTS);
    for (let k = 0; k < lit; k++) {
      ctx.fillStyle = segmentColour((k + 0.5) / SEGMENTS);
      const y = rect.y + rect.h - (k + 1) * segH - k * segGap;
      ctx.fillRect(x, y, barW, segH);
    }
    if (opts.peaks && state.peaks[i]! > 0.01) {
      const py = rect.y + rect.h - state.peaks[i]! * rect.h - Math.max(3, 4 * s) - segGap * 2;
      ctx.fillStyle = CLASSIC_PEAK;
      ctx.fillRect(x, Math.max(rect.y - 8 * s, py), barW, Math.max(3, Math.round(4 * s)));
    }
  }
}

/** `count` points -1..1 from a time-domain byte buffer (128 is silence). */
export function scopePoints(time: ArrayLike<number>, count: number): number[] {
  const out: number[] = [];
  const len = time.length;
  if (!len || count <= 0) return out;
  const stride = len / count;
  for (let i = 0; i < count; i++) {
    const v = time[Math.min(len - 1, Math.floor(i * stride))] ?? 128;
    out.push(Math.max(-1, Math.min(1, (v - 128) / 128)));
  }
  return out;
}

export function scopeRect(viewW: number, viewH: number, panelW: number): Rect {
  const r = barsRect(viewW, viewH, panelW);
  return { x: r.x, y: Math.round(viewH / 2 - r.h / 2), w: r.w, h: r.h };
}

export function drawScope(
  ctx: CanvasRenderingContext2D,
  points: readonly number[],
  rect: Rect,
  draw: ScopeDraw,
  scale = 1,
): void {
  const mid = rect.y + rect.h / 2;
  const amp = rect.h / 2;
  const n = points.length;
  if (n < 2) return;
  const xAt = (i: number) => rect.x + (i / (n - 1)) * rect.w;
  if (draw === 'dots') {
    const r = Math.max(1.5, 2 * scale);
    for (let i = 0; i < n; i++) {
      const v = points[i]!;
      ctx.fillStyle = segmentColour(Math.abs(v));
      ctx.fillRect(xAt(i) - r, mid - v * amp - r, r * 2, r * 2);
    }
    return;
  }
  if (draw === 'solid') {
    for (let i = 0; i < n; i++) {
      const v = points[i]!;
      ctx.fillStyle = segmentColour(Math.abs(v));
      const y = mid - v * amp;
      const w = Math.max(1, rect.w / n);
      ctx.fillRect(xAt(i), Math.min(mid, y), w, Math.max(1, Math.abs(y - mid)));
    }
    return;
  }
  ctx.strokeStyle = CLASSIC_GREEN;
  ctx.lineWidth = Math.max(1.5, 2 * scale);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const y = mid - points[i]! * amp;
    if (i === 0) ctx.moveTo(xAt(i), y);
    else ctx.lineTo(xAt(i), y);
  }
  ctx.stroke();
}

/** A still for the panel's tiles: a fixed, Winamp-looking shape. */
export function stillBars(count = BAR_COUNT): number[] {
  return Array.from({ length: count }, (_, i) => {
    const x = i / Math.max(1, count - 1);
    return Math.max(0.12, Math.min(0.95, 0.9 - x * 0.62 + 0.12 * Math.sin(i * 1.7)));
  });
}

export function stillWave(count = 64): number[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i / count;
    return 0.55 * Math.sin(t * Math.PI * 9) * (0.6 + 0.4 * Math.sin(t * Math.PI * 2.3 + 1));
  });
}
