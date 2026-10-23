import type { AudiobookItem } from '../audiobooks/-audiobooks.types';
import type { PodcastShowSummary } from '../podcasts/-podcasts.types';
import type { SearchLabel } from '../search/-search.types';
import type { ProviderSearchResult } from '../watchlist/-watchlist.types';
import type { FollowKindFilter } from './-wanted.types';

import { initials, type FollowKind } from './-wanted.following';
import { plural } from './-wanted.helpers';

/*
 * The Follow… dialog (board 9b, HANDOFF 36): one dialog for all four kinds.
 * Each kind searches its own source and follows through its own route, as
 * the pages that followed them before did (artist watchlist, labels
 * watchlist, podcasts search and watchlist, audiobook authors).
 */

export type { FollowKind };

export const FOLLOW_KINDS: { kind: FollowKind; label: string }[] = [
  { kind: 'artist', label: 'Artist' },
  { kind: 'label', label: 'Label' },
  { kind: 'podcast', label: 'Podcast' },
  { kind: 'author', label: 'Author' },
];

/** The providers the artist search can ask, in the old Follow an artist dialog's order. */
export const ARTIST_SOURCES = [
  { value: 'deezer', label: 'Deezer' },
  { value: 'spotify', label: 'Spotify' },
  { value: 'itunes', label: 'Apple Music' },
  { value: 'discogs', label: 'Discogs' },
  { value: 'musicbrainz', label: 'MusicBrainz' },
] as const;

export type ArtistSource = (typeof ARTIST_SOURCES)[number]['value'];

/** The source named inside the search field, as each route searches it. */
export function sourceName(kind: FollowKind, artistSource: ArtistSource = 'deezer'): string {
  switch (kind) {
    case 'artist':
      return ARTIST_SOURCES.find((s) => s.value === artistSource)?.label ?? 'Deezer';
    case 'label':
      return 'MusicBrainz';
    case 'podcast':
      return 'Apple Podcasts';
    case 'author':
      return 'Audible · Apple';
  }
}

/** "artists", "labels"…: the field's name and the status line's noun. */
export function kindNoun(kind: FollowKind, many = false): string {
  const one = { artist: 'artist', label: 'label', podcast: 'podcast', author: 'author' }[kind];
  return many ? `${one}s` : one;
}

/** Where the Following tab's Kind filter opens the dialog. */
export function kindFromFilter(filter: FollowKindFilter): FollowKind {
  switch (filter) {
    case 'labels':
      return 'label';
    case 'podcasts':
      return 'podcast';
    case 'authors':
      return 'author';
    default:
      return 'artist';
  }
}

export interface FollowResult {
  /** Unique within one search. */
  key: string;
  name: string;
  /** "by … · 48 episodes", "Original production · UK", "12 audiobooks found · latest …". */
  meta: string;
  /** "You have 6" / "You have none", where the source can say; '' otherwise. */
  have: string;
  image: string;
  /** Round art for people (artists, authors), square for labels and podcasts. */
  round: boolean;
  initials: string;
  /** Already followed: a disabled row with the Following tag. */
  following: boolean;
  raw:
    | { kind: 'artist'; result: ProviderSearchResult }
    | { kind: 'label'; label: SearchLabel & { is_watching?: boolean } }
    | { kind: 'podcast'; show: PodcastShowSummary }
    | { kind: 'author'; name: string; cover: string };
}

