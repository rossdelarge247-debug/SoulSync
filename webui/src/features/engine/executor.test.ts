import { describe, expect, it } from 'vitest';

import { LOOKAHEAD } from './automation';
import { Transition, type PlanLike, type TransitionInput } from './executor';
import { BeatGrid } from './grid';
import { FINISHED, PARAM_NAMES, WENT_BACK, type DeckId, type ParamName } from './score';
import { FakePort } from './testing';

const SR = 48000;
const A = new BeatGrid({ period: 60 / 124, firstBeat: 0.5 });
const B = new BeatGrid({ period: 60 / 126, firstBeat: 0.2 });

function plan(over: Partial<PlanLike> = {}): PlanLike {
  return {
    status: 'ok',
    style: 'long_blend',
    bars: 32,
    beatmatch: true,
    tempo: { relation: 'same', rate: 124 / 126, speed_change_ok: true },
    out: { start: A.barTime(80), bar: 80, end_bar: 112 },
    in: { start: B.barTime(0), bar: 0 },
    length_s: 61.9,
    ...over,
  };
}

function setup(over: Partial<TransitionInput> = {}, hasHold = true) {
  const port = new FakePort(SR, hasHold);
  port.time = 1;
  // the outgoing deck is playing at its own speed and reaches out.start at t0
  const p = over.plan ?? plan();
  const t0 = 20;
  port.map('A', 0, [{ f: 0, p: (p.out.start ?? 0) - t0, r: 1 }]);
  const tr = new Transition({ plan: p, from: 'A', to: 'B', gridA: A, gridB: B, t0, ...over }, port);
  tr.start();
  return { port, tr, t0 };
}

/** The largest step of any param of either deck over [a, b] (1 ms apart). */
function biggestStep(port: FakePort, a: number, b: number): { step: number; key: string } {
  let worst = { step: 0, key: '' };
  for (const deck of ['A', 'B'] as DeckId[]) {
    for (const name of PARAM_NAMES) {
      // frequencies in kHz, EQ gains in tens of dB, gains as they are
      const scale = ['hp', 'lp', 'echoTone'].includes(name)
        ? 1000
        : ['low', 'mid', 'high'].includes(name)
          ? 10
          : 1;
      let prev = port.value(deck, name, a);
      for (let t = a + 0.001; t <= b; t += 0.001) {
        const v = port.value(deck, name, t);
        const step = Math.abs(v - prev) / scale;
        if (step > worst.step) worst = { step, key: `${deck}.${name}@${t.toFixed(3)}` };
        prev = v;
      }
    }
  }
  return worst;
}

