/**
 * Zoom on a lane (Brief F 3b, 37s; 442): five snap levels, no free zoom.
 * Whole track (the playhead moves across a still track), then 64, 16, 4 and
 * 1 bar (the playhead fixed at the lane's centre, the track scrolling under
 * it). Only logic: the levels, the window on show at a time, how dense the
 * beat map is at each level, and the words.
 */
import type { LaneView } from './dj-mode.logic';

export type ZoomLevel = 'whole' | 64 | 16 | 4 | 1;

export const ZOOM_LEVELS: readonly ZoomLevel[] = ['whole', 64, 16, 4, 1];

/** One level in (+) or out (−); stays put at either end. */
export function zoomStep(level: ZoomLevel, dir: 1 | -1): ZoomLevel {
  const i = ZOOM_LEVELS.indexOf(level);
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + dir))]!;
}

/** "whole track", "64 bars", "1 bar" (the pill's label, and what's said). */
export function zoomWords(level: ZoomLevel): string {
  if (level === 'whole') return 'whole track';
  return `${level} ${level === 1 ? 'bar' : 'bars'}`;
}

interface GridLike {
  beatAt(t: number): number;
  timeAt(i: number): number;
  periodAt(i: number): number;
}

/** How many seconds a zoom level spans around `t` (bars of the grid there; 2 s a bar without one). */
export function zoomSpan(
  level: ZoomLevel,
  t: number,
  grid: GridLike | null,
  duration: number,
): number {
  if (level === 'whole') return duration;
  const bar = grid ? 4 * grid.periodAt(grid.beatAt(t)) : 2;
  return Math.min(duration > 0 ? duration : Infinity, level * bar);
}

/**
 * The part of the track on show at playhead `t`: the whole track, or a
 * window centred on the playhead (37s: it may run past either end, which
 * shows as empty lane, so the playhead stays at the centre).
 */
export function zoomView(
  level: ZoomLevel,
  t: number,
  grid: GridLike | null,
  duration: number,
): LaneView {
  if (level === 'whole' || !(duration > 0)) return { start: 0, end: duration };
  const span = zoomSpan(level, t, grid, duration);
  return { start: t - span / 2, end: t + span / 2 };
}

/** The beat map's density at a level (37s): beat ticks at 4 bars and under; numbers every n bars. */
export function zoomDensity(level: ZoomLevel): { beats: boolean; numberEvery: number } {
  switch (level) {
    case 'whole':
      return { beats: false, numberEvery: 32 };
    case 64:
      return { beats: false, numberEvery: 16 };
    case 16:
      return { beats: false, numberEvery: 4 };
    default:
      return { beats: true, numberEvery: 1 };
  }
}

/**
 * The scale and offset the lane draws its whole-track layers with so the
 * window shows: the layer is `scale` lanes wide and moved so the playhead
 * sits at the centre (CSS `--zoom-scale`, `--zoom-pos`).
 */
export function zoomTransform(
  level: ZoomLevel,
  t: number,
  grid: GridLike | null,
  duration: number,
): { scale: number; pos: number } {
  if (level === 'whole' || !(duration > 0)) return { scale: 1, pos: 0 };
  const span = zoomSpan(level, t, grid, duration);
  return { scale: duration / span, pos: Math.max(0, Math.min(1, t / duration)) };
}

/** The sections strip's outline for the window on show (fractions of the lane), or null at whole. */
export function zoomOutline(view: LaneView, duration: number): { x0: number; x1: number } | null {
  if (!(duration > 0) || (view.start <= 0 && view.end >= duration)) return null;
  const c = (x: number) => Math.max(0, Math.min(1, x / duration));
  return { x0: c(view.start), x1: c(view.end) };
}

export interface ZoomTick {
  /** 0–1 across the whole track */
  x: number;
  kind: 'beat' | 'bar' | 'phrase';
  /** the bar's number, where one is written */
  label: number | null;
}

interface MapGrid {
  grid: { barTime(bar: number): number; timeAt(i: number): number; barBeat(bar: number): number };
  bars: number;
  truncated: boolean;
}

/**
 * The beat map's ticks over the whole track at a zoom level's density (37s):
 * a tick a bar (14px every 8), beats four a bar at 4 bars and under, a
 * number every 32 bars whole, 16 at 64, 4 at 16, every bar closer. The lane
 * draws them on one layer and moves it under the fixed playhead.
 */
export function zoomTicks(g: MapGrid, duration: number, level: ZoomLevel): ZoomTick[] {
  const { beats, numberEvery } = zoomDensity(level);
  const out: ZoomTick[] = [];
  if (!(duration > 0) || g.bars <= 0) return out;
  // a truncated grid runs on to the file's end (as beatMap)
  let last = g.bars;
  if (g.truncated) while (last < 10_000 && g.grid.barTime(last) <= duration) last += 1;
  for (let i = 0; i < last; i += 1) {
    const t = g.grid.barTime(i);
    if (t > duration) break;
    if (t >= 0)
      out.push({
        x: t / duration,
        kind: i % 8 === 0 ? 'phrase' : 'bar',
        label: i % numberEvery === 0 ? i + 1 : null,
      });
    if (beats)
      for (let k = 1; k < 4; k += 1) {
        const tb = g.grid.timeAt(g.grid.barBeat(i) + k);
        if (tb >= 0 && tb <= duration) out.push({ x: tb / duration, kind: 'beat', label: null });
      }
  }
  return out;
}
