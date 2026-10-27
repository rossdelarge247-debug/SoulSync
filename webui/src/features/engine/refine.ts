/**
 * Keeping the two decks' beats together where the grids are a little out
 * (auto-mix stage B: "correct drift during the overlap").
 *
 * The clock (clock.ts) lines the grids up exactly, so the decks can't drift
 * apart on their own. What's left is the grids themselves: each is a few
 * milliseconds out here and there (it was found at 22 kHz; a live drummer's
 * beats wander from a straight line), and over a 32-bar blend a period that's
 * a hair off adds up. So before a transition the engine listens to both
 * windows at each beat of the overlap: where the kick's attack really is
 * (the steepest rise of the low band, within ±35 ms of the grid's beat;
 * clear when the band's level after it is three times what came just before).
 * The difference between what the two decks' grids are out by, beat for
 * beat, smoothed (a median over 8 beats, a knot every 4) and kept within
 * ±25 ms, is added to the incoming deck's place: its beats then land on the
 * outgoing deck's real beats. Only beats with a clear attack on both decks
 * count; with fewer than 8 the correction is left at zero.
 *
 * It runs once a transition, on the main thread, over ±60 ms around each
 * beat (about 6,000 samples a beat): a few milliseconds in all.
 */

import type { BeatGrid } from './grid';

export interface DeckAudio {
  /** the window's samples (one channel is enough; two are averaged) */
  channels: readonly Float32Array[];
  sampleRate: number;
  /** the window's first sample's place in the track (seconds) */
  offset: number;
}

export interface Onset {
  beat: number;
  /** the grid's time less the attack's (seconds): how far the grid is out */
  error: number;
  /** how clear the attack is (its rise against the window's average rise) */
  strength: number;
}

const SEARCH_S = 0.035;
const PRE_S = 0.06;
const POST_S = 0.04;
/** an attack whose level jumps this many times over what came just before is clear */
const CLEAR = 3;
/** the correction never moves a deck further than this */
export const MAX_CORRECTION_S = 0.025;

/** A low-pass at ~150 Hz (2nd order, Butterworth), the kick's band. */
function lowpass(x: Float32Array, sampleRate: number): Float32Array {
  const w = Math.tan((Math.PI * 150) / sampleRate);
  const k = 1 / (1 + Math.SQRT2 * w + w * w);
  const b0 = w * w * k;
  const b1 = 2 * b0;
  const a1 = 2 * (w * w - 1) * k;
  const a2 = (1 - Math.SQRT2 * w + w * w) * k;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** Where the kick's attack is near each beat of [from, to] (the grid's beat numbers). */
export function onsets(audio: DeckAudio, grid: BeatGrid, from: number, to: number): Onset[] {
  const sr = audio.sampleRate;
  const ch = audio.channels;
  const len = ch[0]?.length ?? 0;
  const smooth = Math.max(1, Math.round(0.002 * sr));
  const out: Onset[] = [];
  for (let beat = Math.ceil(from); beat <= Math.floor(to); beat++) {
    const t = grid.timeAt(beat);
    const centre = (t - audio.offset) * sr;
    const a = Math.round(centre - PRE_S * sr);
    const b = Math.round(centre + POST_S * sr);
    if (a < 0 || b >= len) continue;
    const x = new Float32Array(b - a);
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (const c of ch) s += c[a + i];
      x[i] = s / ch.length;
    }
    const low = lowpass(x, sr);
    // the envelope (rectified, 2 ms moving average) and its rise
    const env = new Float32Array(low.length);
    let acc = 0;
    for (let i = 0; i < low.length; i++) {
      acc += Math.abs(low[i]);
      if (i >= smooth) acc -= Math.abs(low[i - smooth]);
      env[i] = acc / smooth;
    }
    const lo = Math.round((PRE_S - SEARCH_S) * sr);
    const hi = Math.round((PRE_S + SEARCH_S) * sr);
    let best = -1;
    let bestRise = 0;
    for (let i = Math.max(lo, smooth); i < Math.min(hi, env.length); i++) {
      const rise = env[i] - env[i - smooth];
      if (rise > bestRise) {
        bestRise = rise;
        best = i;
      }
    }
    if (best < 0) continue;
    // how clear it is: the level just after the attack against just before
    const gap = Math.round(0.004 * sr);
    let before = 0;
    let n = 0;
    for (let i = Math.max(0, best - gap - Math.round(0.02 * sr)); i < best - gap; i++) {
      before += env[i];
      n++;
    }
    before = n ? before / n : 0;
    let after = 0;
    for (let i = best; i < Math.min(env.length, best + Math.round(0.03 * sr)); i++)
      after = Math.max(after, env[i]);
    // the steepest rise is half a smoothing width after the attack starts
    const attack = a + best - smooth / 2;
    out.push({
      beat,
      error: t - (audio.offset + attack / sr),
      strength: after / (before + 0.02 * after + 1e-9),
    });
  }
  return out;
}

/**
 * The correction (seconds, added to the incoming deck's place at master
 * beat φ) that puts its real beats on the outgoing deck's. `aBeat(φ)` and
 * `bBeat(φ)` are the decks' beat numbers at φ (clock.ts).
 */
export function correction(
  a: Onset[],
  b: Onset[],
  window: { from: number; to: number },
  aBeat: (phi: number) => number,
  bBeat: (phi: number) => number,
): (phi: number) => number {
  const aBy = new Map(a.filter((o) => o.strength >= CLEAR).map((o) => [o.beat, o.error]));
  const bBy = new Map(b.filter((o) => o.strength >= CLEAR).map((o) => [o.beat, o.error]));
  const pairs: { phi: number; d: number }[] = [];
  for (let phi = Math.ceil(window.from); phi <= Math.floor(window.to); phi++) {
    const ia = aBeat(phi);
    const ib = bBeat(phi);
    if (
      !Number.isInteger(Math.round(ia * 1e6) / 1e6) ||
      !Number.isInteger(Math.round(ib * 1e6) / 1e6)
    )
      continue;
    const ea = aBy.get(Math.round(ia));
    const eb = bBy.get(Math.round(ib));
    if (ea === undefined || eb === undefined) continue;
    // each grid is late on its attack by its error: at master beat φ, A's
    // attack was ea ago and B's eb ago, so B's place moves by ea - eb to
    // play its attack when A plays its own
    pairs.push({ phi, d: ea - eb });
  }
  if (pairs.length < 8) return () => 0;
  const knots: { phi: number; d: number }[] = [];
  const first = pairs[0].phi;
  const last = pairs[pairs.length - 1].phi;
  for (let phi = first; phi <= last + 3; phi += 4) {
    const near = pairs.filter((p) => Math.abs(p.phi - phi) <= 4).map((p) => p.d);
    if (near.length < 3) continue;
    near.sort((x, y) => x - y);
    const m = near[near.length >> 1];
    knots.push({
      phi: Math.min(phi, last),
      d: Math.max(-MAX_CORRECTION_S, Math.min(MAX_CORRECTION_S, m)),
    });
  }
  if (knots.length === 0) return () => 0;
  return (phi: number) => {
    if (phi <= knots[0].phi) return knots[0].d;
    const end = knots[knots.length - 1];
    if (phi >= end.phi) return end.d;
    let i = 0;
    while (i + 1 < knots.length && knots[i + 1].phi <= phi) i++;
    const k0 = knots[i];
    const k1 = knots[i + 1];
    return k0.d + ((phi - k0.phi) / (k1.phi - k0.phi)) * (k1.d - k0.d);
  };
}
