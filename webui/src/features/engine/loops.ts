/**
 * Loops on a deck (DJ mode step 6), on top of its position map.
 *
 * A deck's map says where in its track it is at every frame (clock.ts);
 * a loop folds that: from the frame it starts, a position at or past the
 * loop's end is brought back into it, `start + (p − start) mod length`.
 * So looping is exact to the sample at any speed (Sync's stretch, a nudge,
 * a hand on the platter): the loop is in track time, the map in output
 * frames. The worklet folds the same way and crossfades each wrap over
 * WRAP_S of track time (deck-processor.js), so there's no click.
 *
 * A map made from a folded position (a relock, a tempo change, a jump)
 * stays consistent: a position before the loop's end folds to itself. To
 * leave a loop and play on from where it is, the map is moved back by the
 * whole loops it had run (`unfoldKnots`), then the loop ends at that frame.
 */
import type { Knot } from './clock';

import { positionAt } from './clock';

/** A loop in track seconds, from frame `from` until frame `until` (exclusive). */
export interface LoopSpan {
  start: number;
  end: number;
  from: number;
  until: number;
}

/** A wrap's crossfade, in track seconds (the worklet's). */
export const WRAP_S = 0.004;

/** The loop in force at frame f, or null. */
export function loopAt(loops: readonly LoopSpan[], f: number): LoopSpan | null {
  for (let i = loops.length - 1; i >= 0; i--) {
    const l = loops[i]!;
    if (f >= l.from && f < l.until) return l;
  }
  return null;
}

/** A track position folded into the loop in force at frame f. */
export function fold(p: number, loops: readonly LoopSpan[], f: number): number {
  const l = loopAt(loops, f);
  if (!l || p < l.end) return p;
  const len = l.end - l.start;
  if (!(len > 0)) return p;
  return l.start + ((p - l.start) % len);
}

/** How many whole loops the map has run past the loop's start at frame f (0 outside one). */
export function wraps(p: number, loops: readonly LoopSpan[], f: number): number {
  const l = loopAt(loops, f);
  if (!l || p < l.end) return 0;
  return Math.floor((p - l.start) / (l.end - l.start));
}

/** The folded position at frame f, or null before the map starts. */
export function foldedAt(
  knots: readonly Knot[],
  loops: readonly LoopSpan[],
  f: number,
  sampleRate: number,
): number | null {
  const p = positionAt(knots, f, sampleRate);
  return p === null ? null : fold(p, loops, f);
}

/**
 * The map from frame f on, moved back by `by` track seconds (the loops it
 * had run): the knot in force at f restated at f, and every later knot.
 */
export function shiftKnots(
  knots: readonly Knot[],
  f: number,
  by: number,
  sampleRate: number,
): Knot[] {
  const p = positionAt(knots, f, sampleRate);
  if (p === null) return [];
  let r = 1;
  for (const k of knots) {
    if (k.f <= f) r = k.r;
    else break;
  }
  const out: Knot[] = [{ f, p: p - by, r }];
  for (const k of knots) if (k.f > f) out.push({ f: k.f, p: k.p - by, r: k.r });
  return out;
}

/** The loops with one ending at frame f (or a new one from f): those over by then are dropped. */
export function withLoop(
  loops: readonly LoopSpan[],
  f: number,
  next: { start: number; end: number } | null,
  sampleRate = 48000,
): LoopSpan[] {
  // what ended over 10 s before goes
  const kept = loops
    .filter((l) => l.until > f - sampleRate * 10 && l.from < f)
    .map((l) => (l.until > f ? { ...l, until: f } : l));
  if (next) kept.push({ start: next.start, end: next.end, from: f, until: Infinity });
  return kept;
}
