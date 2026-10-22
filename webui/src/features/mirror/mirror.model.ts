/**
 * What the "Mirror a playlist" dialog shows and says (boards 2o, 2p), worked
 * out from the service's playlists, the mirrors you already have and a
 * library check of the chosen playlist's tracks. Pure.
 */

import { detectPlaylistUrl, isDetected } from '@/routes/sync/-sync.url-detect';

/** A playlist the dialog can offer, from an account list, a link or a search result. */
export interface MirrorCandidate {
  /** The mirror's source: 'spotify' (your account) or 'deezer' (a public link). */
  source: 'spotify' | 'deezer';
  id: string;
  name: string;
  owner?: string;
  imageUrl?: string;
  trackCount?: number;
  /** The link it came from, kept as the mirror's description like the Sync page does. */
  link?: string;
}

/** One track as the services send it (Spotify objects, Deezer flattened). */
export interface SourceTrack {
  id?: string | number;
  name?: string;
  title?: string;
  artists?: unknown;
  artist?: unknown;
  artist_name?: string;
  album?: unknown;
  duration_ms?: number;
}

export interface OwnershipCounts {
  total: number;
  /** In your library. */
  have: number;
  /** Not in the library but already on Wanted. */
  wanted: number;
  /** What a check would add to Wanted. */
  toAdd: number;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as { name?: unknown; title?: unknown };
    if (typeof record.name === 'string') return record.name;
    if (typeof record.title === 'string') return record.title;
  }
  return '';
}

/** `{name, artist}` for the library check, from any of the services' shapes. */
export function checkRow(track: SourceTrack): { name: string; artist: string } {
  const name = track.name || track.title || '';
  let artist = track.artist_name || '';
  if (!artist) {
    const credits = Array.isArray(track.artists) ? track.artists : [track.artists ?? track.artist];
    artist = textOf(credits[0]);
  }
  return { name, artist };
}

export function ownershipCounts(
  tracks: readonly SourceTrack[],
  check: { tracks?: { in_library?: boolean; in_wishlist?: boolean }[] } | null,
): OwnershipCounts {
  const total = tracks.length;
  let have = 0;
  let wanted = 0;
  (check?.tracks ?? []).forEach((row) => {
    if (row?.in_library) have += 1;
    else if (row?.in_wishlist) wanted += 1;
  });
  return { total, have, wanted, toAdd: Math.max(0, total - have - wanted) };
}

export interface MirroredRow {
  id: number;
  source?: string;
  source_playlist_id?: string | number;
  name?: string;
}

export function isAlreadyMirrored(
  rows: readonly MirroredRow[] | undefined,
  candidate: Pick<MirrorCandidate, 'source' | 'id'>,
): boolean {
  return (rows ?? []).some(
    (row) => row.source === candidate.source && String(row.source_playlist_id) === candidate.id,
  );
}

const count = new Intl.NumberFormat('en-GB');

function plural(n: number, word: string): string {
  return `${count.format(n)} ${n === 1 ? word : `${word}s`}`;
}

/** "by Spotify · 40 tracks" */
export function rowMeta(candidate: MirrorCandidate): string {
  const parts: string[] = [];
  if (candidate.owner) parts.push(`by ${candidate.owner}`);
  if (candidate.trackCount != null) parts.push(plural(candidate.trackCount, 'track'));
  return parts.join(' · ');
}

/** The phone's "48 tracks · you have 31". */
export function shortMeta(candidate: MirrorCandidate, counts: OwnershipCounts | null): string {
  const parts: string[] = [];
  const total = counts?.total ?? candidate.trackCount;
  if (total != null) parts.push(plural(total, 'track'));
  if (counts) parts.push(`you have ${count.format(counts.have)}`);
  return parts.join(' · ');
}

export function filterCandidates(
  list: readonly MirrorCandidate[],
  query: string,
): MirrorCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter(
    (c) => c.name.toLowerCase().includes(q) || (c.owner ?? '').toLowerCase().includes(q),
  );
}

/** The dialog's consequence line, with the real counts. */
export function consequenceText({
  counts,
  keepInSync,
  targetName,
}: {
  counts: OwnershipCounts | null;
  keepInSync: boolean;
  targetName: string | null;
}): string {
  if (!keepInSync) {
    return 'Saved to Mirrored playlists only. Nothing goes to Wanted until you run it from there.';
  }
  if (!counts) return 'Checking which of its tracks you already have…';
  if (counts.total === 0)
    return 'This playlist has no tracks yet. SoulSync checks it again every 24 hours.';
  const already = counts.wanted
    ? ` ${plural(counts.wanted, 'more track')} ${counts.wanted === 1 ? 'is' : 'are'} on Wanted already.`
    : '';
  if (counts.toAdd === 0) {
    return counts.have === counts.total
      ? 'You already have every track. SoulSync keeps checking for new ones every 24 hours.'
      : `Nothing new goes to Wanted.${already}`;
  }
  const at = targetName ? ` at ${targetName}, your quality target` : '';
  return `${plural(counts.toAdd, 'track')} will be added to Wanted${at}, and SoulSync starts looking for ${counts.toAdd === 1 ? 'it' : 'them'} now.${already}`;
}

/** The phone's shorter line (board 2p). */
export function shortConsequence(
  counts: OwnershipCounts | null,
  keepInSync: boolean,
  targetName: string | null,
): string {
  if (!keepInSync) return 'Saved to Mirrored playlists only.';
  if (!counts) return 'Checking which tracks you have…';
  if (counts.toAdd === 0) return 'Nothing new goes to Wanted.';
  return `${plural(counts.toAdd, 'track')} will be added to Wanted${targetName ? ` at ${targetName}` : ''}.`;
}

export type LinkResult =
  | { ok: true; candidate: Pick<MirrorCandidate, 'source' | 'id' | 'link'> }
  | { ok: false; message: string };

/**
 * A pasted link, as something this dialog can mirror. Spotify playlist links
 * need your Spotify connected (the playlist is read through your account);
 * Deezer playlist links are read without one. Everything else goes to Add
 * playlist on Mirrored playlists, which reads more services.
 */
export function readLink(raw: string, spotifyConnected: boolean): LinkResult {
  const detection = detectPlaylistUrl(raw);
  if (!isDetected(detection)) return { ok: false, message: detection.error };
  if (detection.source === 'spotify_public') {
    if (detection.kind && detection.kind !== 'playlist') {
      return {
        ok: false,
        message: 'That is a Spotify album link. Paste a playlist link to mirror it.',
      };
    }
    if (!spotifyConnected) {
      return {
        ok: false,
        message:
          'Spotify isn’t connected, so this dialog can’t read that link. Add playlist on Mirrored playlists reads public Spotify links without it.',
      };
    }
    return {
      ok: true,
      candidate: { source: 'spotify', id: String(detection.id), link: detection.url },
    };
  }
  if (detection.source === 'deezer' && detection.id) {
    return {
      ok: true,
      candidate: { source: 'deezer', id: String(detection.id), link: detection.url },
    };
  }
  return {
    ok: false,
    message:
      'This dialog mirrors Spotify and Deezer playlist links. Use Add playlist on Mirrored playlists for that one.',
  };
}

/** Where a search result playlist would be found again. */
export function candidateLink(source: string, id: string): string | undefined {
  if (source === 'spotify') return `https://open.spotify.com/playlist/${id}`;
  if (source === 'deezer') return `https://www.deezer.com/playlist/${id}`;
  return undefined;
}
