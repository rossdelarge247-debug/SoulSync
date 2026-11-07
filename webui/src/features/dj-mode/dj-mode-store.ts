/**
 * DJ mode's state (Brief F, step 2: the lanes). One store for the page, in
 * the entry chunk, so D works from the player before the Visuals' pieces
 * have loaded; the lanes themselves (dj-stage.tsx) load with the overlay.
 *
 * - **on / off**: offered only for a library track with its file, on a
 *   laptop or desktop (dj-mode.logic.ts `djAvailability`). While on, the
 *   visuals controller stops the visual (its engine reads `dj`), Lyrics
 *   hides, and Back (or Esc, or closing the overlay) turns it off at once:
 *   in step 2 nothing is ever blending.
 * - **lane A** mirrors the player's track: its 200 peaks, its DJ data (key,
 *   BPM) and its beat grid. Step 2 never touches the audio.
 * - **lane B** is a track loaded by a drop (the `dj` target, dj-stage.tsx)
 *   or, from step 3, by Browse's Load (`loadB`): shown with its waveform and
 *   data, cued, not played.
 * - **the mixer** (step 3, dj-mixer.tsx and dj-mix-session.ts) registers
 *   its hooks (`setMixer`): Back mid-blend brings the fader to A over a
 *   bar first (413), turning DJ mode off lets the decks go, ⇧P is Play B,
 *   and the mix's phase (`mix`) feeds the header's line and Esc's rule.
 * - a track without its grid is asked for at once (`source: 'dj_now'`, the
 *   on-demand path, core/dj/ondemand.py) and watched through Brief A's one
 *   poll (analysis.api.ts); the grid is read again when it lands (420).
 */
import type { AnalysisEntry } from '@/features/dj/analysis.api';
import type { DragItem } from '@/features/dnd/dnd-model';

import { analysisStore, requestAnalysis } from '@/features/dj/analysis.api';
import { liveSay } from '@/features/dnd/dnd-engine';
import { appURL } from '@/platform/url-base';

import type { Cue, CueSet } from './dj-cues';
import type {
  Availability,
  LaneApiGrid,
  LaneGrid,
  LanePhase,
  PlayerTrackLike,
} from './dj-mode.logic';
import type { DeckPort } from './dj-transport';
import type { ZoomLevel } from './dj-zoom';

import {
  barWords,
  CueStore,
  cueAt,
  cueSeconds,
  cueWords,
  emptyCues,
  MAIN_SLOT,
  withCue,
  withoutCue,
} from './dj-cues';
import { cachedLevels, loadLevels, SmoothClock, type Levels } from './dj-levels';
import {
  cueTime,
  djAvailability,
  gridProblem,
  laneGrid,
  noGridWords,
  PENDING_REASONS,
} from './dj-mode.logic';
import { djPrefs, type DjPrefsStore } from './dj-prefs';
import { DeckTransport } from './dj-transport';
import { zoomStep, zoomWords } from './dj-zoom';

export interface LaneTrack {
  id: string;
  title: string;
  artist: string;
  image: string | null;
  /** seconds, when known before the peaks say */
  duration: number | null;
  /** what the drag carried, until the DJ data says */
  key?: string | null;
  bpm?: number | null;
  /** B: the track as the player's queue takes it (Hand over, 414); fetched when the drag didn't carry it */
  queue?: Record<string, unknown> | null;
  /** B: why the player can't take it (its file isn't on this computer), once known */
  queueWhy?: string | null;
}

export interface LaneInfo {
  bpm: number | null;
  key: string | null;
  keyUncertain: boolean;
}

export interface LaneState {
  track: LaneTrack;
  /** the player's 200 bar heights (0–1), null until they come (or for none) */
  peaks: number[] | null;
  /** the decoded length the peaks span */
  duration: number | null;
  grid: LaneGrid | null;
  phase: LanePhase;
  /** why there's no grid to blend on (37d), for `noGridWords` */
  reason: string | null;
  info: LaneInfo | null;
  /**
   * The deck's cue point, seconds: CUE's (step 4b) when the person set one,
   * else B's mix-in and A's start. Play B starts B here.
   */
  cue: number;
  /** the person's cue points 1–4 on this track (3b, 439) */
  cues: CueSet;
  /** the person's main cue (CUE, slot 0), null for the default */
  main?: Cue | null;
  /** the track's level every 10 ms (step 4b), once the server has it */
  fine?: Levels | null;
}

export interface DjModeSnapshot {
  on: boolean;
  /** the Visuals overlay is open */
  open: boolean;
  availability: Availability;
  a: LaneState | null;
  b: LaneState | null;
  /** Browse is there (step 3 registers it): the button and B show */
  browse: boolean;
  /** the mixer's phase (step 3): what the header says, what Back and Esc do */
  mix: MixState;
  /** the cue picked on each lane (a white ring; a click on the waveform places it) */
  pick: Record<Deck, number | null>;
  /** each lane's zoom (442): the person's last (16 bars to start, S3), kept per profile */
  zoom: Record<Deck, ZoomLevel>;
}

export type MixPhaseLike =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'starting'
  | 'playing'
  | 'paused'
  | 'backing'
  | 'handing'
  | 'failed';

export interface MixState {
  phase: MixPhaseLike;
  /** B's window on its deck (424), track seconds */
  window: { start: number; end: number } | null;
  /** B's speed while Sync stretches it */
  rateB: number | null;
  /** Sync is on and can work */
  sync: boolean;
  /** the decks' windows as levels (3b: a zoomed lane's detail) */
  levels?: Record<'A' | 'B', import('./dj-mix-session').DeckLevels | null>;
  /** the last Hand over, while its notice shows (37i) */
  handed?: import('./dj-mix-session').Handed | null;
  /** B playing on its own (A finished, 37j) */
  solo?: boolean;
  /** B playing before the blend, in the headphones (B's Play, step 4b) */
  previewB?: boolean;
  /** a hand on a deck's platter */
  hand?: 'A' | 'B' | null;
  /** each deck's speed against its own tempo as it plays, or will (M2: the heads' BPM) */
  rates?: { A: number | null; B: number | null };
  /** each deck's loop (step 6): drawn on its lane */
  loops?: Record<'A' | 'B', import('./dj-mix-session').DeckLoop | null>;
}

/** A loop or beatjump key's action on a deck (step 6). */
export type LoopAction = 'loop' | 'in' | 'out' | 'reloop' | 'half' | 'double' | 'back' | 'on';