describe('running a plan (stage B)', () => {
  it('lines the incoming downbeat up on the outgoing phrase, beat for beat through the window', () => {
    const { port, tr, t0 } = setup();
    expect(port.position('A', t0)).toBeCloseTo(A.barTime(80), 6);
    expect(port.position('B', t0)).toBeCloseTo(B.barTime(0), 6);
    const clock = tr.beatClock;
    for (let phi = 0; phi <= 128; phi += 4) {
      const t = clock.timeAt(phi);
      expect(port.position('A', t)).toBeCloseTo(A.timeAt(A.barBeat(80) + phi), 5);
      expect(port.position('B', t)).toBeCloseTo(B.timeAt(phi), 5);
    }
    // and after, the incoming deck at its own speed
    expect(port.rate('B', clock.timeAt(150))).toBeCloseTo(1, 4);
  });

  it('plays the score: the incoming deck in by the middle, the bass swapped, the outgoing out by the end', () => {
    const { port, tr, t0 } = setup();
    const at = (phi: number) => tr.beatClock.timeAt(phi);
    expect(port.value('B', 'xf', t0 - 0.01)).toBe(0);
    expect(port.value('B', 'xf', at(64))).toBeCloseTo(1, 6);
    expect(port.value('A', 'xf', at(64))).toBeCloseTo(1, 6);
    expect(port.value('A', 'xf', at(128))).toBeCloseTo(0, 6);
    expect(port.value('B', 'low', at(63))).toBe(-40);
    expect(port.value('B', 'low', at(65))).toBe(0);
    expect(port.value('A', 'low', at(65))).toBe(-40);
    expect(tr.state().phase).toBe('counting');
    port.time = at(50);
    expect(tr.state()).toMatchObject({ phase: 'mixing', bar: 13, bars: 32, label: 'Long blend' });
    port.time = at(130);
    expect(tr.state().phase).toBe('done');
  });

  it('chooses a plain speed change within 3% and the stretch past it, or always with key lock', () => {
    expect(setup().tr.modes).toEqual({ out: 'resample', in: 'resample' });
    const far = new BeatGrid({ period: 60 / 131, firstBeat: 0.2 });
    const wide = setup({
      gridB: far,
      plan: plan({ in: { start: far.barTime(0), bar: 0 }, bars: 8, style: 'short_blend' }),
    });
    expect(wide.tr.modes).toEqual({ out: 'stretch', in: 'stretch' });
    expect(wide.port.modes).toEqual({ A: 'stretch', B: 'stretch' });
    expect(setup({ keyLock: 'always' }).tr.modes).toEqual({ out: 'stretch', in: 'stretch' });
  });

  it('cancels before it starts: nothing changes, the incoming deck never plays', () => {
    const { port, tr, t0 } = setup();
    port.time = 5;
    tr.cancel();
    expect(tr.state().phase).toBe('cancelled');
    expect(port.value('B', 'xf', t0 + 30)).toBe(0);
    expect(port.value('A', 'xf', t0 + 70)).toBe(1);
    expect(port.stops.B).toBeLessThanOrEqual((5 + LOOKAHEAD) * SR + 1);
    expect(port.rate('A', t0 + 30)).toBeCloseTo(1, 6);
  });

  for (const hasHold of [true, false]) {
    it(`finishes over one bar from the next beat without a jump (${hasHold ? 'with' : 'without'} cancelAndHold)`, () => {
      const { port, tr } = setup({}, hasHold);
      const clock = tr.beatClock;
      port.time = clock.timeAt(40.3);
      tr.finishNow();
      const t = clock.timeAt(41);
      const period = clock.periodAt(41);
      const end = t + 4 * period;
      for (const [key, value] of Object.entries(FINISHED)) {
        const [deck, name] = key.split('.') as [DeckId, ParamName];
        expect(port.value(deck, name, end + 0.01), key).toBeCloseTo(value, 3);
      }
      expect(biggestStep(port, port.time, end + 1).step).toBeLessThan(0.05);
      // the decks stay on the beat through the bar, then the incoming one is back at its own speed
      const phiEnd = tr.beatClock.beatAt(end);
      expect(phiEnd).toBeCloseTo(45, 4);
      expect(port.position('B', end)).toBeCloseTo(B.timeAt(45), 4);
      expect(port.position('A', end)).toBeCloseTo(A.timeAt(A.barBeat(80) + 45), 4);
      expect(port.rate('B', end + 4 * 4 * period + 1)).toBeCloseTo(1, 4);
      expect(port.stops.A / SR).toBeCloseTo(end, 1);
      expect(tr.state().phase).toBe('done');
    });
  }

  it('goes back over one bar, even after the bass swap (Design 251)', () => {
    const { port, tr } = setup();
    const clock = tr.beatClock;
    port.time = clock.timeAt(80.6);
    tr.back();
    const t = clock.timeAt(81);
    const end = t + 4 * clock.periodAt(81);
    for (const [key, value] of Object.entries(WENT_BACK)) {
      const [deck, name] = key.split('.') as [DeckId, ParamName];
      expect(port.value(deck, name, end + 0.01), key).toBeCloseTo(value, 3);
    }
    expect(biggestStep(port, port.time, end + 1).step).toBeLessThan(0.05);
    expect(port.position('A', end)).toBeCloseTo(A.timeAt(A.barBeat(80) + 85), 4);
    expect(port.rate('A', end + 20)).toBeCloseTo(1, 4);
    expect(port.stops.B / SR).toBeCloseTo(end, 1);
    expect(port.stops.A).toBe(Infinity);
    expect(tr.state().phase).toBe('back');
  });

  for (const hasHold of [true, false]) {
    it(`takes over: every control stops where it is, the decks stay on the beat (Design 250, ${hasHold ? 'with' : 'without'} cancelAndHold)`, () => {
      const { port, tr } = setup({}, hasHold);
      const clock = tr.beatClock;
      port.time = clock.timeAt(70.4);
      const t = port.time + LOOKAHEAD;
      const before = PARAM_NAMES.map((n) => [port.value('A', n, t), port.value('B', n, t)]);
      tr.takeover();
      PARAM_NAMES.forEach((n, i) => {
        expect(port.value('A', n, t + 30), `A.${n}`).toBeCloseTo(before[i][0], 6);
        expect(port.value('B', n, t + 30), `B.${n}`).toBeCloseTo(before[i][1], 6);
      });
      expect(biggestStep(port, port.time, t + 5).step).toBeLessThan(0.05);
      const rA = port.rate('A', t + 10);
      const rB = port.rate('B', t + 10);
      expect(rA / rB).toBeCloseTo(60 / 124 / (60 / 126), 4);
      expect(tr.state().phase).toBe('yours');
    });
  }

  it('crossfades plainly when the plan falls back (no grid for the outgoing track)', () => {
    const fallback = plan({
      status: 'crossfade',
      style: 'crossfade',
      bars: null,
      beatmatch: false,
      out: { start: 200, bar: null },
      in: { start: 1.5, bar: null },
      length_s: 6,
      fallback: { kind: 'crossfade', code: 'no_beat', reason: 'Sand Script has no steady beat' },
    });
    const { port, tr, t0 } = setup({ plan: fallback, gridA: null });
    expect(tr.beatmatch).toBe(false);
    expect(port.position('B', t0)).toBeCloseTo(1.5, 6);
    expect(port.rate('B', t0 + 3)).toBeCloseTo(1, 6);
    expect(port.value('B', 'xf', t0 + 3)).toBeCloseTo(Math.SQRT1_2, 1);
    expect(port.value('A', 'xf', t0 + 6.01)).toBeCloseTo(0, 6);
    expect(tr.state().fallback).toBe('Sand Script has no steady beat');
  });

  it('a cut is on the one and needs no tempo match', () => {
    const { port, tr, t0 } = setup({ plan: plan({ style: 'cut', bars: 0, beatmatch: false }) });
    expect(tr.beatmatch).toBe(false);
    expect(port.value('A', 'xf', t0 + 0.05)).toBe(0);
    expect(port.value('B', 'xf', t0 + 0.05)).toBe(1);
    expect(port.position('B', t0)).toBeCloseTo(B.barTime(0), 6);
    expect(port.rate('B', t0 + 1)).toBeCloseTo(1, 6);
  });
});

