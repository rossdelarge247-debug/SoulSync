/**
 * The stations a profile played last, newest first (the expanded player's
 * Stations tab; HANDOFF 142, 163). The server keeps the profile's list
 * (`GET /api/radio/recent`, written once a station has played for 30 s, so a
 * skim doesn't count); this browser keeps its own copy per profile
 * (`ssRadioRecentStations:<profile id>`), which is the first paint and the
 * fallback, and is merged with the server's when it answers. The copy is per
 * profile because the server's list is: two profiles on one browser never
 * see each other's stations. The old shared key (no profile) is dropped.
 *
 * Only what a row draws and what `play()` needs is kept: the id, the name,
 * the letters, our own logo route, the card's line, and when it was played.
 */

import type { Station } from './radio.types';

/** The old shared key, and the prefix of each profile's own. */
export const RECENT_STATIONS_KEY = 'ssRadioRecentStations';

/** This profile's key, or null while no profile is known (then nothing is kept). */
export function recentStationsKey(profileId: number | string | null | undefined): string | null {
  return profileId == null || profileId === '' ? null : `${RECENT_STATIONS_KEY}:${profileId}`;
}

/** Drop the copy kept before it was per profile: it may hold another profile's stations. */
export function dropSharedRecent(store: Store): void {
  try {
    store?.removeItem?.(RECENT_STATIONS_KEY);
  } catch {
    // storage that can't be written has nothing to drop
  }
}
export const RECENT_STATIONS_MAX = 8;
/** A station counts on the server once it has played this long (the server checks too). */
export const RECENT_AFTER_MS = 30_000;

export type RecentStation = Pick<
  Station,
  | 'id'
  | 'name'
  | 'logo_url'
  | 'logo_text'
  | 'genre'
  | 'kind_label'
  | 'city'
  | 'country'
  | 'source'
  | 'added_by'
> & {
  /** Unix seconds it was last played, when known (older copies have none). */
  played_at?: number;
};

type Store =
  | (Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>)
  | null
  | undefined;

function clean(raw: unknown): RecentStation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.name !== 'string' || !r.name) return null;
  const text = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  return {
    id: r.id,
    name: r.name,
    logo_url: text('logo_url'),
    logo_text: text('logo_text') || undefined,
    genre: text('genre'),
    kind_label: text('kind_label'),
    city: text('city'),
    country: text('country'),
    source: (['built_in', 'directory', 'your_link'].includes(text('source'))
      ? text('source')
      : 'built_in') as Station['source'],
    added_by: text('added_by') || null,
    ...(typeof r.played_at === 'number' && Number.isFinite(r.played_at)
      ? { played_at: r.played_at }
      : {}),
  };
}

/** What's kept, newest first; nothing (not an error) when storage can't be read. */
export function readRecentStations(store: Store, key: string | null): RecentStation[] {
  if (!key) return [];
  try {
    const raw = store?.getItem(key);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: RecentStation[] = [];
    for (const item of list) {
      const s = clean(item);
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out.slice(0, RECENT_STATIONS_MAX);
  } catch {
    return [];
  }
}

function save(store: Store, key: string | null, list: RecentStation[]): void {
  if (!key) return;
  try {
    store?.setItem(key, JSON.stringify(list));
  } catch {
    // a private window: the list lives for this page only
  }
}

/** Put a station at the front (once), keep the newest eight; returns the new list. */
export function rememberStation(
  store: Store,
  key: string | null,
  station: Station | RecentStation,
  now = Date.now(),
): RecentStation[] {
  const entry = clean(station);
  const list = readRecentStations(store, key);
  if (!entry) return list;
  entry.played_at = Math.floor(now / 1000);
  const next = [entry, ...list.filter((s) => s.id !== entry.id)].slice(0, RECENT_STATIONS_MAX);
  save(store, key, next);
  return next;
}

/** The server's answer (`GET /api/radio/recent`'s `stations`) as kept rows; anything malformed is skipped. */
export function serverRecent(raw: unknown): RecentStation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(clean).filter((s): s is RecentStation => s !== null);
}

/**
 * This browser's list and the server's as one, newest first: a station on
 * both takes the later play and the server's words (they're fresher); a
 * station only this browser has (played under 30 s, or before the server
 * kept a list) stays, by its own time; a row with no time goes after the
 * timed ones, in its old order. The newest eight.
 */
export function mergeRecent(local: RecentStation[], server: RecentStation[]): RecentStation[] {
  const byId = new Map<string, { s: RecentStation; at: number; order: number }>();
  const add = (s: RecentStation, order: number, prefer: boolean) => {
    const at = s.played_at ?? -1;
    const had = byId.get(s.id);
    if (!had) return void byId.set(s.id, { s, at, order });
    const words = prefer ? s : had.s;
    const best = Math.max(had.at, at);
    byId.set(s.id, {
      s: { ...words, ...(best >= 0 ? { played_at: best } : {}) },
      at: best,
      order: Math.min(had.order, order),
    });
  };
  local.forEach((s, i) => add(s, i, false));
  server.forEach((s, i) => add(s, local.length + i, true));
  return [...byId.values()]
    .sort((a, b) => b.at - a.at || a.order - b.order)
    .map((x) => x.s)
    .slice(0, RECENT_STATIONS_MAX);
}

/** Keep the merged list as this browser's first paint; returns it. */
export function keepRecentStations(
  store: Store,
  key: string | null,
  list: RecentStation[],
): RecentStation[] {
  const next = list.slice(0, RECENT_STATIONS_MAX);
  save(store, key, next);
  return next;
}

/** A kept station as the radio session's `play()` takes it, until the server's answer replaces it. */
export function recentAsStation(s: RecentStation): Station {
  return {
    kind: 'eclectic',
    description: '',
    homepage: '',
    favourite: false,
    auto_add: false,
    has_now_playing: false,
    has_tracklists: false,
    quality: { codec: '', bitrate_kbps: 0, lossless: false, label: '' },
    tags: [],
    sends_titles: null,
    streams: [],
    ...s,
  };
}
