/**
 * The player's pure parts (board 6a; docs/design/DESIGN-SYSTEM.md, "Player
 * bar and tray"): what the bar and the tray say, worked out from the engine's
 * state with no DOM, so they're tested on their own. The chrome that draws
 * them is player.ts; playback itself is static/media-player.js.
 */

/** What's playing decides the controls (the "source kind" seam). */
export type SourceKind = 'library' | 'stream' | 'podcast' | 'audiobook' | 'radio';

export interface SourceView {
  kind: SourceKind;
  /** a waveform you can scrub, or (radio) a level meter */
  progress: 'waveform' | 'meter';
  /** elapsed / total times, or (radio) a Live tag */
  times: boolean;
  /** −15 s / +30 s instead of Previous / Next */
  skip: { back: number; forward: number } | null;
  /** the "1.2×" button beside the transport */
  speedButton: boolean;
  /** the source's one action (radio's Add to Wanted) has a slot */
  actionSlot: boolean;
  /** shuffle and repeat make sense */
  queueModes: boolean;
}

export function sourceView(kind: SourceKind | null | undefined): SourceView {
  switch (kind) {
    case 'podcast':
    case 'audiobook':
      return {
        kind,
        progress: 'waveform',
        times: true,
        skip: { back: 15, forward: 30 },
        speedButton: true,
        actionSlot: false,
        queueModes: true,
      };
    case 'radio':
      return {
        kind,
        progress: 'meter',
        times: false,
        skip: null,
        speedButton: false,
        actionSlot: true,
        queueModes: false,
      };
    case 'stream':
      return {
        kind,
        progress: 'waveform',
        times: true,
        skip: null,
        speedButton: false,
        actionSlot: false,
        queueModes: true,
      };
    default:
      return {
        kind: 'library',
        progress: 'waveform',
        times: true,
        skip: null,
        speedButton: false,
        actionSlot: false,
        queueModes: true,
      };
  }
}

// ── expanded or collapsed, kept per browser ────────────────────────────────

export const PLAYER_STATE_KEY = 'ssPlayerExpanded';

export type TrayState = 'bar' | 'tray';

interface StoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The remembered state; the bar (collapsed) by default or when storage fails. */
export function readTrayState(store: StoreLike | null | undefined): TrayState {
  try {
    return store?.getItem(PLAYER_STATE_KEY) === '1' ? 'tray' : 'bar';
  } catch {
    return 'bar';
  }
}

export function writeTrayState(store: StoreLike | null | undefined, state: TrayState): void {
  try {
    if (state === 'tray') store?.setItem(PLAYER_STATE_KEY, '1');
    else store?.removeItem(PLAYER_STATE_KEY);
  } catch {
    /* storage blocked: the choice holds for this visit */
  }
}

// ── times ──────────────────────────────────────────────────────────────────

/** 1:42, 58:02, 1:02:07. Unknown or negative is 0:00. */
export function formatClock(seconds: number | null | undefined): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The tray's right-hand time: what's left, with a real minus sign. */
export function formatRemaining(current: number, duration: number): string {
  if (!Number.isFinite(duration) || duration <= 0) return '−0:00';
  return `−${formatClock(Math.max(0, duration - (Number.isFinite(current) ? current : 0)))}`;
}

/** "1 minute 42 seconds of 4 minutes 36 seconds" for the slider's aria-valuetext. */
export function spokenTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const bits: string[] = [];
  if (h) bits.push(part(h, 'hour'));
  if (m) bits.push(part(m, 'minute'));
  if (s || bits.length === 0) bits.push(part(s, 'second'));
  return bits.join(' ');
}

export function positionText(current: number, duration: number): string {
  return `${spokenTime(current)} of ${spokenTime(duration)}`;
}

/** Where a slider key takes the playhead. */
export function seekStep(key: string, current: number, duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const now = Number.isFinite(current) ? current : 0;
  let next: number;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      next = now - 5;
      break;
    case 'ArrowRight':
    case 'ArrowUp':
      next = now + 5;
      break;
    case 'PageDown':
      next = now - 30;
      break;
    case 'PageUp':
      next = now + 30;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = duration - 1;
      break;
    default:
      return null;
  }
  return Math.max(0, Math.min(duration, next));
}

// ── volume ─────────────────────────────────────────────────────────────────

