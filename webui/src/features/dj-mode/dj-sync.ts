/**
 * Sync (Brief F, 416, 421, 433): B stretched to A's tempo and placed on A's
 * beat, as position maps for the engine's deck B (features/engine/clock.ts's
 * knots). Pure, so it's tested without Web Audio.
 *
 * A plays at its own tempo on deck A (rate 1, the element's speed). B is
 * locked to A beat for beat: at A's beat a0 + k, B is at its beat b0 + k·m
 * (m = 1, or ½ / 2 for half and double time), so the two can't drift
 * whatever their grids do; between beats B moves in a straight line. A
 * constant grid gives B one steady rate (433: −1.6% for three minutes).
 */
import type { Knot } from '@/features/engine/clock';
import type { BeatGrid } from '@/features/engine/grid';

/** The furthest Sync stretches B (446's ±16%). */
export const SYNC_RANGE = 0.16;
/** Play B never starts sooner than this after it's pressed (s): time to schedule. */
export const MIN_LEAD_S = 0.25;

export interface SyncRatio {
  /** B's beats per A beat: 1, or ½ (B at half time) or 2 (double) */
  m: number;
  /** B's speed against A's (track seconds a second, A at rate 1) */
  rate: number;
}

/** B's beat period against A's near where they meet: m and the rate; null when it's out of range. */
export function syncRatio(
  periodA: number,
  periodB: number,
  rateA = 1,
  range = SYNC_RANGE,
): SyncRatio | null {
  if (!(periodA > 0) || !(periodB > 0)) return null;
  const q = periodB / periodA;
  let best: SyncRatio | null = null;
  for (const m of [1, 0.5, 2]) {
    const rate = m * q * rateA;
    if (!best || Math.abs(rate - 1) < Math.abs(best.rate - 1)) best = { m, rate };
  }
  return best && Math.abs(best.rate - 1) <= range + 1e-9 ? best : null;
}

/** The same from two BPMs (the lanes' numbers), for "set by Sync" before the decks load. */
export function syncRatioFromBpm(
  bpmA: number | null | undefined,
  bpmB: number | null | undefined,
): SyncRatio | null {
  const a = Number(bpmA);
  const b = Number(bpmB);
  if (!(a > 0) || !(b > 0)) return null;
  return syncRatio(60 / a, 60 / b);
}

/** A's first bar that starts at least `lead` seconds (of track) after `pos`: its index and time. */
export function nextBar(
  grid: BeatGrid,
  pos: number,
  lead = MIN_LEAD_S,
): { bar: number; time: number } {
  const want = pos + lead;
  let bar = Math.ceil((grid.beatAt(want) - grid.downbeatIndex) / 4 - 1e-9);
  // a grid's beats aren't evenly spaced: make sure, one bar either way
  while (grid.barTime(bar) < want - 1e-9) bar += 1;
  while (bar > 0 && grid.barTime(bar - 1) >= want) bar -= 1;
  // never −0
  bar += 0;
  return { bar, time: grid.barTime(bar) };
}

/** The bar B is cued at (its mix-in rounded to the nearest bar): its first beat and time. */
export function cueBeat(grid: BeatGrid, cue: number): { beat: number; time: number } {
  const bar = Math.max(0, Math.round((grid.beatAt(cue) - grid.downbeatIndex) / 4));
  const beat = grid.barBeat(bar);
  return { beat, time: grid.timeAt(beat) };
}

export interface LockSpec {
  gridA: BeatGrid;
  /** A's beat (fractional is fine) at context second `t0` */
  a0: number;
  /** A's deck rate (1: the element's speed) */
  rateA: number;
  gridB: BeatGrid;
  /** B's beat at `t0` */
  b0: number;
  m: number;
  /** context second where the lock starts */
  t0: number;
  sampleRate: number;
  /** stop once B's position passes this (track seconds: its window's end) */
  untilB: number;
  /** at most this many beats */
  maxBeats?: number;
}

/** B's map, locked to A beat for beat from `t0` (a knot a beat; its last rate carries on). */
export function lockedKnots(s: LockSpec): Knot[] {
  const out: Knot[] = [];
  const tA0 = s.gridA.timeAt(s.a0);
  const max = s.maxBeats ?? 4000;
  const at = (k: number) => s.t0 + (s.gridA.timeAt(s.a0 + k) - tA0) / s.rateA;
  const posB = (k: number) => s.gridB.timeAt(s.b0 + k * s.m);
  for (let k = 0; k < max; k++) {
    const t = at(k);
    const p = posB(k);
    const dt = at(k + 1) - t;
    const r = dt > 0 ? (posB(k + 1) - p) / dt : 1;
    out.push({ f: t * s.sampleRate, p, r });
    if (p > s.untilB) break;
  }
  return out;
}

/** A deck's rate at context second `t` from its map (track seconds a second), or null. */
export function rateAt(knots: readonly Knot[], t: number, sampleRate: number): number | null {
  const f = t * sampleRate;
  let k: Knot | null = null;
  for (const x of knots) {
    if (x.f <= f) k = x;
    else break;
  }
  return k ? k.r : null;
}

/**
 * The phase meter's reading (step 6): how far deck X's beat is from deck
 * Y's, in beats, −0.5 … +0.5 (+: X ahead). From each deck's place on its
 * own grid, so it reads true at any tempo.
 */
export function phaseOffset(gridX: BeatGrid, px: number, gridY: BeatGrid, py: number): number {
  const fx = gridX.beatAt(px);
  const fy = gridY.beatAt(py);
  let d = fx - Math.floor(fx) - (fy - Math.floor(fy));
  if (d > 0.5) d -= 1;
  if (d <= -0.5) d += 1;
  return d;
}

/** The phase meter in words, before the other deck's name: "in phase with", "12 ms ahead of", "30 ms behind". */
export function phaseWords(beats: number, beatSeconds: number): string {
  const ms = Math.round(beats * beatSeconds * 1000);
  if (Math.abs(ms) < 5) return 'in phase with';
  return `${Math.abs(ms)} ms ${ms > 0 ? 'ahead of' : 'behind'}`;
}
