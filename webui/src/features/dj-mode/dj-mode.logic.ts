/**
 * DJ mode (Brief F, 37a–37q), the part that is only logic: when the toggle
 * is offered, the beat map's ticks, numbers and regions from a track's grid,
 * the line under a lane in words (its text equivalent), a lane's state while
 * its grid is worked out, what a drop on lane B would do, and the words the
 * header and the announcements use.
 *
 * Nothing here touches the page; dj-mode-store.ts and the lanes use it.
 */
import type { DragItem } from '@/features/dnd/dnd-model';
import type { ApiGrid } from '@/features/engine/grid';

import { camelotParts } from '@/features/dj/key-colour';
import { pyRound, tempoStep, wheelSteps } from '@/features/dnd/dnd-model';
import { BeatGrid, gridFromApi } from '@/features/engine/grid';

/* ── the toggle (37a, 37l, 37q; 417, 425) ─────────────────────────────── */

/** The player's track as `SoulSyncPlayer.state().track` has it. */
export interface PlayerTrackLike {
  id?: string | number | null;
  title?: string | null;
  artist?: string | null;
  filename?: string | null;
  file_path?: string | null;
  is_library?: boolean | null;
  is_preview?: boolean | null;
  download_pending?: boolean | null;
  image_url?: string | null;
  duration?: number | null;
  kind?: string | null;
}

export type Unoffered =
  /** 417: never on a phone, not even disabled */
  | 'phone'
  | 'nothing'
  /** radio, a podcast, an audiobook, a stream, a Spotify row, a 30-second preview */
  | 'not_library'
  /** a library track whose file is away (its drive isn't connected) */
  | 'file_away';

export interface Availability {
  offered: boolean;
  why: Unoffered | null;
}

/**
 * Is DJ mode offered (425: always, on a laptop or desktop, for a library
 * track with its file; not behind the mixing setting)? Off, nothing is drawn:
 * no disabled button to explain.
 */
export function djAvailability({
  track,
  kind,
  phone,
  libraryAway = false,
}: {
  track: PlayerTrackLike | null | undefined;
  kind: string | null | undefined;
  phone: boolean;
  libraryAway?: boolean;
}): Availability {
  if (phone) return { offered: false, why: 'phone' };
  if (!track) return { offered: false, why: 'nothing' };
  const k = kind ?? track.kind ?? (track.is_library ? 'library' : 'stream');
  const id = track.id;
  if (
    k !== 'library' ||
    !track.is_library ||
    track.is_preview ||
    track.download_pending ||
    id === null ||
    id === undefined ||
    id === ''
  )
    return { offered: false, why: 'not_library' };
  if (!(track.filename || track.file_path) || libraryAway)
    return { offered: false, why: 'file_away' };
  return { offered: true, why: null };
}

/* ── a lane's grid (CONTRACTS "Auto-mix stage A": GET /api/library/dj/grid/<id>) ── */

export interface GridRegion {
  start_bar: number;
  end_bar: number;
  start: number;
  end: number;
  bars?: number;
  confidence?: number;
  how?: string | null;
}

export interface GridSection {
  kind: string;
  start_bar: number;
  end_bar: number;
  start: number;
  end: number;
  confidence?: number;
}

/** The grid route's answer as the lanes read it: the engine's shape, plus sections and mix-in. */
export type LaneApiGrid = Omit<ApiGrid, 'mix_out'> & {
  sections?: GridSection[];
  mix_in?: GridRegion | null;
  mix_out?: GridRegion | null;
  beat_confidence?: number;
};

/** A lane's grid, ready to draw. */
export interface LaneGrid {
  grid: BeatGrid;
  bpm: number | null;
  /** bars from the first downbeat */
  bars: number;
  sections: GridSection[];
  mixIn: GridRegion | null;
  mixOut: GridRegion | null;
  meter: string;
  /** the beat grid is sure enough to beat-match on */
  confident: boolean;
  /** only the first part was analysed (a long file) */
  truncated: boolean;
  /** how far the analysis read (a long file: its first part), seconds */
  analysedS: number | null;
  /** the analysed loudness (Auto-gain, step 5) */
  loudness: { replaygain_db: number | null; level_db: number | null } | null;
}

