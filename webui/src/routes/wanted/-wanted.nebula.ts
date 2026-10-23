import type { FoundItem, WantedItem } from './-wanted.types';

import { kindLabel, lastTryPhrase, plural, relativeAgo, serverTime } from './-wanted.helpers';

/*
 * Wanted as a nebula (board 9a, HANDOFF 32). Upstream's idea, kept: Wanted
 * seen by artist (upstream's groupWishlistArtists), each artist filed under
 * its worst thing (upstream's groupTrouble), busiest first. The groups are
 * the page's own three words, the same as the Show filters and the list's
 * tags: Searching, Not found yet, Found this week.
 */

export type NebulaGroup = 'searching' | 'not-found' | 'found';

/** Worst first: the order an artist is filed by (not the columns' order). */
const WORST_FIRST: NebulaGroup[] = ['not-found', 'searching', 'found'];

/** The columns, left to right, as the Show filters run. */
export const NEBULA_GROUPS: {
  group: NebulaGroup;
  label: string;
  tone: 'info' | 'neutral' | 'success';
}[] = [
  { group: 'searching', label: 'Searching', tone: 'info' },
  { group: 'not-found', label: 'Not found yet', tone: 'neutral' },
  { group: 'found', label: 'Found this week', tone: 'success' },
];

export interface NebulaArtist {
  /** The lower-cased name: one artist however the rows spell it. */
  key: string;
  name: string;
  group: NebulaGroup;
  /** How many of theirs: wanted things, or what was found for a found-only artist. */
  count: number;
  items: WantedItem[];
  found: FoundItem[];
  /** The first art any of theirs has; '' for the plain circle. */
  image: string;
}

