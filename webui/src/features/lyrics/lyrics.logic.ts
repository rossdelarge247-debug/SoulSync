/**
 * Lyrics centre stage, step 1 (BACKLOG "Lyrics centre stage, timed to the
 * words"; boards 27a–27g): the pure part. Reading what `POST
 * /api/lyrics/fetch` answered (LRC with a start per line, Enhanced LRC's
 * `<mm:ss.xx>` per word when a file carries them, or plain text), finding
 * the line at a moment, the sweep across it, the plain lyrics' slow scroll,
 * the words of the pill's source line, and the early/late nudge kept per
 * track.
 *
 * The sweep is honest (27d): with word times each word fills at its own
 * time with a hard edge; without them SYNCHRO.S spreads the line's time
 * across its syllables, and the drawing says it's an estimate (a feathered
 * edge, lit to 85%).
 */

export type Timing = 'word' | 'line' | 'plain';

export interface LyricWord {
  text: string;
  start: number;
  end: number;
  /** the estimate's share of the line: syllables */
  syllables: number;
}

export interface LyricLine {
  time: number;
  /** when the next line starts (or a little after the last) */
  end: number;
  text: string;
  words: LyricWord[];
  /** the file gave this line's words their own times */
  real: boolean;
}

export interface ParsedLyrics {
  timing: Timing;
  lines: LyricLine[];
  /** plain text's lines (timing 'plain') */
  plain: string[];
}

/** What the player fetched (SoulSyncPlayer.lyricsData(), static/media-player.js). */
export interface RawLyrics {
  key: string;
  done: boolean;
  synced: string | null;
  plain: string | null;
  source: string | null;
  instrumental: boolean;
  fileName: string | null;
}

/** A − and A+ step through these (27a): the current line's size at 1440. */
export const SIZES = [36, 44, 56] as const;
export type LyricSize = (typeof SIZES)[number];
export const DEFAULT_SIZE: LyricSize = 44;

/** Earlier / Later move this much (27a), and never further than OFFSET_MAX. */
export const OFFSET_STEP = 0.1;
export const OFFSET_MAX = 10;

/** None found and Instrumental are said once, then go (27g). */
export const QUIET_MS = 5000;

/** The estimate never takes longer than this per syllable over a long gap. */
export const SECONDS_PER_SYLLABLE = 0.42;
/** A word time's last word holds at most this long. */
const LAST_WORD_HOLD = 3;
/** How long the last line counts as current after it starts, with nothing after it. */
const LAST_LINE_HOLD = 6;

const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const WORD_STAMP = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
const OFFSET_TAG = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i;

function seconds(min: string, sec: string): number {
  return Number(min) * 60 + Number(sec.replace(':', '.'));
}

/** Rough syllables in a word: vowel groups, a silent final e, at least one. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-zà-ÿ]/g, '');
  if (!w) return 1;
  const groups = w.match(/[aeiouyà-ÿ]+/g)?.length ?? 0;
  let n = groups;
  if (w.length > 2 && w.endsWith('e') && !/[aeiouy]le$/.test(w) && !w.endsWith('ee') && n > 1)
    n -= 1;
  return Math.max(1, n);
}

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** One LRC line's words, with Enhanced LRC's times when there are any. */
function lineWords(
  body: string,
  start: number,
): { text: string; words: LyricWord[]; real: boolean } {
  WORD_STAMP.lastIndex = 0;
  if (!WORD_STAMP.test(body)) {
    const text = body.trim().replace(/\s+/g, ' ');
    return {
      text,
      words: splitWords(text).map((t) => ({ text: t, start, end: start, syllables: syllables(t) })),
      real: false,
    };
  }
  // segments between word stamps: the text before the first takes the line's time
  const words: LyricWord[] = [];
  let at = start;
  let last = 0;
  WORD_STAMP.lastIndex = 0;
  let m: RegExpExecArray | null;
  const push = (chunk: string, t: number) => {
    for (const w of splitWords(chunk))
      words.push({ text: w, start: t, end: t, syllables: syllables(w) });
  };
  while ((m = WORD_STAMP.exec(body)) !== null) {
    push(body.slice(last, m.index), at);
    at = seconds(m[1]!, m[2]!);
    last = m.index + m[0].length;
  }
  push(body.slice(last), at);
  return { text: words.map((w) => w.text).join(' '), words, real: true };
}

/** LRC (with or without word times) into lines, sorted, ends filled in. */
export function parseLrc(text: string | null | undefined): LyricLine[] {
  if (!text) return [];
  let fileOffset = 0;
  const out: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const off = OFFSET_TAG.exec(raw);
    if (off) {
      // LRC's offset is milliseconds, positive meaning the words come sooner
      fileOffset = Number(off[1]) / 1000;
      continue;
    }
    const stamps: number[] = [];
    STAMP.lastIndex = 0;
    let m: RegExpExecArray | null;
    let bodyAt = 0;
    while ((m = STAMP.exec(raw)) !== null) {
      if (m.index !== bodyAt) break;
      stamps.push(seconds(m[1]!, m[2]!));
      bodyAt = m.index + m[0].length;
    }
    if (!stamps.length) continue;
    const body = raw.slice(bodyAt);
    for (const t of stamps) {
      const { text: words, words: list, real } = lineWords(body, t);
      out.push({ time: t, end: t, text: words, words: list, real });
    }
  }
  if (fileOffset) {
    for (const l of out) {
      l.time = Math.max(0, l.time - fileOffset);
      for (const w of l.words) w.start = Math.max(0, w.start - fileOffset);
    }
  }
  out.sort((a, b) => a.time - b.time);
  for (let i = 0; i < out.length; i += 1) {
    const line = out[i]!;
    const next = out[i + 1];
    line.end = next ? Math.max(line.time, next.time) : line.time + LAST_LINE_HOLD;
    if (line.real) {
      for (let j = 0; j < line.words.length; j += 1) {
        const w = line.words[j]!;
        const after = line.words[j + 1];
        w.end = after
          ? Math.max(w.start, after.start)
          : Math.min(line.end, w.start + LAST_WORD_HOLD);
      }
    }
  }
  return out;
}

