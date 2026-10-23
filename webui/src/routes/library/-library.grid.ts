/**
 * Library → Albums, Genres and Artists: what a tile says and what a selection
 * holds. Pure, so the words and the counting are tested without a page.
 */

import type { StatusTagTone } from '@/components/primitives';

import type { LibraryRelease, SelectionBody } from './-library.types';

/** The tracks a release has in all: the total a source gave, else what you have. */
export function releaseTracks(release: LibraryRelease): number {
  return release.tracks_total ?? release.tracks_owned ?? 0;
}

function tracksLabel(n: number): string {
  return `${n} track${n === 1 ? '' : 's'}`;
}

/**
 * The meta line (7a): "artist · year · format" for an album you have whole,
 * "artist · year · N tracks" for one you have part of or don't have.
 */
export function releaseMeta(release: LibraryRelease, { withArtist = true } = {}): string {
  const parts: string[] = [];
  if (withArtist && release.artist_name) parts.push(release.artist_name);
  if (release.year) parts.push(String(release.year));
  const whole = release.kind === 'library' && release.state !== 'partial';
  if (whole && release.format) parts.push(release.format);
  else {
    const n = releaseTracks(release);
    if (n) parts.push(tracksLabel(n));
  }
  return parts.join(' · ');
}

/** The type in words, for the confirm's list ("Album", "EP"). */
export function releaseType(release: LibraryRelease): string {
  switch (release.album_type) {
    case 'ep':
      return 'EP';
    case 'single':
      return 'Single';
    case 'compilation':
      return 'Compilation';
    default:
      return 'Album';
  }
}

/**
 * The tag, only when the state isn't "you have it" (7a): below the quality
 * target (warning), part of it found or on Wanted (info), not in your library
 * (neutral). An album you have whole has none.
 */
export function releaseTag(release: LibraryRelease): { tone: StatusTagTone; label: string } | null {
  if (release.kind === 'library') {
    if (release.state === 'partial') {
      return {
        tone: 'info',
        label: `${release.tracks_owned} of ${releaseTracks(release)} found`,
      };
    }
    if (release.state === 'below_target') return { tone: 'warning', label: 'Below quality target' };
    return null;
  }
  if (release.wanted) {
    return {
      tone: 'info',
      label: release.wanted.status === 'not_found' ? 'Wanted · not found' : 'Wanted · searching',
    };
  }
  return { tone: 'neutral', label: 'Not in your library' };
}

/** Something to add: you don't have all of it and it isn't on Wanted. */
export function isWantable(release: LibraryRelease): boolean {
  if (release.wanted) return false;
  return release.kind === 'missing' || release.state === 'partial';
}

/** The tracks adding it to Wanted would add. */
export function missingTracks(release: LibraryRelease): number {
  return Math.max(0, releaseTracks(release) - (release.tracks_owned || 0));
}

/** Where a tile opens: the Artist page (2g), at the album when you have it. */
export function releaseHref(release: LibraryRelease): string | null {
  if (release.artist_id === null || release.artist_id === undefined || release.artist_id === '')
    return null;
  const base = `/artist-detail/library/${encodeURIComponent(String(release.artist_id))}`;
  return release.kind === 'library' && release.album_id !== null
    ? `${base}?album=${release.album_id}`
    : base;
}

// ── selection (7c) ────────────────────────────────────────────────────────────

export interface SelectFilter {
  show: string;
  genre: string;
  q: string;
}

/** "Select all N missing": the filter it was pressed under, and its numbers then. */
export interface SelectAll {
  filter: SelectFilter;
  count: number;
  tracks: number;
}

export interface Selection {
  /** Picked by hand, whatever their state. */
  picked: ReadonlyMap<string, LibraryRelease>;
  /** Everything there is to add under a filter, less `excluded`. */
  all: SelectAll | null;
  excluded: ReadonlyMap<string, LibraryRelease>;
}

export const EMPTY_SELECTION: Selection = { picked: new Map(), all: null, excluded: new Map() };

/** Not in your library and not on Wanted: what "missing" buttons add. */
export function isAddableMissing(release: LibraryRelease): boolean {
  return release.kind === 'missing' && !release.wanted;
}

