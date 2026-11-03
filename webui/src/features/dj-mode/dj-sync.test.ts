/** Sync's maps (416, 421, 433): B on A's beats from A's next bar. */
import { describe, expect, it } from 'vitest';

import { BeatGrid } from '@/features/engine/grid';

import { gridA, gridB } from './dj-mix.fixtures';
import { cueBeat, lockedKnots, nextBar, syncRatio, syncRatioFromBpm } from './dj-sync';

describe('the ratio', () => {
  it('the same tempo, half and double time, and out of range', () => {
    expect(syncRatioFromBpm(124, 126)!.rate).toBeCloseTo(124 / 126);
    expect(syncRatioFromBpm(124, 62)).toEqual({ m: 0.5, rate: 1 });
    expect(syncRatioFromBpm(124, 248)).toEqual({ m: 2, rate: 1 });
    expect(syncRatioFromBpm(124, 150)).toBeNull();
    expect(syncRatioFromBpm(null, 124)).toBeNull();
    expect(syncRatio(0.5, 0.48)!.rate).toBeCloseTo(0.96);
  });
});

describe('A’s next bar (421)', () => {
  it('is the first bar at least the lead after A’s position', () => {
    expect(nextBar(gridA(), 121.12)).toEqual({ bar: 61, time: 123 });
    // a bar that starts too soon is skipped
    expect(nextBar(gridA(), 122.9)).toEqual({ bar: 62, time: 125 });
    expect(nextBar(gridA(), 0)).toEqual({ bar: 0, time: 1 });
  });

  it('on a drifting grid too', () => {
    const beats = Array.from({ length: 200 }, (_, i) => 1 + i * 0.5 + i * i * 0.0005);
    const g = new BeatGrid({ kind: 'beats', period: 0.5, firstBeat: 1, beats });
    const nb = nextBar(g, 40);
    expect(nb.time).toBeGreaterThanOrEqual(40.25);
    expect(g.barTime(nb.bar - 1)).toBeLessThan(40.25);
  });
});

describe('B locked to A', () => {
  it('B’s cue is its nearest bar', () => {
    expect(cueBeat(gridB(), 0.52)).toEqual({ beat: 0, time: 0.5 });
    expect(cueBeat(gridB(), 2.3).time).toBeCloseTo(2.42);
  });

  it('at A’s beat a0 + k, B is at its beat b0 + k·m', () => {
    const knots = lockedKnots({
      gridA: gridA(),
      a0: 244,
      rateA: 1,
      gridB: gridB(),
      b0: 0,
      m: 1,
      t0: 10,
      sampleRate: 48000,
      untilB: 20,
    });
    expect(knots[0]).toEqual({ f: 480000, p: 0.5, r: expect.closeTo(0.96, 9) });
    expect(knots[8]!.f / 48000).toBeCloseTo(14);
    expect(knots[8]!.p).toBeCloseTo(0.5 + 8 * 0.48);
    // stops once B passes the window's end
    expect(knots.at(-1)!.p).toBeGreaterThan(20);
    expect(knots.at(-2)!.p).toBeLessThanOrEqual(20);
  });

  it('half time: one beat of B every two of A, at B’s own speed', () => {
    const slow = new BeatGrid({ period: 1, firstBeat: 0 });
    const knots = lockedKnots({
      gridA: gridA(),
      a0: 0,
      rateA: 1,
      gridB: slow,
      b0: 0,
      m: 0.5,
      t0: 0,
      sampleRate: 48000,
      untilB: 4,
    });
    expect(knots[2]!.p).toBeCloseTo(1);
    expect(knots[0]!.r).toBeCloseTo(1);
  });
});
