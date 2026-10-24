/**
 * The Visuals overlay's pure rules (boards 10a–10f): the MilkDrop list's
 * filters and steps, auto-cycle, Quality and the frame-rate guard, the
 * credit's words, and which key does what. No DOM; unit tested.
 */

import type {
  Autocycle,
  Family,
  Moved,
  OwnFolderState,
  PresetEntry,
  Quality,
  ShowFilter,
} from './visuals.types';

import { FAMILY_NAMES, QUALITIES } from './visuals.types';

// ── the list ─────────────────────────────────────────────────────────────────

export const RECENT_MAX = 20;

/** Search over names and authors: every word has to be in one or the other. */
export function matchesQuery(entry: PresetEntry, query: string): boolean {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = `${entry.name} ${entry.author ?? ''}`.toLocaleLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function authorKey(author: string | null | undefined): string {
  return (author ?? '').toLocaleLowerCase();
}

export interface ListFilter {
  query: string;
  show: ShowFilter;
  author: string;
  favourites: ReadonlySet<string>;
  recent: readonly string[];
  /** presets the curated set leaves out but Favourites and Recent keep (101) */
  kept?: readonly PresetEntry[];
}

/** The listed presets and the kept ones, A–Z, each once. */
export function withKept(
  all: readonly PresetEntry[],
  kept: readonly PresetEntry[] = [],
): PresetEntry[] {
  if (!kept.length) return all.slice();
  const seen = new Set(all.map((p) => p.key));
  const extra = kept.filter((p) => !seen.has(p.key));
  return [...all, ...extra].sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  );
}

/**
 * What the browser lists: All A–Z, Favourites A–Z, Recent newest first, or
 * Yours A–Z; then the author and the search. Favourites and Recent keep a
 * preset the curated set leaves out.
 */
export function filterPresets(all: readonly PresetEntry[], f: ListFilter): PresetEntry[] {
  let base: PresetEntry[];
  if (f.show === 'recent') {
    const byKey = new Map(withKept(all, f.kept).map((p) => [p.key, p]));
    base = f.recent.map((k) => byKey.get(k)).filter((p): p is PresetEntry => Boolean(p));
  } else if (f.show === 'favourites') {
    base = withKept(all, f.kept).filter((p) => f.favourites.has(p.key));
  } else if (f.show === 'yours') {
    base = all.filter((p) => p.source === 'own');
  } else {
    base = all.slice();
  }
  const author = f.author ? authorKey(f.author) : '';
  return base.filter(
    (p) => (!author || authorKey(p.author) === author) && matchesQuery(p, f.query),
  );
}

/** "2,412 presets · A–Z · 38 authors" */
export function listSummary(list: readonly PresetEntry[], show: ShowFilter): string {
  const authors = new Set(list.map((p) => authorKey(p.author)).filter(Boolean)).size;
  const n = list.length;
  const order = show === 'recent' ? 'newest first' : 'A–Z';
  return `${n.toLocaleString('en-GB')} ${n === 1 ? 'preset' : 'presets'} · ${order} · ${authors.toLocaleString('en-GB')} ${authors === 1 ? 'author' : 'authors'}`;
}

/**
 * The count line under Show (18a): "395 from the curated packs and 12 of
 * yours · A–Z" while All lists everything, "12 of yours · A–Z" on Yours;
 * otherwise what's listed, the order and the authors.
 */
export function browserSummary(
  list: readonly PresetEntry[],
  f: { show: ShowFilter; query: string; author: string; everyPreset: boolean },
): string {
  if (f.show === 'yours' && !f.query.trim() && !f.author)
    return list.length ? `${list.length.toLocaleString('en-GB')} of yours · A–Z` : 'None of yours';
  if (f.show !== 'all' || f.query.trim() || f.author) return listSummary(list, f.show);
  const own = list.filter((p) => p.source === 'own').length;
  const bundled = list.length - own;
  const n = (x: number) => x.toLocaleString('en-GB');
  const packs = f.everyPreset
    ? `${n(bundled)} from every pack`
    : `${n(bundled)} from the curated packs`;
  return `${packs}${own ? ` and ${n(own)} of yours` : ''} · A–Z`;
}