/** Does a release fall under a "Select all" filter (what the server will pick)? */
export function matchesSelectAll(release: LibraryRelease, filter: SelectFilter): boolean {
  if (!isAddableMissing(release)) return false;
  if (filter.show === 'library' && release.kind !== 'library') return false;
  if (filter.show === 'missing' && release.kind !== 'missing') return false;
  if (filter.show === 'below' && !(release.below_target > 0)) return false;
  const keys = release.genres.map((g) => g.toLowerCase());
  if (filter.genre && !keys.includes(filter.genre)) return false;
  const q = filter.q.trim().toLowerCase();
  if (
    q &&
    ![release.title, release.artist_name, ...release.genres].join(' ').toLowerCase().includes(q)
  ) {
    return false;
  }
  return true;
}

export function isChecked(selection: Selection, release: LibraryRelease): boolean {
  if (selection.picked.has(release.id)) return true;
  return Boolean(
    selection.all &&
    !selection.excluded.has(release.id) &&
    matchesSelectAll(release, selection.all.filter),
  );
}

export function toggleRelease(selection: Selection, release: LibraryRelease): Selection {
  const picked = new Map(selection.picked);
  const excluded = new Map(selection.excluded);
  const underAll = Boolean(selection.all && matchesSelectAll(release, selection.all.filter));
  if (isChecked(selection, release)) {
    picked.delete(release.id);
    if (underAll) excluded.set(release.id, release);
  } else if (underAll) {
    excluded.delete(release.id);
  } else {
    picked.set(release.id, release);
  }
  return { picked, all: selection.all, excluded };
}

/** Press "Select all N missing": the filter's set joins what's picked. */
export function selectAll(selection: Selection, all: SelectAll): Selection {
  const picked = new Map([...selection.picked].filter(([, r]) => !matchesSelectAll(r, all.filter)));
  return { picked, all, excluded: new Map() };
}

export function selectionCount(selection: Selection): number {
  const fromAll = selection.all ? Math.max(0, selection.all.count - selection.excluded.size) : 0;
  return selection.picked.size + fromAll;
}

export function selectionTracks(selection: Selection): number {
  let tracks = 0;
  for (const release of selection.picked.values()) tracks += releaseTracks(release);
  if (selection.all) {
    tracks += selection.all.tracks;
    for (const release of selection.excluded.values()) tracks -= missingTracks(release);
  }
  return Math.max(0, tracks);
}

/** The body the bulk routes take for this selection. */
export function selectionBody(selection: Selection): SelectionBody {
  const body: SelectionBody = { release_ids: [...selection.picked.keys()] };
  if (selection.all) {
    body.filter = { ...selection.all.filter };
    if (selection.excluded.size) body.exclude_ids = [...selection.excluded.keys()];
  }
  return body;
}

/** The albums you have in a hand-picked selection (what Remove from library can act on). */
export function ownedIds(selection: Selection): string[] {
  return [...selection.picked.values()].filter((r) => r.kind === 'library').map((r) => r.id);
}

/** Artists behind the hand-picked part of a selection. */
export function selectionArtistIds(selection: Selection): (string | number)[] {
  const ids = new Set<string | number>();
  for (const release of selection.picked.values()) {
    if (release.artist_id !== null && release.artist_id !== undefined) ids.add(release.artist_id);
  }
  return [...ids];
}

/** The toast after a bulk add: what happened to each, in words. */
export function addedSentence(result: {
  added: number;
  already_wanted: number;
  already_have: number;
  failed: number;
  refused: number;
  asks_first: boolean;
}): string {
  const parts: string[] = [];
  const albums = (n: number) => `${n} album${n === 1 ? '' : 's'}`;
  if (result.added) {
    parts.push(
      result.asks_first
        ? `Asked for ${albums(result.added)}; an admin approves them before anything downloads`
        : `Added ${albums(result.added)} to Wanted`,
    );
  }
  if (result.already_wanted) parts.push(`${result.already_wanted} already wanted`);
  if (result.already_have) parts.push(`${result.already_have} you already have`);
  if (result.refused) parts.push(`${result.refused} past your request limit`);
  if (result.failed) parts.push(`${result.failed} couldn't be found on a metadata service`);
  if (!parts.length) return 'Nothing to add.';
  return parts.join(' · ');
}