/** What the mixer (step 3) lends the store: it lives with the Visuals' pieces. */
export interface MixerHooks {
  /** B is playing (or about to, or Back is bringing A back): a blend */
  blending(): boolean;
  /** Back mid-blend: the fader to A over a bar, then `done` */
  backOverBar(done: () => void): void;
  /** let the decks go at once (DJ mode off, the overlay closed, B removed) */
  end(): void;
  /** Play B (⇧P) or Pause B */
  playB(): boolean;
  /** B's place now while it plays (lane B's playhead) */
  positionB(): number | null;
  /** A's place on its deck while it's there (the element only keeps time near enough, M1) */
  positionA?(): number | null;
  /** A is playing on DJ mode's deck (its element muted under it) */
  holdsTrack?(): boolean;
  /** A deck's Headphones, Key lock and jumps (3b); the session's */
  togglePhones?(deck: 'A' | 'B'): void;
  toggleKeyLock?(deck: 'A' | 'B'): void;
  jump?(deck: 'A' | 'B', seconds: number): 'seek' | 'cue' | 'jumped' | 'outside';
  /** a deck plays (B: in a blend or before it; A: on its deck or the player's element) */
  deckPlaying?(deck: 'A' | 'B'): boolean;
  /** B's own Play before the blend, into the headphones (step 4b) */
  previewB?(on: boolean): boolean;
  /** B's place while stopped (CUE's return) */
  parkB?(seconds: number): void;
  /** a hand on a deck's platter: null when on, else why not */
  grab?(deck: 'A' | 'B'): string | null;
  moveHand?(deck: 'A' | 'B', offsetSeconds: number): void;
  letGo?(deck: 'A' | 'B'): void;
  /** whoever has a hand on a deck lets go (the overlay closed) */
  releaseHand?(): void;
  /** ← →: a little faster or slower while held (0 lets go) */
  nudge?(deck: 'A' | 'B', dir: -1 | 0 | 1): boolean;
  /** A is on its deck (its transport is the player's own then too) */
  aOnDeck?(): boolean;
  /** Hand over (414, step 4): false (and said why) when it can't */
  handOver?(): boolean;
  /** why Hand over can't happen now, or null */
  handOverWhy?(): string | null;
  /** Hand over's Undo (10 s) */
  undoHandOver?(): Promise<boolean>;
  /** A's end is DJ mode's (A ran out while B plays: a Hand over) */
  ownsAdvance?(): boolean;
  /** loops and beatjump (step 6) */
  loopAction?(deck: 'A' | 'B', action: LoopAction): boolean;
  /** Quantize's toggle (step 6) */
  toggleQuantize?(): void;
}

export const IDLE_MIX: MixState = { phase: 'idle', window: null, rateB: null, sync: false };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface PlayerLike {
  state?: () => { track?: PlayerTrackLike | null; kind?: string | null } | null;
}

interface AnalysisLike {
  watch(ids: string[]): () => void;
  entry(id: string): AnalysisEntry | undefined;
  subscribe(fn: () => void): () => void;
}

export interface DjModeDeps {
  win?: Window;
  fetch?: FetchLike;
  /** ask for tracks to be analysed now (the on-demand path) */
  /** its answer (null: turned away, e.g. 409 held) or a rejection lets the ask be tried again */
  analyse?: (ids: string[]) => Promise<unknown> | void;
  analysis?: AnalysisLike;
  /** a laptop or desktop, not a phone (417) */
  phone?: () => boolean;
  /** the library's drive is away (the drives' store) */
  libraryAway?: () => boolean;
  /** one polite announcement per change of state (37p) */
  say?: (words: string) => void;
  now?: () => number;
  /** the person's DJ settings (zoom, step 5) */
  prefs?: DjPrefsStore;
}

export const PHONE_QUERY = '(max-width: 768px)';
/** A phone on its side (lyrics-mount's query): still a phone (417, review L9). */
// a coarse pointer too, so a short desktop window (Ross's was about 500px
// under the top bar) isn't taken for a phone (review N3)
export const PHONE_LANDSCAPE_QUERY =
  '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)';
/** How long a drag's "has its beat grid" answer is trusted (review L5). */
export const READINESS_MS = 60_000;

/** Is this window a phone's, upright or on its side? */
export function isPhone(win: Window): boolean {
  return Boolean(
    win.matchMedia?.(PHONE_QUERY).matches || win.matchMedia?.(PHONE_LANDSCAPE_QUERY).matches,
  );
}

/** Peaks: 202 means ask again after this long (as the player does; gives up after six). */
export function peaksDelay(attempt: number): number | null {
  if (attempt >= 6) return null;
  return Math.min(8000, 1500 * 2 ** attempt);
}

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/** The player's track as lane A shows it. */
export function laneTrackFromPlayer(t: PlayerTrackLike): LaneTrack {
  let title = text(t.title);
  const cut = title.indexOf('||'); // some titles are stored "<id>||<title>"
  if (cut >= 0) title = title.slice(cut + 2);
  return {
    id: text(t.id),
    title: title.trim(),
    artist: text(t.artist).trim(),
    image: t.image_url || null,
    duration: typeof t.duration === 'number' && t.duration > 0 ? t.duration : null,
  };
}

