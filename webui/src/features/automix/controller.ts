/**
 * Auto-mix in real playback (stage C; BACKLOG "Auto-mix: beat-matched
 * transitions in Up next"; boards 26a–26j; HANDOFF "Dev, auto-mix stage C
 * of 27 October").
 *
 * The player (static/media-player.js) plays every track on its `<audio>`
 * element as it always has. With DJ mix on, for the pair that's next (the
 * playing track and the one after it, both library tracks with their
 * files), this (DJ mix is shown as Auto mix; the stored value keeps `dj`):
 *
 * 1. plans the pair (`GET /api/library/dj/plan` with the chip's style);
 * 2. about 45 s before the plan's `out.start`, fetches both tracks' grids
 *    and each deck's window, one at a time through the loader's line;
 * 3. two bars before `out.start` (the run-up), takes the outgoing track
 *    over from the element: deck A starts at the element's place on the
 *    context's clock, the element fades out under it and goes on muted,
 *    keeping time for the bar and the record; the engine mixes deck B in;
 * 4. once the mix is over and the incoming deck is back at its own speed,
 *    hands it back to the element: the player loads the incoming track and
 *    joins the deck where it is (the crossfade's own hand-off), and the
 *    decks let go of their windows.
 *
 * So the engine only ever plays a transition: every track is the player's
 * from shortly after its mix in to shortly before its mix out, with its
 * seek, scrobble, lyrics, Media Session and EQ as before. (The other way,
 * keeping the incoming track on the engine to the next transition, would
 * need the whole track decoded in the browser, 100–200 MB a deck, and
 * every one of the player's features moved onto the decks.)
 *
 * Interruptions and the listener: Pause pauses both (the context is
 * suspended and lifecycle.ts told it's the listener's, so it's no
 * interruption); a seek during the countdown cancels the mix and the
 * element plays on from where it was sent, during the mix it finishes the
 * mix over one bar; Next during the mix cuts to the incoming track where it
 * is, during the countdown it cancels and skips as always; any other load
 * (a row, Previous, a page's Play) lets the mix go; a queue edit that
 * changes the next track cancels a countdown (a mix in progress finishes
 * into its track, which is put back after the playing one if it was
 * removed); a context the system suspends cancels a countdown (the track
 * plays out straight on) and finishes a mix with a cut to the next track
 * when sound is back, and a phone's page going hidden finishes the mix
 * over one bar (executor.ts, Design's 252 and 308).
 *
 * No crossfade (Ross, 27 October: "we either mix auto or manual or
 * nothing"): a pair that can't be beat-matched takes Design's 302 move, as
 * the planner says: a cut on the outgoing track's last phrase (a `cut`
 * plan: the player starts the next track there, no decks, with the same
 * countdown and Cancel as a mix: 314), an echo out into the incoming track
 * on the decks (placed by time where the outgoing track has no grid to
 * trust), or straight on to its end with no transition (a `play_on` plan,
 * a page that can't run the decks, a mix that missed its windows). Cancel
 * plays the track out straight on, with no fallback (316); after Back the
 * next track comes in by 302's rule: a cut on the outgoing track's last
 * phrase where its grid is ready to mix, else straight on (317). A mix the
 * system cut off finishes with a cut once sound is back (308).
 *
 * Auto mix off (Between tracks: Off), a podcast, an audiobook, radio, a
 * stream, shuffle or repeat one: nothing here runs, and the player plays as
 * it always has.
 */

import type { BeatClock, Knot } from '@/features/engine/clock';
import type { DeckData, DeckReport } from '@/features/engine/engine';
import type { ApiGrid, BeatGrid } from '@/features/engine/grid';
import type { DeckId, Score } from '@/features/engine/score';

import {
  isPlaced,
  type PlacedPlan,
  type TransitionInput,
  type TransitionState,
} from '@/features/engine/executor';
import { gridFromApi, relativeTrimDb } from '@/features/engine/grid';
import { correction, onsets } from '@/features/engine/refine';
import { windowLevels, windowsFor, type Windows } from '@/features/engine/windows';

import type { AutomixPrefs } from './prefs';

import { AUTO_CHOICE, type Choice, type ChipStyle, type PairPlan } from './plans';

// ── what auto-mix reads and drives ─────────────────────────────────────────

export interface QueueTrack {
  id?: string | number | null;
  title?: string;
  artist?: string;
  album_id?: string | number | null;
  /** an album's own order (an album played from its page carries it) */
  track_number?: number | null;
  file_path?: string;
  is_library?: boolean;
  kind?: string;
  media_src?: string;
  duration?: number | null;
  image_url?: string | null;
  /** the chip chosen in Up next for the gap after this track (lasts for this
   *  queue), and the track it was chosen for (283: another next track is Auto again) */
  automix?: (Choice & { to?: string | null }) | null;
  /** queued from a set (Play as a mix): its row, the set's chip after it and
   *  the track that chip leads into; a draft's id is 0 (`draft: true`) */
  mix_set?: {
    id: number;
    name: string;
    row: number;
    transition?: Choice | null;
    next?: string | null;
    draft?: boolean;
  } | null;
}

export interface PlayerSnapshotLike {
  track: QueueTrack | null;
  kind: string | null;
  playing: boolean;
  queue: QueueTrack[];
  index: number;
  shuffle: boolean;
  repeat: string;
  volume: number;
  muted: boolean;
  crossfading?: boolean;
  crossfadeSeconds?: number;
  playbackRate?: number;
  /** the sleep timer: minutes, or 'track' (pause at the end of this one) */
  sleep?: number | 'track';
  /**
   * the playing track ended and its advance went to auto-mix or was turned
   * away by a load in flight (media-player.js's `onAudioEnded`): the next
   * track is owed. Never set by a stop meant at the end (the sleep timer).
   */
  advanceOwed?: boolean;
}

export interface CrossfadeHint {
  skip?: boolean;
  startAt?: number;
  inAt?: number;
  gain?: number;
  seconds?: number;
}

export interface HandoffLike {
  readonly currentTime: number;
  pause(): void;
  src: string;
  volume: number;
}

export interface PlayerPort {
  state(): PlayerSnapshotLike;
  audio(): HTMLAudioElement | null;
  playIndex(
    index: number,
    options: { handoff?: HandoffLike; automix?: boolean },
  ): Promise<{ status: string } | undefined>;
  insertNext(track: QueueTrack): number;
  /** move a queued row to straight after the playing one; its new index */
  moveNext?(index: number): number;
  renderQueue(): void;
}

export interface TransitionLike {
  state(): TransitionState;
  cancel(): void;
  finishNow(bars?: number): void;
  back(): void;
  readonly beatClock: BeatClock;
  readonly score: Score;
}

export interface EngineLike {
  readonly context: BaseAudioContext;
  readonly sampleRate: number;
  readonly graph: { master: GainNode };
  load(deck: DeckId, data: DeckData): void;
  unload(deck: DeckId): void;
  play(deck: DeckId, at: number, from: number, rate?: number): void;
  stop(deck: DeckId, atFrame: number): void;
  position(deck: DeckId, at?: number): number | null;
  current(deck: DeckId): Knot[];
  report(deck: DeckId): { frame: number; report: DeckReport } | null;
  mix(input: TransitionInput): TransitionLike;
  setPaused(on: boolean): void;
}

export interface AutomixServices {
  /** the pair's plan; `fresh` asks the server again rather than a kept answer */
  plan(
    from: string,
    to: string,
    choice: Choice,
    lean: AutomixPrefs['lean'],
    fresh?: boolean,
  ): Promise<PairPlan>;
  grids(ids: string[]): Promise<Record<string, ApiGrid>>;
  window(ctx: BaseAudioContext, id: string, start: number, dur: number): Promise<DeckData>;
  /** the engine on the player's audio graph (made once), or null where it can't be */
  engine(): Promise<EngineLike | null>;
  prefs(): AutomixPrefs;
  /** why this page can't run the decks (support.ts), or null */
  support?: () => string | null;
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(id: unknown): void;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(id: unknown): void;
  };
}

// ── what the chips and the handover view read ──────────────────────────────

