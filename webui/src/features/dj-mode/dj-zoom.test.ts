/** Zoom (3b, 37s; 442): the five levels, the window on show, the beat map's density. */
import { describe, expect, it } from 'vitest';

import { BeatGrid } from '@/features/engine/grid';

import {
  zoomDensity,
  zoomOutline,
  zoomSpan,
  zoomStep,
  zoomTicks,
  zoomTransform,
  zoomView,
  zoomWords,
  ZOOM_LEVELS,
} from './dj-zoom';

/** 120 BPM, the first downbeat at 1 s: a bar every 2 s; 142 bars in a 286 s track. */
const grid = () => new BeatGrid({ period: 0.5, firstBeat: 1 });
const lane = () => ({ grid: grid(), bars: 142, truncated: false });

describe('the levels', () => {
  it('five snap levels, no free zoom; − and + stop at the ends', () => {
    expect(ZOOM_LEVELS).toEqual(['whole', 64, 16, 4, 1]);
    expect(zoomStep('whole', 1)).toBe(64);
    expect(zoomStep(4, 1)).toBe(1);
    expect(zoomStep(1, 1)).toBe(1);
    expect(zoomStep('whole', -1)).toBe('whole');
    expect(zoomWords('whole')).toBe('whole track');
    expect(zoomWords(16)).toBe('16 bars');
    expect(zoomWords(1)).toBe('1 bar');
  });
});

describe('the window on show', () => {
  it('whole: the track; zoomed: bars of the grid centred on the playhead', () => {
    expect(zoomView('whole', 100, grid(), 286)).toEqual({ start: 0, end: 286 });
    expect(zoomSpan(16, 100, grid(), 286)).toBe(32);
    expect(zoomView(16, 100, grid(), 286)).toEqual({ start: 84, end: 116 });
    expect(zoomView(1, 21, grid(), 286)).toEqual({ start: 20, end: 22 });
    // without a grid a bar is 2 s; never wider than the track
    expect(zoomSpan(4, 10, null, 286)).toBe(8);
    expect(zoomSpan(64, 10, grid(), 100)).toBe(100);
  });

  it('near the start it runs past the edge, so the playhead stays at the centre', () => {
    expect(zoomView(16, 5, grid(), 286)).toEqual({ start: -11, end: 21 });
  });

  it('the layer’s scale and place, and the sections strip’s outline', () => {
    expect(zoomTransform('whole', 100, grid(), 286)).toEqual({ scale: 1, pos: 0 });
    const t = zoomTransform(16, 143, grid(), 286);
    expect(t.scale).toBeCloseTo(286 / 32);
    expect(t.pos).toBeCloseTo(0.5);
    expect(zoomOutline({ start: 0, end: 286 }, 286)).toBeNull();
    const o = zoomOutline({ start: 84, end: 116 }, 286)!;
    expect(o.x0).toBeCloseTo(84 / 286);
    expect(o.x1).toBeCloseTo(116 / 286);
  });
});

describe('the beat map at each level', () => {
  it('beat ticks only at 4 bars and under; numbers every 32, 16, 4 and 1 bars', () => {
    expect(zoomDensity('whole')).toEqual({ beats: false, numberEvery: 32 });
    expect(zoomDensity(64)).toEqual({ beats: false, numberEvery: 16 });
    expect(zoomDensity(16)).toEqual({ beats: false, numberEvery: 4 });
    expect(zoomDensity(4)).toEqual({ beats: true, numberEvery: 1 });
    expect(zoomDensity(1)).toEqual({ beats: true, numberEvery: 1 });
  });

  it('the ticks over the whole track', () => {
    const whole = zoomTicks(lane(), 286, 'whole');
    expect(whole.filter((t) => t.kind !== 'beat')).toHaveLength(142);
    expect(whole.filter((t) => t.label !== null).map((t) => t.label)).toEqual([1, 33, 65, 97, 129]);
    expect(whole.filter((t) => t.kind === 'phrase')).toHaveLength(18);
    const close = zoomTicks(lane(), 286, 4);
    expect(close.filter((t) => t.kind === 'beat')).toHaveLength(142 * 3);
    expect(close.filter((t) => t.label !== null)).toHaveLength(142);
    expect(
      zoomTicks(lane(), 286, 16)
        .filter((t) => t.label !== null)
        .slice(0, 3)
        .map((t) => t.label),
    ).toEqual([1, 5, 9]);
    // bar 17 (index 16) at 33 s
    expect(close.find((t) => t.label === 17)!.x).toBeCloseTo(33 / 286);
  });
});
