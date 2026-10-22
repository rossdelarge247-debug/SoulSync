/**
 * The Soulseek section's logic (boards 2m, 2n), pure so every rule is pinned
 * by unit tests:
 *
 * - **filters**: At your target (the default: copies that meet the quality
 *   target's bar), Any quality, Whole albums (folders only) and Not in my
 *   library (hides what you have every track of), plus today's format filter
 *   and sort;
 * - **grouping**: copies of the same folder (or the same single file) from
 *   different users are one row, best copy first;
 * - **consequence**: what a row means for your library, from the library
 *   check of its tracks: "has the 1 track you're missing", "upgrades your
 *   MP3 320 copy", "on your Wanted list";
 * - **the one primary**: only the first row that completes something you
 *   already want (tracks on Wanted, or the missing tracks of an album you
 *   have) gets the primary button.
 */

import type { AudioQuality, QualityRule } from '@/features/quality/quality.model';

import {
  meetsBar,
  normalizeFormat,
  qualityFromPath,
  qualityLabel as audioLabel,
  qualityRank,
} from '@/features/quality/quality.model';

import type { BasicAlbum, BasicResult, BasicTrack, FormatFilter, SortKey } from './-basic.types';

import { applyFiltersAndSort } from './-basic.helpers';
import { isAlbum } from './-basic.types';

// ── Filters ───────────────────────────────────────────────────────────────

export type QualityFilter = 'target' | 'any';

export interface SoulseekFilters {
  quality: QualityFilter;
  /** Whole albums: folders only. */
  albumsOnly: boolean;
  /** Not in my library: hide rows you already have every track of. */
  notInLibrary: boolean;
  format: FormatFilter;
  sort: SortKey;
  reversed: boolean;
}

export const DEFAULT_SOULSEEK_FILTERS: SoulseekFilters = {
  quality: 'target',
  albumsOnly: false,
  notInLibrary: false,
  format: 'all',
  sort: 'quality_score',
  reversed: false,
};

export const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  quality_score: 'Best copy first',
  relevance: 'Best match first',
  size: 'Biggest first',
  title: 'Name A–Z',
  username: 'User A–Z',
  bitrate: 'Highest bitrate first',
  duration: 'Longest first',
};

// ── Quality ───────────────────────────────────────────────────────────────

export function trackQuality(track: BasicTrack): AudioQuality {
  return {
    format: normalizeFormat(track.quality),
    bitrate: track.bitrate,
    sampleRate: track.sample_rate,
    bitDepth: track.bit_depth,
  };
}

/** A folder meets the bar when every one of its files does. */
export function meetsTargetResult(result: BasicResult, bar: readonly QualityRule[]): boolean {
  if (!isAlbum(result)) return meetsBar(trackQuality(result), bar);
  const tracks = result.tracks ?? [];
  if (!tracks.length) {
    return meetsBar({ format: normalizeFormat(result.dominant_quality) }, bar);
  }
  return tracks.every((track) => meetsBar(trackQuality(track), bar));
}

/** The copy's own quality, for comparing it with the one you have. */
export function resultQuality(result: BasicResult): AudioQuality {
  if (!isAlbum(result)) return trackQuality(result);
  const tracks = result.tracks ?? [];
  const sample = tracks.find((t) => t.bit_depth && t.sample_rate) ?? tracks[0];
  return {
    format: normalizeFormat(result.dominant_quality || sample?.quality),
    bitrate:
      tracks.reduce((low, t) => (t.bitrate && (!low || t.bitrate < low) ? t.bitrate : low), 0) ||
      null,
    sampleRate: sample?.sample_rate ?? null,
    bitDepth: sample?.bit_depth ?? null,
  };
}

// ── Grouping ──────────────────────────────────────────────────────────────