export type Stage =
  | 'idle'
  | 'planned'
  | 'loading'
  | 'ready'
  | 'counting'
  | 'mixing'
  | 'settling'
  | 'handback'
  | 'back'
  | 'rejoin'
  /** a pair that can't be beat-matched and has no grid going out: the
   *  player cuts on the bar (no decks) */
  | 'cut';

export interface Lane {
  /** 0–1 levels, one per step of the ruler */
  levels: Float32Array;
}

export interface HandoverLanes {
  /** the ruler, in master beats from the mix's start (φ): from φ0 to φ1 */
  phi0: number;
  phi1: number;
  /** the window: 0 to beats */
  beats: number;
  /** a marker (the bass swap, the drop) */
  marker: { beat: number; label: string } | null;
  a: Lane;
  b: Lane;
}

export interface AutomixView {
  /** DJ mix applies to the playing pair (the setting, or a set played as a mix) */
  dj: boolean;
  stage: Stage;
  /** the pair that's next, while there is one */
  pair: {
    fromId: string;
    toId: string;
    fromTitle: string;
    fromArtist: string;
    toTitle: string;
    toArtist: string;
    toIndex: number;
    choice: Choice;
    fromSet: QueueTrack['mix_set'] | null;
  } | null;
  plan: PairPlan | null;
  planError: string | null;
  /** why the windows didn't load (the track then plays on) */
  loadError: string | null;
  /** seconds to `out.start` (the first chip's "in 2:58") */
  inSeconds: number | null;
  /** where the mix starts, in the playing track's seconds (the waveform's cyan marker) */
  outStart: number | null;
  /** the countdown, in bars (Mix now, or the last 16 bars before an automatic mix or cut: 314) */
  barsToGo: number | null;
  /** the listener's Cancel called this pair's mix off: it plays out straight on (316) */
  cancelled: boolean;
  manual: boolean;
  transition: TransitionState | null;
  /** where the ruler's playhead is (φ), while it mixes */
  phi: number | null;
  lanes: HandoverLanes | null;
  canMixNow: boolean;
  mixNowWhy: string | null;
  /**
   * UX-9: a mix that couldn't start (the decks didn't load, too near the
   * end, no grid going out): why, said in the bar and the tray with Try
   * again, and the track plays on straight. Null otherwise.
   */
  failed: string | null;
  /** the incoming deck's tempo change against its own (26d: "124.0 (−1.6%)") */
  incomingBpm: { bpm: number; pct: number } | null;
  /** why this page can't run the decks (support.ts), or null */
  unsupported: string | null;
}

const EMPTY_VIEW: AutomixView = {
  dj: false,
  stage: 'idle',
  pair: null,
  plan: null,
  planError: null,
  loadError: null,
  inSeconds: null,
  outStart: null,
  barsToGo: null,
  cancelled: false,
  manual: false,
  transition: null,
  phi: null,
  lanes: null,
  canMixNow: false,
  mixNowWhy: null,
  failed: null,
  incomingBpm: null,
  unsupported: null,
};

// ── timings ────────────────────────────────────────────────────────────────

/** windows are fetched this long before the mix starts (seconds) */
export const PRELOAD_S = 45;
/** the decks take over this many bars before the mix starts (the run-up) */
export const LEAD_BARS = 2;
/** and the window for deck A starts this many bars before (room for a late tick) */
const PREROLL_BARS = 4;
/** an automatic mix counts down over its last 16 bars (26e) */
const COUNTDOWN_BARS = 16;
/** Mix now waits at least this long for the windows (seconds) */
const MIX_NOW_LEAD_S = 6;
/** the hand-over fades between the element and a deck (seconds) */
const FADE_S = 0.08;
/** how far ahead the decks start, past the context's time */
const AHEAD_S = 0.12;
const TICK_MS = 120;
/** a cut on the bar is set this long ahead, on a timer, rather than by the tick */
const CUT_LOOKAHEAD_S = 2;
/** past its cut point by this much, a cut doesn't happen: the track plays on (H1) */
const CUT_LATE_S = 0.25;
/** a cut timer that fires late (a busy page, a faster rate) still cuts up to this late */
const CUT_LATE_TIMER_S = 1;
/**
 * The last line of defence for the queue (Ross's report of 28 October): the
 * playing track's element has ended, the player says the next track is
 * owed (its own 'ended' advance went to auto-mix, or a load turned it away:
 * `advanceOwed`), the decks hold nothing and nothing moved on after this
 * long: the next track is started here. A stop meant at the end (the sleep
 * timer's end of track) never owes one (the gauntlet review's H1).
 */
export const STALLED_END_MS = 1500;

// ── helpers ────────────────────────────────────────────────────────────────

const PER = { same: 1, half: 0.5, double: 2 } as const;

function idOf(t: QueueTrack | null | undefined): string {
  return t && t.id !== null && t.id !== undefined ? String(t.id) : '';
}

/** A library track with its file: what a deck can play. */
export function mixable(t: QueueTrack | null | undefined): boolean {
  if (!t || !idOf(t) || !t.file_path || t.media_src) return false;
  return !t.kind || t.kind === 'library';
}

/**
 * The chip for the gap after a track: Up next's choice, else its set's,
 * else Auto. A chip describes a pair (283): once the next track changes
 * (a reorder, an insert, a removal) it's Auto's pick again, whoever chose it.
 */
export function choiceOf(
  t: QueueTrack | null | undefined,
  next?: QueueTrack | null | undefined,
): Choice {
  const nextId = next === undefined ? null : idOf(next);
  const mine = t?.automix;
  if (mine?.style && (next === undefined || !mine.to || mine.to === nextId))
    return { style: mine.style as ChipStyle, bars: mine.bars ?? null };
  const set = t?.mix_set;
  const own = set?.transition;
  if (own?.style && (next === undefined || !set?.next || set.next === nextId))
    return { style: own.style as ChipStyle, bars: own.bars ?? null };
  return AUTO_CHOICE;
}

/** Two rows of a set played as a mix, one after the other: DJ mix for this play (28e). */
export function playedAsMix(from: QueueTrack, to: QueueTrack): boolean {
  return Boolean(
    from.mix_set &&
    to.mix_set &&
    from.mix_set.id === to.mix_set.id &&
    to.mix_set.row > from.mix_set.row,
  );
}

/** The rate a deck's map has at a frame. */
export function rateAt(knots: readonly Knot[], frame: number): number | null {
  if (!knots.length || frame < knots[0].f) return null;
  let k = knots[0];
  for (const kn of knots) {
    if (kn.f <= frame) k = kn;
    else break;
  }
  return k.r;
}

/**
 * Mix now (26a, 26e): the plan moved to the outgoing track's next phrase
 * that leaves time for the windows, its length shortened to what the track
 * has left. Null when there isn't room for even two bars.
 */
export function mixNowPlan(
  plan: PairPlan,
  gridA: BeatGrid,
  phrases: ApiGrid['phrases'],
  position: number,
  duration: number,
  lead = MIX_NOW_LEAD_S,
): (PairPlan & PlacedPlan) | null {
  if (!isPlaced(plan)) return null;
  const earliest = position + lead;
  const barOf = (t: number) => Math.ceil((gridA.beatAt(t) - gridA.downbeatIndex) / 4 - 1e-6);
  let bar: number | null = null;
  for (const ph of phrases ?? []) {
    if (ph.time >= earliest) {
      bar = ph.bar;
      break;
    }
  }
  if (bar === null) {
    // past the analysed phrases: the next bar on the line of eights
    bar = Math.max(0, barOf(earliest));
    bar = Math.ceil(bar / 8) * 8;
  }
  const start = gridA.barTime(bar);
  const barS = gridA.barTime(bar + 1) - start;
  const left = (duration > 0 ? duration : Infinity) - start - 1;
  const wanted = plan.bars ?? 0;
  let bars = wanted;
  if (wanted > 0) {
    bars = 0;
    for (const n of [wanted, 32, 16, 8, 4, 2]) {
      if (n <= wanted && n * barS <= left) {
        bars = n;
        break;
      }
    }
    if (!bars) return null;
  } else if (left < barS) return null;
  return {
    ...plan,
    bars: wanted > 0 ? bars : plan.bars,
    out: { ...plan.out, start, bar, end: gridA.barTime(bar + bars), end_bar: bar + bars },
  };
}

