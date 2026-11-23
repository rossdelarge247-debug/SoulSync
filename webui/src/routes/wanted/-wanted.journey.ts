/*
 * Wanted's journey (step 1, the "Wanted journey" canvas: boards 1–6): one
 * status per wanted song, the line that says why, and where each song came
 * from with how far along that source is.
 *
 * The data: the wishlist rows (tries, last try, source), and GET
 * /api/wishlist/journey for what the rows don't know: the live download task,
 * the quarantined attempts, each playlist's library figures and the retry
 * ladder (core/wishlist/journey.py says how each is joined).
 */

import type {
  JourneyResponse,
  JourneyStatus,
  TrackJourney,
  WantedItem,
  WantedTrack,
} from './-wanted.types';

import { WL_FAILING_ATTEMPTS } from '../wishlist/-wishlist.types';

// ---------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 7483 → "7,483". */
export function n(count: number): string {
  return count.toLocaleString('en-GB');
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${n(count)} ${count === 1 ? one : many}`;
}

/** Seconds from now, in words: "in about 4 hours", "in about 7 days". */
export function inAbout(seconds: number): string {
  if (seconds < MINUTE) return 'in under a minute';
  if (seconds < HOUR) return `in about ${plural(Math.round(seconds / MINUTE), 'minute')}`;
  if (seconds < 36 * HOUR) return `in about ${plural(Math.round(seconds / HOUR), 'hour')}`;
  return `in about ${plural(Math.round(seconds / DAY), 'day')}`;
}

/** SQLite's UTC "YYYY-MM-DD HH:MM:SS" (or ISO) in ms; 0 when unreadable. */
function utcMs(value: string): number {
  if (!value) return 0;
  let text = value.trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : 0;
}

// ---------------------------------------------------------------------------
// The live read
// ---------------------------------------------------------------------------

export interface RetryLadder {
  /** tries → seconds to wait after that many failed tries. */
  ladder: Map<number, number>;
  maxCooldown: number;
}

export interface JourneyData {
  tracks: Map<string, TrackJourney>;
  retry: RetryLadder | null;
  /** Files held in quarantine, and the songs they're attempts at. */
  quarantineFiles: number | null;
  quarantineSongs: number | null;
  playlists: NonNullable<JourneyResponse['playlists']>;
}

export const EMPTY_JOURNEY: JourneyData = {
  tracks: new Map(),
  retry: null,
  quarantineFiles: null,
  quarantineSongs: null,
  playlists: [],
};

export function readJourney(response: JourneyResponse | undefined): JourneyData {
  if (!response) return EMPTY_JOURNEY;
  const tracks = new Map<string, TrackJourney>();
  for (const [id, entry] of Object.entries(response.tracks ?? {})) {
    if (!entry) continue;
    const phase = entry.download?.phase;
    const progress = Number(entry.download?.progress);
    tracks.set(id, {
      downloadStatus: entry.download?.status ?? null,
      downloadPhase: phase === 'downloading' || phase === 'searching' ? phase : null,
      progress: Number.isFinite(progress) && entry.download?.progress != null ? progress : null,
      quarantineEntry: entry.quarantine?.entry_id ?? null,
      quarantineCount: Math.max(0, Number(entry.quarantine?.count) || 0),
      quarantineReason: entry.quarantine?.reason ?? '',
      quarantineTrigger: entry.quarantine?.trigger ?? '',
      quarantineMatchedBy: entry.quarantine?.matched_by ?? '',
    });
  }
  let retry: RetryLadder | null = null;
  if (response.retry) {
    const ladder = new Map<number, number>();
    for (const [tries, seconds] of Object.entries(response.retry.ladder ?? {})) {
      const t = Number(tries);
      const s = Number(seconds);
      if (Number.isInteger(t) && Number.isFinite(s)) ladder.set(t, s);
    }
    retry = { ladder, maxCooldown: Math.max(0, Number(response.retry.max_cooldown) || 0) };
  }
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    tracks,
    retry,
    quarantineFiles: count(response.quarantine_total),
    quarantineSongs: count(response.quarantine_songs),
    playlists: response.playlists ?? [],
  };
}

// ---------------------------------------------------------------------------
// One status per song, one per row
// ---------------------------------------------------------------------------

/**
 * A song's status. What's live wins: a file on its way, then a search running
 * now; then an attempt waiting in quarantine; then the tries (three or more
 * without a result is Not found; fewer is Waiting, between tries).
 */
export function trackJourney(track: WantedTrack, live: TrackJourney | undefined): JourneyStatus {
  if (live?.downloadPhase === 'downloading') return 'downloading';
  if (live?.downloadPhase === 'searching') return 'searching';
  if (live?.quarantineEntry) return 'decision';
  if (track.tries >= WL_FAILING_ATTEMPTS) return 'not-found';
  return 'waiting';
}

/** Needs you first: the order a row of several songs takes its one status by,
 *  and the order the list sorts by. */
export const NEEDS_YOU_FIRST: JourneyStatus[] = [
  'decision',
  'not-found',
  'downloading',
  'searching',
  'waiting',
];

export function journeyRank(status: JourneyStatus | 'found'): number {
  const at = NEEDS_YOU_FIRST.indexOf(status as JourneyStatus);
  return at === -1 ? NEEDS_YOU_FIRST.length : at;
}

export type JourneyCounts = Record<JourneyStatus, number>;

export function emptyCounts(): JourneyCounts {
  return { waiting: 0, searching: 0, downloading: 0, decision: 0, 'not-found': 0 };
}

/** The journey fields of a row, from its songs. */
export function itemJourney(
  tracks: WantedTrack[],
  journeys: Map<string, TrackJourney> | undefined,
): Pick<
  WantedItem,
  | 'journey'
  | 'journeyCount'
  | 'trackStates'
  | 'quarantineEntry'
  | 'quarantineCount'
  | 'searchingNow'
> {
  const trackStates = emptyCounts();
  let entry: string | null = null;
  let held = 0;
  let searchingNow = false;
  for (const track of tracks) {
    const live = journeys?.get(track.id);
    trackStates[trackJourney(track, live)] += 1;
    if (!live) continue;
    if (live.downloadPhase === 'searching') searchingNow = true;
    held += live.quarantineCount;
    // entry ids start with the time they were held: the largest is the newest
    if (live.quarantineEntry && (!entry || live.quarantineEntry > entry))
      entry = live.quarantineEntry;
  }
  const journey = NEEDS_YOU_FIRST.find((state) => trackStates[state] > 0) ?? 'waiting';
  return {
    journey,
    journeyCount: trackStates[journey],
    trackStates,
    quarantineEntry: entry,
    quarantineCount: held,
    searchingNow,
  };
}

/** The rows again, each with its status from the live read. */
export function withJourney(
  items: WantedItem[],
  journeys: Map<string, TrackJourney> | undefined,
): WantedItem[] {
  return items.map((item) => ({ ...item, ...itemJourney(item.tracks, journeys) }));
}

// ---------------------------------------------------------------------------
// The line under the tag
// ---------------------------------------------------------------------------

/** Seconds until a song's next try is due (the retry ladder), 0 when due now. */
export function nextTryIn(track: WantedTrack, retry: RetryLadder | null, nowMs: number): number {
  if (!retry || track.tries <= 1) return 0;
  const cooldown = retry.ladder.get(track.tries) ?? retry.maxCooldown;
  const last = utcMs(track.lastTried);
  if (!last || cooldown <= 0) return 0;
  return Math.max(0, Math.round((last + cooldown * 1000 - nowMs) / 1000));
}

/** Why a quarantined attempt was held, short enough for the row. */
export function heldBecause(trigger: string): string {
  switch (trigger) {
    case 'acoustid_unverified':
    case 'acoustid':
      return 'couldn’t confirm it’s the right song';
    case 'integrity':
      return 'the file was damaged';
    case 'bit_depth':
    case 'quality':
      return 'below your quality';
    case 'silence':
      return 'mostly silence';
    default:
      return 'might be the wrong song';
  }
}

export interface DetailContext {
  retry: RetryLadder | null;
  now: number;
  /** "in about 2 hours" for the next scheduled search, '' when none is due. */
  nextSearch: string;
}

/** The one line that says where a song has got to. */
export function trackDetail(
  track: WantedTrack,
  live: TrackJourney | undefined,
  ctx: DetailContext,
): string {
  const state = trackJourney(track, live);
  switch (state) {
    case 'downloading':
      if (live?.downloadStatus === 'queued') return 'Queued to download';
      if (live?.downloadStatus === 'post_processing' || live?.downloadStatus === 'postprocessing')
        return 'Checking and tagging it';
      return live?.progress != null
        ? `${Math.round(live.progress)}% downloaded`
        : 'Downloading now';
    case 'searching':
      return track.tries > 0 ? `Searching now · try ${track.tries + 1}` : 'Searching now';
    case 'decision': {
      const count = live?.quarantineCount ?? 1;
      return `${plural(count, 'try', 'tries')} held back · ${heldBecause(live?.quarantineTrigger ?? '')}`;
    }
    case 'not-found': {
      const wait = nextTryIn(track, ctx.retry, ctx.now);
      return `No match after ${n(track.tries)} searches · ${
        wait > 0 ? `tries again ${inAbout(wait)}` : 'tries again on the next search'
      }`;
    }
    default: {
      if (track.tries === 0)
        return ctx.nextSearch ? `Not tried yet · next search ${ctx.nextSearch}` : 'Not tried yet';
      const wait = nextTryIn(track, ctx.retry, ctx.now);
      const tried = track.tries === 1 ? 'Tried once' : `Tried ${n(track.tries)} times`;
      return wait > 0
        ? `${tried} · next try ${inAbout(wait)}`
        : `${tried} · tries again on the next search`;
    }
  }
}

const STATE_WORDS: Record<JourneyStatus, (count: number) => string> = {
  decision: (c) => `${n(c)} ${c === 1 ? 'needs' : 'need'} your decision`,
  'not-found': (c) => `${n(c)} not found`,
  downloading: (c) => `${n(c)} downloading`,
  searching: (c) => `${n(c)} searching`,
  waiting: (c) => `${n(c)} waiting`,
};

/** "2 need your decision · 3 searching · 5 not found", Needs you first. */
export function statesSentence(counts: JourneyCounts, separator = ' · '): string {
  return NEEDS_YOU_FIRST.filter((state) => counts[state] > 0)
    .map((state) => STATE_WORDS[state](counts[state]))
    .join(separator);
}

/**
 * A row's line: its song's; for a release whose songs are all at one step,
 * its most-tried song's; otherwise how its songs stand ("2 not found · 1
 * waiting").
 */
export function itemDetail(
  item: WantedItem,
  journeys: Map<string, TrackJourney> | undefined,
  ctx: DetailContext,
): string {
  if (item.tracks.length === 1 || item.journeyCount === item.tracks.length) {
    const track = [...item.tracks].sort((a, b) => b.tries - a.tries)[0];
    return trackDetail(track, journeys?.get(track.id), ctx);
  }
  return statesSentence(item.trackStates);
}

// ---------------------------------------------------------------------------
// Where things came from (the From filter and the Sources view)
// ---------------------------------------------------------------------------

const UNNAMED_PLAYLISTS = new Set(['', 'unknown playlist', 'wishlist']);

export type SourceGroup = 'playlists' | 'following' | 'requests';

/** The sources that aren't playlists, in the order the views list them. */
export const FIXED_SOURCES: { key: string; label: string; group: SourceGroup }[] = [
  { key: 'followed-artists', label: 'Followed artists', group: 'following' },
  { key: 'followed-labels', label: 'Followed labels', group: 'following' },
  { key: 'mine', label: 'Requested by me', group: 'requests' },
  { key: 'discography', label: 'Download discography', group: 'requests' },
  { key: 'upgrades', label: 'Upgrades', group: 'requests' },
  { key: 'redownloads', label: 'Re-downloads', group: 'requests' },
  { key: 'playlist', label: 'Playlists without a name', group: 'playlists' },
];

export const SOURCE_GROUPS: { group: SourceGroup; label: string }[] = [
  { group: 'playlists', label: 'Playlists' },
  { group: 'following', label: 'Following' },
  { group: 'requests', label: 'Your requests' },
];

export function playlistName(info: Record<string, unknown> | null): string {
  const name = typeof info?.playlist_name === 'string' ? info.playlist_name.trim() : '';
  return UNNAMED_PLAYLISTS.has(name.toLowerCase()) ? '' : name;
}

/**
 * The key for where a song came from: `playlist:<name>` (lower-cased) for each
 * named playlist, a fixed key for the rest. A request by hand, an album added
 * from its page, a set's and the API's read "Requested by me"; a repair's
 * download with Re-downloads; an upgrade's with Upgrades.
 */
export function sourceKey(type: string, info: Record<string, unknown> | null): string {
  switch (type) {
    case 'playlist': {
      const name = playlistName(info);
      return name ? `playlist:${name.toLowerCase()}` : 'playlist';
    }
    case 'watchlist':
      return 'followed-artists';
    case 'watchlist_label':
      return 'followed-labels';
    case 'discography':
      return 'discography';
    case 'enhance':
      return 'upgrades';
    case 'redownload':
    case 'repair':
      return 'redownloads';
    default:
      return 'mine';
  }
}

/** "from Running", "from Followed artists": the meta line's source. */
export function sourceLabelFor(type: string, info: Record<string, unknown> | null): string {
  const key = sourceKey(type, info);
  if (key.startsWith('playlist:')) return playlistName(info);
  return FIXED_SOURCES.find((source) => source.key === key)?.label ?? 'Requested by me';
}

/** The things from one source; every thing for none. A release counts when
 *  any of its songs came from there. */
export function itemsFrom(items: WantedItem[], from: string | undefined): WantedItem[] {
  if (!from) return items;
  return items.filter((item) =>
    item.tracks.some((track) => sourceKey(track.sourceType, track.sourceInfo) === from),
  );
}

export type PlaylistLibrary =
  | { kind: 'known'; owned: number; total: number }
  | { kind: 'checking'; checked: number; total: number }
  | { kind: 'not-mirrored' };

type PlaylistEntry = NonNullable<JourneyResponse['playlists']>[number];

function playlistEntry(playlists: PlaylistEntry[], name: string): PlaylistEntry | undefined {
  const wanted = name.trim().toLowerCase();
  return playlists.find((playlist) => (playlist.name ?? '').trim().toLowerCase() === wanted);
}

/**
 * How much of a playlist is in the library, when SYNCHRO.S knows: only for a
 * mirrored playlist the sync has checked track by track (the Mirrored
 * playlists page's own rule, libraryOwnedKnown). Otherwise what is known.
 */
export function playlistLibrary(playlists: PlaylistEntry[], name: string): PlaylistLibrary {
  const mirror = playlistEntry(playlists, name)?.mirror;
  const total = Math.max(0, Number(mirror?.total) || 0);
  if (!mirror || total === 0) return { kind: 'not-mirrored' };
  if (!mirror.library_known)
    return { kind: 'checking', checked: Math.max(0, Number(mirror.library_checked) || 0), total };
  return { kind: 'known', owned: Math.min(total, Number(mirror.in_library) || 0), total };
}

function mirrorSource(playlists: PlaylistEntry[], name: string): string {
  const source = playlistEntry(playlists, name)?.mirror?.source ?? '';
  const names: Record<string, string> = {
    spotify: 'Spotify',
    tidal: 'Tidal',
    deezer: 'Deezer',
    youtube: 'YouTube',
    listenbrainz: 'ListenBrainz',
    qobuz: 'Qobuz',
    beatport: 'Beatport',
    file: 'A file',
  };
  return names[source.toLowerCase()] ?? (source ? source[0].toUpperCase() + source.slice(1) : '');
}

export interface SourceSummary {
  key: string;
  label: string;
  group: SourceGroup;
  /** A named playlist's name as written. */
  playlist: string | null;
  /** Songs still wanted from here. */
  wanted: number;
  counts: JourneyCounts;
  library: PlaylistLibrary | null;
  meta: string;
  headline: string;
  /** The bar, left to right: in your library, on its way, waiting, needs you, not found. */
  bar: { owned: number; active: number; waiting: number; decision: number; notFound: number };
}

function distinct(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function namesLine(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${plural(names.length - 2, 'more', 'more')}`;
}

