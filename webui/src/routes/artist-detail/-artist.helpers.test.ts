import { describe, expect, it } from 'vitest';

import type { WatchlistArtist } from '../watchlist/-watchlist.types';
import type { Discography } from './-artist-detail.types';

import { applyMusicBrainzDeclutter, defaultFilterState } from './-artist-detail.filters';
import {
  addOutcome,
  artistWantedTracks,
  buildReleases,
  canAddToWanted,
  cardState,
  cardTag,
  countsLine,
  filterReleases,
  findFollowedRow,
  followingText,
  formatLabel,
  headerCounts,
  latestRelease,
  latestText,
  monthYearLong,
  normalizeTitle,
  orderReleases,
  releaseKind,
  releaseMeta,
  shownReleases,
  sourceLinks,
  wantedByRelease,
  wantedThingCount,
  type ArtistRelease,
  type CardState,
  type QualityAlbum,
} from './-artist.helpers';

const NOW = new Date('2026-10-21T12:00:00Z');

function disc(partial: Discography): Discography {
  return { source: 'spotify', ...partial };
}

const DISCOGRAPHY = disc({
  albums: [
    {
      id: 'll',
      title: 'Low Light',
      album_type: 'album',
      release_date: '2021-09-03',
      track_count: 11,
      owned: true,
      track_completion: { owned_tracks: 11, total_tracks: 11, percentage: 100, missing_tracks: 0 },
      library_album_id: 'L-ll',
      library_formats: ['MP3-320'],
    },
    {
      id: 'tw',
      title: 'Tidewater',
      album_type: 'album',
      release_date: '2026-03-02',
      track_count: 12,
      owned: true,
      track_completion: { owned_tracks: 11, total_tracks: 12, percentage: 92, missing_tracks: 1 },
      library_album_id: 'L-tw',
      library_formats: ['FLAC'],
    },
    { id: 'ph', title: 'Pale Harbour', release_date: '2019-02-01', track_count: 9, owned: false },
  ],
  eps: [
    { id: 'hl', title: 'Harbour Light', release_date: '2022-08-19', track_count: 4, owned: null },
  ],
  singles: [
    { id: 'sw', title: 'Slack Water', release_date: '2020-07-03', track_count: 2, owned: false },
    {
      id: 'nfl',
      title: 'Night Ferry (Live)',
      release_date: '2024-11-01',
      track_count: 1,
      owned: false,
    },
  ],
});

const releases = () => orderReleases(buildReleases(DISCOGRAPHY, NOW));
const byTitle = (list: ArtistRelease[], title: string) => list.find((r) => r.title === title)!;

describe('releases', () => {
  it('flattens every bucket with what the cards need', () => {
    const tw = byTitle(releases(), 'Tidewater');
    expect(tw).toMatchObject({
      id: 'tw',
      kind: 'album',
      year: '2026',
      trackCount: 12,
      owned: true,
      ownedTracks: 11,
      totalTracks: 12,
      libraryAlbumId: 'L-tw',
      formats: ['FLAC'],
    });
    expect(byTitle(releases(), 'Harbour Light').owned).toBeNull();
  });

  it('orders albums newest first, then EPs and singles newest first', () => {
    expect(releases().map((r) => r.title)).toEqual([
      'Tidewater',
      'Low Light',
      'Pale Harbour',
      'Night Ferry (Live)',
      'Harbour Light',
      'Slack Water',
    ]);
  });

  it('names the section a release sits in, keeping compilations', () => {
    expect(releaseKind({ album_type: 'compilation' }, 'albums')).toBe('compilation');
    expect(releaseKind({ album_type: 'compile' }, 'albums')).toBe('compilation');
    expect(releaseKind({ album_type: 'single' }, 'eps')).toBe('ep');
    expect(releaseKind({}, 'singles')).toBe('single');
    expect(releaseKind({ album_type: 'ep' }, 'singles')).toBe('ep');
    expect(releaseKind({}, 'albums')).toBe('album');
  });

  it('applies the old filter bar: types, live, and the MusicBrainz declutter that never hides what you own', () => {
    const mb = buildReleases(
      {
        source: 'musicbrainz',
        albums: [
          { id: 'a', title: 'Studio', owned: false },
          { id: 'b', title: 'Concert', secondary_types: ['Live'], owned: false },
          { id: 'c', title: 'Owned live', secondary_types: ['Live'], owned: true },
        ],
        singles: [{ id: 'd', title: 'One', owned: false }],
      },
      NOW,
    );
    const options = applyMusicBrainzDeclutter(defaultFilterState(), 'musicbrainz');
    expect(shownReleases(mb, options).map((r) => r.title)).toEqual(['Studio', 'Owned live', 'One']);
    const noSingles = { ...options, categories: { ...options.categories, singles: false } };
    expect(shownReleases(mb, noSingles).map((r) => r.title)).toEqual(['Studio', 'Owned live']);
    const everything = { ...options, content: { ...options.content, live: true } };
    expect(shownReleases(mb, everything)).toHaveLength(4);
  });
});