describe('interruptions (Design 252)', () => {
  it('cancels a countdown when Web Audio stops', () => {
    const { port, tr } = setup();
    port.time = 10;
    tr.onLifecycle({ kind: 'interrupted', reason: 'suspended' });
    expect(tr.state().phase).toBe('cancelled');
  });

  it('finishes with a short crossfade once sound is back from a cut-off mix', () => {
    const { port, tr } = setup();
    const clock = tr.beatClock;
    port.time = clock.timeAt(30);
    tr.onLifecycle({ kind: 'interrupted', reason: 'interrupted' });
    expect(tr.state().phase).toBe('interrupted');
    port.time = clock.timeAt(30) + 0.01; // the context's time stood still meanwhile
    const events: string[] = [];
    tr.on((e) => events.push(e.type));
    tr.onLifecycle({ kind: 'resumed', reason: 'interrupted', forMs: 40000 });
    expect(events).toContain('crossfaded');
    const end = port.time + LOOKAHEAD + 2;
    expect(port.value('B', 'xf', end)).toBeCloseTo(1, 6);
    expect(port.value('A', 'xf', end)).toBeCloseTo(0, 6);
    expect(port.value('B', 'low', end)).toBeCloseTo(0, 6);
    expect(biggestStep(port, port.time, end + 1).step).toBeLessThan(0.05);
  });

  it('on a phone, a hidden page finishes the mix over one bar before the lock stops it', () => {
    const { port, tr } = setup({ phone: true });
    port.time = tr.beatClock.timeAt(20.2);
    tr.onLifecycle({ kind: 'interrupted', reason: 'hidden' });
    expect(tr.state().phase).toBe('done');
    const end = tr.beatClock.timeAt(25);
    expect(port.value('B', 'xf', end + 0.01)).toBeCloseTo(1, 6);
  });
});
