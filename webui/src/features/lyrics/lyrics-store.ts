/**
 * The lyrics layer's state (27a–27g), shared by the Visuals overlay's layer,
 * its header button, the phone's record (27e) and the visuals controller
 * (Lyrics only turns the visual off). It reads the player: what's playing
 * (`SoulSyncPlayer.state()`) and the lyrics the player already fetched for
 * it (`SoulSyncPlayer.lyricsData()`, static/media-player.js), redrawn on
 * every `ss:player` event. It never fetches lyrics itself.
 *
 * Kept per browser (27a's note 1): Lyrics on or off, Lyrics only and the text
 * size. Kept per track: the early/late nudge, also in this browser
 * (`soulsync-lyrics-offsets`; Design asked for "remembered per track", not
 * per profile, and the toggle beside it is per browser).
 */

import type { LyricSize, ParsedLyrics, RawLyrics } from './lyrics.logic';

import {
  clampOffset,
  DEFAULT_SIZE,
  OFFSET_STEP,
  parseLyrics,
  putOffset,
  QUIET_MS,
  readOffsets,
  SIZES,
  sourceLine,
  stepSize,
  trackKey,
} from './lyrics.logic';

export type LyricsState = 'hidden' | 'loading' | 'synced' | 'plain' | 'none' | 'instrumental';

export interface LyricsSnapshot {
  /** Lyrics over the visuals (the header's toggle, T) */
  on: boolean;
  /** the visual off under it */
  only: boolean;
  size: LyricSize;
  /** music is playing: not radio, a podcast or an audiobook (they stay as today) */
  available: boolean;
  state: LyricsState;
  doc: ParsedLyrics | null;
  source: string;
  title: string;
  /** the nudge's key: this track */
  trackKey: string | null;
  /** seconds; positive shows the words earlier */
  offset: number;
  /** None found / Instrumental still saying so (gone after 5 s) */
  quiet: boolean;
  /** the layer shows (on, music, and not a quiet state that has gone) */
  showing: boolean;
  /** Lyrics only is in force: the visuals controller stops its stage */
  onlyActive: boolean;
}

export const STORAGE = {
  on: 'soulsync-visuals-lyrics',
  only: 'soulsync-visuals-lyrics-only',
  size: 'soulsync-visuals-lyrics-size',
  offsets: 'soulsync-lyrics-offsets',
} as const;

interface PlayerLike {
  state?: () => {
    track?: { id?: string | number | null; title?: string; artist?: string; album?: string } | null;
    kind?: string | null;
  };
  lyricsData?: () => RawLyrics | null;
}