describe('Wanted', () => {
  const rows = [
    {
      id: 1,
      spotify_track_id: 'w1',
      spotify_data: {
        name: 'Harbour Bell',
        artists: [{ name: 'Pale Harbour' }],
        album: { id: 'tw', name: 'Tidewater', album_type: 'album' },
      },
      retry_count: 1,
    },
    {
      id: 2,
      spotify_track_id: 'w2',
      // a feature: the page's artist is credited second
      spotify_data: JSON.stringify({
        name: 'Night Ferry (Live)',
        artists: [{ name: 'Someone' }, { name: 'pale harbour' }],
        album: { id: 'other-id', name: 'Night Ferry (Live)' },
      }),
      retry_count: 22,
    },
    {
      id: 3,
      spotify_track_id: 'w3',
      spotify_data: {
        name: 'Elsewhere',
        artists: [{ name: 'Saltmarsh' }],
        album: { name: 'Lantern' },
      },
      retry_count: 0,
    },
  ];

  it("keeps only this artist's tracks, features included", () => {
    const tracks = artistWantedTracks(rows, 'Pale Harbour');
    expect(tracks.map((t) => t.id)).toEqual(['w1', 'w2']);
    expect(wantedThingCount(tracks)).toBe(2);
  });

  it('matches a release by album id or title, and says how the search is going', () => {
    const tracks = artistWantedTracks(rows, 'Pale Harbour');
    const map = wantedByRelease(releases(), tracks);
    expect(map.get(byTitle(releases(), 'Tidewater').key)).toEqual({
      tracks: 1,
      tries: 1,
      status: 'searching',
    });
    // matched by title, not id; 22 tries is past the slowest cadence
    expect(map.get(byTitle(releases(), 'Night Ferry (Live)').key)?.status).toBe('not-found');
    expect(map.has(byTitle(releases(), 'Pale Harbour').key)).toBe(false);
  });

  it('folds case, accents and punctuation when comparing titles', () => {
    expect(normalizeTitle('Sigur Rós — Ágætis Byrjun!')).toBe('sigur ros agætis byrjun');
    expect(normalizeTitle('「夜明け」')).toBe('夜明け');
    expect(normalizeTitle('Salt & Pepper')).toBe('salt and pepper');
  });
});

