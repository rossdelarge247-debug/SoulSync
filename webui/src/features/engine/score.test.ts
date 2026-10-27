import { describe, expect, it } from 'vitest';

import { DEFAULT_BARS, KILL_DB, STYLES, scoreFor, type ParamKey, type Point } from './score';

const last = (pts: Point[] | undefined) => pts?.at(-1);

describe('the styles as scores (26a)', () => {
  it('every style ends with the incoming deck in and the outgoing one out', () => {
    for (const style of STYLES) {
      const s = scoreFor(style, undefined, { crossfadeSeconds: 6, beatSeconds: 0.48 });
      expect(last(s.lanes['B.xf'])?.value, style).toBe(1);
      expect(last(s.lanes['A.xf'])?.value, style).toBe(0);
      // in time order, every lane
      for (const [key, pts] of Object.entries(s.lanes) as [ParamKey, Point[]][]) {
        for (let i = 1; i < pts.length; i++)
          expect(pts[i].beat, `${style} ${key}`).toBeGreaterThanOrEqual(pts[i - 1].beat);
      }
    }
  });

  it('takes each style at its own length unless one is chosen', () => {
    expect(scoreFor('long_blend', null).beats).toBe(4 * DEFAULT_BARS.long_blend);
    expect(scoreFor('long_blend', 16).beats).toBe(64);
    expect(scoreFor('cut', null).beats).toBe(0);
    expect(scoreFor('crossfade', null, { crossfadeSeconds: 6 }).beats).toBe(6);
  });

  it('a long blend brings the incoming deck in over the first half and swaps the bass on the middle downbeat', () => {
    const s = scoreFor('long_blend', 32);
    expect(s.beatmatch).toBe(true);
    expect(last(s.lanes['B.xf'])?.beat).toBe(64);
    expect(s.lanes['A.xf']?.find((p) => p.value < 1)?.beat).toBeGreaterThan(64);
    expect(s.lanes['B.low']?.[0]).toEqual({ beat: 0, value: KILL_DB, ramp: 'set' });
    expect(last(s.lanes['B.low'])).toEqual({ beat: 65, value: 0, ramp: 'linear' });
    expect(last(s.lanes['A.low'])).toEqual({ beat: 65, value: KILL_DB, ramp: 'linear' });
    expect(s.marker).toEqual({ beat: 64, label: 'bass swap' });
  });

  it('a cut is on the one, an echo out rings on after it', () => {
    const cut = scoreFor('cut', null);
    expect(cut.beatmatch).toBe(false);
    expect(last(cut.lanes['A.xf'])?.beat).toBeLessThan(0.05);
    const echo = scoreFor('echo_out', 4, { beatSeconds: 0.5 });
    expect(echo.beatmatch).toBe(false);
    expect(echo.lanes['A.echoSend']?.[0].beat).toBe(-1); // the last beat goes into the echo
    expect(echo.lanes['A.echoTime']?.[0].value).toBeCloseTo(0.375);
    expect(last(echo.lanes['A.echoReturn'])).toMatchObject({ beat: 16, value: 0 });
    expect(echo.aStop).toBeLessThan(0.1);
  });

  it('a filter sweep opens the incoming high-pass and closes the outgoing one', () => {
    const s = scoreFor('filter_sweep', 16);
    expect(s.lanes['B.hp']?.[0].value).toBe(900);
    expect(last(s.lanes['B.hp'])).toMatchObject({ beat: 32, ramp: 'exp' });
    expect(last(s.lanes['A.hp'])).toMatchObject({ beat: 64, value: 1500, ramp: 'exp' });
  });

  it('a drop swap swaps on the incoming drop, at the window end', () => {
    const s = scoreFor('drop_swap', 16);
    expect(s.marker).toEqual({ beat: 64, label: 'drop' });
    expect(s.lanes['A.xf']?.find((p) => p.value === 0)?.beat).toBeGreaterThan(64);
    expect(s.aStop).toBeGreaterThan(64);
  });

  it('brings the incoming deck in at its trim and back to its own level by the end', () => {
    const s = scoreFor('short_blend', 8, { trimDb: -6 });
    expect(s.lanes['B.trim']?.[0].value).toBeCloseTo(0.501, 3);
    expect(last(s.lanes['B.trim'])).toMatchObject({ beat: 32, value: 1 });
    expect(scoreFor('short_blend', 8).lanes['B.trim']).toBeUndefined();
  });
});
