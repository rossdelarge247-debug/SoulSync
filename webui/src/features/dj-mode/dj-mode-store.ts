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
 * - a track without its grid is asked for at once (`source: 'dj_now'`, the
 *   on-demand path, core/dj/ondemand.py) and watched through Brief A's one
 *   poll (analysis.api.ts); the grid is read again when it lands (420).
 */
import type { AnalysisEntry } from '@/features/dj/analysis.api';
import type { DragItem } from '@/features/dnd/dnd-model';

import { analysisStore, requestAnalysis } from '@/features/dj/analysis.api';
import { liveSay } from '@/features/dnd/dnd-engine';
import { appURL } from '@/platform/url-base';

import type {
  Availability,
  LaneApiGrid,
  LaneGrid,
  LanePhase,
  PlayerTrackLike,
} from './dj-mode.logic';

import { cueTime, djAvailability, gridProblem, laneGrid, PENDING_REASONS } from './dj-mode.logic';

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
}

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
  analyse?: (ids: string[]) => void;
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
  private readonly analyse: (ids: string[]) => void;
  private readonly analysis: AnalysisLike;
  private readonly phone: () => boolean;
  private readonly libraryAway: () => boolean;
  private readonly sayFn: (words: string) => void;
  /** each load's generation: an answer for an older load is dropped */
  private gen: Record<Deck, number> = { a: 0, b: 0 };
  private unwatch: Record<Deck, (() => void) | null> = { a: null, b: null };
  private timers: Record<Deck, ReturnType<typeof setTimeout> | null> = { a: null, b: null };
  private browseOpener: (() => void) | null = null;
  private offAnalysis: (() => void) | null = null;
  /** the grid lookups for a drag's drop line (37c): true has a grid, false not yet */
  private readiness = new Map<string, boolean | 'asking'>();

  constructor(deps: DjModeDeps = {}) {
    this.win = deps.win ?? window;
    this.f = deps.fetch ?? ((url, init) => this.win.fetch(url, init));
    this.analyse =
      deps.analyse ??
      ((ids) => {
        // a person opened DJ mode or loaded B: their ask, said as DJ mode's
        requestAnalysis(ids, { reason: 'asked', source: 'dj_now' }).catch(() => {
          /* the lane keeps saying it's in line; the sweep reaches it anyway */
        });
      });
    this.analysis = deps.analysis ?? analysisStore;
    this.phone = deps.phone ?? (() => Boolean(this.win.matchMedia?.(PHONE_QUERY).matches));
    this.libraryAway = deps.libraryAway ?? (() => false);
    this.sayFn = deps.say ?? ((w) => liveSay(w));
    this.s = {
      on: false,
      open: false,
      availability: { offered: false, why: 'nothing' },
      a: null,
      b: null,
      browse: false,
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
    // closing the overlay is Back (step 2: nothing is ever blending)
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
    this.clearLane('a');
    this.clearLane('b');
    this.set({ on: false });
    this.say('DJ mode off');
    return true;
  }

  toggle(): boolean {
    return this.setOn(!this.s.on);
  }

  /** Back (413): with nothing loaded or nothing started, at once. */
  back(): boolean {
    if (!this.s.on) return false;
    return this.setOn(false);
  }

  // ── Browse (step 3) ────────────────────────────────────────────────────

  /**
   * Step 3's Browse registers its opener here; until then the lane draws no
   * Browse… button and B is the page's key (step 2 hides Browse behind this,
   * rather than drawing a button that does nothing).
   */
  setBrowseOpener(open: (() => void) | null): void {
    this.browseOpener = open;
    this.set({ browse: Boolean(open) });
  }

  openBrowse(): boolean {
    if (!this.s.on || !this.browseOpener) return false;
    this.browseOpener();
    return true;
  }

  // ── lane B ─────────────────────────────────────────────────────────────

  /** Load a track into lane B: shown with its waveform and data, cued, not played (step 3 plays it). */
  loadB(item: DragItem | LaneTrack): boolean {
    if (!this.s.on) return false;
    const track = 'image' in item ? item : laneTrackFromItem(item);
    if (!track.id || track.id === this.playingId()) return false;
    this.loadLane('b', track);
    return true;
  }

  removeB(): void {
    if (!this.s.b) return;
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
    if (known === true || known === false) return known;
    if (known === 'asking') return null;
    const entry = this.analysis.entry(id);
    if (entry && typeof entry.ready === 'boolean') {
      this.readiness.set(id, entry.ready);
      return entry.ready;
    }
    this.readiness.set(id, 'asking');
    void this.getJson(`/api/library/dj/grid/${encodeURIComponent(id)}`).then((body) => {
      const g = (body as { grid?: LaneApiGrid } | null)?.grid;
      this.readiness.set(id, Boolean(g?.analyzed));
      onKnown();
    });
    return null;
  }

  // ── loading a lane ─────────────────────────────────────────────────────

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
    };
    this.set(deck === 'a' ? { a: lane } : { b: lane });
    void this.loadPeaks(deck, gen, track.id, 0);
    void this.loadInfo(deck, gen, track.id);
    void this.loadGrid(deck, gen, track.id, true);
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
    const body = (await this.getJson(`/api/library/dj/grid/${encodeURIComponent(id)}`)) as {
      grid?: LaneApiGrid;
    } | null;
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
      this.readiness.set(id, true);
      this.stopWatching(deck);
      if (was === 'analysing' || was === 'waiting')
        this.say(`${lane.track.title || 'The track'} analysed`);
      return;
    }
    const reason = api.reason ?? 'not_analyzed';
    if (PENDING_REASONS.has(reason)) {
      this.setLane(deck, { phase: this.waitingFor(id) ? 'waiting' : 'analysing', reason: null });
      if (ask) this.analyse([id]);
      this.watch(deck, id);
      return;
    }
    this.setLane(deck, { phase: 'no_grid', reason });
    this.stopWatching(deck);
    if (was === 'analysing' || was === 'waiting')
      this.say(`${lane.track.title || 'The track'} analysed`);
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
        void this.loadGrid(deck, this.gen[deck], lane.track.id, false);
        continue;
      }
      const phase: LanePhase = this.waitingFor(lane.track.id) ? 'waiting' : 'analysing';
      if (phase !== lane.phase) this.setLane(deck, { phase });
    }
  }

  dispose(): void {
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