/**
 * 317 (and 302): where the outgoing track's last phrase is, for the cut
 * after Back: the last phrase line at or before the end of its mix-out
 * region, on a grid that's ready to mix (a steady beat, 4/4) and whose
 * ending was analysed. Null otherwise: the track plays straight on.
 */
export function lastPhraseCut(api: ApiGrid | null | undefined): number | null {
  if (!api?.analyzed || api.truncated) return null;
  const g = gridFromApi(api);
  const conf = api.grid?.confidence ?? 0;
  const meter = api.downbeats?.meter ?? '4/4';
  const end = api.mix_out?.end_bar;
  if (!g || conf < 0.5 || meter !== '4/4' || end == null) return null;
  const phrases = (api.phrases ?? []).filter((ph) => ph.bar <= end);
  if (!phrases.length) return null;
  const last = phrases[phrases.length - 1].bar;
  // the phrases carry on every 8 bars past the last one listed
  const bar = last + 8 * Math.floor((end - last) / 8);
  return bar > 0 ? g.barTime(bar) : null;
}

interface Decks {
  A: DeckData;
  B: DeckData;
  w: Windows;
  gridA: BeatGrid | null;
  gridB: BeatGrid | null;
  fix?: (phi: number) => number;
  levelsA: Float32Array;
  levelsB: Float32Array;
  trimDb: number;
}

interface Pending {
  key: string;
  from: QueueTrack;
  to: QueueTrack;
  fromId: string;
  toId: string;
  choice: Choice;
  forced: boolean;
  plan: PairPlan | null;
  planning: boolean;
  planError: string | null;
  /** a track it waited for was analysed: the next plan is asked afresh */
  replan?: boolean;
  /** the plan the decks play: the planner's, or Mix now's */
  effective: PairPlan | null;
  grids: Record<string, ApiGrid> | null;
  decks: Decks | null;
  loading: boolean;
  loadError: string | null;
  manual: boolean;
  /** Mix now pressed before the plan came */
  wantNow: boolean;
  cancelled: boolean;
  missed: string | null;
  wentBack: boolean;
  /** a cut on the bar (a `cut` plan) was set for this pair */
  cutSet: boolean;
  /** the listener sought past the cut point (a timer that's merely late still cuts) */
  soughtPast?: boolean;
  /** each cut timer's number: only the newest acts */
  cutGen?: number;
  /** the playback rate the cut's wait was worked out at */
  cutRate?: number;
  /** 302's echo out by time, placed on the element's own length (M1) */
  byTime?: { base: PairPlan; dur: number; plan: PairPlan & PlacedPlan };
}

// ── the controller ─────────────────────────────────────────────────────────

export class AutomixController {
  private readonly player: PlayerPort;
  private readonly svc: AutomixServices;
  private readonly timers: NonNullable<AutomixServices['timers']>;
  private pending: Pending | null = null;
  private engine: EngineLike | null = null;
  private transition: TransitionLike | null = null;
  private stage: Stage = 'idle';
  private ticker: unknown = null;
  /** our own pauses, plays and seeks on the element (its events are ours, not the listener's) */
  private own = 0;
  private paused = false;
  private handing = false;
  private released = true;
  private lanes: HandoverLanes | null = null;
  private master = 0;
  private view: AutomixView = EMPTY_VIEW;
  private readonly listeners = new Set<() => void>();
  private boundEl: HTMLAudioElement | null = null;
  /**
   * Every timeout and fade the decks' hand-overs start, and the session
   * they belong to: letting go clears them all and moves the session on,
   * so a late one can never mute the element over the next track
   * (gauntlet H1).
   */
  private readonly timeouts = new Set<unknown>();
  private readonly intervals = new Set<unknown>();
  private session = 0;

