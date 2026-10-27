import { describe, expect, it } from 'vitest';

import { loadMessage, WorkletRunner } from './run-worklet';

const SR = 48000;

function sine(freq: number, seconds: number, rate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function noise(seconds: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 2 ** 32 - 0.5) * 0.8;
  }
  return out;
}

/** Clicks (a 1 ms raised-cosine burst) every `every` seconds. */
function clicks(every: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const w = Math.round(0.001 * SR);
  for (let t = 0.25; t < seconds - 0.01; t += every) {
    const at = Math.round(t * SR);
    for (let j = 0; j < w; j++) out[at + j] = 0.9 * (0.5 - 0.5 * Math.cos((2 * Math.PI * j) / w));
  }
  return out;
}

/** The frequency of a tone, from its zero crossings. */
function pitch(x: Float32Array, from: number, to: number): number {
  let n = 0;
  let first = -1;
  let last = -1;
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      if (first < 0) first = i;
      last = i;
      n++;
    }
  }
  return ((n - 1) * SR) / (last - first);
}

/** The energy centroids (seconds) of the clicks in x. */
function clickTimes(x: Float32Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < x.length) {
    if (Math.abs(x[i]) > 0.05) {
      let e = 0;
      let et = 0;
      const end = Math.min(x.length, i + Math.round(0.02 * SR));
      for (let j = i; j < end; j++) {
        const v = x[j] * x[j];
        e += v;
        et += v * j;
      }
      out.push(et / e / SR);
      i = end;
    } else i++;
  }
  return out;
}

function knots(f: number, p: number, r: number): Float64Array {
  return Float64Array.from([f, p, r]);
}