function lower(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function artistResults(
  results: ProviderSearchResult[],
  followedNames: Set<string>,
): FollowResult[] {
  return results.slice(0, 8).map((result) => ({
    key: `artist:${result.id}`,
    name: result.name,
    meta: result.extra ?? '',
    have: '',
    image: result.image ?? '',
    round: true,
    initials: initials(result.name),
    following: followedNames.has(lower(result.name)),
    raw: { kind: 'artist', result },
  }));
}

export function labelResults(
  labels: (SearchLabel & { is_watching?: boolean; disambiguation?: string })[],
  followedIds: Set<string>,
): FollowResult[] {
  return labels
    .filter((label) => label.id && label.name)
    .slice(0, 8)
    .map((label) => {
      const type = label.type ? label.type[0].toUpperCase() + label.type.slice(1) : '';
      return {
        key: `label:${label.id}`,
        name: label.name!,
        meta: [type, label.area, label.disambiguation].filter(Boolean).join(' · '),
        have: '',
        image: '',
        round: false,
        initials: initials(label.name!),
        following: Boolean(label.is_watching) || followedIds.has(String(label.id)),
        raw: { kind: 'label', label },
      };
    });
}

export function podcastResults(
  shows: PodcastShowSummary[],
  followedFeeds: Set<string>,
): FollowResult[] {
  return shows
    .filter((show) => show.feed_url && show.title)
    .slice(0, 8)
    .map((show) => ({
      key: `podcast:${show.feed_url}`,
      name: show.title,
      meta: [
        show.author ? `by ${show.author}` : '',
        show.episode_count ? plural(show.episode_count, 'episode') : '',
      ]
        .filter(Boolean)
        .join(' · '),
      have: '',
      image: show.artwork_url ?? '',
      round: false,
      initials: initials(show.title),
      following: followedFeeds.has(String(show.feed_url)),
      raw: { kind: 'podcast', show },
    }));
}

/**
 * Authors from an author search: Audible answers with books, so the books
 * are grouped by their first author, most books first. "You have" counts
 * the books the audiobook library already owns.
 */
export function authorResults(
  books: AudiobookItem[],
  followedAuthors: Set<string>,
  query: string,
): FollowResult[] {
  const needle = lower(query);
  const byAuthor = new Map<string, { name: string; books: AudiobookItem[] }>();
  for (const book of books) {
    const name = (book.author_names?.[0] ?? book.authors?.[0]?.name ?? '').trim();
    if (!name) continue;
    const key = lower(name);
    const entry = byAuthor.get(key) ?? { name, books: [] };
    entry.books.push(book);
    byAuthor.set(key, entry);
  }
  return [...byAuthor.values()]
    .sort(
      (a, b) =>
        Number(lower(b.name).includes(needle)) - Number(lower(a.name).includes(needle)) ||
        b.books.length - a.books.length ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 8)
    .map(({ name, books: theirs }) => {
      const latest = [...theirs].sort((a, b) =>
        String(b.release_date ?? '').localeCompare(String(a.release_date ?? '')),
      )[0];
      const owned = theirs.filter((book) => book.owned).length;
      return {
        key: `author:${lower(name)}`,
        name,
        meta: [plural(theirs.length, 'audiobook'), latest?.title ? `latest ${latest.title}` : '']
          .filter(Boolean)
          .join(' · '),
        have: owned ? `You have ${owned}` : 'You have none',
        image: latest?.cover_url ?? '',
        round: true,
        initials: initials(name),
        following: followedAuthors.has(lower(name)),
        raw: { kind: 'author', name, cover: latest?.cover_url ?? '' },
      };
    });
}

/** What the first check takes for an artist, from the discovery lookback setting. */
export function lookbackWords(period: string | undefined): string {
  if (period === 'all') return 'The first check adds everything they’ve released';
  const days = Number(period);
  if (Number.isFinite(days) && days > 0)
    return `The first check adds what came out in the last ${plural(days, 'day')}`;
  return 'The first check adds what came out recently';
}

/**
 * The meta line under the results (9b): when it's checked, and what happens
 * to what's already out. `every` is the kind's automation interval ("every
 * 24 hours"), '' when it isn't checked on a schedule.
 */
export function followNote(
  kind: FollowKind,
  every: string,
  extra: { lookback?: string; episodes?: number | null } = {},
): string {
  const when = every
    ? `Checked ${every} with your other follows.`
    : 'Not checked on a schedule right now; Check now on the Following tab checks it.';
  switch (kind) {
    case 'artist':
      return `${when} ${lookbackWords(extra.lookback)}; after that, only new releases go to Wanted.`;
    case 'label':
      return `${when} Only new releases go to Wanted; its back catalogue stays where it is (its row on the Following tab can ask for it).`;
    case 'podcast':
      return `${when} ${
        extra.episodes
          ? `The ${plural(extra.episodes, 'episode')} already out stay where they are`
          : 'Episodes already out stay where they are'
      }; open the podcast to download any of them.`;
    case 'author':
      return `${when} Only books that come out from today go to Wanted; the ones already out stay where they are.`;
  }
}