  constructor(player: PlayerPort, services: AutomixServices) {
    this.player = player;
    this.svc = services;
    this.timers = services.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    };
  }

  // ── the view ──

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getView(): AutomixView {
    return this.view;
  }

  private signature = '';

  /** Tell the views, when what they draw has changed (the tick is 120 ms; most say nothing new). */
  private emit(): void {
    const next = this.buildView();
    const t = next.transition;
    const sig = [
      next.dj,
      next.stage,
      next.pair?.fromId,
      next.pair?.toId,
      next.pair?.toIndex,
      next.pair?.choice.style,
      next.pair?.choice.bars,
      next.plan ? 1 : 0,
      next.plan?.status,
      next.plan?.out?.start,
      next.planError,
      next.loadError,
      next.inSeconds === null ? '' : Math.round(next.inSeconds),
      next.outStart,
      next.barsToGo,
      next.cancelled,
      next.manual,
      t?.phase,
      t?.bar,
      t ? Math.round(t.secondsLeft) : '',
      t?.canGoBack,
      next.phi === null ? '' : Math.round(next.phi * 8),
      next.lanes ? 1 : 0,
      next.canMixNow,
      next.mixNowWhy,
      next.incomingBpm ? next.incomingBpm.bpm.toFixed(1) : '',
      next.unsupported,
    ].join('|');
    if (sig === this.signature && next.plan === this.view.plan && next.lanes === this.view.lanes)
      return;
    this.signature = sig;
    this.view = next;
    for (const fn of this.listeners) fn();
  }

  // ── running ──

  private started = false;

  /** Start listening (the host calls it once). */
  start(): void {
    this.started = true;
    this.tick();
  }

  stop(): void {
    this.started = false;
    this.stopTicker();
    this.letGo();
    this.unbind();
  }

  /** The player said something changed (`ss:player`). */
  poke(): void {
    this.tick();
  }

  /**
   * A track finished its analysis (analyse on demand): a plan that was
   * waiting for it is asked again, so the pair can be mixed after all.
   */
  replanWaiting(): void {
    const p = this.pending;
    if (p && p.plan?.status === 'waiting' && !p.planning) {
      p.plan = null;
      p.planError = null;
      p.replan = true;
    }
    this.tick();
  }

  /**
   * The 120 ms tick runs only while it has something to watch: DJ mix on, a
   * set played as a mix in the queue, or the decks holding a mix (L3).
   * Otherwise the player's own events ('ss:player') are enough.
   */
  private wantTicks(): boolean {
    if (!this.started) return false;
    if (!this.released || this.transition) return true;
    if (this.svc.prefs().between === 'dj') return true;
    return this.player.state().queue.some((t) => t?.mix_set);
  }

  private keepTicking(): void {
    if (this.wantTicks()) {
      if (this.ticker === null) this.ticker = this.timers.setInterval(() => this.tick(), TICK_MS);
    } else this.stopTicker();
  }

  private stopTicker(): void {
    if (this.ticker !== null) this.timers.clearInterval(this.ticker);
    this.ticker = null;
  }

  /** A timeout of this session's: cleared when the decks let go, and never run after. */
  private later(fn: () => void, ms: number): void {
    const session = this.session;
    const id = this.timers.setTimeout(() => {
      this.timeouts.delete(id);
      if (session !== this.session) return;
      fn();
    }, ms);
    this.timeouts.add(id);
  }

  /** An interval of this session's (a fade): the same. */
  private every(fn: (stop: () => void) => void, ms: number): void {
    const session = this.session;
    const id = this.timers.setInterval(() => {
      if (session !== this.session) {
        stop();
        return;
      }
      fn(stop);
    }, ms);
    const stop = () => {
      this.timers.clearInterval(id);
      this.intervals.delete(id);
    };
    this.intervals.add(id);
  }

  private clearTimers(): void {
    for (const id of this.timeouts) this.timers.clearTimeout(id);
    for (const id of this.intervals) this.timers.clearInterval(id);
    this.timeouts.clear();
    this.intervals.clear();
    this.session++;
  }

  /**
   * The last line of defence (H1): whenever the decks aren't holding a mix,
   * the element is the player's, so it's never left muted or faded out.
   */
  private freeElement(): void {
    if (this.engineOwns() && !this.released) return;
    const el = this.player.audio();
    if (!el) return;
    if (el.muted) el.muted = false;
    if (this.fadedOut && el.volume < this.level()) el.volume = this.level();
    this.fadedOut = false;
  }

  /** the element was faded down by a hand-over (its volume is put back with it) */
  private fadedOut = false;

  private bind(el: HTMLAudioElement | null): void {
    if (el === this.boundEl) return;
    this.unbind();
    this.boundEl = el;
    if (!el) return;
    el.addEventListener('pause', this.onPause);
    el.addEventListener('play', this.onPlay);
    el.addEventListener('seeking', this.onSeeking);
    el.addEventListener('loadstart', this.onLoad);
    el.addEventListener('emptied', this.onLoad);
  }

  private unbind(): void {
    const el = this.boundEl;
    if (!el) return;
    el.removeEventListener('pause', this.onPause);
    el.removeEventListener('play', this.onPlay);
    el.removeEventListener('seeking', this.onSeeking);
    el.removeEventListener('loadstart', this.onLoad);
    el.removeEventListener('emptied', this.onLoad);
    this.boundEl = null;
  }

  /** The decks are playing what's heard (or about to). */
  engineOwns(): boolean {
    return (
      this.transition !== null &&
      (this.stage === 'counting' ||
        this.stage === 'mixing' ||
        this.stage === 'settling' ||
        this.stage === 'handback' ||
        this.stage === 'back' ||
        this.stage === 'rejoin')
    );
  }

  /** media-player.js's 'ended' and crossfade leave the advance to us. */
  ownsAdvance(): boolean {
    return this.engineOwns() || this.handing;
  }

  private pairNow(
    st: PlayerSnapshotLike,
  ): { from: QueueTrack; to: QueueTrack; toIndex: number } | null {
    if (!st.track || (st.kind && st.kind !== 'library')) return null;
    // shuffle picks at the end, repeat one loops, and the sleep timer's end
    // of track pauses there: nothing to mix into
    if (st.shuffle || st.repeat === 'one' || st.sleep === 'track') return null;
    const i = st.index;
    if (i < 0 || i >= st.queue.length - 1) return null;
    const from = st.queue[i];
    const to = st.queue[i + 1];
    if (!mixable(from) || !mixable(to)) return null;
    return { from, to, toIndex: i + 1 };
  }

  private djFor(from: QueueTrack, to: QueueTrack): { on: boolean; forced: boolean } {
    const forced = playedAsMix(from, to);
    return { on: forced || this.svc.prefs().between === 'dj', forced };
  }

  private tick(): void {
    const el = this.player.audio();
    this.bind(el);
    this.keepTicking();
    this.freeElement();
    this.followVolume();
    if (this.engineOwns()) {
      this.tickEngine();
      this.emit();
      return;
    }
    const st = this.player.state();
    const pair = this.pairNow(st);
    if (this.unstick(el, pair, st.advanceOwed === true)) return;
    const dj = pair ? this.djFor(pair.from, pair.to) : { on: false, forced: false };
    if (!pair || !dj.on) {
      if (this.pending) this.pending = null;
      this.stage = 'idle';
      this.emit();
      return;
    }
    const prefs = this.svc.prefs();
    const choice = choiceOf(pair.from, pair.to);
    const key = [idOf(pair.from), idOf(pair.to), choice.style, choice.bars ?? 0, prefs.lean].join(
      '|',
    );
    if (!this.pending || this.pending.key !== key || this.pending.from !== pair.from) {
      this.pending = {
        key,
        from: pair.from,
        to: pair.to,
        fromId: idOf(pair.from),
        toId: idOf(pair.to),
        choice,
        forced: dj.forced,
        plan: null,
        planning: false,
        planError: null,
        effective: null,
        grids: null,
        decks: null,
        loading: false,
        loadError: null,
        manual: false,
        wantNow: false,
        cancelled: false,
        missed: null,
        wentBack: false,
        cutSet: false,
      };
    }
    const p = this.pending;
    // the pair's object is the queue's (an edit that moved it keeps it)
    p.to = pair.to;
    if (!p.plan) {
      if (!p.planning && !p.planError) void this.fetchPlan(p);
      this.stage = 'planned';
      this.emit();
      return;
    }
    // a cut on the bar (no grid going out, its BPM known): the player itself
    // ends the outgoing track there and starts the next; no decks, no fade
    if (p.plan.status === 'cut') {
      this.stage = 'cut';
      const at = (p.effective ?? p.plan).out?.start;
      // the rate changed while the cut waits: its wait is worked out again
      if (p.cutSet && el && (el.playbackRate || 1) !== p.cutRate && at != null) {
        p.cutSet = false;
        if (el.currentTime < at + CUT_LATE_S) this.setCut(p, at);
      }
      const armedCut = p.manual || p.forced || prefs.auto;
      if (armedCut && !p.cancelled && !p.missed && !p.cutSet && el && !el.paused && at != null) {
        // past its cut point (a plan that came late: Play next, Add to Up
        // next, a reorder, Auto mix turned on in the tail; or a seek into the
        // outro): never a cut at once, the track plays out straight on
        // (step 2's review H1); a seek back before it arms it again
        if (el.currentTime >= at + CUT_LATE_S) p.missed = 'past the cut';
        else if (el.currentTime >= at - CUT_LOOKAHEAD_S) this.setCut(p, at);
      }
      this.emit();
      return;
    }
    this.stage = p.decks ? 'ready' : p.loading ? 'loading' : 'planned';
    // 317: after Back the next track comes in by 302's rule, never a
    // crossfade: a cut on the outgoing track's last phrase where its grid is
    // ready to mix, else straight on
    if (p.wentBack && !p.cancelled && !p.cutSet && el && !el.paused) {
      const at = lastPhraseCut(p.grids?.[p.fromId]);
      if (at !== null && el.currentTime < at && el.currentTime >= at - CUT_LOOKAHEAD_S)
        this.setCut(p, at);
    }
    // a page that can't run the decks: every pair plays on (Ross: no
    // crossfade), and Mix now says why
    const unsupported = this.svc.support?.() ?? null;
    if (unsupported && p.plan.status === 'ok' && !p.missed) p.missed = unsupported;
    if (p.plan.status !== 'ok' || p.cancelled || p.missed || p.wentBack || !el) {
      this.emit();
      return;
    }
    const armed = p.manual || p.forced || prefs.auto;
    // a plan without its places (waiting) has nothing to arm
    const plan = this.placedPlan(p);
    if (!plan) {
      this.emit();
      return;
    }
    const outStart = plan.out.start;
    if (!armed || outStart == null || el.paused || (el.playbackRate ?? 1) !== 1) {
      this.emit();
      return;
    }
    const pos = el.currentTime;
    if (pos >= outStart - PRELOAD_S && !p.decks && !p.loading && !p.loadError) void this.preload(p);
    const lead = this.leadSeconds(p);
    if (pos >= outStart - lead) {
      if (p.decks && pos <= outStart - 0.3) this.takeOver(p);
      else if (p.loadError || pos > outStart - 0.3) {
        p.missed = p.loadError ?? "the tracks didn't load in time";
      }
    }
    this.emit();
  }

  /** when the playing track's element was first seen ended, with the decks holding nothing */
  private endedAt: { from: QueueTrack; at: number } | null = null;

  /**
   * The element ended and nothing moved the queue on (STALLED_END_MS): the
   * player's own next track, whatever the plan (play on, a missed mix or
   * cut, Cancel, a plan that failed). True when it acted.
   */
  private unstick(
    el: HTMLAudioElement | null,
    pair: { from: QueueTrack; to: QueueTrack; toIndex: number } | null,
    owed: boolean,
  ): boolean {
    if (!el || !el.ended || !owed || this.handing || !pair || !this.started) {
      this.endedAt = null;
      return false;
    }
    const now = Date.now();
    if (!this.endedAt || this.endedAt.from !== pair.from) {
      this.endedAt = { from: pair.from, at: now };
      return false;
    }
    if (now - this.endedAt.at < STALLED_END_MS) return false;
    this.endedAt = null;
    this.pending = null;
    this.stage = 'idle';
    void Promise.resolve()
      .then(() => this.player.playIndex(pair.toIndex, {}))
      .catch(() => undefined);
    this.emit();
    return true;
  }

  private barSeconds(p: Pending): number {
    const g = gridFromApi(p.grids?.[p.fromId]);
    if (g) return 4 * g.period;
    const bpm = p.plan?.tempo?.from_bpm;
    return bpm ? (4 * 60) / bpm : 2;
  }

  private leadSeconds(p: Pending): number {
    return Math.max(3, LEAD_BARS * this.barSeconds(p));
  }

  private async fetchPlan(p: Pending): Promise<void> {
    p.planning = true;
    try {
      const fresh = p.replan === true;
      p.replan = false;
      const lean = this.svc.prefs().lean;
      const plan = fresh
        ? await this.svc.plan(p.fromId, p.toId, p.choice, lean, true)
        : await this.svc.plan(p.fromId, p.toId, p.choice, lean);
      if (this.pending !== p) return;
      p.plan = plan;
      if (p.wantNow) {
        p.wantNow = false;
        this.mixNow();
      }
    } catch (e) {
      if (this.pending === p) p.planError = e instanceof Error ? e.message : String(e);
    } finally {
      p.planning = false;
      if (this.pending === p) this.emit();
    }
  }

  private async preload(p: Pending): Promise<void> {
    p.loading = true;
    this.emit();
    try {
      const engine = await this.ensureEngine();
      if (!engine) throw new Error("this browser can't mix two tracks");
      if (!p.grids) p.grids = await this.svc.grids([p.fromId, p.toId]);
      if (this.pending !== p) return;
      const gridA = gridFromApi(p.grids[p.fromId]);
      const gridB = gridFromApi(p.grids[p.toId]);
      const plan = this.placedPlan(p);
      if (!plan) throw new Error('the plan has no place for the mix');
      const w = windowsFor(plan, gridA, gridB, PREROLL_BARS);
      const A = await this.svc.window(engine.context, p.fromId, w.a.start, w.a.dur);
      if (this.pending !== p) return;
      const B = await this.svc.window(engine.context, p.toId, w.b.start, w.b.dur);
      if (this.pending !== p) return;
      let fix: ((phi: number) => number) | undefined;
      if (
        plan.beatmatch &&
        gridA &&
        gridB &&
        plan.out.bar != null &&
        plan.in.bar != null &&
        plan.bars
      ) {
        const a0 = gridA.barBeat(plan.out.bar);
        const b0 = gridB.barBeat(plan.in.bar);
        const per = PER[plan.tempo?.relation ?? 'same'];
        const beats = plan.bars * 4;
        try {
          fix = correction(
            onsets(A, gridA, a0 - 2, a0 + beats + 2),
            onsets(B, gridB, b0 - 2, b0 + beats * per + 2),
            { from: 0, to: beats },
            (phi) => a0 + phi,
            (phi) => b0 + phi * per,
          );
        } catch {
          fix = undefined;
        }
      }
      p.decks = {
        A,
        B,
        w,
        gridA,
        gridB,
        fix,
        levelsA: windowLevels(A),
        levelsB: windowLevels(B),
        trimDb: relativeTrimDb(p.grids[p.fromId] ?? null, p.grids[p.toId] ?? null),
      };
    } catch (e) {
      if (this.pending === p) p.loadError = e instanceof Error ? e.message : String(e);
    } finally {
      p.loading = false;
      if (this.pending === p && !this.engineOwns()) {
        this.stage = p.decks ? 'ready' : 'planned';
        this.emit();
      }
    }
  }

  private async ensureEngine(): Promise<EngineLike | null> {
    if (this.engine) return this.engine;
    const engine = await this.svc.engine();
    if (engine) {
      engine.graph.master.gain.value = 0;
      this.master = 0;
    }
    this.engine = engine;
    return engine;
  }

  /** The player's level for the decks (the element's volume, linear). */
  private level(): number {
    const st = this.player.state();
    return st.muted ? 0 : Math.max(0, Math.min(1, (st.volume ?? 70) / 100));
  }

  private followVolume(): void {
    const engine = this.engine;
    if (!engine || this.released) return;
    if (!['counting', 'mixing', 'settling', 'back'].includes(this.stage)) return;
    const want = this.level();
    if (Math.abs(want - this.master) < 0.005) return;
    const g = engine.graph.master.gain;
    const now = engine.context.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(this.master, now);
    g.linearRampToValueAtTime(want, now + 0.05);
    this.master = want;
  }

  private fadeMaster(to: number, at: number, seconds: number): void {
    const g = this.engine!.graph.master.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(this.master, at);
    g.linearRampToValueAtTime(to, at + seconds);
    this.master = to;
  }

  /** The element's volume, faded over FADE_S (then muted, or not). */
  private fadeElement(el: HTMLAudioElement, from: number, to: number, after?: () => void): void {
    const steps = 6;
    let n = 0;
    el.volume = Math.max(0, Math.min(1, from));
    this.every(
      (stop) => {
        n++;
        el.volume = Math.max(0, Math.min(1, from + ((to - from) * n) / steps));
        if (n >= steps) {
          stop();
          after?.();
        }
      },
      (FADE_S * 1000) / steps,
    );
  }

  /** Two bars before the mix: the decks take the outgoing track over. */
  private takeOver(p: Pending): void {
    const engine = this.engine;
    const el = this.player.audio();
    const d = p.decks;
    if (!engine || !el || !d) return;
    const ctx = engine.context;
    const plan = this.placedPlan(p);
    if (!plan) {
      p.missed = 'the plan has no place for the mix';
      return;
    }
    const T = ctx.currentTime + AHEAD_S;
    const from = el.currentTime + AHEAD_S;
    if (from < d.w.a.start || from > d.w.a.start + d.w.a.dur - 1) {
      p.missed = "the tracks didn't load in time";
      return;
    }
    engine.load('A', d.A);
    engine.load('B', d.B);
    this.released = false;
    engine.play('A', T, from, 1);
    this.master = 0;
    this.fadeMaster(this.level(), T, FADE_S);
    const level = this.level();
    let mixing: TransitionLike | null = null;
    // only while this mix holds the decks (H1): never after a Next, a row,
    // a station or a failed start
    const ours = () => !this.released && mixing !== null && this.transition === mixing;
    this.later(
      () => {
        if (!ours()) return;
        this.fadedOut = true;
        this.fadeElement(el, level, 0, () => {
          if (!ours()) {
            this.freeElement();
            return;
          }
          // the element goes on, muted: it keeps time for the bar and the record
          el.muted = true;
          el.volume = level;
          this.fadedOut = false;
        });
      },
      Math.max(0, (T - ctx.currentTime) * 1000),
    );
    const t0 = T + ((plan.out.start ?? from) - from);
    try {
      mixing = engine.mix({
        plan,
        from: 'A',
        to: 'B',
        gridA: d.gridA,
        gridB: d.gridB,
        t0,
        trimDb: d.trimDb,
        correction: d.fix,
      });
      this.transition = mixing;
    } catch (e) {
      // nothing scheduled: the element carries on, unmuted, at its level
      this.clearTimers();
      engine.unload('A');
      engine.unload('B');
      this.released = true;
      this.transition = null;
      this.fadedOut = true;
      this.freeElement();
      p.missed = e instanceof Error ? e.message : String(e);
      return;
    }
    this.lanes = this.buildLanes(p, this.transition, d, from);
    this.stage = 'counting';
  }

  private tickEngine(): void {
    const t = this.transition;
    const engine = this.engine;
    const p = this.pending;
    if (!t || !engine || !p) return;
    if (this.handing || this.stage === 'rejoin') return;
    // the player isn't on the outgoing track any more (a station, a stream,
    // something that didn't go through the queue): the decks let go (H2)
    const now = this.player.state();
    if (!now.track || idOf(now.track) !== p.fromId || (now.kind && now.kind !== 'library')) {
      this.hardStop();
      return;
    }
    const s = t.state();
    if (s.phase === 'counting') {
      this.stage = 'counting';
      // the next track changed under the countdown, or DJ mix went off: cancel
      const st = this.player.state();
      const pair = this.pairNow(st);
      const still =
        pair && pair.to === p.to && pair.from === p.from && this.djFor(pair.from, pair.to).on;
      if (!still) {
        p.cancelled = true;
        this.cancelCountdown(t);
        return;
      }
      // the outgoing window ran out before the mix (a shorter file than its analysis)
      if (engine.report('A')?.report.ended) t.finishNow(1);
      return;
    }
    if (s.phase === 'mixing' || s.phase === 'interrupted' || s.phase === 'yours') {
      this.stage = 'mixing';
      return;
    }
    if (s.phase === 'cancelled') {
      void this.rejoin(false);
      return;
    }
    if (s.phase === 'back') {
      this.stage = 'back';
      p.wentBack = true;
      if (s.secondsLeft > 0) return;
      const r = rateAt(engine.current('A'), engine.context.currentTime * engine.sampleRate);
      if (r === null || Math.abs(r - 1) < 1e-3) void this.rejoin(true);
      return;
    }
    if (s.phase === 'done') {
      this.stage = 'settling';
      const now = engine.context.currentTime;
      const r = rateAt(engine.current('B'), now * engine.sampleRate);
      const pos = engine.position('B');
      const w = p.decks?.w.b;
      const nearEnd = pos !== null && w ? pos > w.start + w.dur - 8 : false;
      if (r === null || Math.abs(r - 1) < 1e-3 || nearEnd) void this.handBack();
    }
  }

  /** The mix is over: the player takes the incoming track from deck B where it is. */
  private async handBack(): Promise<void> {
    if (this.handing) return;
    const engine = this.engine;
    const p = this.pending;
    const el = this.player.audio();
    if (!engine || !p) return;
    this.handing = true;
    this.stage = 'handback';
    this.emit();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const now = engine.context.currentTime;
      this.fadeMaster(0, now + 0.01, 0.06);
      engine.stop('B', Math.round((now + 0.1) * engine.sampleRate));
      engine.stop('A', Math.round((now + 0.1) * engine.sampleRate));
      this.later(() => this.letGo(), 200);
    };
    const handoff: HandoffLike = {
      get currentTime() {
        return engine.position('B') ?? 0;
      },
      pause: stop,
      get src() {
        return '';
      },
      set src(_v: string) {
        /* the deck's source is its window */
      },
      get volume() {
        return 1;
      },
      set volume(_v: number) {
        /* the deck's level is the master's */
      },
    };
    const idx = this.placeIncoming(p);
    this.own++;
    try {
      if (el) {
        el.pause();
        el.muted = false;
      }
    } finally {
      this.own--;
    }
    this.own++;
    let result: { status: string } | undefined;
    try {
      result = await this.player.playIndex(idx, { handoff, automix: true });
    } catch {
      result = { status: 'failed' };
    } finally {
      this.own--;
    }
    if (!stopped && result?.status !== 'played') {
      // the player moved on some other way (another load superseded it, a
      // failed load skips on): the deck stops now, not over what plays
      stop();
    }
  }

  /**
   * Where the incoming track is, straight after the playing one (M1): moved
   * there if an edit moved it, found by its id in the next few rows if it
   * was removed and added again, put back only when it's gone.
   */
  private placeIncoming(p: Pending): number {
    const st = this.player.state();
    const next = st.index + 1;
    if (st.queue[next] === p.to) return next;
    let at = st.queue.indexOf(p.to);
    if (at < 0) {
      for (let i = next; i < Math.min(st.queue.length, next + 4); i++) {
        if (idOf(st.queue[i]) === p.toId) {
          at = i;
          break;
        }
      }
    }
    if (at < 0) return this.player.insertNext(p.to);
    if (at === next) return next;
    const moved = this.player.moveNext ? this.player.moveNext(at) : at;
    return moved >= 0 ? moved : at;
  }

  /**
   * Back to the outgoing track on the element: after a Cancel (the element
   * is where deck A is: unmute it under a short crossfade), or after Back
   * (the deck moved with the mix's tempo: the element is sent just ahead and
   * started as the deck gets there).
   */
  private async rejoin(precise: boolean): Promise<void> {
    if (this.stage === 'rejoin') return;
    const engine = this.engine;
    const el = this.player.audio();
    this.stage = 'rejoin';
    this.emit();
    if (!engine || !el) {
      this.letGo(true);
      return;
    }
    const level = this.level();
    const session = this.session;
    // let go of meanwhile (a Next, a station): nothing more to do here
    const gone = () => session !== this.session;
    this.own++;
    try {
      if (precise) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const a = engine.position('A');
          if (a === null) break;
          const target = a + 0.6 + attempt * 0.6;
          el.pause();
          el.currentTime = target;
          await seeked(el, 1500, this.timers);
          if (gone()) return;
          const now = engine.position('A');
          if (now === null) break;
          const wait = target - now - 0.03;
          if (wait < 0) continue;
          await new Promise<void>((r) => this.timers.setTimeout(r, Math.min(3000, wait * 1000)));
          if (gone()) return;
          break;
        }
        el.volume = 0;
        el.muted = false;
        await el.play().catch(() => undefined);
        if (gone()) return;
      } else {
        el.volume = 0;
        el.muted = false;
      }
      this.fadeElement(el, 0, level);
      const now = engine.context.currentTime;
      this.fadeMaster(0, now + 0.01, FADE_S);
      engine.stop('A', Math.round((now + FADE_S + 0.05) * engine.sampleRate));
      engine.stop('B', Math.round((now + FADE_S + 0.05) * engine.sampleRate));
    } finally {
      this.own--;
    }
    this.later(() => this.letGo(true), 250);
  }

  /** Let the decks go (their windows with them); `keep` keeps the pair's flags. */
  private letGo(keep = false): void {
    this.clearTimers();
    const engine = this.engine;
    if (engine && !this.released) {
      try {
        engine.graph.master.gain.cancelScheduledValues(0);
        engine.graph.master.gain.value = 0;
      } catch {
        /* a closed context */
      }
      engine.unload('A');
      engine.unload('B');
    }
    if (this.paused) {
      engine?.setPaused(false);
      this.paused = false;
      // the context was suspended for a Pause: whatever plays next needs it
      const ctx = engine?.context as AudioContext | undefined;
      if (ctx && typeof ctx.resume === 'function') void ctx.resume().catch(() => undefined);
    }
    this.master = 0;
    this.released = true;
    this.transition = null;
    this.lanes = null;
    this.handing = false;
    this.freeElement();
    if (keep && this.pending) this.pending.decks = null;
    else this.pending = null;
    this.stage = 'idle';
    this.emit();
  }

  // ── the listener's actions ──

  /** Mix now (26a, X): into the next track from the outgoing track's next phrase. */
  mixNow(): boolean {
    if (this.engineOwns()) return false;
    const st = this.player.state();
    const pair = this.pairNow(st);
    if (!pair) return false;
    if (!this.pending || this.pending.from !== pair.from || this.pending.to !== pair.to)
      this.tick();
    const p = this.pending;
    if (!p) return false;
    p.cancelled = false;
    p.missed = null;
    p.wentBack = false;
    p.manual = true;
    if (!p.plan) {
      p.wantNow = true;
      this.emit();
      return true;
    }
    const el = this.player.audio();
    if (!el) return false;
    if (p.plan.status === 'cut') {
      // a cut: on the outgoing track's next phrase line when its grid is
      // ready to mix, counted down as a mix's; else now (no decks needed)
      void this.cutOnNextPhrase(p, el);
      this.emit();
      return true;
    }
    if (p.plan.status !== 'ok') {
      // waiting, or a pair that plays on: nothing to mix (never a crossfade)
      p.manual = false;
      this.emit();
      return false;
    }
    void this.armNow(p, el);
    return true;
  }

  private async armNow(p: Pending, el: HTMLAudioElement): Promise<void> {
    try {
      if (!p.grids) p.grids = await this.svc.grids([p.fromId, p.toId]);
    } catch (e) {
      p.loadError = e instanceof Error ? e.message : String(e);
      this.emit();
      return;
    }
    if (this.pending !== p) return;
    const gridA = gridFromApi(p.grids[p.fromId]);
    const placed = this.placedPlan(p);
    if (placed && placed.out.bar == null) {
      // 302's echo out, placed by time (no grid going out to trust): now,
      // once the windows are in, never on a bar counted on a guess
      const start = el.currentTime + MIX_NOW_LEAD_S;
      const left = Number.isFinite(el.duration) ? el.duration - start : Infinity;
      if (left < 1) {
        p.missed = 'too near the end to mix';
        this.emit();
        return;
      }
      p.effective = { ...placed, out: { ...placed.out, start, end: start } };
      p.decks = null;
      p.loadError = null;
      this.emit();
      void this.preload(p);
      return;
    }
    if (!gridA) {
      p.missed = 'the track going out has no beat grid';
      this.emit();
      return;
    }
    const moved = mixNowPlan(
      p.plan!,
      gridA,
      p.grids[p.fromId]?.phrases,
      el.currentTime,
      Number.isFinite(el.duration) ? el.duration : 0,
    );
    if (!moved) {
      // no room left for a mix: the track plays on to its end (no crossfade)
      p.missed = 'too near the end to mix';
      this.emit();
      return;
    }
    p.effective = moved;
    p.decks = null;
    p.loadError = null;
    this.emit();
    void this.preload(p);
  }

  /** Mix now on a `cut` plan (step 2's review): the next phrase line ahead, else now. */
  private async cutOnNextPhrase(p: Pending, el: HTMLAudioElement): Promise<void> {
    p.cutSet = false;
    // the automatic cut's timer, if set, is let go (re-review)
    p.cutGen = (p.cutGen ?? 0) + 1;
    try {
      if (!p.grids) p.grids = await this.svc.grids([p.fromId, p.toId]);
    } catch {
      /* no grid to hand: cut now */
    }
    if (this.pending !== p) return;
    const api = p.grids?.[p.fromId];
    const gridA = gridFromApi(api);
    const ready =
      gridA && (api?.grid?.confidence ?? 0) >= 0.5 && (api?.downbeats?.meter ?? '4/4') === '4/4';
    const plan = p.effective ?? p.plan;
    const moved =
      ready && isPlaced(plan)
        ? mixNowPlan(
            plan,
            gridA,
            api?.phrases,
            el.currentTime,
            Number.isFinite(el.duration) ? el.duration : 0,
            CUT_LOOKAHEAD_S + 1,
          )
        : null;
    if (moved) {
      p.effective = moved;
      this.tick();
      return;
    }
    this.setCut(p, el.currentTime);
    this.emit();
  }

  /** A countdown on the decks is called off: the element takes over again where it is. */
  private cancelCountdown(t: TransitionLike): void {
    t.cancel();
    if (t.state().phase === 'cancelled') void this.rejoin(false);
  }

  /** The countdown's Cancel (26e): the track plays out, as without DJ mix. */
  cancel(): void {
    const p = this.pending;
    if (!p) return;
    p.cancelled = true;
    p.manual = false;
    if (this.transition && this.stage === 'counting') this.cancelCountdown(this.transition);
    this.emit();
  }

  /** Finish now (26d): the rest of the handover over one bar. */
  finishNow(): void {
    const phase = this.transition?.state().phase;
    if (this.transition && (phase === 'mixing' || phase === 'counting'))
      this.transition.finishNow(1);
    this.emit();
  }

  /** Back to the outgoing track over one bar (26d, Design's 251). */
  back(): void {
    if (!this.transition || this.stage !== 'mixing') return;
    if (!this.transition.state().canGoBack) return;
    this.transition.back();
    if (this.pending) this.pending.wentBack = true;
    this.emit();
  }

  /** Next while mixing cuts to the incoming track where it is; true when it acted. */
  next(): boolean {
    if (!this.transition) return false;
    if (this.stage === 'mixing' || this.stage === 'settling') {
      void this.handBack();
      return true;
    }
    if (this.stage === 'counting') {
      if (this.pending) this.pending.cancelled = true;
      this.hardStop();
    }
    return false;
  }

  /** Previous, a row, a page's Play: the decks let go at once, the element is the player's again. */
  previous(): void {
    if (this.engineOwns()) this.hardStop();
  }

  beforeLoad(_index: number, options?: { automix?: boolean }): void {
    if (options?.automix) return;
    if (this.engineOwns() || this.handing) this.hardStop();
    else if (this.pending) this.pending = null;
  }

  private hardStop(): void {
    const engine = this.engine;
    if (engine && !this.released) {
      const now = engine.context.currentTime;
      this.fadeMaster(0, now + 0.005, 0.04);
      engine.stop('A', Math.round((now + 0.06) * engine.sampleRate));
      engine.stop('B', Math.round((now + 0.06) * engine.sampleRate));
    }
    const el = this.player.audio();
    if (el) {
      el.muted = false;
      el.volume = this.level();
    }
    this.fadedOut = false;
    this.letGo();
  }

  /**
   * Other audio than the queue's next row is loading (a station, a stream,
   * a podcast, Stop: media-player.js's loaders say so): the decks let go
   * at once (H2). auto-mix's own hand-back is ignored here.
   */
  otherAudio(): void {
    if (this.handing) return;
    if (this.transition || !this.released) this.hardStop();
    else if (this.pending) this.pending = null;
  }

  /** X (24a): Mix now, when DJ mix is on and there's a pair it can mix. */
  key(k: string): boolean {
    if (k.toUpperCase() !== 'X') return false;
    if (!this.view.canMixNow) return false;
    return this.mixNow();
  }

  // ── the element's events ──

  private readonly onPause = () => {
    const el = this.boundEl;
    if (this.own || !el || el.ended || !this.engineOwns() || this.handing) return;
    // Pause pauses both (26d): the context stops; it's the listener's, not an interruption
    const engine = this.engine!;
    this.paused = true;
    engine.setPaused(true);
    const ctx = engine.context as AudioContext;
    if (typeof ctx.suspend === 'function') void ctx.suspend().catch(() => undefined);
    this.emit();
  };

  private readonly onPlay = () => {
    this.freeElement();
    if (this.own || !this.paused) return;
    const engine = this.engine;
    if (!engine) return;
    const ctx = engine.context as AudioContext;
    const done = () => {
      this.paused = false;
      engine.setPaused(false);
      this.emit();
    };
    if (typeof ctx.resume === 'function') void ctx.resume().then(done, done);
    else done();
  };

  /** The element loads something no one told us about while the decks hold a mix (H2). */
  private readonly onLoad = () => {
    if (this.own || this.handing) return;
    if (this.transition && !this.released) this.hardStop();
  };

  private readonly onSeeking = () => {
    if (this.own) return;
    const p = this.pending;
    if (this.transition && this.stage === 'counting') {
      // a seek during the countdown: the mix is cancelled, the element plays
      // on from where it was sent (the rejoin unmutes it there)
      if (p) p.decks = null;
      this.cancelCountdown(this.transition);
      return;
    }
    if (this.transition && this.stage === 'mixing') {
      this.transition.finishNow(1);
      return;
    }
    const el = this.boundEl;
    if (p && el && !this.engineOwns()) {
      const out = (p.effective ?? p.plan)?.out?.start;
      if ((p.effective ?? p.plan)?.status === 'cut' && out != null) {
        // a cut needs no windows: any seek back before its point arms it
        // again, a seek past it is the listener's (re-review)
        p.soughtPast = el.currentTime >= out + CUT_LATE_S;
        if (el.currentTime < out) {
          p.missed = null;
          p.cutSet = false;
        }
        return;
      }
      // sent back before the mix: it can happen again
      if (out != null && el.currentTime < out - this.leadSeconds(p) - 1) {
        p.missed = null;
        p.wentBack = false;
      }
    }
  };

  // ── the player's crossfade: never (Ross, 27 October) ──

  /**
   * There's no crossfade any more, and media-player.js no longer asks: with
   * Auto mix the decks mix, a cut ends the track on its bar, or the track
   * plays to its end; Off is plain playback. Kept on the window API, null.
   */
  crossfade(_current: QueueTrack | null, _next: QueueTrack | null): CrossfadeHint | null {
    return null;
  }

  /**
   * A `cut` plan: at `at` (the outgoing track's seconds) the player starts
   * the next track. Set once a pair, a moment ahead, on the session's own
   * timer, so a Next, a row or a seek in between lets it go. The wait is
   * in the track's seconds at its playback rate; a pause, a seek back or a
   * slower rate in between sets it again on the tick when it comes round.
   */
  private setCut(p: Pending, at: number): void {
    const el = this.player.audio();
    if (!el) return;
    p.cutSet = true;
    const rate = el.playbackRate && el.playbackRate > 0 ? el.playbackRate : 1;
    p.cutRate = rate;
    const gen = (p.cutGen = (p.cutGen ?? 0) + 1);
    const wait = Math.max(0, ((at - el.currentTime) / rate) * 1000);
    this.later(() => {
      if (this.pending !== p || p.cancelled) return;
      // set again since (Mix now moved the cut to the next phrase, the rate
      // changed): this timer is the old cut's (step 2's re-review)
      if (gen !== p.cutGen) return;
      const st = this.player.state();
      const toIndex = st.queue.indexOf(p.to);
      const now = this.player.audio();
      if (toIndex < 0 || !now || idOf(st.queue[st.index]) !== p.fromId) return;
      if (now.paused || now.currentTime < at - 0.25) {
        // paused, sought back, or slower than it was: set it again on the
        // tick once it plays on and comes round
        p.cutSet = false;
        return;
      }
      if (
        (p.soughtPast && now.currentTime >= at + CUT_LATE_S) ||
        now.currentTime >= at + CUT_LATE_TIMER_S
      ) {
        // sought past the cut point meanwhile (H1), or so late it's no cut
        // on the phrase any more: straight on. Merely late (a busy page, a
        // faster rate) it still cuts (re-review)
        p.cutSet = false;
        p.missed = 'past the cut';
        this.emit();
        return;
      }
      void this.player.playIndex(toIndex, { automix: true });
    }, wait);
  }

  /**
   * The pair's plan with its places, or null (a waiting plan has none). 302's
   * echo out by time (`out.bar` null) sits a second before the element's
   * own end once it's known: the library's duration can be wrong (step 2's
   * review M1).
   */
  private placedPlan(p: Pending): (PairPlan & PlacedPlan) | null {
    const plan = p.effective ?? p.plan;
    if (!isPlaced(plan)) return null;
    if (!p.effective && plan.status === 'ok' && plan.out.bar == null) {
      const el = this.player.audio();
      const dur = el && Number.isFinite(el.duration) && el.duration > 2 ? el.duration : null;
      if (dur !== null && Math.abs(dur - 1 - (plan.out.start ?? 0)) > 0.05) {
        // the same object while nothing changes, so the views aren't told anew
        if (p.byTime?.base !== plan || p.byTime.dur !== dur) {
          const start = Math.max(0, dur - 1);
          p.byTime = {
            base: plan,
            dur,
            plan: { ...plan, out: { ...plan.out, start, end: start } },
          };
        }
        return p.byTime.plan;
      }
    }
    return plan;
  }

  // ── the view ──

  private buildLanes(
    p: Pending,
    t: TransitionLike,
    d: Decks,
    takenAt: number,
  ): HandoverLanes | null {
    const clock = t.beatClock;
    const beats = t.score.beats;
    const T = clock.timeAt(0);
    // from the run-up to two bars past the window
    const ctxNow = this.engine?.context.currentTime ?? T;
    const phi0 = Math.min(-8, Math.floor(clock.beatAt(ctxNow)) - 1);
    const phi1 = Math.max(beats, 4) + 8;
    const n = 160;
    const step = 0.05;
    const levelsA = new Float32Array(n);
    const levelsB = new Float32Array(n);
    const plan = this.placedPlan(p);
    if (!plan) return null;
    const per = PER[plan.tempo?.relation ?? 'same'];
    const gA = d.gridA;
    const gB = d.gridB;
    const outStart = plan.out.start ?? takenAt;
    for (let i = 0; i < n; i++) {
      const phi = phi0 + ((phi1 - phi0) * (i + 0.5)) / n;
      // each deck's own place at that beat (from its grid, else seconds at its rate)
      let posA: number;
      let posB: number;
      if (t.state().beatmatch && gA && gB && plan.out.bar != null && plan.in.bar != null) {
        posA = gA.timeAt(gA.barBeat(plan.out.bar) + phi);
        posB = gB.timeAt(gB.barBeat(plan.in.bar) + phi * per);
      } else {
        const secs = clock.timeAt(phi) - T;
        posA = outStart + secs;
        posB = plan.in.start + secs;
      }
      const ia = Math.floor((posA - d.w.a.start) / step);
      const ib = Math.floor((posB - d.w.b.start) / step);
      levelsA[i] = ia >= 0 && ia < d.levelsA.length ? d.levelsA[ia] : 0;
      levelsB[i] = ib >= 0 && ib < d.levelsB.length && phi >= 0 ? d.levelsB[ib] : 0;
    }
    return {
      phi0,
      phi1,
      beats,
      marker: t.score.marker,
      a: { levels: levelsA },
      b: { levels: levelsB },
    };
  }

  private buildView(): AutomixView {
    const p = this.pending;
    const st = this.player.state();
    const el = this.player.audio();
    const pair = p
      ? {
          fromId: p.fromId,
          toId: p.toId,
          fromTitle: p.from.title ?? '',
          fromArtist: p.from.artist ?? '',
          toTitle: p.to.title ?? '',
          toArtist: p.to.artist ?? '',
          toIndex: st.queue.indexOf(p.to),
          choice: p.choice,
          fromSet: p.from.mix_set ?? null,
        }
      : null;
    const plan = p ? (this.placedPlan(p) ?? p.effective ?? p.plan) : null;
    // a mix's start, or a cut's (302): both count down (314)
    const outStart =
      plan?.status === 'ok' || plan?.status === 'cut' ? (plan.out?.start ?? null) : null;
    const pos = el ? el.currentTime : 0;
    const t = this.transition;
    const ts = t ? t.state() : null;
    let inSeconds: number | null = null;
    let barsToGo: number | null = null;
    const prefs = this.svc.prefs();
    if (p && outStart !== null && !p.cancelled && !p.missed && !p.wentBack) {
      if (ts && (ts.phase === 'counting' || this.stage === 'counting')) {
        inSeconds = ts.secondsLeft;
      } else if (!t) inSeconds = Math.max(0, outStart - pos);
      if (inSeconds !== null && (p.manual || p.forced || prefs.auto)) {
        const bars = Math.ceil(inSeconds / this.barSeconds(p) - 1e-6);
        if (p.manual || bars <= COUNTDOWN_BARS) barsToGo = Math.max(0, bars);
      }
    }
    let phi: number | null = null;
    if (t && this.engine) phi = t.beatClock.beatAt(this.engine.context.currentTime);
    const dj = Boolean(p);
    let canMixNow = false;
    let mixNowWhy: string | null = null;
    const unsupported = this.svc.support?.() ?? null;
    if (!dj) mixNowWhy = prefs.between === 'dj' ? 'Nothing up next to mix into' : 'Auto mix is off';
    // a cut needs no decks: Mix now cuts on the phrase even where they can't run
    else if (unsupported && plan?.status !== 'cut') mixNowWhy = unsupported;
    else if (this.engineOwns()) mixNowWhy = 'Mixing now';
    else if (!el || el.paused) mixNowWhy = 'Play first';
    else {
      canMixNow = true;
    }
    let incomingBpm: AutomixView['incomingBpm'] = null;
    const toBpm = plan?.tempo?.to_bpm;
    if (ts?.rates && toBpm) {
      incomingBpm = { bpm: toBpm * ts.rates.in, pct: (ts.rates.in - 1) * 100 };
    }
    return {
      dj,
      stage: this.stage,
      pair,
      plan,
      planError: p?.planError ?? null,
      loadError: p?.loadError ?? null,
      inSeconds,
      outStart,
      barsToGo,
      cancelled: Boolean(p?.cancelled),
      manual: Boolean(p?.manual),
      transition: ts,
      phi,
      lanes: this.lanes,
      canMixNow,
      mixNowWhy,
      // a seek past a cut and a page that can't run the decks say so elsewhere
      failed:
        p &&
        !p.cancelled &&
        !p.wentBack &&
        p.missed &&
        p.missed !== 'past the cut' &&
        p.missed !== unsupported
          ? p.missed
          : null,
      incomingBpm,
      unsupported: this.svc.support?.() ?? null,
    };
  }
}

function seeked(
  el: HTMLAudioElement,
  ms: number,
  timers: NonNullable<AutomixServices['timers']>,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('seeked', finish);
      resolve();
    };
    el.addEventListener('seeked', finish);
    timers.setTimeout(finish, ms);
  });
}
