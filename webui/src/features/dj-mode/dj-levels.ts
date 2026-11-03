/**
 * A lane's waveform at every zoom (Brief F step 4b, 37s): the track's level
 * every 10 ms from `GET /api/library/dj/levels/<id>` (core/dj/levels.py),
 * for any track on a lane, before a blend as well as in one, kept per track
 * for the visit; until it comes, the player's 200 peaks.
 *
 * `drawWave` paints the part on show into a canvas, one bar a device pixel,
 * each the loudest level under it (from a pyramid of maxima, so the whole
 * track costs no more a frame than 1 bar), the played part brighter. The
 * lane calls it every animation frame while it's on screen, so the
 * waveform scrolls smoothly under the fixed centre playhead.
 */

/** A level source: `values[i]` (0–1) is the level over `[i·step, (i+1)·step)` seconds. */
export interface Levels {
  step: number;
  duration: number;
  /** level 0 is `values`; level k is the max over 2^k of them */
  pyramid: Float32Array[];
}

export function levelsFrom(values: ArrayLike<number>, step: number, scale = 1): Levels {
  const base = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) base[i] = Math.max(0, Math.min(1, values[i]! / scale));
  const pyramid = [base];
  let cur = base;
  while (cur.length > 1) {
    const next = new Float32Array(Math.ceil(cur.length / 2));
    for (let i = 0; i < next.length; i++)
      next[i] = Math.max(cur[2 * i]!, 2 * i + 1 < cur.length ? cur[2 * i + 1]! : 0);
    pyramid.push(next);
    cur = next;
  }
  return { step, duration: values.length * step, pyramid };
}

/** The player's 200 peaks over a track this long, as a level source. */
export function coarseLevels(peaks: readonly number[], duration: number): Levels | null {
  if (!peaks.length || !(duration > 0)) return null;
  return levelsFrom(peaks, duration / peaks.length);
}

/** The loudest level over [t0, t1) seconds, 0–1 (0 outside the track), exactly: whole pyramid blocks. */
export function levelOver(src: Levels, t0: number, t1: number): number {
  const n = src.pyramid[0]!.length;
  let i0 = Math.floor(t0 / src.step + 1e-9);
  let i1 = Math.ceil(t1 / src.step - 1e-9);
  if (i1 <= 0 || i0 >= n) return 0;
  i0 = Math.max(0, i0);
  i1 = Math.min(n, Math.max(i1, i0 + 1));
  let m = 0;
  // the largest aligned block that fits, then the next: a handful of reads a column
  while (i0 < i1) {
    let k = 0;
    while (k + 1 < src.pyramid.length && i0 % (1 << (k + 1)) === 0 && i0 + (1 << (k + 1)) <= i1)
      k++;
    const v = src.pyramid[k]![i0 >> k]!;
    if (v > m) m = v;
    i0 += 1 << k;
  }
  return m;
}

export interface WaveStyle {
  /** the bars' colour (the deck's wave colour) */
  colour: string;
  /** the part still to play, this much of it */
  restAlpha: number;
}

/**
 * The part [start, end) seconds into a canvas `w`×`h` device pixels: a bar
 * a pixel column, centred, the part before `playhead` in `played`.
 */
export function drawWave(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  src: Levels,
  start: number,
  end: number,
  playhead: number,
  style: WaveStyle,
): void {
  ctx.clearRect(0, 0, w, h);
  if (!(end > start) || w <= 0) return;
  const per = (end - start) / w;
  const mid = h / 2;
  const top = h * 0.48;
  ctx.fillStyle = style.colour;
  let alpha = -1;
  for (let x = 0; x < w; x++) {
    const t0 = start + x * per;
    const t1 = t0 + per;
    if (t1 <= 1e-9 || t0 >= src.duration) continue;
    const v = levelOver(src, t0, t1);
    const half = Math.max(0.5, v * top);
    const a = t1 <= playhead ? 1 : style.restAlpha;
    if (a !== alpha) {
      ctx.globalAlpha = a;
      alpha = a;
    }
    ctx.fillRect(x, mid - half, 1, half * 2);
  }
  ctx.globalAlpha = 1;
}

/* ── the server's levels, per track for the visit ──────────────────── */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const cache = new Map<string, Levels | null>();
const inflight = new Map<string, Promise<Levels | null>>();
/** at most this many tracks' levels kept (a track's are a few hundred KB as floats) */
const KEEP = 8;

/** The levels if they're here already. */
export function cachedLevels(id: string): Levels | null {
  return cache.get(id) ?? null;
}

function keep(id: string, v: Levels | null): void {
  cache.delete(id);
  cache.set(id, v);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value!);
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A track's fine levels: asked for, and again while they're worked out
 * (`202`), `delay(attempt)` ms apart, null when they can't be had. One ask
 * a track at a time; the answer is kept.
 */
export function loadLevels(
  id: string,
  url: string,
  f: FetchLike,
  delay: (attempt: number) => number | null,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Levels | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null);
  const going = inflight.get(id);
  if (going) return going;
  const run = (async () => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await f(url);
      } catch {
        return null;
      }
      if (res.status === 202) {
        const ms = delay(attempt);
        if (ms === null) return null;
        await wait(ms);
        continue;
      }
      if (!res.ok) return null;
      try {
        const body = (await res.json()) as { state?: string; step?: number; levels?: string };
        if (body.state !== 'ready' || !body.levels || !(Number(body.step) > 0)) {
          keep(id, null);
          return null;
        }
        const v = levelsFrom(decode(body.levels), Number(body.step), 255);
        keep(id, v);
        return v;
      } catch {
        return null;
      }
    }
  })();
  inflight.set(id, run);
  void run.finally(() => inflight.delete(id));
  return run;
}

/** @internal tests */
export function clearLevelsCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * The element's time made smooth (step 4b): a media element's `currentTime`
 * moves in steps in some browsers, so between steps it's carried on at the
 * element's speed (never more than a quarter second past the last step).
 */
export class SmoothClock {
  private last = Number.NaN;
  private at = 0;

  read(
    el: { currentTime: number; paused?: boolean; playbackRate?: number } | null,
    nowMs: number,
  ): number {
    if (!el) return 0;
    const t = el.currentTime;
    if (t !== this.last) {
      this.last = t;
      this.at = nowMs;
      return t;
    }
    // only an element that says it's playing is carried on
    if (el.paused !== false) return t;
    const ahead = ((nowMs - this.at) / 1000) * (el.playbackRate ?? 1);
    return t + Math.max(0, Math.min(0.25, ahead));
  }
}