describe('the deck processor', () => {
  it('plays a window back sample for sample at rate 1 (after its fade in)', () => {
    const w = new WorkletRunner(SR);
    const src = noise(1);
    w.send(loadMessage(0, src, src, SR, 10));
    w.send({ type: 'map', deck: 0, from: 0, knots: knots(0, 10 + 1000 / SR, 1) });
    const [a] = w.render(SR / 2);
    for (let i = 256; i < 20000; i++) expect(a[0][i]).toBeCloseTo(src[1000 + i], 6);
    expect(a[0][0]).toBe(0); // the fade starts from silence
  });

  it('stretches at rate 1 back to the source exactly', () => {
    const w = new WorkletRunner(SR);
    const src = noise(2);
    w.send(loadMessage(1, src, src, SR, 0));
    w.send({ type: 'mode', deck: 1, mode: 'stretch' });
    w.send({ type: 'map', deck: 1, from: 0, knots: knots(0, 0.2, 1) });
    const [, b] = w.render(SR);
    let worst = 0;
    for (let i = 4096; i < SR - 4096; i++)
      worst = Math.max(worst, Math.abs(b[0][i] - src[Math.round(0.2 * SR) + i]));
    expect(worst).toBeLessThan(1e-5);
  });

  it('keeps the pitch while the tempo changes (stretch), and moves it with a plain speed change', () => {
    const src = sine(440, 4);
    const stretch = new WorkletRunner(SR);
    stretch.send(loadMessage(0, src, src, SR));
    stretch.send({ type: 'mode', deck: 0, mode: 'stretch' });
    stretch.send({ type: 'map', deck: 0, from: 0, knots: knots(0, 0.1, 1.06) });
    const [s] = stretch.render(2 * SR);
    expect(pitch(s[0], SR / 4, (3 * SR) / 2)).toBeCloseTo(440, 0);
    const vinyl = new WorkletRunner(SR);
    vinyl.send(loadMessage(0, src, src, SR));
    vinyl.send({ type: 'map', deck: 0, from: 0, knots: knots(0, 0.1, 1.06) });
    const [v] = vinyl.render(2 * SR);
    expect(pitch(v[0], SR / 4, (3 * SR) / 2)).toBeCloseTo(440 * 1.06, 0);
  });

  it('puts each beat where the map says, within 3 ms while stretching', () => {
    const src = clicks(0.5, 12);
    for (const rate of [0.94, 1.03, 1.08]) {
      const w = new WorkletRunner(SR);
      w.send(loadMessage(0, src, src, SR));
      w.send({ type: 'mode', deck: 0, mode: 'stretch' });
      w.send({ type: 'map', deck: 0, from: 0, knots: knots(0, 0, rate) });
      const [a] = w.render(10 * SR);
      const heard = clickTimes(a[0]).filter((t) => t > 0.1);
      // click k is at 0.25 + 0.5k in the track: rate faster, it's heard sooner
      const errors = heard.map((t) => {
        const k = Math.round((t * rate - 0.25) / 0.5);
        return Math.abs(t - (0.25 + 0.5 * k) / rate);
      });
      expect(heard.length).toBeGreaterThan(10);
      expect(Math.max(...errors)).toBeLessThan(0.003);
    }
  });

  it('follows a new map from its frame on without a break', () => {
    const w = new WorkletRunner(SR);
    const src = sine(220, 4);
    w.send(loadMessage(0, src, src, SR));
    w.send({ type: 'map', deck: 0, from: 0, knots: knots(0, 0.5, 1) });
    w.render(SR / 2);
    // from frame 24064: the same place, now slowing by 2%
    const f = 24064;
    w.send({ type: 'map', deck: 0, from: f, knots: knots(f, 0.5 + f / SR, 0.98) });
    const [a] = w.render(SR / 2);
    let jump = 0;
    for (let i = 1; i < a[0].length; i++) jump = Math.max(jump, Math.abs(a[0][i] - a[0][i - 1]));
    expect(jump).toBeLessThan(0.02); // a 220 Hz sine at 0.5 moves at most 0.0144 a sample
  });

  it('switches to stretch while playing without a dip', () => {
    const w = new WorkletRunner(SR);
    const src = sine(330, 4);
    w.send(loadMessage(0, src, src, SR));
    w.send({ type: 'map', deck: 0, from: 0, knots: knots(0, 0.3, 1) });
    w.render(SR / 2);
    w.send({ type: 'mode', deck: 0, mode: 'stretch' });
    const [a] = w.render(SR / 4);
    let low = Infinity;
    for (let i = 0; i + 480 < a[0].length; i += 480) {
      let e = 0;
      for (let j = 0; j < 480; j++) e += a[0][i + j] ** 2;
      low = Math.min(low, Math.sqrt(e / 480));
    }
    expect(low).toBeGreaterThan(0.5 / Math.SQRT2 - 0.02);
  });

  it('fades out at its stop and is silent after', () => {
    const w = new WorkletRunner(SR);
    const src = sine(440, 2);
    w.send(loadMessage(0, src, src, SR));
    w.send({ type: 'map', deck: 0, from: 0, knots: knots(0, 0, 1) });
    w.send({ type: 'stop', deck: 0, at: 9600 });
    const [a] = w.render(SR / 2);
    expect(Math.max(...a[0].slice(9600 + 128).map(Math.abs))).toBe(0);
    expect(Math.abs(a[0][9600 + 64])).toBeLessThanOrEqual(0.5 * 0.5 + 1e-6);
  });

  it('is silent before its first knot and past its window', () => {
    const w = new WorkletRunner(SR);
    const src = sine(440, 0.5);
    w.send(loadMessage(0, src, src, SR));
    w.send({ type: 'map', deck: 0, from: 12000, knots: knots(12000, 0, 1) });
    const [a] = w.render(SR);
    expect(Math.max(...a[0].slice(0, 12000).map(Math.abs))).toBe(0);
    expect(Math.max(...a[0].slice(12000 + 24000 + 10).map(Math.abs))).toBe(0);
  });

  it('reports where each deck is', () => {
    const w = new WorkletRunner(SR);
    w.send({ type: 'report', every: 1024 });
    const src = sine(440, 2);
    w.send(loadMessage(1, src, src, SR, 30));
    w.send({ type: 'map', deck: 1, from: 0, knots: knots(0, 30, 1) });
    w.render(4096);
    const reports = w.scope.posted.filter((m) => (m as { type: string }).type === 'pos') as {
      frame: number;
      decks: { p: number | null; playing: boolean }[];
    }[];
    expect(reports.length).toBe(4);
    const last = reports[3];
    expect(last.decks[0].p).toBeNull();
    expect(last.decks[1].p).toBeCloseTo(30 + last.frame / SR, 9);
    expect(last.decks[1].playing).toBe(true);
  });
});