/** Case, punctuation and bracketed tags ("[FLAC 24-96]", "(2026)") don't make a different folder. */
export function normalizeName(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    .replace(/\.(flac|mp3|m4a|ogg|opus|wav|aiff?|wma|dsf|dff|alac|aac)$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The key a folder of this album groups under: a library album finds its row by it. */
export function albumGroupKey(
  artist: string | null | undefined,
  album: string | null | undefined,
): string {
  return `album:${normalizeName(artist)}|${normalizeName(album)}`;
}

export function groupKey(result: BasicResult): string {
  if (isAlbum(result)) return albumGroupKey(result.artist, result.album_title);
  return `track:${normalizeName(result.artist)}|${normalizeName(result.title || result.filename)}`;
}

export interface FileGroup {
  key: string;
  kind: 'folder' | 'file';
  /** The copy the row shows. */
  best: BasicResult;
  /** Every copy, best first (the best included). */
  copies: BasicResult[];
}

function betterCopy(a: BasicResult, b: BasicResult): number {
  return (
    (b.quality_score || 0) - (a.quality_score || 0) ||
    (b.free_upload_slots > 0 ? 1 : 0) - (a.free_upload_slots > 0 ? 1 : 0) ||
    (b.upload_speed || 0) - (a.upload_speed || 0)
  );
}

/**
 * Filter, sort and group. Grouping keeps the sort's order of the best copies,
 * so "Biggest first" orders rows by their best copy's size.
 */
export function groupResults(
  results: readonly BasicResult[],
  filters: SoulseekFilters,
  query: string,
  bar: readonly QualityRule[],
): FileGroup[] {
  const kept = results.filter((result) => {
    if (filters.albumsOnly && !isAlbum(result)) return false;
    if (filters.quality === 'target' && !meetsTargetResult(result, bar)) return false;
    return true;
  });
  const sorted = applyFiltersAndSort(
    kept as BasicResult[],
    { type: 'all', format: filters.format, sort: filters.sort, reversed: filters.reversed },
    query,
  );
  const groups = new Map<string, FileGroup>();
  for (const result of sorted) {
    const key = groupKey(result);
    const group = groups.get(key);
    if (group) group.copies.push(result);
    else
      groups.set(key, {
        key,
        kind: isAlbum(result) ? 'folder' : 'file',
        best: result,
        copies: [result],
      });
  }
  return [...groups.values()].map((group) => {
    const copies = [...group.copies].sort(betterCopy);
    return { ...group, best: copies[0], copies };
  });
}

/**
 * The folder rows a library album below your quality target can point at
 * ("Better copies below", Design HANDOFF 18): folders whose best copy meets
 * the target. Nothing while the target is still loading.
 */
export function betterCopyFolders(
  groups: readonly FileGroup[],
  bar: readonly QualityRule[] | null,
): Set<string> {
  const keys = new Set<string>();
  if (!bar || !bar.length) return keys;
  for (const group of groups) {
    if (group.kind === 'folder' && meetsTargetResult(group.best, bar)) keys.add(group.key);
  }
  return keys;
}

export function countUsers(results: readonly BasicResult[]): number {
  return new Set(results.map((r) => r.username).filter(Boolean)).size;
}

export function countFiles(results: readonly BasicResult[]): number {
  return results.reduce(
    (n, r) => n + (isAlbum(r) ? (r.tracks?.length ?? r.track_count ?? 0) : 1),
    0,
  );
}

// ── Ownership ─────────────────────────────────────────────────────────────

/** One library-check answer for a file, keyed by ownershipKey. */
export interface FileOwnership {
  in_library?: boolean;
  in_wishlist?: boolean;
  file_path?: string;
  bitrate?: number | null;
}

export function ownershipKey(
  title: string | null | undefined,
  artist: string | null | undefined,
): string {
  return `${normalizeName(title)}|${normalizeName(artist)}`;
}

/** The `{name, artist}` the library check takes, for each file of a copy. */
export function checkRowsFor(result: BasicResult): { key: string; name: string; artist: string }[] {
  const tracks = isAlbum(result) ? (result.tracks ?? []) : [result];
  return tracks
    .map((track) => {
      const name = track.title || '';
      const artist = track.artist || (isAlbum(result) ? result.artist : '') || '';
      return { key: ownershipKey(name, artist), name, artist };
    })
    .filter((row) => row.name && row.artist);
}

/** pending: the library check hasn't answered yet; unknown: it couldn't. */
export type ConsequenceKind =
  | 'wanted'
  | 'missing'
  | 'upgrade'
  | 'owned'
  | 'new'
  | 'pending'
  | 'unknown';

export interface Consequence {
  kind: ConsequenceKind;
  /** The coloured part of the meta line; '' while the library check runs. */
  text: string;
  /** Files in the folder you don't have. */
  missing: BasicTrack[];
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** What this copy means for your library. */
export function consequenceFor(
  result: BasicResult,
  owned: ReadonlyMap<string, FileOwnership | null>,
  bar: readonly QualityRule[],
): Consequence {
  const tracks = isAlbum(result) ? (result.tracks ?? []) : [result];
  const rows = checkRowsFor(result);
  if (!rows.length) return { kind: 'unknown', text: '', missing: [] };
  const answers = rows.map((row) => owned.get(row.key));
  if (answers.some((a) => a === undefined)) return { kind: 'pending', text: '', missing: [] };
  // null: the check failed for these, so say nothing rather than guess
  if (answers.some((a) => a === null)) return { kind: 'unknown', text: '', missing: [] };

  const keyed = new Map(rows.map((row, i) => [row.key, answers[i] as FileOwnership]));
  const answerFor = (track: BasicTrack) =>
    keyed.get(ownershipKey(track.title, track.artist || (isAlbum(result) ? result.artist : ''))) ??
    {};
  const have = tracks.filter((t) => answerFor(t).in_library);
  const missing = tracks.filter((t) => !answerFor(t).in_library);
  const wanted = missing.filter((t) => answerFor(t).in_wishlist);
  const folder = isAlbum(result);

  // an album you have most of: the gap is the news, wanted or not
  if (folder && have.length && missing.length) {
    return {
      kind: 'missing',
      text: `has the ${missing.length === 1 ? '1 track' : `${missing.length} tracks`} you're missing`,
      missing,
    };
  }
  if (wanted.length) {
    return {
      kind: 'wanted',
      text: folder
        ? `has ${plural(wanted.length, 'track')} on your Wanted list`
        : 'on your Wanted list',
      missing,
    };
  }
  if (have.length === tracks.length) {
    // the copies you have, worst first
    const yours = have
      .map((t) => {
        const a = answerFor(t);
        return qualityFromPath(a.file_path, a.bitrate ?? null);
      })
      .sort((a, b) => qualityRank(a) - qualityRank(b));
    const worst = yours[0];
    const copy = resultQuality(result);
    const yoursBelow = worst && bar.length > 0 && !meetsBar(worst, bar);
    if (
      worst &&
      yoursBelow &&
      meetsTargetResult(result, bar) &&
      qualityRank(copy) > qualityRank(worst)
    ) {
      const label = audioLabel(worst);
      return {
        kind: 'upgrade',
        text: label ? `upgrades your ${label} copy` : 'upgrades your copy',
        missing,
      };
    }
    return {
      kind: 'owned',
      text: folder ? `you have all ${plural(tracks.length, 'track')}` : 'in your library',
      missing,
    };
  }
  return { kind: 'new', text: 'not in your library', missing };
}

/** Completes something you already want: the rows that may carry the primary. */
export function completesWanted(kind: ConsequenceKind): boolean {
  return kind === 'wanted' || kind === 'missing';
}

/** The key of the one row that gets the primary button, or null. */
export function primaryKey(
  groups: readonly FileGroup[],
  consequences: ReadonlyMap<string, Consequence>,
): string | null {
  const first = groups.find((g) => completesWanted(consequences.get(g.key)?.kind ?? 'pending'));
  return first?.key ?? null;
}

/** Not in my library: drop rows you have every file of (an upgrade still shows). */
export function dropOwned(
  groups: readonly FileGroup[],
  consequences: ReadonlyMap<string, Consequence>,
): FileGroup[] {
  return groups.filter((g) => consequences.get(g.key)?.kind !== 'owned');
}

// ── Row text ──────────────────────────────────────────────────────────────

/** "Folder · 12 tracks" / "Track · in Pale Harbour - Tidewater". */
export function rowMeta(result: BasicResult): string {
  if (isAlbum(result)) {
    const n = result.tracks?.length || result.track_count || 0;
    return `Folder · ${plural(n, 'track')}`;
  }
  return result.album ? `Track · in ${result.album}` : 'Track';
}

/** "free slot · 3.1 MB/s" / "queue of 2 · 800 kB/s". slskd reports bytes a second. */
export function slotLine(result: BasicResult): string {
  const parts: string[] = [];
  if ((result.free_upload_slots || 0) > 0) parts.push('free slot');
  else if ((result.queue_length || 0) > 0) parts.push(`queue of ${result.queue_length}`);
  else parts.push('no free slot');
  const speed = result.upload_speed || 0;
  if (speed > 0) {
    parts.push(
      speed >= 1_000_000
        ? `${(speed / 1_000_000).toFixed(1)} MB/s`
        : `${Math.round(speed / 1000)} kB/s`,
    );
  }
  return parts.join(' · ');
}

export interface RowActions {
  /** The main action's label: Download missing, Upgrade, Download. */
  main: string;
  /** "Download all" beside "Download missing". */
  all: boolean;
}

export function rowActions(group: FileGroup, consequence: Consequence | undefined): RowActions {
  const kind = consequence?.kind ?? 'pending';
  const folder = group.kind === 'folder';
  if (
    folder &&
    (kind === 'missing' || kind === 'wanted') &&
    consequence &&
    consequence.missing.length
  ) {
    const partial =
      consequence.missing.length < (isAlbum(group.best) ? group.best.tracks.length : 1);
    if (partial) return { main: 'Download missing', all: true };
  }
  if (kind === 'upgrade') return { main: 'Upgrade', all: false };
  return { main: 'Download', all: false };
}

/** A folder narrowed to the files you don't have, for "Download missing". */
export function missingOnly(album: BasicAlbum, missing: readonly BasicTrack[]): BasicAlbum {
  const keep = new Set(missing);
  const tracks = album.tracks.filter((t) => keep.has(t));
  return {
    ...album,
    tracks,
    track_count: tracks.length,
    total_size: tracks.reduce((sum, t) => sum + (t.size || 0), 0),
  };
}

/** The quality cell: "FLAC 24/96", "MP3 320". */
export { qualityLabel } from './-basic.helpers';

/** The "At your target" filter's label, short like the board: "At your target (FLAC+)". */
export function targetFilterLabel(targetName: string | null | undefined): string {
  if (!targetName) return 'At your target';
  const short = targetName.replace(/\s+or better$/i, '+');
  return `At your target (${short})`;
}

/** "1.4 GB", "410 MB", "8.5 MB"; '—' when the source didn't say. */
export function fileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}
