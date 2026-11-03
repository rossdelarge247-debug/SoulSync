/**
 * DJ mode's cue points (Brief F 3b, 37g; 439, 445): four a track, a
 * person's own, kept on the server (`/api/library/dj/cues/<id>`,
 * core/dj/cues.py). The model is only logic: picking a slot, placing a cue
 * where the waveform was clicked (snapped to the nearest beat when there's a
 * grid, so the bar is the truth and a re-analysis moves it), moving it,
 * clearing the pick, and the words. `CueStore` reads and saves them.
 *
 * - Pick 1–4 (a white ring); a click on the waveform places the picked cue
 *   there; while picked, another click moves it; Esc clears the pick.
 * - Pressing a set cue jumps the deck to it (and picks it, so a click moves it).
 * - The keyboard: 1–4 do what a press does; ⇧1–4 place (or move) a cue at
 *   the playhead, for those who don't use a pointer.
 */
import type { BeatGrid } from '@/features/engine/grid';

import { appURL } from '@/platform/url-base';

export interface Cue {
  slot: number;
  /** bars from the first downbeat (to the beat), when there's a grid */
  bar: number | null;
  seconds: number;
}

/** Four slots, null where nothing is set. */
export type CueSet = readonly (Cue | null)[];

export const SLOTS = [1, 2, 3, 4] as const;
/** The deck's main cue point (CUE, step 4b): slot 0, kept beside the hot cues. */
export const MAIN_SLOT = 0;

/** The main cue from the route's list (slot 0), or null. */
export function mainCueOf(list: readonly Cue[] | null | undefined): Cue | null {
  const c = (list ?? []).find((x) => x && x.slot === MAIN_SLOT);
  return c && Number.isFinite(c.seconds) && c.seconds >= 0
    ? { slot: MAIN_SLOT, bar: c.bar ?? null, seconds: c.seconds }
    : null;
}

export function emptyCues(): CueSet {
  return [null, null, null, null];
}

/** The cue set from the route's list. */
export function cueSetOf(list: readonly Cue[] | null | undefined): CueSet {
  const out: (Cue | null)[] = [null, null, null, null];
  for (const c of list ?? []) {
    if (c && SLOTS.includes(c.slot as 1) && Number.isFinite(c.seconds) && c.seconds >= 0)
      out[c.slot - 1] = { slot: c.slot, bar: c.bar ?? null, seconds: c.seconds };
  }
  return out;
}

/** A cue at a time: on the nearest beat with a grid (its bar to the beat), else the time itself. */
/** The bars a cue can sit at on the grid (core/dj/cues.py MIN_BAR, MAX_BAR). */
export const MIN_BAR = -1000;
export const MAX_BAR = 10000;

export function cueAt(slot: number, seconds: number, grid: BeatGrid | null, duration: number): Cue {
  const t = Math.max(0, Math.min(duration > 0 ? duration : Infinity, seconds));
  if (!grid) return { slot, bar: null, seconds: round(t, 3) };
  const beat = Math.round(grid.beatAt(t));
  const bar = (beat - grid.downbeatIndex) / 4;
  const at = round(Math.max(0, grid.timeAt(beat)), 4);
  // a bar the server can't keep (L1): the cue keeps its seconds instead,
  // so it's saved, just not moved by a later re-analysis
  if (!(bar >= MIN_BAR && bar <= MAX_BAR)) return { slot, bar: null, seconds: at };
  return { slot, bar, seconds: at };
}

function round(x: number, d: number): number {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}

/** The cue's place now (its bar on the grid, when it has both). */
export function cueSeconds(cue: Cue, grid: BeatGrid | null): number {
  if (grid && cue.bar !== null) return Math.max(0, grid.barTime(cue.bar));
  return cue.seconds;
}

export function withCue(set: CueSet, cue: Cue): CueSet {
  const out = [...set];
  out[cue.slot - 1] = cue;
  return out;
}

export function withoutCue(set: CueSet, slot: number): CueSet {
  const out = [...set];
  out[slot - 1] = null;
  return out;
}

/** The bar as the button and the disc say it: 1-based, "17" or "17.3" (bar and beat). */
export function barWords(cue: Cue): string | null {
  if (cue.bar === null) return null;
  const whole = Math.floor(cue.bar + 1e-9);
  const beat = Math.round((cue.bar - whole) * 4);
  return beat ? `${whole + 1}.${beat + 1}` : String(whole + 1);
}