/** What the fetch answered, ready to show; null when there's nothing to show. */
export function parseLyrics(raw: Pick<RawLyrics, 'synced' | 'plain'> | null): ParsedLyrics | null {
  if (!raw) return null;
  const lines = parseLrc(raw.synced);
  if (lines.some((l) => l.text)) {
    return { timing: lines.some((l) => l.real) ? 'word' : 'line', lines, plain: [] };
  }
  // a sidecar .lrc with no stamps is plain text; so is LRCLIB's plain
  const plainSource = raw.plain || (raw.synced && !lines.length ? raw.synced : null);
  const plain = (plainSource || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]));
  while (plain.length && !plain[plain.length - 1]) plain.pop();
  if (plain.some(Boolean)) return { timing: 'plain', lines: [], plain };
  return null;
}

/** The line playing at `t` (−1 before the first). */
export function lineAt(lines: readonly LyricLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.time <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * How much of each word is lit at `t`, 0 to 1. Real times fill each word
 * across its own time; the estimate spreads the line's singing time (the
 * gap to the next line, capped at SECONDS_PER_SYLLABLE a syllable) across
 * its syllables, at an even pace.
 */
export function wordFills(line: LyricLine, t: number): number[] {
  if (line.real) {
    return line.words.map((w) => {
      if (t <= w.start) return 0;
      if (w.end <= w.start) return 1;
      return Math.min(1, (t - w.start) / (w.end - w.start));
    });
  }
  const total = line.words.reduce((n, w) => n + w.syllables, 0) || 1;
  const span = Math.max(0.8, Math.min(line.end - line.time, total * SECONDS_PER_SYLLABLE));
  const sung = Math.max(0, Math.min(1, (t - line.time) / span)) * total;
  let before = 0;
  return line.words.map((w) => {
    const f = Math.max(0, Math.min(1, (sung - before) / w.syllables));
    before += w.syllables;
    return f;
  });
}

/** Plain lyrics scroll with the track (27g): 0 at the start, 1 at the end. */
export function plainProgress(t: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(1, t / duration));
}

/** The pill's source line (27g): where the words came from and how they're timed. */
export function sourceLine(source: string | null, fileName: string | null, timing: Timing): string {
  const how =
    timing === 'word'
      ? 'timed to the word'
      : timing === 'line'
        ? 'timed to the line'
        : 'not timed: scrolling with the track';
  if (source === 'sidecar') {
    const stem = fileName ? fileName.replace(/\.[^.]+$/, '') : '';
    const ext = timing === 'plain' ? 'txt' : 'lrc';
    return stem
      ? `From ${stem}.${ext} beside the track · ${how}`
      : `From a file beside the track · ${how}`;
  }
  return `LRCLIB · ${how}`;
}

/** "+0.3 s" (earlier), "−0.2 s" (later), "0.0 s". */
export function offsetWords(offset: number): string {
  const v = Math.round(offset * 10) / 10;
  if (v === 0) return '0.0 s';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} s`;
}

/** For a screen reader: "0.3 seconds earlier". */
export function offsetSpoken(offset: number): string {
  const v = Math.round(offset * 10) / 10;
  if (v === 0) return 'on time';
  return `${Math.abs(v).toFixed(1)} seconds ${v > 0 ? 'earlier' : 'later'}`;
}

export function clampOffset(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, v)) * 10) / 10;
}

/** A − / A+ (27a): the next size down or up, staying at the ends. */
export function stepSize(size: number, dir: 1 | -1): LyricSize {
  const at = SIZES.indexOf(size as LyricSize);
  const i = at < 0 ? SIZES.indexOf(DEFAULT_SIZE) : at;
  return SIZES[Math.max(0, Math.min(SIZES.length - 1, i + dir))]!;
}

/** The lines either side scale with the current one (24/600 beside 44). */
export function sideSize(size: number): number {
  return Math.round((size * 24) / 44);
}

/** "1:42" for a line's time on hover. */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The nudge is kept per track (27a): a library track by its id, anything
 * else by title, artist and album.
 */
export function trackKey(
  track:
    | { id?: string | number | null; title?: string; artist?: string; album?: string }
    | null
    | undefined,
  kind: string | null | undefined,
): string | null {
  if (!track) return null;
  if (kind === 'library' && track.id !== undefined && track.id !== null && track.id !== '')
    return `lib:${String(track.id)}`;
  const parts = [track.title, track.artist, track.album].map((p) =>
    String(p || '')
      .trim()
      .toLowerCase(),
  );
  if (!parts[0]) return null;
  return `t:${parts.join('|')}`;
}

/** The kept offsets, newest last, at most this many tracks. */
export const OFFSETS_MAX = 500;

export function putOffset(
  map: Record<string, number>,
  key: string,
  value: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) if (k !== key) next[k] = v;
  const v = clampOffset(value);
  if (v !== 0) next[key] = v;
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - OFFSETS_MAX; i += 1) delete next[keys[i]!];
  return next;
}

export function readOffsets(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && k.length <= 600) out[k] = clampOffset(v);
    }
    return out;
  } catch {
    return {};
  }
}