/** "−12 dB" for a 0–100 volume (20·log10); 0 is "Muted". */
export function volumeDb(percent: number, muted = false): string {
  const p = Number(percent);
  if (muted || !Number.isFinite(p) || p <= 0) return 'Muted';
  const db = 20 * Math.log10(Math.min(100, p) / 100);
  const rounded = Math.round(db);
  return rounded === 0 ? '0 dB' : `−${Math.abs(rounded)} dB`;
}

// ── the readout ────────────────────────────────────────────────────────────

export interface AudioDetails {
  format?: string | null;
  bitrate_kbps?: number | null;
  bit_depth?: number | null;
  sample_rate?: number | null;
  path_label?: string | null;
}

/** 96000 → "96", 44100 → "44.1". */
export function khz(rate: number | null | undefined): string | null {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return null;
  const k = r / 1000;
  return Number.isInteger(k) ? String(k) : String(Math.round(k * 10) / 10);
}

const LOSSY = new Set(['MP3', 'AAC', 'OGG', 'Opus', 'WMA']);

/** "FLAC 24/96 · 2,304 kbps"; "MP3 · 320 kbps · 44.1 kHz"; "FLAC" when that's all there is. */
export function formatReadout(d: AudioDetails | null | undefined): string {
  if (!d || !d.format) return '—';
  const parts: string[] = [];
  const rate = khz(d.sample_rate);
  // no-break spaces inside each part: a narrow readout wraps between parts
  if (d.bit_depth && rate && !LOSSY.has(d.format))
    parts.push(`${d.format}\u00a0${d.bit_depth}/${rate}`);
  else parts.push(d.format);
  if (d.bitrate_kbps) parts.push(`${d.bitrate_kbps.toLocaleString('en-US')}\u00a0kbps`);
  if (rate && (LOSSY.has(d.format) || !d.bit_depth)) parts.push(`${rate}\u00a0kHz`);
  return parts.join(' · ');
}

/** "FLAC 24/96" for the bar's meta line, or "MP3 320". */
export function shortFormat(d: AudioDetails | null | undefined): string | null {
  if (!d || !d.format) return null;
  const rate = khz(d.sample_rate);
  if (d.bit_depth && rate && !LOSSY.has(d.format)) return `${d.format} ${d.bit_depth}/${rate}`;
  if (LOSSY.has(d.format) && d.bitrate_kbps) return `${d.format} ${d.bitrate_kbps}`;
  return d.format;
}

const EXT_FORMATS: Record<string, string> = {
  flac: 'FLAC',
  mp3: 'MP3',
  m4a: 'AAC',
  mp4: 'AAC',
  aac: 'AAC',
  alac: 'ALAC',
  ogg: 'OGG',
  oga: 'OGG',
  opus: 'Opus',
  wav: 'WAV',
  aif: 'AIFF',
  aiff: 'AIFF',
  wma: 'WMA',
  dsf: 'DSD',
};

/** A format from a file name or address, for tracks the server can't describe. */
export function formatFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const clean = String(path).split(/[?#]/)[0] ?? '';
  const m = /\.([a-z0-9]{2,5})$/i.exec(clean);
  return m ? (EXT_FORMATS[m[1]!.toLowerCase()] ?? null) : null;
}

/** "Library → Living room". */
export function pathLabel(source: string, output: string | null | undefined): string {
  return `${source} → ${output || 'This device'}`;
}

/** Where a kind plays from, when the server doesn't say. */
export function sourceLabel(
  kind: SourceKind,
  track: { username?: string; is_preview?: boolean } | null,
): string {
  switch (kind) {
    case 'podcast':
      return 'Podcast feed';
    case 'audiobook':
      return 'Audiobook sample';
    case 'radio':
      return 'Radio stream';
    case 'stream':
      if (track?.is_preview) return 'Preview';
      return track?.username ? 'Soulseek' : 'Stream';
    default:
      return 'Library';
  }
}

/** "Lantern · 2024 · track 3 of 11". */
export function albumLine(d: {
  album?: string | null;
  year?: number | string | null;
  track_number?: number | null;
  album_track_count?: number | null;
}): string {
  const bits: string[] = [];
  if (d.album) bits.push(d.album);
  if (d.year) bits.push(String(d.year));
  if (d.track_number) {
    bits.push(
      d.album_track_count && d.album_track_count >= d.track_number
        ? `track ${d.track_number} of ${d.album_track_count}`
        : `track ${d.track_number}`,
    );
  }
  return bits.join(' · ');
}

// ── the waveform ───────────────────────────────────────────────────────────

/** How many bars fit: about 3px bars on 2px gaps, between 24 and 200. */
export function barCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 64;
  return Math.max(24, Math.min(200, Math.floor((width + 2) / 5)));
}