function metaFor(
  key: string,
  tracks: WantedTrack[],
  library: PlaylistLibrary | null,
  source: string,
): string {
  if (key.startsWith('playlist:')) {
    const from = source ? `${source} · ` : '';
    if (library?.kind === 'known') return `${from}mirrored`;
    if (library?.kind === 'checking') return `${from}mirrored, still checking`;
    return 'Not mirrored';
  }
  switch (key) {
    case 'followed-artists':
      return `${plural(distinct(tracks.map((t) => t.artist)).length, 'artist')} · new releases`;
    case 'followed-labels':
      return 'New releases from labels you follow';
    case 'discography':
      return namesLine(distinct(tracks.map((t) => t.artist)));
    case 'upgrades':
      return 'Better quality for songs you have';
    case 'redownloads':
      return 'Songs to download again';
    case 'playlist':
      return 'Playlists that didn’t give a name';
    default:
      return 'Songs and albums you asked for';
  }
}

function headlineFor(key: string, wanted: number, library: PlaylistLibrary | null): string {
  const still = `${n(wanted)} still wanted`;
  if (library?.kind === 'known') {
    const toGo = Math.max(0, library.total - library.owned);
    return `${n(library.owned)} of ${n(library.total)} in your library · ${n(toGo)} to go`;
  }
  if (library?.kind === 'checking') return `${n(library.checked)} checked so far · ${still}`;
  if (key.startsWith('playlist:')) return `${still} · mirror it to count what you have`;
  return still;
}

