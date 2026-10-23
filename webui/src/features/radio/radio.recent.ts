/**
 * The stations played in this browser, newest first (the expanded player's
 * "Recent stations", HANDOFF 2026-10-23 radio tray). Kept per browser like the
 * player's expanded state: there is no server list of played stations, and
 * Heard on radio only has the stations something was identified on.
 *
 * Only what a row draws and what `play()` needs is kept: the id, the name,
 * the letters, our own logo route, and the card's line.
 */

import type { Station } from './radio.types';

export const RECENT_STATIONS_KEY = 'ssRadioRecentStations';
export const RECENT_STATIONS_MAX = 8;

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
>;

type Store = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

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
  };
}

/** What's kept, newest first; nothing (not an error) when storage can't be read. */
export function readRecentStations(store: Store): RecentStation[] {
  try {
    const raw = store?.getItem(RECENT_STATIONS_KEY);
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

/** Put a station at the front (once), keep the newest eight; returns the new list. */
export function rememberStation(store: Store, station: Station | RecentStation): RecentStation[] {
  const entry = clean(station);
  const list = readRecentStations(store);
  if (!entry) return list;
  const next = [entry, ...list.filter((s) => s.id !== entry.id)].slice(0, RECENT_STATIONS_MAX);
  try {
    store?.setItem(RECENT_STATIONS_KEY, JSON.stringify(next));
  } catch {
    // a private window: the list lives for this page only
  }
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
