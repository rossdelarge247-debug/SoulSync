/**
 * The beat clock both decks follow through a transition, and the position
 * maps it gives the deck processor (worklet/deck-processor.js).
 *
 * A transition counts master beats φ from the outgoing track's phrase
 * boundary (the plan's `out.start`, φ = 0) to the window's end (φ = Φ,
 * four a bar). Each deck's place in its own track is a function of φ:
 *
 *   A: gridA.timeAt(a0 + φ)        B: gridB.timeAt(b0 + φ · perMaster) + correction(φ)
 *
 * where a0 and b0 are the beats of `out.start` and `in.start`, and
 * perMaster is 1 (or ½ / 2 for half and double time). So beat for beat the
 * two are on the same φ: the incoming downbeat lands on the outgoing phrase
 * and nothing can drift, whatever the grids do (a drifting track's beats are
 * followed too). `correction` is what the audio itself says the grids are
 * out by (refine.ts).
 *
 * How fast φ runs (the master tempo) is the third part: with `morph` it moves
 * smoothly from the outgoing track's own tempo (A at rate 1) to the
 * incoming's (B at rate 1), as djay and Traktor's automix do, so the
 * incoming track plays at its own speed once the mix is over and the
 * player can carry on with it. Before the window A plays at rate 1.
 */

import type { BeatGrid } from './grid';

/** One knot of a position map: from context frame f, track seconds p, moving at rate r. */
export interface Knot {
  f: number;
  p: number;
  r: number;
}

export type Tempo = { kind: 'morph' } | { kind: 'followA' } | { kind: 'hold'; period: number };

export interface ClockSpec {
  /** context seconds at φ = 0 */
  t0: number;
  /** the window, in master beats (Φ) */
  beats: number;
  a: { grid: BeatGrid; beat0: number };
  b: { grid: BeatGrid; beat0: number; perMaster: number };
  tempo: Tempo;
  /** seconds added to B's position at φ (refine.ts) */
  correction?: (phi: number) => number;
  /** how far past the window the clock is worked out (beats; default 64) */
  extra?: number;
  /** where the table starts (default 0); a clock rebuilt mid-window starts there */
  from?: number;
}

/** The table's step (beats) and the maps' knot step. */
const STEP = 1 / 32;
const KNOT_STEP = 1 / 8;
const H = 1 / 64;

/** What the executor reads off a clock. */
export interface BeatClock {
  timeAt(phi: number): number;
  beatAt(t: number): number;
  periodAt(phi: number): number;
  ratesAt(phi: number): { a: number; b: number };
  posA(phi: number): number;
  posB(phi: number): number;
}

export class MasterClock implements BeatClock {
  readonly spec: ClockSpec;
  private readonly phi0: number;
  private readonly times: Float64Array;
  private readonly last: number;

  constructor(spec: ClockSpec) {
    this.spec = spec;
    this.phi0 = spec.from ?? 0;
    const end = spec.beats + (spec.extra ?? 64);
    const n = Math.max(2, Math.ceil((end - this.phi0) / STEP) + 1);
    this.times = new Float64Array(n);
    this.times[0] = spec.t0;
    let prev = this.periodAt(this.phi0);
    for (let k = 1; k < n; k++) {
      const phi = this.phi0 + k * STEP;
      const cur = this.periodAt(phi);
      this.times[k] = this.times[k - 1] + ((prev + cur) / 2) * STEP;
      prev = cur;
    }
    this.last = this.phi0 + (n - 1) * STEP;
  }

  /** Track seconds of deck A at φ. */
  posA(phi: number): number {
    return this.spec.a.grid.timeAt(this.spec.a.beat0 + phi);
  }

  /** Track seconds of deck B at φ. */
  posB(phi: number): number {
    const b = this.spec.b;
    return b.grid.timeAt(b.beat0 + phi * b.perMaster) + (this.spec.correction?.(phi) ?? 0);
  }

  private slope(f: (phi: number) => number, phi: number): number {
    return (f(phi + H) - f(phi - H)) / (2 * H);
  }

  /** A's and B's seconds per master beat at φ. */
  deckPeriods(phi: number): { a: number; b: number } {
    return { a: this.slope((x) => this.posA(x), phi), b: this.slope((x) => this.posB(x), phi) };
  }

  /** Output seconds per master beat at φ. */
  periodAt(phi: number): number {
    const tempo = this.spec.tempo;
    if (tempo.kind === 'hold') return tempo.period;
    const { a, b } = this.deckPeriods(phi);
    if (tempo.kind === 'followA' || phi <= 0) return a;
    if (phi >= this.spec.beats) return b;
    const u = phi / this.spec.beats;
    const w = u * u * (3 - 2 * u); // smoothstep: the tempo starts and ends moving gently
    return (1 - w) * a + w * b;
  }

  /** Context seconds at φ. Before the table: A at rate 1. */
  timeAt(phi: number): number {
    if (phi <= this.phi0) {
      if (this.spec.tempo.kind === 'hold')
        return this.spec.t0 + (phi - this.phi0) * this.spec.tempo.period;
      return this.spec.t0 + (this.posA(phi) - this.posA(this.phi0));
    }
    if (phi >= this.last)
      return this.times[this.times.length - 1] + (phi - this.last) * this.periodAt(this.last);
    const x = (phi - this.phi0) / STEP;
    const k = Math.floor(x);
    return this.times[k] + (x - k) * (this.times[k + 1] - this.times[k]);
  }