describe('card states', () => {
  const quality = new Map<string, QualityAlbum>([
    ['L-ll', { id: 'L-ll', tracks: 11, below_target: 11, formats: ['MP3 320'] }],
  ]);

  it('reads In your library, or Below quality target from the joined album', () => {
    const ll = byTitle(releases(), 'Low Light');
    expect(cardState(ll, undefined, null, false)).toEqual({ kind: 'owned', below: 0 });
    const state = cardState(ll, undefined, quality, false);
    expect(state).toEqual({ kind: 'owned', below: 11 });
    expect(cardTag(state)).toEqual({ text: 'Below quality target', tone: 'warning' });
    expect(cardTag(state, true)?.text).toBe('Below target');
    expect(cardTag({ kind: 'owned', below: 0 })?.text).toBe('In your library');
    expect(cardTag({ kind: 'owned', below: 0 }, true)?.text).toBe('In library');
  });

  it('gives a partly complete album its progress and what Wanted is doing about the rest', () => {
    const tw = byTitle(releases(), 'Tidewater');
    const searching = cardState(tw, { tracks: 1, tries: 1, status: 'searching' }, null, false);
    expect(searching).toEqual({
      kind: 'partial',
      owned: 11,
      total: 12,
      wanted: { tracks: 1, tries: 1, status: 'searching' },
    });
    expect(cardTag(searching)).toEqual({ text: '11 of 12 · Searching', tone: 'info' });
    expect(cardTag(searching, true)?.text).toBe('11 of 12');
    const notFound = cardState(tw, { tracks: 1, tries: 9, status: 'not-found' }, null, false);
    expect(cardTag(notFound)?.text).toBe('11 of 12 · not found yet');
    const alone = cardState(tw, undefined, null, false);
    expect(cardTag(alone)?.text).toBe('11 of 12 in your library');
    expect(canAddToWanted(alone)).toBe(true);
    expect(canAddToWanted(searching)).toBe(false);
  });

  it('says Wanted · Searching / not found yet for a wanted release', () => {
    const sw = byTitle(releases(), 'Slack Water');
    const state = cardState(sw, { tracks: 2, tries: 2, status: 'searching' }, null, false);
    expect(cardTag(state)).toEqual({ text: 'Wanted · Searching', tone: 'info' });
    expect(
      cardTag(cardState(sw, { tracks: 2, tries: 30, status: 'not-found' }, null, false))?.text,
    ).toBe('Wanted · not found yet');
  });

  it('offers Add to Wanted for a release neither owned nor wanted, and reads as wanted while one is sent', () => {
    const ph = byTitle(releases(), 'Pale Harbour');
    const state = cardState(ph, undefined, null, false);
    expect(state).toEqual({ kind: 'missing' });
    expect(cardTag(state)).toBeNull();
    expect(canAddToWanted(state)).toBe(true);
    expect(cardState(ph, undefined, null, true)).toMatchObject({
      kind: 'wanted',
      wanted: { status: 'searching' },
    });
  });

  it('says it is still checking, with a word, until the library answers', () => {
    const state = cardState(byTitle(releases(), 'Harbour Light'), undefined, null, false);
    expect(state).toEqual({ kind: 'checking' });
    expect(cardTag(state)?.text).toBe('Checking your library…');
  });

  it('writes the meta line as the board does', () => {
    const list = releases();
    const ll = byTitle(list, 'Low Light');
    expect(releaseMeta(ll, { kind: 'owned', below: 0 })).toBe('2021 · Album · 11 tracks · MP3 320');
    expect(releaseMeta(ll, { kind: 'owned', below: 0 }, true)).toBe('2021 · Album · MP3 320');
    const tw = byTitle(list, 'Tidewater');
    expect(releaseMeta(tw, cardState(tw, undefined, null, false))).toBe('2026 · Album · 12 tracks');
    expect(releaseMeta(byTitle(list, 'Night Ferry (Live)'), { kind: 'missing' })).toBe(
      '2024 · Single',
    );
    expect(formatLabel(['FLAC', 'MP3-320'])).toBe('FLAC and 1 more');
  });

  it('filters: Albums are albums, Missing is anything not fully in the library', () => {
    const list = releases();
    const states = new Map<string, CardState>(
      list.map((r) => [r.key, cardState(r, undefined, null, false)]),
    );
    const stateOf = (r: ArtistRelease) => states.get(r.key)!;
    expect(filterReleases(list, 'albums', stateOf).map((r) => r.title)).toEqual([
      'Tidewater',
      'Low Light',
      'Pale Harbour',
    ]);
    expect(filterReleases(list, 'missing', stateOf).map((r) => r.title)).toEqual([
      'Tidewater',
      'Pale Harbour',
      'Night Ferry (Live)',
      'Slack Water',
    ]);
    expect(filterReleases(list, 'all', stateOf)).toHaveLength(list.length);
  });
});

