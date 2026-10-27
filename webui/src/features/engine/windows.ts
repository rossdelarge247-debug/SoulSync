/**
 * The stretches of two tracks a transition needs (each deck's window,
 * `GET /api/library/dj/window`), with room before the mix for the run-up
 * and after it to finish or go back; and a window's level lane for the
 * handover view (26d's two lanes on one bar ruler).
 *
 * Used by the lab (harness/lab-session.ts) and auto-mix (features/automix).
 */

import type { DeckData } from './engine';
import type { BeatGrid } from './grid';
import type { Plan } from './loader';

import { DEFAULT_BARS, needsBeatmatch, type Style } from './score';

export interface Windows {
  a: { start: number; dur: number };
  b: { start: number; dur: number };
  /** where the outgoing deck starts playing (track seconds) */
  aFrom: number;
  /** the outgoing mix point (track seconds) */
  outStart: number;
}

/** The server's cap on a window (seconds). */
export const MAX = 180;

/** The stretches of the two tracks a transition needs, with room to finish or go back. */
export function windowsFor(
  plan: Plan,
  gridA: BeatGrid | null,
  gridB: BeatGrid | null,
  prerollBars: number,
): Windows {
  const style = (plan.status === 'crossfade' ? 'crossfade' : plan.style) as Style;
  const beatmatch =
    plan.status === 'ok' && needsBeatmatch(style) && gridA !== null && gridB !== null;
  const bars = plan.bars ?? DEFAULT_BARS[style] ?? 0;
  const clamp = (start: number, end: number) => {
    const s = Math.max(0, start);
    return { start: s, dur: Math.max(1, Math.min(MAX, end - s)) };
  };
  if (beatmatch && gridA && gridB && plan.out.bar != null && plan.in.bar != null) {
    const outStart = gridA.barTime(plan.out.bar);
    const aFrom = Math.max(0, gridA.barTime(plan.out.bar - prerollBars));
    const a = clamp(aFrom - 0.5, gridA.barTime(plan.out.bar + bars + 16) + 1);
    const perMaster = { same: 1, half: 0.5, double: 2 }[plan.tempo?.relation ?? 'same'];
    const b0 = gridB.barBeat(plan.in.bar);
    const inStart = gridB.timeAt(b0);
    const b = clamp(inStart - 0.5, gridB.timeAt(b0 + (bars * 4 + 16 + 64) * perMaster) + 2);
    return { a, b, aFrom, outStart };
  }
  const outStart = plan.out.start ?? 0;
  const beat = gridA ? gridA.periodAt(gridA.beatAt(outStart)) : 0.5;
  const preroll = gridA ? prerollBars * 4 * beat : 15;
  const aFrom = Math.max(0, outStart - preroll);
  const length = style === 'crossfade' ? (plan.length_s ?? 6) : bars * 4 * beat;
  return {
    a: clamp(aFrom - 0.5, outStart + length + 8),
    b: clamp(plan.in.start - 0.5, plan.in.start + 60),
    aFrom,
    outStart,
  };
}

/**
 * A window's level, for a lane: the peak of its quarter-rate mono copy in
 * steps of `stepSeconds`, 0–1, starting at the window's own start (taken
 * before the samples go to the worklet).
 */
export function windowLevels(
  deck: Pick<DeckData, 'mono4' | 'sampleRate'>,
  stepSeconds = 0.05,
): Float32Array {
  const rate = deck.sampleRate / 4;
  const per = Math.max(1, Math.round(stepSeconds * rate));
  const n = Math.ceil(deck.mono4.length / per);
  const out = new Float32Array(n);
  let top = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(deck.mono4.length, (i + 1) * per);
    for (let k = i * per; k < end; k++) {
      const v = Math.abs(deck.mono4[k]);
      if (v > m) m = v;
    }
    out[i] = m;
    if (m > top) top = m;
  }
  if (top > 0) for (let i = 0; i < n; i++) out[i] /= top;
  return out;
}