/**
 * The server's 200 heights resampled to `count` bars (the loudest of each
 * span), as fractions of the bar's height, never under `floor`. No peaks
 * (still working out, a stream, an episode) is a flat line of `floor`.
 */
export function waveformBars(
  peaks: number[] | null | undefined,
  count: number,
  floor = 0.08,
): number[] {
  const n = Math.max(1, Math.floor(count));
  if (!peaks || peaks.length === 0) return Array.from({ length: n }, () => floor);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * peaks.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / n));
    let top = 0;
    for (let j = start; j < end && j < peaks.length; j++) {
      const v = Number(peaks[j]);
      if (Number.isFinite(v) && v > top) top = v;
    }
    out.push(Math.max(floor, Math.min(1, top)));
  }
  return out;
}

export interface Chapter {
  start: number;
  title?: string;
}

/** Chapter starts as percentages along the waveform (the first, at 0, is left out). */
export function chapterTicks(
  chapters: Chapter[] | null | undefined,
  duration: number,
): { left: number; title: string }[] {
  if (!chapters || !Number.isFinite(duration) || duration <= 0) return [];
  return chapters
    .filter((c) => Number.isFinite(c.start) && c.start > 0.5 && c.start < duration)
    .map((c) => ({ left: (c.start / duration) * 100, title: c.title || '' }));
}

/** PodcastIndex chapters JSON ({chapters: [{startTime, title}]}) as Chapters. */
export function parseChapters(json: unknown): Chapter[] {
  const list = (json as { chapters?: unknown })?.chapters;
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => {
      const item = c as { startTime?: unknown; title?: unknown; toc?: unknown };
      return {
        start: Number(item.startTime),
        title: typeof item.title === 'string' ? item.title : '',
        toc: item.toc,
      };
    })
    .filter((c) => Number.isFinite(c.start) && c.toc !== false)
    .map(({ start, title }) => ({ start, title }));
}

/** Fraction of the waveform under a pointer at clientX. */
export function fractionAt(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.max(0, Math.min(1, (clientX - left) / width));
}

// ── the list ───────────────────────────────────────────────────────────────

export interface QueueSummary {
  length: number;
  index: number;
  radio: boolean;
  repeat: 'off' | 'all' | 'one';
  context: string;
}

/** How many tracks come after the current one. */
export function upNextCount(q: { length: number; index: number }): number {
  if (q.length <= 0) return 0;
  return Math.max(0, q.length - Math.max(q.index + 1, 0));
}

/** The line under Up next: "8 up next · then similar tracks". */
export function queueFoot(q: QueueSummary): string {
  const n = upNextCount(q);
  const count = n === 0 ? 'Nothing up next' : `${n} up next`;
  let then: string;
  if (q.repeat === 'all' && q.length > 0) then = 'then from the top';
  else if (q.radio) then = 'then similar tracks';
  else if (n === 0) then = 'playback stops after this';
  else then = 'then playback stops';
  const from = q.context ? ` · from ${q.context}` : '';
  return `${count}${from} · ${then}`;
}

/** "Sleep timer" menu state: Off, "30 min (12:40)", "End of track". */
export function sleepLabel(
  value: number | 'track' | null | undefined,
  endsAt: number,
  now: number,
): string {
  if (value === 'track') return 'End of track';
  if (!value) return 'Off';
  const left = endsAt > now ? Math.ceil((endsAt - now) / 60000) : value;
  return `${left} min left`;
}

export function sleepChoiceLabel(value: number | 'track'): string {
  if (value === 'track') return 'At the end of this track';
  if (value === 0) return 'Off';
  return value >= 60 && value % 60 === 0
    ? `${value / 60} hour${value === 60 ? '' : 's'}`
    : `${value} minutes`;
}

export function formatSpeed(speed: number): string {
  const n = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return `${Number.isInteger(n) ? n.toFixed(0) : String(n)}×`;
}

/** "3 min ago", "2 h ago", "yesterday", "12 Oct". `playedAt` is UTC "YYYY-MM-DD HH:MM:SS". */
export function timeAgo(playedAt: string | null | undefined, now: number): string {
  if (!playedAt) return '';
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(playedAt) ? playedAt : `${playedAt.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor(Math.max(0, now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** Peaks polling: 202 means ask again after this many ms (gives up after six). */
export function peaksRetryDelay(attempt: number): number | null {
  if (attempt >= 6) return null;
  return Math.min(8000, 1500 * 2 ** attempt);
}