describe('the header', () => {
  it('counts releases, what you have, what is wanted and your tracks', () => {
    const list = releases();
    const wanted = new Map([
      [byTitle(list, 'Slack Water').key, { tracks: 2, tries: 1, status: 'searching' as const }],
    ]);
    const states = new Map<string, CardState>(
      list.map((r) => [r.key, cardState(r, wanted.get(r.key), null, false)]),
    );
    const counts = headerCounts(list, states, 132);
    expect(counts).toEqual({ releases: 6, inLibrary: 2, onWanted: 1, tracks: 132, checking: true });
    expect(countsLine(counts, false)).toBe(
      '6 releases · 2 in your library · 1 on Wanted · 132 tracks',
    );
    expect(countsLine(counts, false, true)).toBe('6 releases · 2 in library · 1 wanted');
  });

  it('says not in your library for a source artist, and checking before anything is known', () => {
    const counts = { releases: 1, inLibrary: 0, onWanted: 0, tracks: null, checking: false };
    expect(countsLine(counts, true)).toBe('1 release · not in your library · 0 on Wanted');
    expect(countsLine({ ...counts, checking: true }, false)).toBe(
      '1 release · checking your library… · 0 on Wanted',
    );
  });

  it('names the latest release with its month', () => {
    const latest = latestRelease(releases())!;
    expect(latestText(latest)).toBe('Tidewater, March 2026');
    expect(monthYearLong('2025-03-14T10:00:00')).toBe('March 2025');
    expect(monthYearLong('2019')).toBe('2019');
    expect(monthYearLong('soon')).toBe('');
  });

  it('links the services SoulSync matched, linkable ones only', () => {
    expect(
      sourceLinks({ spotify_artist_id: 'sp1', musicbrainz_id: 'mb1', amazon_id: 'az' }).map(
        (l) => l.label,
      ),
    ).toEqual(['Spotify', 'MusicBrainz']);
  });

  it("finds the artist's followed row by a shared provider id, else by name", () => {
    const row = (extra: Partial<WatchlistArtist>) =>
      ({ id: 1, artist_name: 'Other', date_added: '2025-03-14', ...extra }) as WatchlistArtist;
    const rows = [
      row({ id: 1, deezer_artist_id: 'dz9' }),
      row({ id: 2, artist_name: 'Pale Harbour' }),
    ];
    expect(findFollowedRow(rows, { name: 'X', deezer_id: 'dz9' }, null)?.id).toBe(1);
    expect(findFollowedRow(rows, { name: 'pale harbour' }, null)?.id).toBe(2);
    expect(findFollowedRow(rows, { name: 'Nobody' }, null)).toBeNull();
    expect(followingText(rows[0])).toBe('Following since March 2025');
    expect(followingText(null)).toBe('Following');
  });
});

describe('what an add came to', () => {
  it('is fine when tracks were added or were already queued', () => {
    expect(addOutcome({ status: 'done', tracks_added: 3 })).toEqual({ ok: true, reason: '' });
    expect(addOutcome({ status: 'done', tracks_skipped: 2 }).ok).toBe(true);
  });

  it('says why nothing was added', () => {
    expect(addOutcome({ status: 'error', message: 'Album not found' })).toEqual({
      ok: false,
      reason: 'Album not found',
    });
    expect(addOutcome({ status: 'done', tracks_skipped_owned: 4 }).reason).toBe(
      'you already have every track',
    );
    expect(addOutcome({ status: 'done', tracks_skipped_filter: 1 }).reason).toMatch(/filters/);
    expect(addOutcome({ status: 'done', tracks_skipped_artist: 1 }).reason).toMatch(
      /other artists/,
    );
    expect(addOutcome({ status: 'done' }).reason).toMatch(/no tracks/);
  });
});