/**
 * Every source on Wanted with its songs counted by status, grouped as the
 * Sources view lists them (Playlists, Following, Your requests); playlists
 * busiest first, the rest in FIXED_SOURCES order.
 */
export function sourceSummaries(
  items: WantedItem[],
  journeys: Map<string, TrackJourney>,
  playlists: PlaylistEntry[],
): SourceSummary[] {
  const byKey = new Map<string, WantedTrack[]>();
  for (const item of items) {
    for (const track of item.tracks) {
      const key = sourceKey(track.sourceType, track.sourceInfo);
      const list = byKey.get(key);
      if (list) list.push(track);
      else byKey.set(key, [track]);
    }
  }
  const out: SourceSummary[] = [];
  for (const [key, tracks] of byKey) {
    const fixed = FIXED_SOURCES.find((source) => source.key === key);
    const name = key.startsWith('playlist:') ? playlistName(tracks[0].sourceInfo) : null;
    const counts = emptyCounts();
    for (const track of tracks) counts[trackJourney(track, journeys.get(track.id))] += 1;
    const library = name ? playlistLibrary(playlists, name) : null;
    out.push({
      key,
      label: fixed?.label ?? name ?? key,
      group: fixed?.group ?? 'playlists',
      playlist: name,
      wanted: tracks.length,
      counts,
      library,
      meta: metaFor(key, tracks, library, name ? mirrorSource(playlists, name) : ''),
      headline: headlineFor(key, tracks.length, library),
      bar: {
        owned: library?.kind === 'known' ? library.owned : 0,
        active: counts.downloading + counts.searching,
        waiting: counts.waiting,
        decision: counts.decision,
        notFound: counts['not-found'],
      },
    });
  }
  const order = (summary: SourceSummary) => {
    const at = FIXED_SOURCES.findIndex((source) => source.key === summary.key);
    return at === -1 ? -1 : at;
  };
  return out.sort(
    (a, b) =>
      order(a) - order(b) ||
      b.wanted - a.wanted ||
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
}

/** The bar's words for a screen reader: "212 in your library, 2 on their way, …". */
export function barLabel(bar: SourceSummary['bar']): string {
  const bits: string[] = [];
  if (bar.owned) bits.push(`${n(bar.owned)} in your library`);
  if (bar.active) bits.push(`${n(bar.active)} downloading or searching`);
  if (bar.waiting) bits.push(`${n(bar.waiting)} waiting`);
  if (bar.decision)
    bits.push(`${n(bar.decision)} ${bar.decision === 1 ? 'needs' : 'need'} your decision`);
  if (bar.notFound) bits.push(`${n(bar.notFound)} not found`);
  return bits.join(', ') || 'Nothing to show';
}

/** The songs from one source, each with its status, Needs you first. */
export function sourceTracks(
  items: WantedItem[],
  key: string,
  journeys: Map<string, TrackJourney>,
): { track: WantedTrack; status: JourneyStatus }[] {
  const out: { track: WantedTrack; status: JourneyStatus }[] = [];
  for (const item of items) {
    for (const track of item.tracks) {
      if (sourceKey(track.sourceType, track.sourceInfo) !== key) continue;
      out.push({ track, status: trackJourney(track, journeys.get(track.id)) });
    }
  }
  return out.sort(
    (a, b) =>
      journeyRank(a.status) - journeyRank(b.status) ||
      utcMs(b.track.addedAt) - utcMs(a.track.addedAt) ||
      a.track.title.localeCompare(b.track.title),
  );
}

// ---------------------------------------------------------------------------
// Songs or Sources, remembered per profile in this browser
// ---------------------------------------------------------------------------

export type WantedBrowse = 'songs' | 'sources';

const BROWSE_KEY = 'soulsync-wanted-browse';

export function readStoredBrowse(profileId: number): WantedBrowse {
  try {
    return window.localStorage.getItem(`${BROWSE_KEY}:${profileId}`) === 'sources'
      ? 'sources'
      : 'songs';
  } catch {
    return 'songs';
  }
}

export function storeBrowse(profileId: number, browse: WantedBrowse): void {
  try {
    window.localStorage.setItem(`${BROWSE_KEY}:${profileId}`, browse);
  } catch {
    /* private window or blocked storage: the toggle still works for this visit */
  }
}

/** Where a song's Review goes: its attempts in Downloads → Review → Quarantine. */
export function quarantineSearch(entryId: string) {
  return { media: 'music' as const, review: 'quarantine' as const, entry: entryId };
}