/** "just now" / "2 minutes ago" / "3 hours ago" / "2 days ago" */
export function agoWords(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return 'just now';
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

/**
 * Player settings → MilkDrop → Your own presets: the line under the folder
 * (18b). Read (success), empty (warning) or unreadable (danger), always in
 * words; no tone before a folder is set.
 */
export function ownFolderLine(
  own: OwnFolderState | null | undefined,
  folder: string,
  nowSeconds: number = Date.now() / 1000,
): { tone: 'success' | 'warning' | 'danger' | null; words: string } | null {
  if (!own) return null;
  const where = folder.trim() || 'the folder';
  if (!own.configured)
    return {
      tone: null,
      words: 'None yet. Point this at a folder of .milk files; each is converted when it’s picked.',
    };
  if (own.problem === 'missing')
    return {
      tone: 'danger',
      words: `SYNCHRO.S can’t open ${where}: it isn’t there inside the container. Check the folder is in your set-up’s volumes.`,
    };
  if (own.problem)
    return {
      tone: 'danger',
      words: `SYNCHRO.S can’t open ${where}: it isn’t allowed to read it. Check who owns the folder and that it can be read.`,
    };
  const big = own.too_big ?? 0;
  const bigWords = big
    ? ` ${big.toLocaleString('en-GB')} ${big === 1 ? 'is' : 'are'} too big (over 512 KB) and ${big === 1 ? 'was' : 'were'} left out.`
    : '';
  if (!own.count)
    return {
      tone: 'warning',
      words: `The folder has no .milk files yet. Put them in it; SYNCHRO.S reads it again when MilkDrop next opens.${bigWords}`,
    };
  const read =
    typeof own.read_at === 'number' && own.read_at > 0
      ? `, read ${agoWords(nowSeconds - own.read_at)}`
      : '';
  const capped = own.truncated
    ? ` Only the first ${own.count.toLocaleString('en-GB')} are listed.`
    : '';
  return {
    tone: 'success',
    words: `${own.count.toLocaleString('en-GB')} ${own.count === 1 ? 'preset' : 'presets'}${read}.${bigWords}${capped}`,
  };
}

/** The newest first, each once, at most RECENT_MAX. */
export function pushRecent(recent: readonly string[], key: string, max = RECENT_MAX): string[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, max);
}

/**
 * The next (or previous) key in a list from `current`, skipping keys that
 * won't load. A current key that isn't in the list starts from the top.
 */
export function stepKey(
  list: readonly { key: string }[],
  current: string | null,
  dir: 1 | -1,
  skip: ReadonlySet<string> = new Set(),
): string | null {
  const keys = list.map((p) => p.key).filter((k) => !skip.has(k) || k === current);
  if (!keys.length) return null;
  const at = current ? keys.indexOf(current) : -1;
  if (at < 0) return dir === 1 ? keys[0]! : keys[keys.length - 1]!;
  for (let i = 1; i <= keys.length; i++) {
    const k = keys[(at + dir * i + keys.length * i) % keys.length]!;
    if (!skip.has(k) && k !== current) return k;
  }
  return null;
}

/** A random key other than the current one (and none that won't load). */
export function randomKey(
  list: readonly { key: string }[],
  current: string | null,
  skip: ReadonlySet<string> = new Set(),
  rand: () => number = Math.random,
): string | null {
  const keys = list.map((p) => p.key).filter((k) => k !== current && !skip.has(k));
  if (!keys.length) return null;
  return keys[Math.min(keys.length - 1, Math.floor(rand() * keys.length))]!;
}

/** "2.1 MB" / "0.4 MB" / "12 KB" */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 100 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function byLine(entry: Pick<PresetEntry, 'author'>): string {
  return entry.author ? `by ${entry.author}` : 'author unknown';
}

// ── auto-cycle ───────────────────────────────────────────────────────────────

export const AUTOCYCLE_CHOICES: readonly { value: Autocycle; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: '30', label: 'Every 30 s' },
  { value: '120', label: 'Every 2 min' },
  { value: 'track', label: 'On track change' },
];

const AUTOCYCLE_EXTRA: Record<string, string> = {
  '60': 'Every minute',
  '300': 'Every 5 min',
};

export function normaliseAutocycle(v: unknown): Autocycle {
  return v === '30' || v === '60' || v === '120' || v === '300' || v === 'track' ? v : 'off';
}

/** The select's options: the board's four, plus a saved older value. */
export function autocycleChoices(current: Autocycle): { value: Autocycle; label: string }[] {
  const extra = AUTOCYCLE_EXTRA[current];
  return extra
    ? [...AUTOCYCLE_CHOICES, { value: current, label: extra }]
    : AUTOCYCLE_CHOICES.slice();
}

/** Seconds between changes; 0 for off and on track change. */
export function autocycleSeconds(v: Autocycle): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function autocycleWords(v: Autocycle): string {
  if (v === 'track') return 'on track change';
  const s = autocycleSeconds(v);
  if (!s) return '';
  return s < 60 ? `every ${s} s` : s === 60 ? 'every minute' : `every ${s / 60} min`;
}

// ── Quality and the frame-rate guard ─────────────────────────────────────────

export function normaliseQuality(v: unknown): Quality {
  return v === 'half' || v === 'quarter' ? v : 'full';
}

/** MilkDrop's pixel ratio for a Quality: the screen's (capped at 2), scaled. */
export function qualityPixelRatio(q: Quality, dpr: number): number {
  const base = Math.min(2, Math.max(1, Number.isFinite(dpr) ? dpr : 1));
  return base * (q === 'quarter' ? 0.25 : q === 'half' ? 0.5 : 1);
}

export function lowerQuality(q: Quality): Quality | null {
  const i = QUALITIES.indexOf(q);
  return i >= 0 && i < QUALITIES.length - 1 ? QUALITIES[i + 1]! : null;
}

