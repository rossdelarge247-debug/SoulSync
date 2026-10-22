/**
 * The metadata service's section (board 2m "Spotify"): what it found that you
 * don't have yet, as rows. Pure, so the "what you don't have" rule and the
 * meta lines are pinned by unit tests.
 */

import type { OwnershipState } from './-search.ownership';
import type {
  SearchAlbum,
  SearchArtist,
  SearchLabel,
  SearchPlaylist,
  SearchTrack,
  SourceResults,
} from './-search.types';
import type { SearchType } from './-search.url';

import {
  albumIdentity,
  formatDuration,
  foundArtistLine,
  labelMetaLine,
  rankPlaylists,
  trackIdentity,
} from './-search.helpers';

export type CatalogRow =
  | { kind: 'album'; key: string; item: SearchAlbum; owned: boolean }
  | { kind: 'playlist'; key: string; item: SearchPlaylist }
  | { kind: 'track'; key: string; item: SearchTrack; owned: boolean; wanted: boolean }
  | { kind: 'artist'; key: string; item: SearchArtist }
  | { kind: 'label'; key: string; item: SearchLabel };

export interface CatalogRows {
  /** What the section shows: everything, or only what you don't have. */
  rows: CatalogRow[];
  /** Every row, owned ones included. */
  all: CatalogRow[];
  /** How many owned rows `rows` leaves out. */
  hiddenOwned: number;
}

function isOwned(row: CatalogRow): boolean {
  return (row.kind === 'album' || row.kind === 'track') && row.owned;
}

export function catalogRows({
  results,
  labels,
  ownership,
  type,
  query,
  showOwned,
}: {
  results: SourceResults;
  labels: SearchLabel[];
  ownership: OwnershipState;
  type: SearchType;
  query: string;
  showOwned: boolean;
}): CatalogRows {
  const albums: CatalogRow[] = results.albums.map((item, i) => ({
    kind: 'album',
    key: `album:${albumIdentity(item)}:${i}`,
    item,
    owned: ownership.ownedAlbums.has(albumIdentity(item)),
  }));
  const playlists: CatalogRow[] = rankPlaylists(results.playlists, query).map((item, i) => ({
    kind: 'playlist',
    key: `playlist:${item.id ?? item.name}:${i}`,
    item,
  }));
  const tracks: CatalogRow[] = results.tracks.map((item, i) => {
    const identity = trackIdentity(item);
    const owned = ownership.ownedTracks.has(identity);
    return {
      kind: 'track',
      key: `track:${identity}:${i}`,
      item,
      owned,
      wanted: !owned && ownership.wishlistTracks.has(identity),
    };
  });
  const artists: CatalogRow[] = results.artists.map((item, i) => ({
    kind: 'artist',
    key: `artist:${item.id ?? item.name}:${i}`,
    item,
  }));
  const labelRows: CatalogRow[] = labels.map((item, i) => ({
    kind: 'label',
    key: `label:${item.id ?? item.name}:${i}`,
    item,
  }));

  let all: CatalogRow[];
  if (type === 'artists') all = artists;
  else if (type === 'albums') all = albums;
  else if (type === 'tracks') all = tracks;
  else all = [...albums, ...playlists, ...tracks, ...artists, ...labelRows];

  const rows = showOwned ? all : all.filter((row) => !isOwned(row));
  return { rows, all, hiddenOwned: all.length - rows.length };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? word : `${word}s`}`;
}

export function albumKind(album: SearchAlbum): string {
  if (album.album_type === 'single') return 'Single';
  if (album.album_type === 'ep') return 'EP';
  if (album.album_type === 'compilation') return 'Compilation';
  return 'Album';
}

export function catalogMeta(row: CatalogRow): string {
  switch (row.kind) {
    case 'album': {
      const a = row.item;
      return [
        a.artist,
        albumKind(a),
        a.release_date ? a.release_date.slice(0, 4) : '',
        a.total_tracks ? plural(a.total_tracks, 'track') : '',
        row.owned ? 'in your library' : 'not in your library',
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'playlist': {
      const p = row.item;
      return [
        p.creator ? `Playlist by ${p.creator}` : 'Playlist',
        p.track_count ? plural(p.track_count, 'track') : '',
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'track': {
      const t = row.item;
      return [
        t.artist,
        t.album,
        formatDuration(t.duration_ms),
        row.owned ? 'in your library' : row.wanted ? 'on your Wanted list' : 'not in your library',
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'artist': {
      const line = foundArtistLine(row.item);
      return line === 'Artist' ? 'Artist' : `Artist · ${line}`;
    }
    case 'label':
      return `Label · ${labelMetaLine(row.item)}`;
  }
}

/** The phone's shorter line (board 2n): "Album · 9 tracks · not in your library". */
export function catalogShortMeta(row: CatalogRow): string {
  switch (row.kind) {
    case 'album':
      return [
        albumKind(row.item),
        row.item.total_tracks ? plural(row.item.total_tracks, 'track') : '',
        row.owned ? 'in your library' : 'not in your library',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'track':
      return [
        row.item.artist,
        row.owned ? 'in your library' : row.wanted ? 'on your Wanted list' : 'not in your library',
      ]
        .filter(Boolean)
        .join(' · ');
    default:
      return catalogMeta(row);
  }
}

/** "14 releases · 2 playlists · 5 tracks". */
export function catalogCounts(all: readonly CatalogRow[]): string {
  const count = (kind: CatalogRow['kind']) => all.filter((r) => r.kind === kind).length;
  const parts: string[] = [];
  const releases = count('album');
  if (releases) parts.push(plural(releases, 'release'));
  if (count('playlist')) parts.push(plural(count('playlist'), 'playlist'));
  if (count('track')) parts.push(plural(count('track'), 'track'));
  if (count('artist')) parts.push(plural(count('artist'), 'artist'));
  if (count('label')) parts.push(plural(count('label'), 'label'));
  return parts.join(' · ');
}