export function laneGrid(api: LaneApiGrid | null | undefined): LaneGrid | null {
  const grid = gridFromApi(api as ApiGrid | null | undefined);
  if (!grid || !api) return null;
  const bars = Math.max(0, Math.floor(Number(api.bars) || 0));
  return {
    grid,
    bpm: typeof api.bpm === 'number' ? api.bpm : null,
    bars,
    sections: (api.sections ?? []).filter(
      (s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    ),
    mixIn: api.mix_in ?? null,
    mixOut: api.mix_out ?? null,
    meter: api.downbeats?.meter ?? '4/4',
    confident: api.grid?.confident !== false,
    truncated: Boolean(api.truncated),
    analysedS: typeof api.analysed_s === 'number' && api.analysed_s > 0 ? api.analysed_s : null,
    loudness: api.loudness
      ? {
          replaygain_db: api.loudness.replaygain_db ?? null,
          level_db: api.loudness.level_db ?? null,
        }
      : null,
  };
}

/* ── the beat map (37b: 22px, a tick a bar, 14px every 8, a number every 32) ── */

/** What part of the track the lane shows, in seconds (zoom, 3b, narrows it; whole by default). */
export interface LaneView {
  start: number;
  end: number;
}

export interface BeatTick {
  /** 1-based, as the line says it */
  bar: number;
  /** 0–1 across the lane */
  x: number;
  /** the start of a phrase: every 8 bars (14px; 6px otherwise) */
  phrase: boolean;
  /** every 32 bars: 1, 33, 65, … */
  label: number | null;
}

export interface MapSpan {
  x0: number;
  x1: number;
}

export interface BeatMapLayout {
  bars: number;
  /**
   * A long file only had its first part analysed: where that part ends,
   * across the lane; the ticks after it follow the grid on (CONTRACTS: a
   * constant grid runs on past the analysed part), marked as such.
   */
  analysedTo: number | null;
  ticks: BeatTick[];
  /** the mix-in and mix-out regions (dashed amber) */
  mixIn: MapSpan | null;
  mixOut: MapSpan | null;
  /** the sections strip (18px) */
  sections: (MapSpan & { kind: string })[];
}

export const PHRASE_BARS = 8;
export const LABEL_BARS = 32;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function spanOf(start: number, end: number, view: LaneView): MapSpan | null {
  const w = view.end - view.start;
  if (!(w > 0)) return null;
  const x0 = (start - view.start) / w;
  const x1 = (end - view.start) / w;
  if (x1 <= 0 || x0 >= 1 || !(x1 > x0)) return null;
  return { x0: clamp01(x0), x1: clamp01(x1) };
}

/**
 * The beat map and sections strip from a grid, across `view` (the whole
 * track unless zoomed). A tick sits at each bar's first beat; bars past the
 * analysed part follow the grid on (a constant grid carries on, CONTRACTS).
 */
export function beatMap(g: LaneGrid, duration: number, view?: LaneView): BeatMapLayout {
  const v = view ?? { start: 0, end: duration };
  const w = v.end - v.start;
  const ticks: BeatTick[] = [];
  // a truncated grid runs on to the file's end (review L6); otherwise its own bars
  const last = g.truncated && g.bars > 0 ? barsWithin(g, duration) : g.bars;
  if (w > 0 && g.bars > 0) {
    for (let i = 0; i < last; i += 1) {
      const t = g.grid.barTime(i);
      if (t < v.start - 1e-6 || t > v.end + 1e-6 || t > duration + 1e-6) continue;
      const bar = i + 1;
      ticks.push({
        bar,
        x: clamp01((t - v.start) / w),
        phrase: i % PHRASE_BARS === 0,
        label: i % LABEL_BARS === 0 ? bar : null,
      });
    }
  }
  const region = (r: GridRegion | null) => (r ? spanOf(r.start, r.end, v) : null);
  const sections: BeatMapLayout['sections'] = [];
  for (const s of g.sections) {
    const span = spanOf(s.start, s.end, v);
    if (span) sections.push({ ...span, kind: s.kind });
  }
  const analysedTo =
    g.truncated && g.analysedS !== null && g.analysedS < duration && w > 0
      ? clamp01((g.analysedS - v.start) / w)
      : null;
  return {
    bars: g.bars,
    analysedTo,
    ticks,
    mixIn: region(g.mixIn),
    mixOut: region(g.mixOut),
    sections,
  };
}

/** How many bars start within the file, following the grid on. */
export function barsWithin(g: LaneGrid, duration: number): number {
  let n = g.bars;
  while (n < 10_000 && g.grid.barTime(n) <= duration + 1e-6) n += 1;
  return n;
}

/** The mix-out has been reached at `t` (said once, 37p). */
export function inMixOut(g: LaneGrid | null, t: number): boolean {
  return Boolean(g?.mixOut && t >= g.mixOut.start);
}

/** The 0-based bar playing at `t` (before the first downbeat: −1). */
export function barIndexAt(g: LaneGrid, t: number): number {
  return Math.floor((g.grid.beatAt(t) - g.grid.downbeatIndex) / 4 + 1e-9);
}

/** The bar playing at `t` as the line says it: 1-based, within 1 … bars. */
export function barAt(g: LaneGrid, t: number): number {
  return Math.max(1, Math.min(Math.max(1, g.bars), barIndexAt(g, t) + 1));
}

/** Which phrase (8 bars) is playing: the line under a lane changes once a phrase (37p). */
export function phraseAt(g: LaneGrid | null, t: number): number {
  if (!g) return -1;
  return Math.floor((barAt(g, t) - 1) / PHRASE_BARS);
}

/** 62 → "1:02" */
export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The line under lane A (37b), its text equivalent: "bar 61 of 142 · drop in
 * 1:02 · mix-out from bar 121 (3:59)". The next drop is left out when there's
 * none ahead; inside one it says "in the drop"; past the mix-out's start,
 * "in the mix-out".
 */
export function laneLine(g: LaneGrid, t: number): string {
  // past a long file's analysed part the bars aren't known: say so, not a wrong bar
  if (g.truncated && g.analysedS !== null && t >= g.analysedS)
    return `past the analysed part (the first ${clock(g.analysedS)})`;
  const parts = [`bar ${barAt(g, t)} of ${g.bars}`];
  const inDrop = g.sections.find((s) => s.kind === 'drop' && s.start <= t && t < s.end);
  const nextDrop = g.sections.find((s) => s.kind === 'drop' && s.start > t);
  if (inDrop) parts.push('in the drop');
  else if (nextDrop) parts.push(`drop in ${clock(nextDrop.start - t)}`);
  if (g.mixOut) {
    if (t >= g.mixOut.start) parts.push('in the mix-out');
    else parts.push(`mix-out from bar ${g.mixOut.start_bar + 1} (${clock(g.mixOut.start)})`);
  }
  return parts.join(' · ');
}

/** Where B is cued (step 3 starts it there): its mix-in, else its first downbeat. */
export function cueTime(g: LaneGrid | null): number {
  if (!g) return 0;
  if (g.mixIn) return Math.max(0, g.mixIn.start);
  return Math.max(0, g.grid.barTime(0));
}

/** The line under lane B once it's loaded (37m): "cued at bar 1 of 128 · mix-out from bar 113". */
export function cuedLine(g: LaneGrid): string {
  const at = cueTime(g);
  const parts = [`cued at bar ${barAt(g, at)} of ${g.bars}`];
  if (g.mixOut) parts.push(`mix-out from bar ${g.mixOut.start_bar + 1}`);
  return parts.join(' · ');
}

/** The beat map as text (it's an image with its words, 37p). */
export function beatMapWords(g: LaneGrid): string {
  const parts = [`${g.bars} bars, a phrase every ${PHRASE_BARS}`];
  if (g.mixIn) parts.push(`mix-in bars ${g.mixIn.start_bar + 1} to ${g.mixIn.end_bar}`);
  if (g.mixOut) parts.push(`mix-out bars ${g.mixOut.start_bar + 1} to ${g.mixOut.end_bar}`);
  if (g.truncated && g.analysedS !== null)
    parts.push(`the first ${clock(g.analysedS)} analysed, the grid carried on after it`);
  const kinds = g.sections.map((s) => s.kind);
  if (kinds.length) parts.push(`sections: ${kinds.join(', ')}`);
  return `Beat map: ${parts.join('; ')}`;
}

/* ── a lane while its grid is worked out (37d, 37e; 420) ─────────────── */

/**
 * Why a track has no grid to blend on, said where the beat map would be
 * (37d): "Harbour Lights has no steady beat: Sync is off, blend by ear".
 */
export function noGridWords(title: string, reason: string | null | undefined): string {
  const t = title || 'This track';
  const why = (() => {
    switch (reason) {
      case 'not_4_4':
        return 'isn’t in 4/4';
      case 'too_long':
        return 'is too long to analyse';
      case 'too_short':
        return 'is too short to beat-match';
      case 'unsure':
        return 'has a beat grid that isn’t sure enough';
      case 'bpm_mismatch':
        return 'has a beat grid that doesn’t match the BPM you set';
      case 'unreachable':
      case 'error':
        return 'couldn’t be read';
      default:
        return 'has no steady beat';
    }
  })();
  return `${t} ${why}: Sync is off, blend by ear`;
}

export type LanePhase =
  /** the grid route hasn't answered yet */
  | 'loading'
  /** asked for, in line or being worked out (Brief A's bar and line) */
  | 'analysing'
  /** in line for the library's drive (37d's Waiting) */
  | 'waiting'
  | 'ready'
  /** analysed, no grid to blend on (37d's Loaded, no grid) */
  | 'no_grid';

/** The reasons the grid route gives while a grid is still to come. */
export const PENDING_REASONS = new Set(['not_analyzed', 'analyzing']);

/** A grid that's there but can't be beat-matched on: the reason, or null when it's fine. */
export function gridProblem(g: LaneGrid): string | null {
  if (g.meter !== '4/4') return 'not_4_4';
  if (!g.confident) return 'unsure';
  return null;
}

/* ── lane B's drop (37c, 37d; 436) ────────────────────────────────────── */

/** 37d's reasons, in its words. */
export function dropRefusal(
  item: DragItem | undefined,
  { playingId }: { playingId: string | null },
): string | null {
  if (!item) return 'Only a track from your library can be the second track';
  if (item.inLibrary === false) return 'Only a track from your library can be the second track';
  if (item.away || item.fileMissing)
    return `Can’t load ${item.title || 'it'}: its file is on a drive that isn’t connected`;
  if (playingId !== null && String(item.id) === String(playingId))
    return 'That’s the track that’s playing';
  return null;
}

/**
 * What lane B takes: one track (the first of several lifted is the one
 * loaded; the drop line says so), never the playing one.
 */
export function laneVerdict(
  items: DragItem[],
  ctx: { playingId: string | null },
): { ok: true } | { ok: false; reason: string } {
  const reason = dropRefusal(items[0], ctx);
  return reason ? { ok: false, reason } : { ok: true };
}

/** "Same key", "+1 on the wheel", "relative", "3 steps on the wheel" (Browse's words, 37f). */
export function keyStepWords(a: string | null | undefined, b: string | null | undefined): string {
  const turns = wheelSteps(a, b);
  if (turns === null) return '';
  if (turns === 0) return 'Same key';
  const pa = camelotParts(a)!;
  const pb = camelotParts(b)!;
  if (pa.number === pb.number) return 'relative';
  if (turns === 1) {
    const up = (pb.number - pa.number + 12) % 12 === 1;
    return `${up ? '+1' : '−1'} on the wheel`;
  }
  return `${turns} steps on the wheel`;
}

/** B's tempo against A's, as Sync would stretch it: "+1.6%", "half time", "same tempo". */
export function tempoStepWords(a: number | null | undefined, b: number | null | undefined): string {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0)) return '';
  // tempoStep's "double" is B doubled to meet A: B runs at half A's tempo,
  // which a DJ (and 37f's "62.0 half time", core/dj/camelot.py) calls half time
  const { how } = tempoStep(x, y);
  if (how === 'double') return 'half time';
  if (how === 'half') return 'double time';
  const pct = pyRound((y / x - 1) * 100, 1);
  if (pct === 0) return 'same tempo';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

