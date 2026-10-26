/** Words and small pure helpers for Library → Sets (boards 22a–22i, 22r–22s). */
import type {
  MatchCounts,
  MatchRow,
  MixResult,
  SetKind,
  SetRow,
  SetSummary,
  SourceName,
  SourceStates,
} from './sets.api';

export const SOURCE_NAMES: Record<SourceName, string> = {
  mixesdb: 'MixesDB',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
};

export const KIND_TAGS: Record<SetKind, string> = {
  suggested: 'Suggested',
  famous: 'Famous mix',
  hand: 'By hand',
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "91 min" (up to two hours, as 22c says it), then "2 h 4 min", "2 h". */
export function lengthWords(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "16 tracks · 91 min": a Your sets row's second line. */
export function setRowMeta(tracks: number, seconds: number): string {
  return [plural(tracks, 'track'), seconds ? lengthWords(seconds) : ''].filter(Boolean).join(' · ');
}

/**
 * The draft's meta line (22c): "16 tracks · 91 min · 118–127 BPM · 14 smooth
 * steps, 1 jump · 3 locked"; steps not known yet are counted too (22n).
 */
export function metaLine(s: SetSummary): string {
  const parts = [plural(s.tracks, 'track')];
  if (s.seconds) parts.push(lengthWords(s.seconds));
  if (s.bpm_min !== null && s.bpm_max !== null)
    parts.push(s.bpm_min === s.bpm_max ? `${s.bpm_min} BPM` : `${s.bpm_min}–${s.bpm_max} BPM`);
  const steps = [];
  if (s.smooth) steps.push(plural(s.smooth, 'smooth step'));
  if (s.jumps) steps.push(plural(s.jumps, 'jump'));
  if (s.unknown) steps.push(`${s.unknown.toLocaleString()} not known yet`);
  if (steps.length) parts.push(steps.join(', '));
  if (s.locked) parts.push(`${s.locked.toLocaleString()} locked`);
  return parts.join(' · ');
}

/** The phone's shorter meta (22d): "16 tracks · 91 min · 14 smooth, 1 jump · 3 locked". */
export function metaLineShort(s: SetSummary): string {
  const parts = [plural(s.tracks, 'track')];
  if (s.seconds) parts.push(lengthWords(s.seconds));
  const steps = [];
  if (s.smooth) steps.push(`${s.smooth} smooth`);
  if (s.jumps) steps.push(plural(s.jumps, 'jump'));
  if (s.unknown) steps.push(`${s.unknown} not known`);
  if (steps.length) parts.push(steps.join(', '));
  if (s.locked) parts.push(`${s.locked} locked`);
  return parts.join(' · ');
}

/** "You own 14 of 22" (IDs aren't in "of"). */
export function ownLine(c: MatchCounts): string {
  return `You own ${c.owned.toLocaleString()} of ${c.of.toLocaleString()}`;
}

/** "3 more in another version · 5 missing". */
export function ownRest(c: MatchCounts): string {
  const parts = [];
  if (c.version) parts.push(`${c.version.toLocaleString()} more in another version`);
  if (c.missing) parts.push(`${c.missing.toLocaleString()} missing`);
  return parts.join(' · ');
}

/** "today", "yesterday", "3 days ago", "last week", "2 weeks ago", "4 months ago". */
export function whenWords(at: number | string | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined || at === '') return '';
  const ms = typeof at === 'number' ? at * 1000 : Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "2019-05-12" -> "12 May 2019"; a year stays a year. */
export function dateWords(date: string | null | undefined): string {
  if (!date) return '';
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(date);
  if (!m) return date;
  if (!m[2]) return m[1];
  const month = MONTHS[Number(m[2]) - 1] ?? '';
  return m[3] ? `${Number(m[3])} ${month} ${m[1]}` : `${month} ${m[1]}`;
}

/** A result's meta (22f): "12 May 2019 · 22 tracks · MixesDB", "Mix CD, 2020 · MusicBrainz". */
export function resultMeta(r: MixResult): string {
  const when =
    r.kind === 'cd' ? `Mix CD${r.date ? `, ${r.date.slice(0, 4)}` : ''}` : dateWords(r.date);
  return [when, r.tracks ? plural(r.tracks, 'track') : '', SOURCE_NAMES[r.source]]
    .filter(Boolean)
    .join(' · ');
}

/** Once under the match (22f): "Tracklist from MixesDB · edited 2 weeks ago". */
export function sourceLine(source: SourceName, edited?: string | null, now = Date.now()): string {
  const when = edited ? whenWords(edited, now) : '';
  return [`Tracklist from ${SOURCE_NAMES[source]}`, when ? `edited ${when}` : '']
    .filter(Boolean)
    .join(' · ');
}

/** "Searched MixesDB, MusicBrainz and Discogs." */
export function searchedLine(states: SourceStates): string {
  const asked = (Object.keys(SOURCE_NAMES) as SourceName[]).filter(
    (s) => states[s]?.state !== 'off',
  );
  if (!asked.length) return '';
  const names = asked.map((s) => SOURCE_NAMES[s]);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Searched ${list}.`;
}

/** 22r's Notice title: "MixesDB can't be reached" / "MixesDB and Discogs can't be reached". */
export function downNames(states: SourceStates): SourceName[] {
  return (Object.keys(SOURCE_NAMES) as SourceName[]).filter((s) => states[s]?.state === 'down');
}

export function namesList(names: SourceName[]): string {
  const words = names.map((s) => SOURCE_NAMES[s]);
  return words.length < 2
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** What one source's absence leaves out, for 22r's Notice. */
export function downMissing(names: SourceName[]): string {
  const mixes = names.includes('mixesdb');
  const cds = names.includes('musicbrainz') || names.includes('discogs');
  if (mixes && !cds) return 'so radio and club mixes are missing below. Mix CDs are here.';
  if (cds && !mixes) return 'so some mix CDs are missing below.';
  return 'so some mixes are missing below.';
}

/** "Want the Dub", "Want the remix": the row's second choice (22f). */
export function wantLabel(version: string | null | undefined): string {
  const v = (version || '').trim();
  if (!v || v === 'the original') return 'Want the original';
  if (/\bremix\b/i.test(v) && v.split(/\s+/).length > 1) return 'Want the remix';
  return `Want the ${v}`;
}

/** "You have the Original Mix" / "You have the Saltmarsh Remix". */
export function haveLine(have: string | null | undefined): string {
  const v = (have || '').trim();
  if (!v || v === 'the original') return 'You have the Original Mix';
  return `You have the ${v}`;
}

/** The tracklist's rows as a set keeps them (Save as mix). */
export function rowsFromMatch(rows: MatchRow[], wants: Record<number, boolean> = {}): SetRow[] {
  return rows.map((r, i) => ({
    track_id: r.track && r.state !== 'missing' ? r.track.id : null,
    artist: r.artist,
    title: r.title,
    at: r.at || null,
    state: r.state,
    want: wants[i] ? 'wanted' : 'yours',
    version: r.state === 'version' ? (r.want_version ?? null) : null,
    mbid: r.mbid ?? null,
    raw: r.raw ?? null,
  }));
}

/**
 * Move one row (Move…, drag, Move up/down): a new list. Locked rows hold
 * their places: a locked row doesn't move, and moving another row never
 * shifts one. The unlocked rows fill the places between them in their new
 * order; a drop on a locked row's place lands on the nearest free place.
 */
export function moveRow<T extends { locked?: boolean | null }>(
  rows: T[],
  from: number,
  to: number,
): T[] {
  if (from === to || from < 0 || from >= rows.length || rows[from]?.locked) return rows;
  const free = rows.map((r, i) => (r.locked ? -1 : i)).filter((i) => i >= 0);
  const target = Math.max(0, Math.min(rows.length - 1, to));
  // the free place nearest the target, looking the way the row moves first
  let slot = free.indexOf(target);
  if (slot < 0) {
    const ahead = target > from ? free.filter((i) => i > target) : free.filter((i) => i < target);
    const behind = target > from ? free.filter((i) => i < target) : free.filter((i) => i > target);
    const pick = target > from ? (behind.at(-1) ?? ahead[0]) : (behind[0] ?? ahead.at(-1));
    slot = free.indexOf(pick ?? from);
  }
  const order = free.map((i) => rows[i]);
  const [row] = order.splice(free.indexOf(from), 1);
  order.splice(slot, 0, row);
  const next = rows.slice();
  free.forEach((place, k) => {
    next[place] = order[k];
  });
  return next;
}

/** The prefixes a mix's "open it there" link may start with (the server keeps the same list). */
export const SOURCE_LINK_PREFIXES = [
  'https://www.mixesdb.com/w/',
  'https://www.mixes.wiki/w/',
  'https://musicbrainz.org/release/',
  'https://www.discogs.com/release/',
] as const;

/** A source link safe to use as an href, or null. */
export function safeSourceLink(url: string | null | undefined): string | null {
  if (!url || url.length > 500) return null;
  return SOURCE_LINK_PREFIXES.some((p) => url.startsWith(p)) ? url : null;
}

/* ── energy shapes (22a's six) ───────────────────────────────────────── */

export type ShapeKey = 'steady' | 'build' | 'build-melodic' | 'peak-middle' | 'waves' | 'wind-down';

/** Energy 1–10 at a fraction of the set (0–1), for the dashed "asked for" line. */
export const SHAPES: Record<ShapeKey, { name: string; at: (t: number) => number }> = {
  steady: { name: 'Steady', at: () => 5 },
  build: { name: 'Build', at: (t) => 3 + 6 * t },
  'build-melodic': {
    name: 'Build, end melodic',
    at: (t) => (t < 0.7 ? 3 + 5 * (t / 0.7) : 8 - 3.5 * ((t - 0.7) / 0.3)),
  },
  'peak-middle': { name: 'Peak in the middle', at: (t) => 3 + 6 * Math.sin(Math.PI * t) },
  waves: { name: 'Waves', at: (t) => 5 + 2.5 * Math.sin(4 * Math.PI * t - Math.PI / 2) },
  'wind-down': { name: 'Wind down', at: (t) => 8 - 5 * t },
};

export function isShape(value: unknown): value is ShapeKey {
  return typeof value === 'string' && value in SHAPES;
}

/** A name for a new empty set: "New set 24 October". */
export function newSetName(now = new Date()): string {
  return `New set ${now.getDate()} ${MONTHS[now.getMonth()]}`;
}
