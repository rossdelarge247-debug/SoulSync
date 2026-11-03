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

import type { CueSet } from './dj-cues';
import type {
  Availability,
  LaneApiGrid,
  LaneGrid,
  LanePhase,
  PlayerTrackLike,
} from './dj-mode.logic';
import type { ZoomLevel } from './dj-zoom';

import { CueStore, cueAt, cueSeconds, cueWords, emptyCues, withCue, withoutCue } from './dj-cues';
import {
  cueTime,
  djAvailability,
  gridProblem,
  laneGrid,
  noGridWords,
  PENDING_REASONS,
} from './dj-mode.logic';
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
  /** B: where it's cued (its mix-in), seconds */
  cue: number;
  /** the person's cue points 1–4 on this track (3b, 439) */
  cues: CueSet;
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
  /** each lane's zoom (442), kept for the session */
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
}

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
  /** A is playing on DJ mode's deck (its element muted under it) */
  holdsTrack?(): boolean;
  /** A deck's Headphones, Key lock and jumps (3b); the session's */
  togglePhones?(deck: 'A' | 'B'): void;
  toggleKeyLock?(deck: 'A' | 'B'): void;
  jump?(deck: 'A' | 'B', seconds: number): 'seek' | 'cue' | 'jumped' | 'outside';
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
    this.s = {
      on: false,
      open: false,
      availability: { offered: false, why: 'nothing' },
      a: null,
      b: null,
      browse: false,
      mix: IDLE_MIX,
      pick: { a: null, b: null },
      zoom: { a: 'whole', b: 'whole' },
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
    const { track } = this.player();
    const id = track?.id === null || track?.id === undefined ? '' : String(track.id);
    if (track && id && id !== this.s.a?.track.id) {
      this.loadLane('a', laneTrackFromPlayer(track));
      // the player moved onto B's track: B would be the playing track itself
      if (this.s.b?.track.id === id) this.clearLane('b');
    }
  }

  setOpen(open: boolean): void {
    if (open === this.s.open) return;
    this.set({ open });
    // closing the overlay ends DJ mode, a blend with it (the hard stop: A
    // back on its element at once); step 4 keeps it on with the overlay closed (37o)
    if (!open && this.s.on) this.setOn(false);
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
      this.say('DJ mode on');
      return true;
    }
    this.browseCloser?.();
    this.mixer?.end();
    // the cues waiting to be saved go now; picks and zoom are this visit's
    this.cueStore.flush();
    this.set({ pick: { a: null, b: null }, zoom: { a: 'whole', b: 'whole' } });
    this.clearLane('a');
    this.clearLane('b');
    this.readiness.clear();
    // asked again next time DJ mode opens (review N1)
    this.asked.clear();
    this.set({ on: false });
    this.say('DJ mode off');
    return true;
  }

  toggle(): boolean {
    return this.setOn(!this.s.on);
  }

  /**
   * Back (413): with nothing loaded or B not started, at once; mid-blend
   * the fader comes back to A over one bar first, then DJ mode is off.
   */
  back(): boolean {
    if (!this.s.on) return false;
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
      was.window?.end === mix.window?.end
    )
      return;
    this.set({ mix });
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
    // said once, unless the caller says it itself (a drop's toast)
    if (announce) this.say(`${track.title || 'The track'} loaded as B, cued`);
    return true;
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

  private async loadCues(deck: Deck, gen: number, id: string): Promise<void> {
    const set = await this.cueStore.load(id);
    if (!this.live(deck, gen) || !set) return;
    this.setLane(deck, { cues: set });
  }

  private deckName(deck: Deck): 'A' | 'B' {
    return deck === 'a' ? 'A' : 'B';
  }

  /**
   * A cue pressed (or 1–4): an empty one is picked (a click on the waveform
   * then places it; pressed again, the pick goes); a set one jumps its deck
   * there and is picked, so a click moves it.
   */
  pressCue(deck: Deck, slot: number): void {
    const lane = this.s[deck];
    if (!this.s.on || !lane || slot < 1 || slot > 4) return;
    const cue = lane.cues[slot - 1] ?? null;
    if (!cue) {
      if (this.s.pick[deck] === slot) {
        this.clearPick(deck);
        return;
      }
      this.set({ pick: { ...this.s.pick, [deck]: slot } });
      this.say(cueWords('picked', this.deckName(deck), { slot }));
      return;
    }
    this.set({ pick: { ...this.s.pick, [deck]: slot } });
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

  /** The picked cue placed (or moved) where the waveform was clicked: on the nearest beat. */
  placeCue(deck: Deck, seconds: number): boolean {
    const lane = this.s[deck];
    const slot = this.s.pick[deck];
    if (!this.s.on || !lane || slot === null) return false;
    const grid = lane.phase === 'ready' ? (lane.grid?.grid ?? null) : null;
    const had = lane.cues[slot - 1];
    const cue = cueAt(slot, seconds, grid, lane.duration ?? 0);
    const cues = withCue(lane.cues, cue);
    this.setLane(deck, { cues });
    this.cueStore.save(lane.track.id, cues, () => this.say('The cues couldn’t be saved'));
    this.say(cueWords(had ? 'moved' : 'placed', this.deckName(deck), cue));
    return true;
  }

  /** The picked cue at the playhead (Enter on the lane: placing without a pointer). */
  placeAtPlayhead(deck: Deck): boolean {
    if (this.s.pick[deck] === null) return false;
    let t: number | null;
    if (deck === 'a') t = this.player().track ? this.audioTime() : null;
    else t = this.positionB() ?? this.s.b?.cue ?? null;
    return t === null ? false : this.placeCue(deck, t);
  }

  private audioTime(): number | null {
    try {
      const a = (
        this.win as Window & { SoulSyncPlayer?: { audio?: () => { currentTime: number } | null } }
      ).SoulSyncPlayer?.audio?.();
      return a ? a.currentTime : null;
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
    this.cueStore.save(lane.track.id, cues, () => this.say('The cues couldn’t be saved'));
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

  laneKey(k: string, focused: Deck | null): boolean {
    if (!this.s.on) return false;
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
    // a new track on a lane: whole track again (442), nothing picked
    this.set({
      zoom: { ...this.s.zoom, [deck]: 'whole' },
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
        cue: deck === 'b' ? cueTime(g) : 0,
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