/** The button's text: "2 · 17" set, "2" empty (37g). */
export function cueButtonText(slot: number, cue: Cue | null): string {
  if (!cue) return String(slot);
  const bar = barWords(cue);
  return bar ? `${slot} · ${bar}` : `${slot} · ${clock(cue.seconds)}`;
}

/** Its accessible name: "Cue 2, bar 17: press to jump there" / "Cue 3, empty: press, then click the waveform". */
export function cueButtonName(slot: number, cue: Cue | null, picked: boolean): string {
  const where = cue ? (barWords(cue) ? `bar ${barWords(cue)}` : clock(cue.seconds)) : null;
  if (!cue) return `Cue ${slot}, empty${picked ? ', picked: click the waveform to place it' : ''}`;
  return `Cue ${slot}, ${where}${picked ? ', picked: click the waveform to move it' : ''}`;
}

/** The pointer's label over the waveform while a cue is picked (37g). */
export function placeLabel(slot: number, grid: BeatGrid | null, seconds: number): string {
  if (grid) {
    const bar = Math.floor((grid.beatAt(seconds) - grid.downbeatIndex) / 4) + 1;
    return `Cue ${slot} · bar ${Math.max(1, bar)} · click to place`;
  }
  return `Cue ${slot} · ${clock(seconds)} · click to place`;
}

function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** One announcement per change (37p). */
export function cueWords(
  kind: 'picked' | 'placed' | 'moved' | 'cleared' | 'jumped',
  deck: 'A' | 'B',
  cue: Cue | { slot: number },
): string {
  const where =
    'seconds' in cue ? (barWords(cue) ? `bar ${barWords(cue)}` : clock(cue.seconds)) : '';
  switch (kind) {
    case 'picked':
      return `Cue ${cue.slot} on deck ${deck} picked: click the waveform to place it`;
    case 'placed':
      return `Cue ${cue.slot} on deck ${deck} at ${where}`;
    case 'moved':
      return `Cue ${cue.slot} on deck ${deck} moved to ${where}`;
    case 'cleared':
      return `Cue ${cue.slot} no longer picked`;
    case 'jumped':
      return `Deck ${deck} to cue ${cue.slot}, ${where}`;
  }
}

/* ── the server ─────────────────────────────────────────────────────── */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** How long a change waits before it's saved, so a run of moves is one save (ms). */
export const SAVE_DELAY_MS = 600;

/**
 * Reads a track's cues and saves changes (debounced, the last one wins). A
 * save that fails is said once by the caller; the cues stay as placed.
 */
export class CueStore {
  private pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; set: CueSet; onFail?: () => void }
  >();
  /** each track's main cue as last read or set: it's saved with the hot cues (step 4b) */
  private mains = new Map<string, Cue | null>();
  private sets = new Map<string, CueSet>();

  constructor(private readonly f: FetchLike) {}

  async load(trackId: string): Promise<CueSet | null> {
    try {
      const res = await this.f(appURL(`/api/library/dj/cues/${encodeURIComponent(trackId)}`));
      if (!res.ok) return null;
      const body = (await res.json()) as { cues?: Cue[] };
      const set = cueSetOf(body.cues);
      this.mains.set(trackId, mainCueOf(body.cues));
      this.sets.set(trackId, set);
      return set;
    } catch {
      return null;
    }
  }

  /** The main cue as last read (or set), or null. */
  main(trackId: string): Cue | null {
    return this.mains.get(trackId) ?? null;
  }

  /** The main cue changed (CUE): saved with the hot cues as they are. */
  saveMain(trackId: string, cue: Cue | null, onFail?: () => void): void {
    this.mains.set(trackId, cue);
    this.save(trackId, this.sets.get(trackId) ?? emptyCues(), onFail);
  }

  save(trackId: string, set: CueSet, onFail?: () => void): void {
    this.sets.set(trackId, set);
    const was = this.pending.get(trackId);
    if (was) clearTimeout(was.timer);
    const timer = setTimeout(() => this.send(trackId), SAVE_DELAY_MS);
    this.pending.set(trackId, { timer, set, onFail });
  }

  private send(trackId: string): void {
    const p = this.pending.get(trackId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(trackId);
    void this.f(appURL(`/api/library/dj/cues/${encodeURIComponent(trackId)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cues: [this.mains.get(trackId) ?? null, ...p.set].filter(Boolean),
      }),
    })
      .then((res) => {
        if (!res.ok) p.onFail?.();
      })
      .catch(() => p.onFail?.());
  }

  /** Save what's waiting now (DJ mode off, a track changed). */
  flush(): void {
    for (const id of Array.from(this.pending.keys())) this.send(id);
  }
}
