import { describe, expect, it } from 'vitest';

import {
  BAR_COUNT,
  barBins,
  barLevels,
  barsRect,
  CLASSIC_GREEN,
  CLASSIC_PEAK,
  CLASSIC_RED,
  CLASSIC_YELLOW,
  drawBars,
  drawScope,
  newBarsState,
  PEAK_HOLD,
  scopePoints,
  SEGMENTS,
  segmentColour,
  stepBars,
} from './classic';

function fakeCtx() {
  const fills: { style: string; x: number; y: number; w: number; h: number }[] = [];
  const path: string[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: String(this.fillStyle), x, y, w, h });
    },
    beginPath: () => path.push('begin'),
    moveTo: () => path.push('move'),
    lineTo: () => path.push('line'),
    stroke: () => path.push('stroke'),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, path };
}

describe('Classic: Winamp’s 19 bars (10b)', () => {
  it('19 log-spaced bands, low to high, inside the spectrum', () => {
    const bins = barBins(512, 48000);
    expect(bins).toHaveLength(BAR_COUNT);
    for (let i = 0; i < bins.length; i++) {
      const [a, b] = bins[i]!;
      expect(b).toBeGreaterThan(a);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(512);
      if (i) expect(a).toBeGreaterThanOrEqual(bins[i - 1]![0]);
    }
    // low bands are narrow, high bands wide
    expect(bins[18]![1] - bins[18]![0]).toBeGreaterThan(bins[0]![1] - bins[0]![0]);
  });

  it('a loud band lights its bar, silence leaves them dark', () => {
    const bins = barBins(512, 48000);
    const freq = new Uint8Array(512);
    expect(barLevels(freq, bins).every((v) => v === 0)).toBe(true);
    freq.fill(255, bins[3]![0], bins[3]![1]);
    const lv = barLevels(freq, bins);
    expect(lv[3]).toBeGreaterThan(0.9);
    expect(lv[10]).toBe(0);
  });

  it('bars jump up and fall back steadily', () => {
    const st = newBarsState(2);
    stepBars(st, [1, 0.5], 1 / 60);
    expect(st.levels).toEqual([1, 0.5]);
    stepBars(st, [0, 0], 0.1);
    expect(st.levels[0]).toBeCloseTo(1 - 0.22, 5);
  });

  it('a peak hangs a moment, then falls faster and faster until the bar catches it', () => {
    const st = newBarsState(1);
    stepBars(st, [1], 1 / 60);
    expect(st.peaks[0]).toBe(1);
    // hold
    for (let t = 0; t < PEAK_HOLD - 0.05; t += 0.05) stepBars(st, [0], 0.05);
    expect(st.peaks[0]).toBe(1);
    const drops: number[] = [];
    let last = st.peaks[0]!;
    for (let i = 0; i < 6; i++) {
      stepBars(st, [0], 0.05);
      drops.push(last - st.peaks[0]!);
      last = st.peaks[0]!;
    }
    expect(drops[5]).toBeGreaterThan(drops[2]!);
    expect(st.peaks[0]).toBeGreaterThanOrEqual(st.levels[0]!);
  });

  it('green at the bottom, yellow in the middle, red at the top', () => {
    expect(segmentColour(0.1)).toBe(CLASSIC_GREEN);
    expect(segmentColour(0.5)).toBe(CLASSIC_YELLOW);
    expect(segmentColour(0.9)).toBe(CLASSIC_RED);
  });

  it('720px wide at a 1440 window, centred in the room the panel leaves', () => {
    const full = barsRect(1440, 900, 0);
    expect(full.w).toBe(720);
    expect(full.x).toBe(360);
    const panel = 520 + 32;
    const r = barsRect(1440, 900, panel);
    expect(r.w).toBe(720);
    expect(r.x).toBe(Math.round((1440 - panel - 720) / 2));
    const phone = barsRect(390, 844, 0);
    expect(phone.w).toBeLessThanOrEqual(390 - 32);
  });

  it('draws lit segments in the ramp’s colours, and the peaks when asked', () => {
    const st = newBarsState(2);
    st.levels = [1, 0.25];
    st.peaks = [1, 0.5];
    const { ctx, fills } = fakeCtx();
    drawBars(ctx, st, { x: 0, y: 0, w: 100, h: 160 }, { peaks: true });
    const bar0 = fills.filter((f) => f.x === 0 && f.style !== CLASSIC_PEAK);
    expect(bar0).toHaveLength(SEGMENTS);
    expect(bar0[0]!.style).toBe(CLASSIC_GREEN);
    expect(bar0[SEGMENTS - 1]!.style).toBe(CLASSIC_RED);
    expect(fills.filter((f) => f.style === CLASSIC_PEAK)).toHaveLength(2);
    const { ctx: c2, fills: f2 } = fakeCtx();
    drawBars(c2, st, { x: 0, y: 0, w: 100, h: 160 }, { peaks: false });
    expect(f2.filter((f) => f.style === CLASSIC_PEAK)).toHaveLength(0);
  });
});

describe('Classic: the oscilloscope (10b)', () => {
  it('samples the wave into -1..1 points', () => {
    const time = new Uint8Array(1024).fill(128);
    time[0] = 255;
    time[512] = 0;
    const pts = scopePoints(time, 4);
    expect(pts).toHaveLength(4);
    expect(pts[0]).toBeCloseTo(127 / 128, 3);
    expect(pts[2]).toBe(-1);
    expect(pts[1]).toBe(0);
  });

  it('Lines strokes one path, Dots and Solid fill', () => {
    const pts = [0, 0.5, -0.5, 1];
    const lines = fakeCtx();
    drawScope(lines.ctx, pts, { x: 0, y: 0, w: 100, h: 100 }, 'lines');
    expect(lines.path).toEqual(['begin', 'move', 'line', 'line', 'line', 'stroke']);
    const dots = fakeCtx();
    drawScope(dots.ctx, pts, { x: 0, y: 0, w: 100, h: 100 }, 'dots');
    expect(dots.fills).toHaveLength(4);
    const solid = fakeCtx();
    drawScope(solid.ctx, pts, { x: 0, y: 0, w: 100, h: 100 }, 'solid');
    expect(solid.fills).toHaveLength(4);
    // a solid column reaches from the middle to the sample
    expect(solid.fills[3]!.h).toBeCloseTo(50, 0);
  });
});