export const GUARD_FPS = 24;
export const GUARD_SECONDS = 5;

/**
 * Under 24 frames a second for 5 seconds drops Quality one step, once per
 * preset (Ross, 23 October: phones start at Full like desktop; this handles
 * the weak ones). Fed every frame's time; `reset()` on a new preset.
 */
export class FrameRateGuard {
  private slowSince: number | null = null;
  private window: number[] = [];
  private spent = false;

  constructor(
    private readonly minFps = GUARD_FPS,
    private readonly seconds = GUARD_SECONDS,
  ) {}

  reset(): void {
    this.slowSince = null;
    this.window = [];
    this.spent = false;
  }

  /** The guard won't act again for this preset ("Put it back", or it already did). */
  disarm(): void {
    this.spent = true;
  }

  get armed(): boolean {
    return !this.spent;
  }

  /** A frame drawn at `nowMs`; true the moment Quality should drop. */
  frame(nowMs: number): boolean {
    if (this.spent) return false;
    this.window.push(nowMs);
    // a one-second window of frame times
    while (this.window.length && nowMs - this.window[0]! > 1000) this.window.shift();
    if (this.window.length < 2) return false;
    const span = (nowMs - this.window[0]!) / 1000;
    if (span < 0.5) return false;
    const fps = (this.window.length - 1) / span;
    if (fps >= this.minFps) {
      this.slowSince = null;
      return false;
    }
    if (this.slowSince === null) this.slowSince = this.window[0]!;
    if (nowMs - this.slowSince >= this.seconds * 1000) {
      this.spent = true;
      return true;
    }
    return false;
  }

  /** A gap (tab hidden, overlay closed) isn't slowness. */
  pause(): void {
    this.slowSince = null;
    this.window = [];
  }
}

// ── the credit (10c) ─────────────────────────────────────────────────────────

export const CREDIT_MS = 4000;
export const HINT_TIMES = 3;

export function movedWords(moved: Moved, autocycle: Autocycle): string {
  switch (moved) {
    case 'picked':
      return 'you picked it';
    case 'next':
      return 'next';
    case 'previous':
      return 'previous';
    case 'random':
      return 'random';
    case 'every':
    case 'track':
      return autocycleWords(autocycle) || 'auto-cycle';
    case 'retry':
      return 'tried again';
    case 'back':
      return 'back on';
    case 'opened':
      return 'where you left it';
  }
}

/** "by Hapax · MilkDrop · 4 of 2,412 · on track change" */
export function creditLine(opts: {
  author: string | null;
  family: Family;
  position: number;
  total: number;
  moved: Moved;
  autocycle: Autocycle;
}): string {
  const bits =
    opts.family === 'milkdrop'
      ? [opts.author ? `by ${opts.author}` : 'author unknown', FAMILY_NAMES.milkdrop]
      : opts.family === 'classic'
        ? [FAMILY_NAMES.classic, 'drawn by SYNCHRO.S']
        : ['drawn by SYNCHRO.S'];
  if (opts.position > 0 && opts.total > 0)
    bits.push(`${opts.position.toLocaleString('en-GB')} of ${opts.total.toLocaleString('en-GB')}`);
  bits.push(movedWords(opts.moved, opts.autocycle));
  return bits.join(' · ');
}

// ── keys (10a's note; answer 60; question 83) ────────────────────────────────

export type OverlayKey = 'next' | 'previous' | 'random' | 'favourite';

/**
 * The overlay's own keys: V next, Shift+V previous, R random, S favourite.
 * L is the A–B loop everywhere, the overlay included (HANDOFF 83). Nothing while
 * a modifier is held or a field has the keyboard.
 */
export function overlayKey(ev: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  inField?: boolean;
}): OverlayKey | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.inField) return null;
  switch (ev.key) {
    case 'v':
    case 'V':
      return ev.shiftKey ? 'previous' : 'next';
    case 'r':
    case 'R':
      return ev.shiftKey ? null : 'random';
    case 's':
    case 'S':
      return ev.shiftKey ? null : 'favourite';
    default:
      return null;
  }
}

// ── stills (10d) ─────────────────────────────────────────────────────────────

/**
 * Reduce motion (the system's or Player settings' "Reduce visual effects")
 * opens the overlay still, unless "Play visuals this time" was pressed in
 * this session.
 */
export function stillReason(opts: {
  systemReduce: boolean;
  settingReduce: boolean;
  playAnyway: boolean;
}): 'system' | 'setting' | null {
  if (opts.playAnyway) return null;
  if (opts.settingReduce) return 'setting';
  if (opts.systemReduce) return 'system';
  return null;
}

/** An analyser buffer that only holds silence (time domain, 128 = zero). */
export function isSilent(time: ArrayLike<number>, tolerance = 2): boolean {
  for (let i = 0; i < time.length; i++) {
    if (Math.abs((time[i] ?? 128) - 128) > tolerance) return false;
  }
  return true;
}