/**
 * The drop line's second line (37c): "Same key · +1.6% · has its beat grid".
 * A step that isn't known is left out; `grid` is null while it's being looked up.
 */
export function dropStepLine(
  a: { key?: string | null; bpm?: number | null } | null,
  b: { key?: string | null; bpm?: number | null },
  grid: boolean | null,
): string {
  const parts = [
    a ? keyStepWords(a.key, b.key) : '',
    a ? tempoStepWords(a.bpm, b.bpm) : '',
    grid === true ? 'has its beat grid' : grid === false ? 'analysed when it’s loaded' : '',
  ].filter(Boolean);
  if (parts.length) parts[0] = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
  return parts.join(' · ');
}

/* ── words ────────────────────────────────────────────────────────────── */

/** A lane as a named group (37p): "Deck A, Night Ferry, playing, bar 61 of 142". */
export function laneGroupName(
  deck: 'A' | 'B',
  title: string | null,
  state: string,
  line?: string | null,
): string {
  if (!title) return `Deck ${deck}, empty`;
  return [`Deck ${deck}`, title, state, line].filter(Boolean).join(', ');
}

/** The header's line beside "DJ mode" (37b, 37e, 37m). */
export function headerLine({
  a,
  aPhase,
  b,
  bPhase,
  browse,
  mix = 'idle',
  solo = false,
}: {
  a: string | null;
  aPhase: LanePhase | null;
  b: string | null;
  bPhase: LanePhase | null;
  browse: boolean;
  /** the mixer's phase (step 3) */
  mix?: string;
  /** B playing on its own (step 4, 37j) */
  solo?: boolean;
}): string {
  if (mix === 'handing') return `Handing over to ${b || 'B'}`;
  if (solo && b && mix === 'playing')
    return `${b} on its own · Hand over makes it the player’s track`;
  if (b) {
    if (mix === 'starting' || mix === 'playing') return 'Blending · Back ends it over a bar';
    if (mix === 'backing') return `Bringing ${a || 'A'} back over a bar`;
    if (mix === 'paused') return `${b} paused · Play B carries on on the next bar`;
    if (bPhase === 'analysing' || bPhase === 'loading' || bPhase === 'waiting')
      return `Analysing ${b} · Sync comes with the grid`;
    if (mix === 'ready') return `${b} cued · Play B, then move the fader`;
    if (mix === 'loading') return `${b} cued · getting the decks ready`;
    return `${b} cued`;
  }
  if (a && aPhase === 'analysing')
    return `Analysing ${a} · you can load B now; Sync comes with the grid`;
  if (a) return `${a} on the speakers · drop ${browse ? 'or Browse ' : ''}a second track`;
  return 'Nothing playing';
}

/**
 * The player bar's one line with the Visuals closed (37o, 37j): while DJ
 * mode is on with B loaded (or handing over); null otherwise, and always
 * with DJ mode off (nothing new, ever).
 */
export function barLine({
  on,
  open,
  b,
  mix,
}: {
  on: boolean;
  open: boolean;
  b: string | null;
  mix: string;
}): string | null {
  if (!on || open) return null;
  if (mix === 'handing') return `DJ mode · handing over to ${b || 'B'}`;
  if (!b) return null;
  if (mix === 'starting' || mix === 'playing' || mix === 'backing')
    return `DJ mode · blending into ${b}`;
  if (mix === 'paused') return `DJ mode · ${b} paused`;
  return `DJ mode · ${b} cued`;
}

/** 37l: T while DJ mode is on. */
export const LYRICS_WAIT = 'Lyrics come back when DJ mode is off';
