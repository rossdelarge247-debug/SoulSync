import { describe, expect, it } from 'vitest';

import type { Plan } from '../loader';

import { BeatGrid } from '../grid';
import { labAllowed } from './lab-gate';
import { windowsFor } from './lab-session';

const A = new BeatGrid({ period: 60 / 124, firstBeat: 0.5 });
const B = new BeatGrid({ period: 60 / 126, firstBeat: 0.2 });

function plan(over: Partial<Plan> = {}): Plan {
  return {
    status: 'ok',
    style: 'long_blend',
    bars: 32,
    beatmatch: true,
    tempo: { relation: 'same', rate: 0.984, speed_change_ok: true },
    out: { start: A.barTime(80), bar: 80 },
    in: { start: B.barTime(0), bar: 0 },
    length_s: 62,
    ...over,
  };
}

describe('the lab', () => {
  it('asks for windows that cover the run-up, the mix, and room to finish or go back', () => {
    const w = windowsFor(plan(), A, B, 8);
    expect(w.outStart).toBeCloseTo(A.barTime(80), 9);
    expect(w.aFrom).toBeCloseTo(A.barTime(72), 9);
    expect(w.a.start).toBeCloseTo(w.aFrom - 0.5, 9);
    expect(w.a.start + w.a.dur).toBeGreaterThanOrEqual(A.barTime(128));
    expect(w.b.start).toBe(0);
    expect(w.b.start + w.b.dur).toBeGreaterThan(B.timeAt(128 + 16));
    expect(w.a.dur).toBeLessThanOrEqual(180);
    expect(w.b.dur).toBeLessThanOrEqual(180);
  });

  it('keeps a window to the server’s three minutes', () => {
    const slow = new BeatGrid({ period: 60 / 70, firstBeat: 0 });
    const w = windowsFor(plan({ out: { start: slow.barTime(80), bar: 80 } }), slow, B, 16);
    expect(w.a.dur).toBe(180);
  });

  it('a crossfade without a grid plays its run-up in seconds', () => {
    const w = windowsFor(
      plan({
        status: 'crossfade',
        style: 'crossfade',
        bars: null,
        out: { start: 200, bar: null },
        in: { start: 1, bar: null },
        length_s: 6,
      }),
      null,
      null,
      8,
    );
    expect(w.aFrom).toBe(185);
    expect(w.a.start + w.a.dur).toBeCloseTo(214, 6);
    expect(w.b).toEqual({ start: 0.5, dur: 60.5 });
  });

  it('is for admins, in a development build or with ?lab=1', () => {
    expect(labAllowed(true, true, '')).toBe(true);
    expect(labAllowed(true, false, '')).toBe(false);
    expect(labAllowed(true, false, '?lab=1')).toBe(true);
    expect(labAllowed(false, true, '?lab=1')).toBe(false);
  });
});