  /** φ at context seconds t. */
  beatAt(t: number): number {
    const times = this.times;
    if (t <= times[0]) {
      let phi = this.phi0 + (t - times[0]) / this.periodAt(this.phi0);
      for (let i = 0; i < 4; i++)
        phi -= (this.timeAt(phi) - t) / this.periodAt(Math.min(phi, this.phi0));
      return phi;
    }
    if (t >= times[times.length - 1])
      return this.last + (t - times[times.length - 1]) / this.periodAt(this.last);
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    return this.phi0 + (lo + (t - times[lo]) / (times[lo + 1] - times[lo])) * STEP;
  }

  /** The rates the two decks play at, at φ. */
  ratesAt(phi: number): { a: number; b: number } {
    const m = this.periodAt(phi);
    const { a, b } = this.deckPeriods(phi);
    return { a: a / m, b: b / m };
  }

  /** A deck's position map over [from, to] (beats), a knot every eighth of a beat. */
  knots(deck: 'A' | 'B', sampleRate: number, from: number, to: number): Knot[] {
    const pos = deck === 'A' ? (x: number) => this.posA(x) : (x: number) => this.posB(x);
    const out: Knot[] = [];
    const n = Math.max(1, Math.ceil((to - from) / KNOT_STEP));
    let t = this.timeAt(from);
    let p = pos(from);
    for (let k = 0; k < n; k++) {
      const phi1 = Math.min(to, from + (k + 1) * KNOT_STEP);
      const t1 = this.timeAt(phi1);
      const p1 = pos(phi1);
      out.push({ f: t * sampleRate, p, r: t1 > t ? (p1 - p) / (t1 - t) : 1 });
      t = t1;
      p = p1;
    }
    const rates = this.ratesAt(to);
    out.push({ f: t * sampleRate, p, r: deck === 'A' ? rates.a : rates.b });
    return out;
  }
}

/** A deck playing on its own from `p` at context second `t`, at `rate`. */
export function freeKnots(t: number, p: number, sampleRate: number, rate = 1): Knot[] {
  return [{ f: t * sampleRate, p, r: rate }];
}

/**
 * A deck on its own whose rate moves from r0 to r1 over `duration` seconds
 * (linearly in time), then stays at r1: how a deck left alone after a
 * transition returns to its own tempo.
 */
export function glideKnots(
  t: number,
  p: number,
  r0: number,
  r1: number,
  duration: number,
  sampleRate: number,
): Knot[] {
  const out: Knot[] = [];
  if (!(duration > 0) || Math.abs(r1 - r0) < 1e-9) return [{ f: t * sampleRate, p, r: r1 }];
  const step = 0.125;
  const n = Math.ceil(duration / step);
  const pos = (tau: number) => p + r0 * tau + ((r1 - r0) * tau * tau) / (2 * duration);
  for (let k = 0; k < n; k++) {
    const a = k * step;
    const b = Math.min(duration, (k + 1) * step);
    out.push({ f: (t + a) * sampleRate, p: pos(a), r: (pos(b) - pos(a)) / (b - a) });
  }
  out.push({ f: (t + duration) * sampleRate, p: pos(duration), r: r1 });
  return out;
}

/** The worklet's form: [f, p, r, f, p, r, …]. */
export function flatten(knots: readonly Knot[]): Float64Array {
  const out = new Float64Array(knots.length * 3);
  knots.forEach((k, i) => {
    out[i * 3] = k.f;
    out[i * 3 + 1] = k.p;
    out[i * 3 + 2] = k.r;
  });
  return out;
}

/** A position map's value at frame f (the worklet's rule), for the main thread's own copy. */
export function positionAt(knots: readonly Knot[], f: number, sampleRate: number): number | null {
  if (knots.length === 0 || f < knots[0].f) return null;
  let lo = 0;
  let hi = knots.length - 1;
  if (f >= knots[hi].f) lo = hi;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knots[mid].f <= f) lo = mid;
      else hi = mid;
    }
  }
  const k = knots[lo];
  return k.p + ((f - k.f) * k.r) / sampleRate;
}

/** Splice a new map in from frame `from` (the worklet's rule). */
export function spliceKnots(old: readonly Knot[], from: number, next: readonly Knot[]): Knot[] {
  return old.filter((k) => k.f < from).concat(next);
}

/** One clock before beat `at`, another from it (a transition changed course there). */
export class SplicedClock implements BeatClock {
  constructor(
    private readonly before: BeatClock,
    private readonly after: MasterClock,
    private readonly at: number,
  ) {}

  timeAt(phi: number): number {
    return phi < this.at ? this.before.timeAt(phi) : this.after.timeAt(phi);
  }

  beatAt(t: number): number {
    return t < this.after.spec.t0 ? this.before.beatAt(t) : this.after.beatAt(t);
  }

  periodAt(phi: number): number {
    return phi < this.at ? this.before.periodAt(phi) : this.after.periodAt(phi);
  }

  ratesAt(phi: number): { a: number; b: number } {
    return phi < this.at ? this.before.ratesAt(phi) : this.after.ratesAt(phi);
  }

  posA(phi: number): number {
    return this.after.posA(phi);
  }

  posB(phi: number): number {
    return this.after.posB(phi);
  }
}
