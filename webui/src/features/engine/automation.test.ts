import { describe, expect, it } from 'vitest';

import { AutomatedParam, ParamTimeline } from './automation';
import { FakeParam } from './testing';

/** The biggest step between neighbouring samples of a param over [a, b] (1 ms apart). */
function biggestStep(at: (t: number) => number, a: number, b: number): number {
  let worst = 0;
  let prev = at(a);
  for (let t = a + 0.001; t <= b; t += 0.001) {
    const v = at(t);
    worst = Math.max(worst, Math.abs(v - prev));
    prev = v;
  }
  return worst;
}

describe('the timeline model', () => {
  it('evaluates sets, straight ramps and exponential ramps as the spec does', () => {
    const tl = new ParamTimeline(1);
    tl.add('set', 1, 0);
    tl.add('linear', 3, 1);
    tl.add('exp', 5, 100);
    tl.add('set', 6, 7);
    expect(tl.valueAt(0.5)).toBe(1);
    expect(tl.valueAt(1)).toBe(0);
    expect(tl.valueAt(2)).toBeCloseTo(0.5);
    expect(tl.valueAt(4)).toBeCloseTo(10);
    expect(tl.valueAt(5.5)).toBeCloseTo(100);
    expect(tl.valueAt(9)).toBe(7);
  });

  it('holds a ramp mid-way on its own curve', () => {
    const tl = new ParamTimeline(0);
    tl.add('set', 0, 0);
    tl.add('linear', 4, 8);
    const held = tl.holdAt(1);
    expect(held).toEqual({ value: 2, kind: 'linear' });
    expect(tl.valueAt(0.5)).toBeCloseTo(1);
    expect(tl.valueAt(3)).toBe(2);
  });
});

describe('stopping where it is (Design 250)', () => {
  const schedule = (p: AutomatedParam) => {
    p.set(0, 0);
    p.linear(4, 1);
    p.set(5, 1);
    p.exp(9, 1000);
  };

  for (const hasHold of [true, false]) {
    it(`never jumps, ${hasHold ? 'with' : 'without'} cancelAndHoldAtTime`, () => {
      for (const at of [0.5, 2.25, 4.5, 6, 8.75]) {
        const fake = new FakeParam(0, hasHold);
        const p = new AutomatedParam(fake, 'x', 0);
        schedule(p);
        const before = p.valueAt(at);
        const held = p.hold(at);
        expect(held).toBeCloseTo(before, 9);
        // what the browser now plays: the same up to `at`, then that value
        const v = (t: number) => fake.browser.valueAt(t);
        expect(v(at)).toBeCloseTo(held, 9);
        expect(v(at + 3)).toBeCloseTo(held, 9);
        expect(biggestStep(v, Math.max(0, at - 0.5), at + 0.5)).toBeLessThan(
          0.02 * Math.max(1, held),
        );
        // and the engine's own copy agrees with the browser everywhere
        for (let t = 0; t < 12; t += 0.37) expect(p.valueAt(t)).toBeCloseTo(v(t), 6);
      }
    });
  }

  it('a plain cancelScheduledValues would have jumped back (why the ramp is rescheduled)', () => {
    const fake = new FakeParam(0, false);
    const p = new AutomatedParam(fake, 'x', 0);
    p.set(0, 0);
    p.linear(4, 1);
    fake.cancelScheduledValues(2);
    expect(fake.browser.valueAt(1.99)).toBe(0); // the ramp in progress is gone: 0.5 → 0
  });

  it('uses cancelAndHoldAtTime where there is one', () => {
    const fake = new FakeParam(0, true);
    const p = new AutomatedParam(fake, 'x', 0);
    p.set(0, 0);
    p.linear(4, 1);
    p.hold(1);
    expect(fake.calls.at(-1)).toBe('hold 1');
    const plain = new FakeParam(0, false);
    const q = new AutomatedParam(plain, 'x', 0);
    q.set(0, 0);
    q.linear(4, 1);
    q.hold(1);
    expect(plain.calls.slice(-2)).toEqual(['cancel 1', 'linear 0.25 1']);
  });

  it('an exponential ramp stays above zero', () => {
    const fake = new FakeParam(1, true);
    const p = new AutomatedParam(fake, 'f', 1);
    p.set(0, 100);
    p.exp(1, 0);
    expect(p.valueAt(1)).toBeGreaterThan(0);
  });
});