function read(win: Window, key: string): string | null {
  try {
    return win.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(win: Window, key: string, value: string | null): void {
  try {
    if (value === null) win.localStorage.removeItem(key);
    else win.localStorage.setItem(key, value);
  } catch {
    // best effort: private windows and blocked site data
  }
}

type Listener = () => void;

export class LyricsStore {
  private s: LyricsSnapshot;
  private readonly listeners = new Set<Listener>();
  private readonly win: Window;
  private readonly now: () => number;
  private offsets: Record<string, number>;
  private parsedFor: string | null = null;
  /** the track whose None found / Instrumental has been said */
  private quietDone: string | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(win: Window, now: () => number = () => Date.now()) {
    this.win = win;
    this.now = now;
    this.offsets = readOffsets(read(win, STORAGE.offsets));
    const size = Number(read(win, STORAGE.size));
    this.s = {
      on: read(win, STORAGE.on) === '1',
      only: read(win, STORAGE.only) === '1',
      size: (SIZES as readonly number[]).includes(size) ? (size as LyricSize) : DEFAULT_SIZE,
      available: false,
      state: 'hidden',
      doc: null,
      source: '',
      title: '',
      trackKey: null,
      offset: 0,
      quiet: false,
      showing: false,
      onlyActive: false,
    };
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): LyricsSnapshot => this.s;

  private player(): PlayerLike | undefined {
    return (this.win as Window & { SoulSyncPlayer?: PlayerLike }).SoulSyncPlayer;
  }

  private set(patch: Partial<LyricsSnapshot>): void {
    const next = { ...this.s, ...patch };
    next.showing =
      next.on &&
      next.available &&
      (next.state === 'loading' ||
        next.state === 'synced' ||
        next.state === 'plain' ||
        ((next.state === 'none' || next.state === 'instrumental') && next.quiet));
    next.onlyActive = next.on && next.only && next.available;
    const changed = (Object.keys(next) as (keyof LyricsSnapshot)[]).some(
      (k) => next[k] !== this.s[k],
    );
    if (!changed) return;
    this.s = next;
    for (const fn of this.listeners) fn();
    try {
      this.win.dispatchEvent(new CustomEvent('ss:lyrics'));
    } catch {
      // no window events in this environment
    }
  }

  /** Read the player again (the host calls this on every ss:player event). */
  refresh(): void {
    let st: ReturnType<NonNullable<PlayerLike['state']>> | undefined;
    let raw: RawLyrics | null = null;
    try {
      st = this.player()?.state?.();
      raw = this.player()?.lyricsData?.() ?? null;
    } catch {
      st = undefined;
    }
    const track = st?.track ?? null;
    const kind = st?.kind ?? null;
    const available =
      Boolean(track) && kind !== 'radio' && kind !== 'podcast' && kind !== 'audiobook';
    const key = available ? trackKey(track, kind) : null;
    const title = String(track?.title || '').replace(/^[^|]*\|\|/, '');
    if (!available || !raw) {
      this.parsedFor = null;
      this.set({
        available,
        state: available ? 'loading' : 'hidden',
        doc: null,
        source: '',
        title,
        trackKey: key,
        offset: key ? (this.offsets[key] ?? 0) : 0,
        quiet: false,
      });
      return;
    }
    const doneKey = `${raw.key}|${raw.done ? 1 : 0}`;
    if (doneKey === this.parsedFor) {
      if (key !== this.s.trackKey)
        this.set({ trackKey: key, offset: key ? (this.offsets[key] ?? 0) : 0 });
      return;
    }
    this.parsedFor = doneKey;
    if (!raw.done) {
      this.set({
        available,
        state: 'loading',
        doc: null,
        source: '',
        title,
        trackKey: key,
        offset: key ? (this.offsets[key] ?? 0) : 0,
        quiet: false,
      });
      return;
    }
    const doc = parseLyrics(raw);
    const state: LyricsState = doc
      ? doc.timing === 'plain'
        ? 'plain'
        : 'synced'
      : raw.instrumental
        ? 'instrumental'
        : 'none';
    // said once, for 5 s of being seen (seen() starts the clock), then gone
    const quiet = (state === 'none' || state === 'instrumental') && this.quietDone !== key;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.set({
      available,
      state,
      doc,
      source: doc ? sourceLine(raw.source, raw.fileName, doc.timing) : '',
      title,
      trackKey: key,
      offset: key ? (this.offsets[key] ?? 0) : 0,
      quiet,
    });
  }

  /**
   * The layer (or the phone's record) is showing None found or
   * Instrumental: it stays 5 s from now, then goes, for this track (27g).
   * Lyrics stays on for the next track.
   */
  seen(): void {
    if (!this.s.quiet || this.quietTimer) return;
    const key = this.s.trackKey;
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.quietDone = key;
      if (this.s.trackKey === key) this.set({ quiet: false });
    }, QUIET_MS);
  }

  // ── the controls ───────────────────────────────────────────────────────────

  setOn(on: boolean): void {
    write(this.win, STORAGE.on, on ? '1' : null);
    this.set({ on });
    // turned on after None found or Instrumental went quiet: say it again
    if (on && (this.s.state === 'none' || this.s.state === 'instrumental')) {
      this.quietDone = null;
      this.set({ quiet: true });
    }
  }

  toggle(): void {
    this.setOn(!this.s.on);
  }

  setOnly(only: boolean): void {
    write(this.win, STORAGE.only, only ? '1' : null);
    this.set({ only });
  }

  stepSize(dir: 1 | -1): void {
    const size = stepSize(this.s.size, dir);
    write(this.win, STORAGE.size, String(size));
    this.set({ size });
  }

  /** Earlier (+1) or Later (−1), 0.1 s a step, kept for this track. */
  nudge(dir: 1 | -1): void {
    const key = this.s.trackKey;
    const offset = clampOffset(this.s.offset + dir * OFFSET_STEP);
    if (key) {
      this.offsets = putOffset(this.offsets, key, offset);
      write(this.win, STORAGE.offsets, JSON.stringify(this.offsets));
    }
    this.set({ offset });
  }

  resetOffset(): void {
    const key = this.s.trackKey;
    if (key) {
      this.offsets = putOffset(this.offsets, key, 0);
      write(this.win, STORAGE.offsets, JSON.stringify(this.offsets));
    }
    this.set({ offset: 0 });
  }

  /**
   * T (24a): lyrics over the visuals while they're open, or in the phone's
   * record while its sheet is up; music only. False leaves the key to the
   * page.
   */
  key(k: string): boolean {
    if (k !== 'T' || !this.s.available) return false;
    const doc = this.win.document;
    const overlay = doc.getElementById('np-modal-overlay');
    const visualsOpen = Boolean(overlay && !overlay.classList.contains('hidden'));
    const sheet = doc.documentElement.hasAttribute('data-player-sheet');
    if (!visualsOpen && !sheet) return false;
    this.toggle();
    return true;
  }

  dispose(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
  }
}

let shared: LyricsStore | null = null;

/** The page's one store (made on first use). */
export function lyricsStore(win: Window = window): LyricsStore {
  shared ??= new LyricsStore(win);
  return shared;
}

/** @internal tests */
export function resetLyricsStore(): void {
  shared?.dispose();
  shared = null;
}