/** A dragged row (or Browse's row, step 3) as lane B loads it. */
function clockWords(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export function laneTrackFromItem(item: DragItem): LaneTrack {
  const q = (item.queue ?? {}) as Record<string, unknown>;
  const duration = Number(q.duration);
  return {
    id: String(item.id),
    title: item.title || text(q.title),
    artist: item.artist ?? text(q.artist),
    image: typeof q.image_url === 'string' && q.image_url ? q.image_url : null,
    duration: duration > 0 ? duration : null,
    key: item.key ?? null,
    bpm: item.bpm ?? null,
    queue:
      item.queue && typeof item.queue.file_path === 'string' && item.queue.file_path
        ? item.queue
        : null,
  };
}

type Listener = () => void;
type Deck = 'a' | 'b';

export class DjModeStore {
  private s: DjModeSnapshot;
  private readonly listeners = new Set<Listener>();
  private readonly win: Window;
  private readonly f: FetchLike;
  private readonly analyse: (ids: string[]) => Promise<unknown> | void;
  private readonly analysis: AnalysisLike;
  private readonly phone: () => boolean;
  private readonly libraryAway: () => boolean;
  private readonly sayFn: (words: string) => void;
  /** each load's generation: an answer for an older load is dropped */
  private gen: Record<Deck, number> = { a: 0, b: 0 };
  private unwatch: Record<Deck, (() => void) | null> = { a: null, b: null };
  private timers: Record<Deck, ReturnType<typeof setTimeout> | null> = { a: null, b: null };
  private browseOpener: (() => void) | null = null;
  private browseCloser: (() => boolean) | null = null;
  private mixer: MixerHooks | null = null;
  /** popups open over the stage (Tempo's menu, DJ outputs): Esc closes the latest first */
  private closers: (() => void)[] = [];
  private offAnalysis: (() => void) | null = null;
  /** the grid lookups for a drag's drop line (37c): true has a grid, false not yet */
  private readiness = new Map<string, { v: boolean | 'asking'; at: number }>();
  /** tracks this store asked analysis for this session: toggling D doesn't ask again (review M1) */
  private asked = new Set<string>();
  /** a grid read on its way, per deck, by load generation (review L1) */
  private gridFor: Record<Deck, number | null> = { a: null, b: null };
  private readonly now: () => number;
  private readonly cueStore: CueStore;
  private readonly prefs: DjPrefsStore;
  /** the element's time between its steps (step 4b) */
  private readonly clock = new SmoothClock();
  /** each deck's Play/Pause and CUE (step 4b, a CDJ's) */
  private readonly transports = { a: new DeckTransport(), b: new DeckTransport() };
  private readonly nudging = new Set<Deck>();
  /** tracks whose cues couldn't be read: nothing is saved over them (review L-5) */
  private readonly unreadCues = new Set<string>();
  private readonly unreadSaid = new Set<string>();
  /** a nudge refused under a blend has been said (review L-7) */
  private arrowSaid = false;
  /** window blur and visibility: held keys let go (review M-2) */
  private offHeld: (() => void) | null = null;
  /** the last "why not" a hand on the platter heard, so it's said once */
  private handWhy: string | null = null;
  /** the tracks whose failed cue save has been said (once a track, L1) */
  private readonly unsavedSaid = new Set<string>();
  /** B as it was when it was handed over: Undo puts it back in its lane, cued */
  private handedB: LaneTrack | null = null;
  /** the player's element, watched for A's end while DJ mode is on (37j's words) */
  private endedEl: EventTarget | null = null;
  /** the lane A track whose element ended, until the player moves on */
  private aEnded: string | null = null;
  private endedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: DjModeDeps = {}) {
    this.win = deps.win ?? window;
    this.f = deps.fetch ?? ((url, init) => this.win.fetch(url, init));
    this.analyse =
      deps.analyse ??
      ((ids) => {
        // a person opened DJ mode or loaded B: their ask, said as DJ mode's,
        // and forced, so an automatic ask a moment ago doesn't swallow it (M1)
        return requestAnalysis(ids, { force: true, reason: 'asked', source: 'dj_now' });
      });
    this.analysis = deps.analysis ?? analysisStore;
    this.cueStore = new CueStore((url, init) => this.f(url, init));
    this.phone = deps.phone ?? (() => isPhone(this.win));
    this.now = deps.now ?? (() => Date.now());
    this.libraryAway = deps.libraryAway ?? (() => false);
    this.sayFn = deps.say ?? ((w) => liveSay(w));
    this.prefs = deps.prefs ?? djPrefs();
    this.s = {
      on: false,
      open: false,
      availability: { offered: false, why: 'nothing' },
      a: null,
      b: null,
      browse: false,
      mix: IDLE_MIX,
      pick: { a: null, b: null },
      zoom: { ...this.prefs.snapshot().zoom },
    };
    this.s.availability = this.availabilityNow();
  }

  // ── store ──────────────────────────────────────────────────────────────

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): DjModeSnapshot => this.s;

  private set(patch: Partial<DjModeSnapshot>): void {
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn();
  }

  private setLane(deck: Deck, patch: Partial<LaneState> | null): void {
    if (patch === null) {
      this.set(deck === 'a' ? { a: null } : { b: null });
      return;
    }
    const was = this.s[deck];
    if (!was) return;
    const next = { ...was, ...patch };
    this.set(deck === 'a' ? { a: next } : { b: next });
  }

  private say(words: string): void {
    try {
      this.sayFn(words);
    } catch {
      /* no live region on this page */
    }
  }

  // ── the player ─────────────────────────────────────────────────────────

  private player(): { track: PlayerTrackLike | null; kind: string | null } {
    try {
      const st = (this.win as Window & { SoulSyncPlayer?: PlayerLike }).SoulSyncPlayer?.state?.();
      return { track: st?.track ?? null, kind: st?.kind ?? null };
    } catch {
      return { track: null, kind: null };
    }
  }

  private availabilityNow(): Availability {
    const { track, kind } = this.player();
    return djAvailability({
      track,
      kind,
      phone: this.phone(),
      libraryAway: this.libraryAway(),
    });
  }

  /** The playing track's id, while one plays. */
  playingId(): string | null {
    const id = this.player().track?.id;
    return id === null || id === undefined || id === '' ? null : String(id);
  }

  /**
   * The player changed (`ss:player`), the phone turned, the drive went:
   * what's offered now, and lane A follows the player's track. Not offered
   * any more (radio started, the drive went): DJ mode turns off.
   */
  refresh(): void {
    const availability = this.availabilityNow();
    const same =
      availability.offered === this.s.availability.offered &&
      availability.why === this.s.availability.why;
    if (!same) this.set({ availability });
    if (!this.s.on) return;
    if (!availability.offered) {
      this.setOn(false);
      return;
    }
    this.watchEnded();
    const { track } = this.player();
    const id = track?.id === null || track?.id === undefined ? '' : String(track.id);
    if (track && id && id !== this.s.a?.track.id) {
      const was = this.s.a?.track ?? null;
      const ended = was !== null && this.aEnded === was.id;
      this.aEnded = null;
      this.loadLane('a', laneTrackFromPlayer(track));
      // the player moved onto B's track: B would be the playing track itself
      // (a Hand over says so itself)
      if (this.s.b?.track.id === id) this.clearLane('b');
      else if (this.s.b && was) {
        // 37j: the player obeyed (Next, a row played, A ended into Up next): B stays loaded
        const now = track.title || 'The next track';
        const head = ended ? `${was.title || 'The track'} ended · ` : '';
        this.say(`${head}${now} is playing · ${this.s.b.track.title || 'B'} still cued`);
      }
    }
  }

  /** A's end (37j's words): watched on the player's element while DJ mode is on. */
  private watchEnded(): void {
    let el: EventTarget | null = null;
    try {
      el =
        (
          this.win as Window & { SoulSyncPlayer?: { audio?: () => EventTarget | null } }
        ).SoulSyncPlayer?.audio?.() ?? null;
    } catch {
      el = null;
    }
    if (!this.s.on || typeof el?.addEventListener !== 'function') el = null;
    if (el === this.endedEl) return;
    this.endedEl?.removeEventListener('ended', this.onAEnded);
    this.endedEl = el;
    el?.addEventListener('ended', this.onAEnded);
  }

  private readonly onAEnded = () => {
    const a = this.s.a;
    if (!this.s.on || !a) return;
    this.aEnded = a.track.id;
    if (this.endedTimer) clearTimeout(this.endedTimer);
    // Up next ran out (37j): the player stops; DJ mode stays with A at its end
    this.endedTimer = setTimeout(() => {
      this.endedTimer = null;
      const b = this.s.b;
      if (!this.s.on || !b || this.blending() || this.s.mix.solo) return;
      if (this.playingId() !== a.track.id || this.aEnded !== a.track.id) return;
      this.say(`${a.track.title || 'The track'} ended · nothing in Up next · Play B to carry on`);
    }, 400);
  };

  /**
   * The overlay opened or closed. DJ mode stays on with it closed (37j: ×
   * closes the overlay and the blend goes on; the player bar shows one line
   * while it's on, 37o); the decks don't need the stage.
   */
  setOpen(open: boolean): void {
    if (open === this.s.open) return;
    this.set({ open });
    if (!open) {
      // the lanes are hidden: no hand on a platter, nothing held (review M-3, M-2)
      this.mixer?.releaseHand?.();
      this.releaseHeld();
    }
  }

  // ── on and off ─────────────────────────────────────────────────────────

  /** D, the header's toggle. On only when offered; off at once (nothing blends in step 2). */
  setOn(on: boolean): boolean {
    if (on === this.s.on) return true;
    if (on) {
      const availability = this.availabilityNow();
      this.set({ availability });
      if (!availability.offered) return false;
      const { track } = this.player();
      this.set({ on: true });
      if (track) this.loadLane('a', laneTrackFromPlayer(track));
      this.watchEnded();
      this.watchHeld(true);
      this.say('DJ mode on');
      return true;
    }
    this.browseCloser?.();
    this.releaseHeld();
    this.watchHeld(false);
    this.mixer?.end();
    this.handedB = null;
    this.transports.a.reset();
    this.transports.b.reset();
    this.aEnded = null;
    if (this.endedTimer) clearTimeout(this.endedTimer);
    this.endedTimer = null;
    // the cues waiting to be saved go now; picks are this visit's, the zoom the person's
    this.cueStore.flush();
    this.set({ pick: { a: null, b: null }, zoom: { ...this.prefs.snapshot().zoom } });
    this.clearLane('a');
    this.clearLane('b');
    this.readiness.clear();
    // asked again next time DJ mode opens (review N1)
    this.asked.clear();
    this.set({ on: false });
    this.watchEnded();
    this.say('DJ mode off');
    return true;
  }

  /** D (37p): on or off, off only when nothing is blending (Back ends a blend over a bar). */
  toggle(): boolean {
    if (this.s.on && this.blending()) {
      this.say('Blending · Back ends it over a bar');
      return true;
    }
    return this.setOn(!this.s.on);
  }

  /**
   * Back (413): with nothing loaded or B not started, at once; mid-blend
   * the fader comes back to A over one bar first, then DJ mode is off.
   */
  back(): boolean {
    if (!this.s.on) return false;
    // Hand over on its way: a moment (review L-2)
    if (this.s.mix.phase === 'handing') {
      this.say(`Handing over to ${this.s.b?.track.title || 'B'}: a moment`);
      return true;
    }
    if (this.blending()) {
      if (this.s.mix.phase === 'backing') return true;
      this.mixer!.backOverBar(() => {
        if (this.s.on) this.setOn(false);
      });
      return true;
    }
    return this.setOn(false);
  }

  /** B is in the speakers (37h): Esc isn't Back then (413), and B can't be swapped. */
  blending(): boolean {
    try {
      return Boolean(this.mixer?.blending());
    } catch {
      return false;
    }
  }

  /**
   * Esc in the overlay (37p): Browse closes first; mid-blend it only says
   * how to end the blend (a stray key never ends one); otherwise it's Back.
   */
  escape(): boolean {
    if (!this.s.on) return false;
    if (this.browseCloser?.()) return true;
    const popup = this.closers.pop();
    if (popup) {
      popup();
      return true;
    }
    // a picked cue is cleared first (439): Esc falls through to Back only when nothing is picked
    for (const deck of ['b', 'a'] as const) {
      if (this.s.pick[deck] !== null) {
        this.clearPick(deck);
        return true;
      }
    }
    if (this.blending()) {
      this.say('Blending · Back ends it over a bar');
      return true;
    }
    return this.back();
  }

  // ── the mixer (step 3) ─────────────────────────────────────────────────

  setMixer(hooks: MixerHooks | null): void {
    this.mixer = hooks;
    if (!hooks && this.s.mix !== IDLE_MIX) this.set({ mix: IDLE_MIX });
  }

  /** The mixer's phase, window and rate changed. */
  setMix(mix: MixState): void {
    const was = this.s.mix;
    if (
      was.phase === mix.phase &&
      was.rateB === mix.rateB &&
      was.sync === mix.sync &&
      was.levels?.A === mix.levels?.A &&
      was.levels?.B === mix.levels?.B &&
      was.window?.start === mix.window?.start &&
      was.window?.end === mix.window?.end &&
      was.handed === mix.handed &&
      Boolean(was.solo) === Boolean(mix.solo) &&
      Boolean(was.previewB) === Boolean(mix.previewB) &&
      (was.hand ?? null) === (mix.hand ?? null) &&
      (was.rates?.A ?? null) === (mix.rates?.A ?? null) &&
      (was.rates?.B ?? null) === (mix.rates?.B ?? null) &&
      was.loops?.A === mix.loops?.A &&
      was.loops?.B === mix.loops?.B
    )
      return;
    this.set({ mix });
  }

  // ── Hand over (step 4: 414, 37i) ───────────────────────────────────────

  /** Why Hand over can't happen now (the button's title), or null. */
  handOverWhy(): string | null {
    if (!this.s.on || !this.s.b) return 'Load a second track first';
    try {
      return this.mixer?.handOverWhy?.() ?? 'The decks aren’t ready';
    } catch {
      return 'The decks aren’t ready';
    }
  }

  /** H or the button: B becomes the player's track (414). False when there's no B. */
  handOver(): boolean {
    if (!this.s.on || !this.s.b) return false;
    const b = this.s.b.track;
    try {
      if (this.mixer?.handOver?.()) this.handedB = b;
    } catch {
      /* the mixer says why itself */
    }
    return true;
  }

  /** Hand over's Undo (10 s): A back as the player's track, B back in its lane, cued. */
  async undoHandOver(): Promise<boolean> {
    const b = this.handedB;
    const mixer = this.mixer;
    if (!this.s.on || !b || !mixer?.undoHandOver) return false;
    this.handedB = null;
    let ok = false;
    try {
      ok = await mixer.undoHandOver();
    } catch {
      ok = false;
    }
    if (!ok || !this.s.on) return false;
    this.refresh();
    this.loadB(b, { announce: false });
    this.say(`Undone: ${this.s.a?.track.title || 'A'} is back · ${b.title || 'B'} cued`);
    return true;
  }

  /** A's end is DJ mode's while B plays (the player asks, media-player.js). */
  ownsAdvance(): boolean {
    try {
      return Boolean(this.s.on && this.mixer?.ownsAdvance?.());
    } catch {
      return false;
    }
  }

  /**
   * ⇧P: Play B (or Pause B while it plays). With B loaded the key is DJ
   * mode's whatever the mixer answers (getting ready, A paused, a second
   * press): it never falls through to Previous (review H4).
   */
  playB(): boolean {
    if (!this.s.on || !this.s.b) return false;
    try {
      this.mixer?.playB();
    } catch {
      /* the mixer says why itself */
    }
    return true;
  }

  positionB(): number | null {
    return this.mixer?.positionB() ?? null;
  }

  /** A's place in its track: deck A's own while it's on its deck, else the player's element. */
  positionA(): number | null {
    try {
      const p = this.mixer?.positionA?.() ?? null;
      if (p !== null && Number.isFinite(p)) return p;
    } catch {
      /* the element's, then */
    }
    return this.audioTime();
  }

  /** A is on DJ mode's deck: auto-mix, made now, must hold (re-review N3). */
  holdsTrack(): boolean {
    try {
      return Boolean(this.s.on && this.mixer?.holdsTrack?.());
    } catch {
      return false;
    }
  }

  // ── Browse (step 3) ────────────────────────────────────────────────────

  /**
   * Step 3's Browse registers its opener here; until then the lane draws no
   * Browse… button and B is the page's key (step 2 hides Browse behind this,
   * rather than drawing a button that does nothing).
   */
  setBrowseOpener(open: (() => void) | null, close: (() => boolean) | null = null): void {
    this.browseOpener = open;
    this.browseCloser = open ? close : null;
    this.set({ browse: Boolean(open) });
  }

  openBrowse(): boolean {
    if (!this.s.on) return false;
    // B is in the speakers: a new B would cut it off (Back first)
    if (this.blending()) {
      this.say('Blending · Back ends it, then Browse');
      return true;
    }
    if (!this.browseOpener) return false;
    this.browseOpener();
    return true;
  }

  // ── lane B ─────────────────────────────────────────────────────────────

  /** Load a track into lane B: shown with its waveform and data, cued, not played (step 3 plays it). */
  loadB(item: DragItem | LaneTrack, { announce = true }: { announce?: boolean } = {}): boolean {
    if (!this.s.on) return false;
    const track = 'image' in item ? item : laneTrackFromItem(item);
    if (!track.id || track.id === this.playingId()) return false;
    // never under a blend: B is in the speakers (Back first)
    if (this.blending()) return false;
    this.loadLane('b', track);
    if (!track.queue) void this.loadQueueTrack(this.gen.b, track.id);
    // said once, unless the caller says it itself (a drop's toast)
    if (announce) this.say(`${track.title || 'The track'} loaded as B, cued`);
    return true;
  }

  /** B as the player's queue takes it, for Hand over (Browse's rows and some drags don't carry it). */
  private async loadQueueTrack(gen: number, id: string): Promise<void> {
    const body = (await this.getJson(`/api/library/dj/track/${encodeURIComponent(id)}`)) as {
      track?: Record<string, unknown> & { file_missing?: boolean };
    } | null;
    if (!this.live('b', gen)) return;
    const t = body?.track;
    const lane = this.s.b;
    if (!lane) return;
    if (!t || t.file_missing || typeof t.file_path !== 'string' || !t.file_path) {
      // Hand over says why instead of waiting forever (review L-5)
      this.setLane('b', {
        track: {
          ...lane.track,
          queueWhy: `${lane.track.title || 'B'}’s file isn’t on this computer: it can’t go to the player`,
        },
      });
      return;
    }
    const duration = Number(t.duration_ms);
    this.setLane('b', {
      track: {
        ...lane.track,
        queue: {
          id: t.id,
          title: t.title,
          artist: t.artist_name,
          album: t.album_title,
          file_path: t.file_path,
          artist_id: t.artist_id,
          album_id: t.album_id,
          image_url: t.image_url,
          bitrate: t.bitrate,
          duration: duration > 0 ? Math.round(duration / 1000) : undefined,
        },
      },
    });
  }

  /** One polite announcement for a change of state the lanes see (the mix-out reached). */
  announce(words: string): void {
    this.say(words);
  }

  removeB(): void {
    if (!this.s.b || this.blending()) return;
    const title = this.s.b.track.title;
    this.clearLane('b');
    this.say(`${title || 'The second track'} removed`);
  }

  // ── a drag's drop line (37c) ───────────────────────────────────────────

  /**
   * Whether a dragged track has its beat grid, for "has its beat grid": the
   * answer if known, else null and a lookup that calls `onKnown` when it lands.
   */
  readinessOf(id: string, onKnown: () => void): boolean | null {
    const known = this.readiness.get(id);
    // an answer is trusted for a minute; a lookup on its way is waited for
    if (known && (known.v === 'asking' || this.now() - known.at < READINESS_MS))
      return known.v === 'asking' ? null : known.v;
    const entry = this.analysis.entry(id);
    if (entry && typeof entry.ready === 'boolean') {
      this.readiness.set(id, { v: entry.ready, at: this.now() });
      return entry.ready;
    }
    this.readiness.set(id, { v: 'asking', at: this.now() });
    void this.getJson(`/api/library/dj/grid/${encodeURIComponent(id)}`).then((body) => {
      const g = (body as { grid?: LaneApiGrid } | null)?.grid;
      // a failed read isn't an answer: the next look asks again (review L5)
      if (g) this.readiness.set(id, { v: Boolean(g.analyzed), at: this.now() });
      else this.readiness.delete(id);
      onKnown();
    });
    return null;
  }

  // ── loading a lane ─────────────────────────────────────────────────────

  /** A popup over the stage (3b: Tempo's menu, DJ outputs): Esc closes it before anything else. */
  addCloser(close: () => void): () => void {
    this.closers.push(close);
    return () => {
      this.closers = this.closers.filter((c) => c !== close);
    };
  }

  // ── cues (3b, 439) ─────────────────────────────────────────────────────

  /** The fine waveform (step 4b): asked for again while the server works it out. */
  private async loadFine(deck: Deck, gen: number, id: string): Promise<void> {
    const have = cachedLevels(id);
    if (have) {
      this.setLane(deck, { fine: have });
      return;
    }
    const fine = await loadLevels(
      id,
      appURL(`/api/library/dj/levels/${encodeURIComponent(id)}`),
      (url, init) => this.f(url, init),
      (attempt) => (attempt >= 12 ? null : Math.min(8000, 1000 * 2 ** attempt)),
    );
    if (!this.live(deck, gen) || !fine) return;
    this.setLane(deck, { fine });
  }

  private async loadCues(deck: Deck, gen: number, id: string): Promise<void> {
    const set = await this.cueStore.load(id);
    if (!this.live(deck, gen)) return;
    if (!set) {
      this.unreadCues.add(id);
      return;
    }
    this.unreadCues.delete(id);
    const main = this.cueStore.main(id);
    const lane = this.s[deck]!;
    this.setLane(deck, {
      cues: set,
      main,
      ...(main ? { cue: cueSeconds(main, lane.grid?.grid ?? null) } : {}),
    });
  }

  // ── the transport (step 4b: Play/Pause and CUE, a CDJ's) ──────────────

  /** CUE's point moves (CUE on a stopped deck away from it): snapped to the beat, kept with the cues. */
  setMainCue(deck: Deck, seconds: number): boolean {
    const lane = this.s[deck];
    if (!this.s.on || !lane) return false;
    // on the beat with Quantize (step 6); as it is without
    const grid =
      lane.phase === 'ready' && lane.grid && this.prefs.snapshot().quantize ? lane.grid.grid : null;
    const cue = cueAt(MAIN_SLOT, seconds, grid, lane.duration ?? 0);
    this.setLane(deck, { main: cue, cue: cue.seconds });
    if (this.cuesReadable(lane.track.id))
      this.cueStore.saveMain(lane.track.id, cue, () => this.cuesNotSaved(lane.track.id));
    const where = barWords(cue);
    this.say(
      `Deck ${this.deckName(deck)} cue at ${where ? `bar ${where}` : clockWords(cue.seconds)}`,
    );
    return true;
  }

  /** The deck's Play/Pause and CUE as a port the transport drives. */
  private port(deck: Deck): DeckPort | null {
    const lane = this.s[deck];
    const mixer = this.mixer;
    if (!lane) return null;
    if (deck === 'a') {
      const player = () =>
        (
          this.win as Window & {
            SoulSyncPlayer?: {
              toggle?: () => void;
              seek?: (s: number) => void;
              audio?: () => HTMLMediaElement | null;
            };
          }
        ).SoulSyncPlayer;
      const el = () => player()?.audio?.() ?? null;
      return {
        playing: () => Boolean(el() && !el()!.paused),
        position: () => this.positionA(),
        cue: () => this.s.a?.cue ?? 0,
        setCue: (p) => void this.setMainCue('a', p),
        play: () => {
          if (el()?.paused) player()?.toggle?.();
        },
        pause: () => {
          if (el() && !el()!.paused) player()?.toggle?.();
        },
        seek: (p) => player()?.seek?.(p),
      };
    }
    if (!mixer) return null;
    return {
      playing: () => Boolean(mixer.deckPlaying?.('B')),
      position: () => this.positionB() ?? this.s.b?.cue ?? null,
      cue: () => this.s.b?.cue ?? 0,
      setCue: (p) => void this.setMainCue('b', p),
      play: () => {
        const phase = this.s.mix.phase;
        if (phase === 'ready') mixer.previewB?.(true);
        else if (phase === 'paused') mixer.playB();
      },
      pause: () => {
        if (this.s.mix.previewB) mixer.previewB?.(false);
        else if (mixer.deckPlaying?.('B')) mixer.playB();
      },
      seek: (p) => mixer.parkB?.(p),
    };
  }

  /**
   * A deck's Play/Pause (`play`) or CUE (`cueDown`, `cueUp`; 4b). Deck A is
   * the player's own transport while A is on its element; under a blend its
   * Play pauses both (the player's Pause) and its CUE waits (Back first).
   * Deck B's plays into the headphones before the blend; Play B is still the
   * synced start. False when there's nothing to act on.
   */
  transport(deck: Deck, action: 'play' | 'cueDown' | 'cueUp'): boolean {
    if (!this.s.on || !this.s[deck]) return false;
    const port = this.port(deck);
    if (!port) return false;
    const t = this.transports[deck];
    const name = this.deckName(deck);
    if (deck === 'a' && this.mixer?.aOnDeck?.() && action !== 'play') {
      if (action === 'cueDown')
        this.say('A’s CUE waits while it’s on its deck · cues 1–4 jump, Back ends the blend');
      return true;
    }
    if (
      deck === 'b' &&
      ['starting', 'backing', 'handing', 'loading', 'idle', 'failed'].includes(this.s.mix.phase)
    ) {
      if (action === 'cueUp') t.reset();
      else
        this.say(
          `Deck B’s transport waits: ${this.s.mix.phase === 'starting' ? 'B comes in on A’s next bar' : 'a moment'}`,
        );
      return true;
    }
    if (action === 'cueUp') {
      if (t.cueUp(port)) this.say(`Deck ${name} back to its cue`);
      return true;
    }
    if (action === 'cueDown') {
      const out = t.cueDown(port);
      if (out === 'back') this.say(`Deck ${name} back to its cue, stopped`);
      else if (out === 'held') this.say(`Deck ${name} playing from its cue while held`);
      return true;
    }
    const out = t.playPress(port);
    if (out === 'latched') this.say(`Deck ${name} plays on`);
    else if (deck === 'b')
      this.say(out === 'play' ? 'Deck B playing in the headphones' : 'Deck B paused');
    return true;
  }

  /** Whether a deck plays (its Play/Pause shows Pause then). */
  deckPlaying(deck: Deck): boolean {
    try {
      return Boolean(this.port(deck)?.playing());
    } catch {
      return false;
    }
  }

  /** A hand on a deck's platter (a press on its waveform): true when it's on. */
  grab(deck: Deck): boolean {
    if (!this.s.on || !this.s[deck] || !this.mixer?.grab) return false;
    const why = this.mixer.grab(this.deckName(deck));
    if (why) {
      if (why !== this.handWhy) this.say(why);
      this.handWhy = why;
      return false;
    }
    this.handWhy = null;
    return true;
  }

  moveHand(deck: Deck, offsetSeconds: number): void {
    this.mixer?.moveHand?.(this.deckName(deck), offsetSeconds);
  }

  letGo(deck: Deck): void {
    this.mixer?.letGo?.(this.deckName(deck));
  }

  /** ← → on a lane (held: -1 / 1; let go: 0). */
  nudge(deck: Deck, dir: -1 | 0 | 1): boolean {
    if (!this.s.on || !this.s[deck]) return false;
    if (dir === 0 && !this.nudging.has(deck)) return false;
    const ok = Boolean(this.mixer?.nudge?.(this.deckName(deck), dir));
    if (dir === 0) this.nudging.delete(deck);
    else if (ok) this.nudging.add(deck);
    return ok;
  }

  /**
   * Anything held lets go (review M-2): a nudge (← →) and a held CUE, for
   * one lane (its focus left) or both (the window lost focus, the page
   * hid), so a lost keyup never leaves a deck 4% off or playing.
   */
  releaseHeld(deck?: Deck): void {
    for (const d of deck ? [deck] : (['a', 'b'] as const)) {
      if (this.nudging.has(d)) this.nudge(d, 0);
      if (this.transports[d].held) this.transport(d, 'cueUp');
    }
  }

  private watchHeld(on: boolean): void {
    this.offHeld?.();
    this.offHeld = null;
    if (!on) return;
    const win = this.win;
    const doc = win.document;
    const all = () => this.releaseHeld();
    const hidden = () => {
      if (doc.hidden) this.releaseHeld();
    };
    win.addEventListener('blur', all);
    doc.addEventListener('visibilitychange', hidden);
    this.offHeld = () => {
      win.removeEventListener('blur', all);
      doc.removeEventListener('visibilitychange', hidden);
    };
  }

  /**
   * ← → on a focused lane: the nudge, or (under a blend, where the player's
   * ±5 s would end it) swallowed with its reason once (review L-7); outside
   * a blend the key stays the player's. True: the key was DJ mode's.
   */
  arrowKey(deck: Deck, dir: -1 | 1, repeat: boolean): boolean {
    if (repeat ? this.isNudging(deck) : this.nudge(deck, dir)) return true;
    if (!this.blending() && !this.mixer?.aOnDeck?.()) return false;
    if (!this.arrowSaid) {
      this.arrowSaid = true;
      this.say('The arrows nudge a playing deck · the player’s seek would end the blend');
    }
    return true;
  }

  /** A held arrow is nudging this deck (its repeats are the nudge's, not the player's seek). */
  isNudging(deck: Deck): boolean {
    return this.nudging.has(deck);
  }

  private deckName(deck: Deck): 'A' | 'B' {
    return deck === 'a' ? 'A' : 'B';
  }

  /**
   * A cue pressed (or 1–4). An empty one is picked (a click on the waveform
   * then places it; pressed again, the pick goes). A set one jumps its deck
   * there and nothing else (step 5, M1: a hot cue on a CDJ or in Traktor);
   * only `move` (⌥-click, or ⌥ with Enter on the button) picks a set one, so
   * the next click on the waveform moves it.
   */
  pressCue(deck: Deck, slot: number, { move = false }: { move?: boolean } = {}): void {
    const lane = this.s[deck];
    if (!this.s.on || !lane || slot < 1 || slot > 4) return;
    const cue = lane.cues[slot - 1] ?? null;
    if (!cue || move) {
      if (this.s.pick[deck] === slot) {
        this.clearPick(deck);
        return;
      }
      this.set({ pick: { ...this.s.pick, [deck]: slot } });
      this.say(
        cue
          ? cueWords('picked to move', this.deckName(deck), cue)
          : cueWords('picked', this.deckName(deck), { slot }),
      );
      return;
    }
    // a jump never leaves this cue picked: a later click can't move it by accident
    if (this.s.pick[deck] === slot) this.set({ pick: { ...this.s.pick, [deck]: null } });
    const grid = lane.phase === 'ready' ? (lane.grid?.grid ?? null) : null;
    const at = cueSeconds(cue, grid);
    const how = this.mixer?.jump?.(this.deckName(deck), at) ?? (deck === 'a' ? 'seek' : 'cue');
    if (how === 'outside') {
      this.say(`Cue ${slot} is outside deck ${this.deckName(deck)}’s 3 minutes`);
      return;
    }
    if (deck === 'b' && how === 'cue') this.setLane('b', { cue: at });
    this.say(cueWords('jumped', this.deckName(deck), cue));
  }

  /** The picked cue placed (or moved) where the waveform was clicked: on the nearest beat; the pick goes. */
  placeCue(deck: Deck, seconds: number): boolean {
    const lane = this.s[deck];
    const slot = this.s.pick[deck];
    if (!this.s.on || !lane || slot === null) return false;
    const grid =
      lane.phase === 'ready' && this.prefs.snapshot().quantize ? (lane.grid?.grid ?? null) : null;
    const had = lane.cues[slot - 1];
    const cue = cueAt(slot, seconds, grid, lane.duration ?? 0);
    const cues = withCue(lane.cues, cue);
    this.setLane(deck, { cues });
    // one place (or move) a pick: a later click can't move it again by accident (M1)
    this.set({ pick: { ...this.s.pick, [deck]: null } });
    this.saveCues(lane.track.id, cues);
    this.say(cueWords(had ? 'moved' : 'placed', this.deckName(deck), cue));
    return true;
  }

  /**
   * A refused or failed save (L1): the cues stay as placed for this visit,
   * and that's said once a track, not at every move.
   */
  /**
   * A track's cues are saved only when they were read: a save replaces all
   * of them, so one made after a failed read would lose what's stored
   * (review L-5). Said once a track.
   */
  private cuesReadable(trackId: string): boolean {
    if (!this.unreadCues.has(trackId)) return true;
    if (!this.unreadSaid.has(trackId)) {
      this.unreadSaid.add(trackId);
      this.say('This track’s cues couldn’t be read: changes here aren’t kept');
    }
    return false;
  }

  private saveCues(trackId: string, cues: CueSet): void {
    if (this.cuesReadable(trackId))
      this.cueStore.save(trackId, cues, () => this.cuesNotSaved(trackId));
  }

  private cuesNotSaved(trackId: string): void {
    if (this.unsavedSaid.has(trackId)) return;
    this.unsavedSaid.add(trackId);
    this.say('The cues couldn’t be saved: they’re kept here until the page is closed');
  }

  /** The picked cue at the playhead (Enter on the lane: placing without a pointer). */
  placeAtPlayhead(deck: Deck): boolean {
    if (this.s.pick[deck] === null) return false;
    let t: number | null;
    if (deck === 'a') t = this.player().track ? this.positionA() : null;
    else t = this.positionB() ?? this.s.b?.cue ?? null;
    return t === null ? false : this.placeCue(deck, t);
  }

  private audioTime(): number | null {
    try {
      const a = (
        this.win as Window & {
          SoulSyncPlayer?: {
            audio?: () => { currentTime: number; paused?: boolean; playbackRate?: number } | null;
          };
        }
      ).SoulSyncPlayer?.audio?.();
      // carried on between the element's steps, so lane A scrolls smoothly (step 4b)
      return a ? this.clock.read(a, this.win.performance?.now?.() ?? Date.now()) : null;
    } catch {
      return null;
    }
  }

  /** The picked cue taken off (Delete with it picked). */
  removeCue(deck: Deck): boolean {
    const lane = this.s[deck];
    const slot = this.s.pick[deck];
    if (!lane || slot === null || !lane.cues[slot - 1]) return false;
    const cues = withoutCue(lane.cues, slot);
    this.setLane(deck, { cues });
    this.saveCues(lane.track.id, cues);
    this.say(`Cue ${slot} on deck ${this.deckName(deck)} removed`);
    return true;
  }

  clearPick(deck: Deck): void {
    const slot = this.s.pick[deck];
    if (slot === null) return;
    this.set({ pick: { ...this.s.pick, [deck]: null } });
    this.say(cueWords('cleared', this.deckName(deck), { slot }));
  }

  // ── zoom (3b, 442) ─────────────────────────────────────────────────────

  zoom(deck: Deck, dir: 1 | -1 | 'whole'): void {
    if (!this.s.on || !this.s[deck]) return;
    const was = this.s.zoom[deck];
    const next = dir === 'whole' ? 'whole' : zoomStep(was, dir);
    if (next === was) return;
    this.set({ zoom: { ...this.s.zoom, [deck]: next } });
    // the level is kept for the next track and the next visit (S3)
    this.prefs.set({ zoom: { ...this.prefs.snapshot().zoom, [deck]: next } });
    this.say(`Deck ${this.deckName(deck)}: ${zoomWords(next)}`);
  }

  zoomOf(deck: Deck): ZoomLevel {
    return this.s.zoom[deck];
  }

  // ── the lane keys (3b, 37p) ────────────────────────────────────────────

  /**
   * The lane a key acts on: the focused lane (its strip included); M, L and
   * 1–4 fall back to B when B is loaded. Without either the key is the page's
   * (M mutes, L is the A–B loop).
   */
  keyDeck(focused: Deck | null, fallbackToB: boolean): Deck | null {
    if (!this.s.on) return null;
    if (focused && this.s[focused]) return focused;
    return fallbackToB && this.s.b ? 'b' : null;
  }

  /**
   * A loop or beatjump key (step 6) on a deck: the focused lane's, else B
   * when it's loaded (as M, L and 1–4: B is the deck being got ready).
   */
  loopKey(action: LoopAction, focused: Deck | null): boolean {
    const deck = this.keyDeck(focused, true);
    if (!deck || !this.mixer?.loopAction) return false;
    this.mixer.loopAction(this.deckName(deck), action);
    return true;
  }

  laneKey(k: string, focused: Deck | null): boolean {
    if (!this.s.on) return false;
    if (k === 'Q') {
      if (!this.mixer?.toggleQuantize) return false;
      this.mixer.toggleQuantize();
      return true;
    }
    const loops: Record<string, LoopAction> = {
      O: 'loop',
      '⇧O': 'reloop',
      I: 'in',
      '⇧I': 'out',
      '[': 'half',
      ']': 'double',
    };
    if (loops[k]) return this.loopKey(loops[k]!, focused);
    if (k === 'M' || k === 'L') {
      const deck = this.keyDeck(focused, true);
      if (!deck || !this.mixer) return false;
      if (k === 'M') this.mixer.togglePhones?.(this.deckName(deck));
      else this.mixer.toggleKeyLock?.(this.deckName(deck));
      return true;
    }
    if (/^[1-4]$/.test(k)) {
      const deck = this.keyDeck(focused, true);
      if (!deck) return false;
      this.pressCue(deck, Number(k));
      return true;
    }
    if (k === 'Z' || k === '-' || k === '+') {
      const deck = this.keyDeck(focused, false);
      if (!deck) return false;
      this.zoom(deck, k === 'Z' ? 'whole' : k === '+' ? 1 : -1);
      return true;
    }
    return false;
  }

  private clearLane(deck: Deck): void {
    this.gen[deck] += 1;
    this.unwatch[deck]?.();
    this.unwatch[deck] = null;
    if (this.timers[deck]) clearTimeout(this.timers[deck]!);
    this.timers[deck] = null;
    if (this.s[deck]) this.setLane(deck, null);
    this.syncAnalysisListener();
  }

  private loadLane(deck: Deck, track: LaneTrack): void {
    this.clearLane(deck);
    this.transports[deck].reset();
    const gen = this.gen[deck];
    const lane: LaneState = {
      track,
      peaks: null,
      duration: track.duration,
      grid: null,
      phase: 'loading',
      reason: null,
      info:
        track.key || track.bpm
          ? { key: track.key ?? null, bpm: track.bpm ?? null, keyUncertain: false }
          : null,
      cue: 0,
      cues: emptyCues(),
    };
    this.set(deck === 'a' ? { a: lane } : { b: lane });
    void this.loadPeaks(deck, gen, track.id, 0);
    void this.loadInfo(deck, gen, track.id);
    void this.loadGrid(deck, gen, track.id, true);
    void this.loadCues(deck, gen, track.id);
    void this.loadFine(deck, gen, track.id);
    // a new track on a lane: whole track again (442), nothing picked
    this.set({
      zoom: { ...this.s.zoom, [deck]: this.prefs.snapshot().zoom[deck] },
      pick: { ...this.s.pick, [deck]: null },
    });
  }

  private live(deck: Deck, gen: number): boolean {
    return this.gen[deck] === gen && Boolean(this.s[deck]);
  }

  private async getJson(url: string, init?: RequestInit): Promise<unknown> {
    try {
      const res = await this.f(appURL(url), init);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  private async loadPeaks(deck: Deck, gen: number, id: string, attempt: number): Promise<void> {
    let res: Response;
    try {
      res = await this.f(appURL(`/api/library/tracks/${encodeURIComponent(id)}/peaks`));
    } catch {
      return;
    }
    if (!this.live(deck, gen)) return;
    if (res.status === 202) {
      const delay = peaksDelay(attempt);
      if (delay !== null)
        this.timers[deck] = setTimeout(
          () => void this.loadPeaks(deck, gen, id, attempt + 1),
          delay,
        );
      return;
    }
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as {
      peaks?: number[] | null;
      duration_s?: number | null;
    } | null;
    if (!this.live(deck, gen) || !body) return;
    const lane = this.s[deck]!;
    this.setLane(deck, {
      peaks: Array.isArray(body.peaks) ? body.peaks : null,
      duration:
        typeof body.duration_s === 'number' && body.duration_s > 0
          ? body.duration_s
          : lane.duration,
    });
  }

  private async loadInfo(deck: Deck, gen: number, id: string): Promise<void> {
    const body = (await this.getJson('/api/library/dj/tracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_ids: [id] }),
    })) as {
      tracks?: Record<
        string,
        { bpm?: number | null; key?: string | null; key_uncertain?: boolean }
      >;
    } | null;
    if (!this.live(deck, gen)) return;
    const dj = body?.tracks?.[id];
    if (!dj) return;
    const lane = this.s[deck]!;
    this.setLane(deck, {
      info: {
        bpm: dj.bpm ?? lane.info?.bpm ?? null,
        key: dj.key ?? lane.info?.key ?? null,
        keyUncertain: Boolean(dj.key_uncertain),
      },
    });
  }

  private async loadGrid(deck: Deck, gen: number, id: string, ask: boolean): Promise<void> {
    this.gridFor[deck] = gen;
    const body = (await this.getJson(`/api/library/dj/grid/${encodeURIComponent(id)}`)) as {
      grid?: LaneApiGrid;
    } | null;
    if (this.gridFor[deck] === gen) this.gridFor[deck] = null;
    if (!this.live(deck, gen)) return;
    const api = body?.grid;
    const lane = this.s[deck]!;
    const was = lane.phase;
    if (!api) {
      this.setLane(deck, { phase: 'no_grid', reason: 'error' });
      return;
    }
    if (api.analyzed) {
      const g = laneGrid(api);
      if (!g) {
        this.setLane(deck, { phase: 'no_grid', reason: 'no_beat' });
        this.stopWatching(deck);
        return;
      }
      const problem = gridProblem(g);
      this.setLane(deck, {
        grid: g,
        phase: problem ? 'no_grid' : 'ready',
        reason: problem,
        // CUE's point when the person set one (step 4b), else B's mix-in and A's start
        cue: lane.main ? cueSeconds(lane.main, g.grid) : deck === 'b' ? cueTime(g) : 0,
      });
      this.readiness.set(id, { v: true, at: this.now() });
      this.stopWatching(deck);
      // ready: Brief A's line says "… is ready to mix" once (review L2);
      // a grid that can't be blended on is said here
      if (problem && (was === 'analysing' || was === 'waiting'))
        this.say(noGridWords(lane.track.title, problem));
      return;
    }
    const reason = api.reason ?? 'not_analyzed';
    if (PENDING_REASONS.has(reason)) {
      this.setLane(deck, { phase: this.waitingFor(id) ? 'waiting' : 'analysing', reason: null });
      if (ask && !this.asked.has(id)) {
        this.asked.add(id);
        // an ask that failed or was turned away is tried again next time (review N1);
        // the lane keeps saying it's in line meanwhile, and the sweep reaches it anyway
        const forget = () => this.asked.delete(id);
        const answer = this.analyse([id]);
        if (answer && typeof answer.then === 'function')
          answer.then((a) => {
            if (a === null) forget();
          }, forget);
      }
      this.watch(deck, id);
      return;
    }
    this.setLane(deck, { phase: 'no_grid', reason });
    this.stopWatching(deck);
    if (was === 'analysing' || was === 'waiting') this.say(noGridWords(lane.track.title, reason));
  }

  private waitingFor(id: string): boolean {
    const e = this.analysis.entry(id);
    return e?.state === 'waiting' && e.reason === 'drive_away';
  }

  private watch(deck: Deck, id: string): void {
    if (!this.unwatch[deck]) this.unwatch[deck] = this.analysis.watch([id]);
    this.syncAnalysisListener();
  }

  private stopWatching(deck: Deck): void {
    this.unwatch[deck]?.();
    this.unwatch[deck] = null;
    this.syncAnalysisListener();
  }

  /** One listener on Brief A's poll while a lane waits for its grid. */
  private syncAnalysisListener(): void {
    const wanted = Boolean(this.unwatch.a || this.unwatch.b);
    if (wanted && !this.offAnalysis)
      this.offAnalysis = this.analysis.subscribe(() => this.onAnalysis());
    else if (!wanted && this.offAnalysis) {
      this.offAnalysis();
      this.offAnalysis = null;
    }
  }

  private onAnalysis(): void {
    for (const deck of ['a', 'b'] as const) {
      const lane = this.s[deck];
      if (!lane || !this.unwatch[deck]) continue;
      const e = this.analysis.entry(lane.track.id);
      if (!e) continue;
      if (e.state === 'done' || e.state === 'failed') {
        // one read at a time: each poll before it answers doesn't ask again
        if (this.gridFor[deck] !== this.gen[deck])
          void this.loadGrid(deck, this.gen[deck], lane.track.id, false);
        continue;
      }
      const phase: LanePhase = this.waitingFor(lane.track.id) ? 'waiting' : 'analysing';
      if (phase !== lane.phase) this.setLane(deck, { phase });
    }
  }

  dispose(): void {
    this.cueStore.flush();
    this.clearLane('a');
    this.clearLane('b');
  }
}

let shared: DjModeStore | null = null;

/** The page's one store (made on first use). */
export function djModeStore(deps?: DjModeDeps): DjModeStore {
  shared ??= new DjModeStore(deps);
  return shared;
}

/** @internal tests */
export function resetDjModeStore(): void {
  shared?.dispose();
  shared = null;
}