export interface NebulaColumn {
  group: NebulaGroup;
  label: string;
  tone: 'info' | 'neutral' | 'success';
  /** Things in this state (the Show filter's count), not artists. */
  count: number;
  artists: NebulaArtist[];
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function matches(item: { title: string; artist: string; album: string }, needle: string): boolean {
  return [item.title, item.artist, item.album].some((v) => v.toLowerCase().includes(needle));
}

/** Group Wanted by artist and file each artist under its worst state. */
export function nebulaArtists(items: WantedItem[], found: FoundItem[], query = ''): NebulaArtist[] {
  const needle = query.trim().toLowerCase();
  const byArtist = new Map<string, NebulaArtist>();
  const ensure = (name: string) => {
    const shown = name.trim() || 'Unknown artist';
    const key = lower(shown);
    let entry = byArtist.get(key);
    if (!entry) {
      entry = { key, name: shown, group: 'found', count: 0, items: [], found: [], image: '' };
      byArtist.set(key, entry);
    }
    return entry;
  };
  for (const item of items) {
    if (needle && !matches(item, needle)) continue;
    ensure(item.artist).items.push(item);
  }
  for (const item of found) {
    if (needle && !matches(item, needle)) continue;
    ensure(item.artist).found.push(item);
  }
  const artists = [...byArtist.values()];
  for (const artist of artists) {
    const states = new Set<NebulaGroup>([
      ...artist.items.map((item) => item.status),
      ...(artist.found.length ? (['found'] as const) : []),
    ]);
    artist.group = WORST_FIRST.find((group) => states.has(group)) ?? 'found';
    artist.count = artist.items.length || artist.found.length;
    artist.image =
      artist.items.find((item) => item.image)?.image ??
      artist.found.find((item) => item.image)?.image ??
      '';
  }
  // busiest first; the name breaks ties so the field doesn't reshuffle
  return artists.sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

/** The three columns, each with its state's count and its artists. */
export function nebulaColumns(items: WantedItem[], found: FoundItem[], query = ''): NebulaColumn[] {
  const needle = query.trim().toLowerCase();
  const artists = nebulaArtists(items, found, query);
  const shownItems = needle ? items.filter((item) => matches(item, needle)) : items;
  const shownFound = needle ? found.filter((item) => matches(item, needle)) : found;
  return NEBULA_GROUPS.map(({ group, label, tone }) => ({
    group,
    label,
    tone,
    count:
      group === 'found'
        ? shownFound.length
        : shownItems.filter((item) => item.status === group).length,
    artists: artists.filter((artist) => artist.group === group),
  }));
}

/** The circle's size: 96 for five or more, 72 for two to four, 56 for one. */
export function circleSize(count: number): 56 | 72 | 96 {
  if (count >= 5) return 96;
  if (count >= 2) return 72;
  return 56;
}

/** Artists a column shows before "All N artists". */
export const COLUMN_PREVIEW = 4;

function lastTried(item: WantedItem): number {
  return Math.max(0, ...item.tracks.map((track) => serverTime(track.lastTried)));
}

function sentenceCase(text: string): string {
  const plain = text.trim().replace(/[.\s]+$/, '');
  return /^[A-Z][a-z]/.test(plain) ? plain[0].toLowerCase() + plain.slice(1) : plain;
}

/**
 * "Why it's stuck", in one sentence (9a's warning box): the tries, which
 * thing, what went wrong on the last try, and when. From what the list and
 * upstream's panel already read: each row's tries, last error and last try.
 * Null when nothing of theirs is stuck (still in its first searches, no
 * failed try).
 */
export function stuckSentence(artist: NebulaArtist, now: number): string | null {
  const stuck = [...artist.items]
    .filter((item) => item.status === 'not-found' || item.lastError)
    .sort((a, b) => b.tries - a.tries || lastTried(b) - lastTried(a));
  const worst = stuck[0];
  if (!worst) return null;
  const tries = plural(worst.tries, 'try', 'tries');
  const which = artist.items.length > 1 ? ` with ${worst.title}` : '';
  const why = worst.lastError
    ? sentenceCase(lastTryPhrase(worst.lastError))
    : 'none of your sources had a match';
  const when = lastTried(worst);
  return `${tries}${which}: ${why}.${when ? ` Last try ${relativeAgo(when, now)}.` : ''}`;
}

/** The thing the "Accept any quality" action is for: the most-tried stuck one. */
export function stuckItem(artist: NebulaArtist): WantedItem | null {
  return (
    [...artist.items]
      .filter((item) => item.status === 'not-found')
      .sort((a, b) => b.tries - a.tries)[0] ?? null
  );
}

/** "Album · 11 tracks · FLAC or better · added 1 week ago" (a panel row). */
export function panelItemMeta(item: WantedItem, qualityName: string, now: number): string {
  const parts: string[] = [kindLabel(item.kind)];
  const wanted = item.trackIds.length;
  if (wanted > 1) {
    parts.push(
      item.albumTotal && wanted < item.albumTotal
        ? `${wanted} of ${item.albumTotal} tracks wanted`
        : plural(wanted, 'track'),
    );
  }
  if (qualityName) parts.push(qualityName);
  const added = serverTime(item.addedAt);
  if (added) parts.push(`added ${relativeAgo(added, now)}`);
  return parts.join(' · ');
}

/** "Search now for both", "… for all 3", or plain "Search now" for one. */
export function searchAllLabel(count: number): string {
  if (count <= 1) return 'Search now';
  return count === 2 ? 'Search now for both' : `Search now for all ${count}`;
}

/** "Remove both from Wanted", "Remove all 3 from Wanted", "Remove from Wanted". */
export function removeAllLabel(count: number): string {
  if (count <= 1) return 'Remove from Wanted';
  return count === 2 ? 'Remove both from Wanted' : `Remove all ${count} from Wanted`;
}

/** "Want the 1 other release you’re missing" / "… the 4 other releases …". */
export function wantOthersLabel(count: number): string {
  return `Want the ${count} other ${count === 1 ? 'release' : 'releases'} you’re missing`;
}

// ---------------------------------------------------------------------------
// The view, remembered per browser
// ---------------------------------------------------------------------------

export type WantedView = 'list' | 'nebula';

/** localStorage key (an identifier other software never sees; kept as SoulSync's). */
export const VIEW_STORAGE_KEY = 'soulsync_wanted_view';

export function readStoredView(): WantedView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'nebula' ? 'nebula' : 'list';
  } catch {
    return 'list';
  }
}

export function storeView(view: WantedView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    /* private window or blocked storage: the toggle still works for this visit */
  }
}
