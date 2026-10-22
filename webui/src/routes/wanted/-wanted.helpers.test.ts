import { describe, expect, it } from 'vitest';

import type { WatchlistArtist } from '../watchlist/-watchlist.types';

import {
  aboutIn,
  addedLabel,
  buildFollowedRows,
  buildWantedItems,
  cycleText,
  filterWantedRows,
  findSystemAutomation,
  followedLatest,
  followedMeta,
  foundWhen,
  intervalText,
  lastTryPhrase,
  monthYear,
  parseWantedTrack,
  qualityNames,
  relativeAgo,
  scheduleState,
  sortWantedRows,
  sourceLabel,
  toFoundItems,
  wantedByArtist,
  wantedCounts,
  wantedMeta,
  wantedRows,
  wantedStatus,
  whyItFailed,
  type WishlistApiTrack,
} from './-wanted.helpers';
import { wantedSearchFromWatchlist, wantedSearchFromWishlist } from './-wanted.redirects';
import {
  resolveFollowedFilter,
  resolveFollowedSort,
  resolveFollowKind,
  resolveTab,
  resolveWantedFilter,
  resolveWantedSort,
  wantedSearchSchema,
  type WantedTrack,
} from './-wanted.types';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const sql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function row(
  over: Partial<WishlistApiTrack> & {
    name?: string;
    artist?: string;
    album?: string;
    type?: string;
    total?: number;
  } = {},
): WishlistApiTrack {
  const {
    name = 'Harbour Light',
    artist = 'Pale Harbour',
    album = 'Tidewater',
    type = 'album',
    total = 12,
    ...rest
  } = over;
  return {
    spotify_track_id: `${artist}-${album}-${name}`,
    spotify_data: {
      name,
      artists: [{ name: artist }],
      album: {
        name: album,
        album_type: type,
        total_tracks: total,
        images: [{ url: `${album}.jpg` }],
      },
    },
    retry_count: 0,
    date_added: sql(NOW - 3 * 86_400_000),
    ...rest,
  };
}

function tracks(...rows: WishlistApiTrack[]): WantedTrack[] {
  return rows.map(parseWantedTrack).filter((t): t is WantedTrack => t !== null);
}

describe('search params', () => {
  it('reads defaults and keeps junk out of the route', () => {
    expect(wantedSearchSchema.parse({})).toEqual({});
    const parsed = wantedSearchSchema.parse({
      tab: 'nope',
      page: 0,
      q: { x: 1 },
      settings: 'yes',
      list: 'labels',
    });
    expect(parsed.tab).toBeUndefined();
    expect(parsed.page).toBeUndefined();
    expect(parsed.q).toBeUndefined();
    expect(parsed.settings).toBeUndefined();
    expect(parsed.list).toBe('labels');
    expect(wantedSearchSchema.parse({ page: 3, q: 311, settings: true }).q).toBe('311');
    expect(resolveTab({})).toBe('wanted');
    expect(resolveWantedFilter('found')).toBe('found');
    expect(resolveWantedFilter('new')).toBe('all');
    expect(resolveFollowedFilter('new')).toBe('new');
    expect(resolveWantedSort('artist')).toBe('artist');
    expect(resolveWantedSort('name-asc')).toBe('newest');
    expect(resolveFollowedSort('scan-oldest')).toBe('scan-oldest');
    // the Following tab: Nothing new, newest activity first, the Kind row
    expect(resolveFollowedFilter('quiet')).toBe('quiet');
    expect(resolveFollowedSort(undefined)).toBe('activity');
    expect(resolveFollowedSort('bogus')).toBe('activity');
    expect(wantedSearchSchema.parse({ kind: 'podcasts' }).kind).toBe('podcasts');
    expect(wantedSearchSchema.parse({ kind: 'nonsense' }).kind).toBeUndefined();
    expect(resolveFollowKind({})).toBe('all');
    expect(resolveFollowKind({ list: 'audiobooks' })).toBe('authors');
    expect(resolveFollowKind({ kind: 'labels', list: 'podcasts' })).toBe('labels');
  });

  it('old Wishlist and Watchlist links keep what they pointed at', () => {
    expect(wantedSearchFromWishlist({ q: 'saw', failing: true, media: 'audiobooks' })).toEqual({
      tab: 'wanted',
      q: 'saw',
      filter: 'not-found',
      media: 'audiobooks',
    });
    expect(wantedSearchFromWishlist({ q: '', failing: false, media: 'music' })).toEqual({
      tab: 'wanted',
    });
    expect(
      wantedSearchFromWatchlist({
        tab: 'labels',
        sort: 'scan-newest',
        q: 'x',
        configId: 'sp1',
        detailId: undefined,
        settings: true,
      }),
    ).toEqual({
      tab: 'followed',
      kind: 'labels',
      sort: 'scan-newest',
      q: 'x',
      configId: 'sp1',
      settings: true,
    });
    expect(
      wantedSearchFromWatchlist({ tab: 'artists', sort: 'name-asc', q: '', settings: false }),
    ).toEqual({ tab: 'followed' });
  });
});

describe('wishlist tracks into wanted rows', () => {
  it('unpacks a row, including spotify_data as a JSON string', () => {
    const [t] = tracks(
      row({
        spotify_data: JSON.stringify({ name: 'Xtal', artists: ['Aphex Twin'], album: 'SAW' }),
        retry_count: '4',
        failure_reason: 'No results',
        quality_profile_id: 2,
        source_type: 'watchlist',
      }),
    );
    expect(t).toMatchObject({
      title: 'Xtal',
      artist: 'Aphex Twin',
      album: 'SAW',
      tries: 4,
      lastError: 'No results',
      qualityProfileId: 2,
      sourceType: 'watchlist',
    });
    expect(parseWantedTrack({ spotify_data: 'not json' })).toBeNull();
    expect(parseWantedTrack({ spotify_data: null })).toBeNull();
  });

  it('groups a release with several wanted tracks into one row and leaves a lone track alone', () => {
    const items = buildWantedItems(
      tracks(
        row({
          name: 'Lantern 1',
          artist: 'Saltmarsh',
          album: 'Lantern',
          total: 11,
          retry_count: 2,
        }),
        row({
          name: 'Lantern 2',
          artist: 'saltmarsh',
          album: 'lantern',
          total: 11,
          retry_count: 5,
        }),
        row({ name: 'Harbour Light' }),
        row({ name: 'Night Ferry (Live)', album: 'Night Ferry (Live)', type: 'single', total: 1 }),
        row({ name: 'A', album: 'Kindling', artist: 'Marrow & Pine', type: 'ep', total: 4 }),
        row({ name: 'B', album: 'Kindling', artist: 'Marrow & Pine', type: 'ep', total: 4 }),
      ),
    );
    expect(items.map((i) => [i.kind, i.title, i.trackIds.length])).toEqual([
      ['album', 'Lantern', 2],
      ['track', 'Harbour Light', 1],
      ['single', 'Night Ferry (Live)', 1],
      ['ep', 'Kindling', 2],
    ]);
    // the album's tries are its most-tried track's, and 3+ is "not found yet"
    expect(items[0].tries).toBe(5);
    expect(items[0].status).toBe('not-found');
    expect(items[1].status).toBe('searching');
  });

  it('says what a row is, where it came from and why the last try failed', () => {
    const [album, track, single] = buildWantedItems(
      tracks(
        row({ name: 'F8', artist: 'Saltmarsh', album: 'Ferry Songs', total: 9 }),
        row({ name: 'F9', artist: 'Saltmarsh', album: 'Ferry Songs', total: 9 }),
        row({ retry_count: 6, failure_reason: 'User went offline.', last_attempted: sql(NOW) }),
        row({
          name: 'Slack Water',
          album: 'Slack Water',
          type: 'single',
          total: 1,
          source_type: 'watchlist',
          retry_count: 1,
          failure_reason: 'Added via Download Discography',
        }),
      ),
    );
    expect(wantedMeta(album, 'FLAC or better').map((p) => p.text)).toEqual([
      'Saltmarsh',
      'Album',
      '2 of 9 tracks wanted',
      'FLAC or better',
    ]);
    const trackMeta = wantedMeta(track, '');
    expect(trackMeta.map((p) => p.text)).toEqual([
      'Pale Harbour',
      'Tidewater',
      'Track',
      'last try: user went offline',
    ]);
    expect(trackMeta.at(-1)?.warning).toBe(true);
    expect(trackMeta.find((p) => p.key === 'album')?.wide).toBe(true);
    // an "Added via …" note is why it's on the list, not a failed try
    expect(wantedMeta(single, '').map((p) => p.text)).toEqual([
      'Pale Harbour',
      'Single',
      'from Followed artists',
    ]);
    expect(wantedStatus(track)).toEqual({ text: 'Not found yet · 6 tries', tone: 'neutral' });
    expect(wantedStatus(single)).toEqual({ text: 'Searching · 1 try', tone: 'info' });
    expect(wantedStatus(album)).toEqual({ text: 'Searching', tone: 'info' });
  });

  it('says a thrown-out download in plain words, the rest as written', () => {
    expect(
      lastTryPhrase(
        'File integrity check failed: Incomplete audio: only ~30s actually decodes of a 234s file (13%)',
      ),
    ).toBe('only ~30s of 3:54 played, so it was thrown out');
    expect(
      lastTryPhrase("AcoustID verification failed: mismatch: 'Xtal' by 'Aphex Twin' (score 0.91)"),
    ).toBe('the wrong song came back ("Xtal" by Aphex Twin)');
    expect(lastTryPhrase('Post-processing failed: [WinError 3] cannot find the path')).toBe(
      "downloaded, but its folder couldn't be created",
    );
    expect(lastTryPhrase('No matching track found')).toBe('no match found on your sources');
    expect(lastTryPhrase('User went offline.')).toBe('User went offline.');
    const [track] = buildWantedItems(
      tracks(
        row({
          retry_count: 4,
          failure_reason: 'AcoustID verification failed: fingerprint mismatch',
          last_attempted: sql(NOW),
        }),
      ),
    );
    expect(wantedMeta(track, '').at(-1)?.text).toBe('last try: the wrong song came back');
  });

  it('names a playlist source, not the placeholders', () => {
    expect(sourceLabel('playlist', { playlist_name: 'Sunday Mornings' })).toBe(
      'from Sunday Mornings',
    );
    expect(sourceLabel('playlist', { playlist_name: 'Unknown Playlist' })).toBe('');
    expect(sourceLabel('playlist', { playlist_name: 'Wishlist' })).toBe('');
    expect(sourceLabel('manual', null)).toBe('');
  });

  it('reads the quality profile names, with the default for items without one', () => {
    const names = qualityNames([
      { id: 1, name: 'Lossless', is_default: 1 },
      { id: 2, name: 'MP3 320' },
    ]);
    expect(names.byId.get(2)).toBe('MP3 320');
    expect(names.fallback).toBe('Lossless');
  });
});

describe('filters, sort and counts', () => {
  const items = buildWantedItems(
    tracks(
      row({ name: 'Old', date_added: sql(NOW - 20 * 86_400_000), retry_count: 9 }),
      row({ name: 'New', album: 'Other', date_added: sql(NOW - 86_400_000), artist: 'Aardvark' }),
    ),
  );
  const found = toFoundItems({
    items: [
      {
        id: 'sb',
        title: 'Static Bloom',
        artist: 'Saltmarsh',
        found_at: new Date(NOW - 3_600_000).toISOString(),
      },
      { id: '', title: 'dropped' },
    ],
  });
  const rows = wantedRows(items, found);

  it('counts each filter', () => {
    expect(wantedCounts(items, found)).toEqual({ wanted: 2, searching: 1, notFound: 1, found: 1 });
    expect(wantedByArtist(items).get('pale harbour')).toBe(1);
  });

  it('filters by status and by text', () => {
    expect(filterWantedRows(rows, 'all').length).toBe(3);
    expect(filterWantedRows(rows, 'found').map((r) => r.item.title)).toEqual(['Static Bloom']);
    expect(filterWantedRows(rows, 'not-found').map((r) => r.item.title)).toEqual(['Old']);
    expect(filterWantedRows(rows, 'searching').map((r) => r.item.title)).toEqual(['New']);
    expect(filterWantedRows(rows, 'all', 'aardv').map((r) => r.item.title)).toEqual(['New']);
  });

  it('sorts newest first by default, with finds at their find time', () => {
    expect(sortWantedRows(rows, 'newest').map((r) => r.item.title)).toEqual([
      'Static Bloom',
      'New',
      'Old',
    ]);
    expect(sortWantedRows(rows, 'oldest').map((r) => r.item.title)).toEqual([
      'Old',
      'New',
      'Static Bloom',
    ]);
    expect(sortWantedRows(rows, 'most-tries').map((r) => r.item.title)).toEqual([
      'Old',
      'New',
      'Static Bloom',
    ]);
    expect(sortWantedRows(rows, 'artist').map((r) => r.item.title)).toEqual([
      'New',
      'Old',
      'Static Bloom',
    ]);
  });
});

describe('time in words', () => {
  it('says how long ago', () => {
    expect(relativeAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeAgo(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(relativeAgo(NOW - 3_600_000, NOW)).toBe('1 hour ago');
    expect(relativeAgo(NOW - 86_400_000, NOW)).toBe('yesterday');
    expect(relativeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3 days ago');
    expect(relativeAgo(NOW - 8 * 86_400_000, NOW)).toBe('1 week ago');
    expect(relativeAgo(NOW - 60 * 86_400_000, NOW)).toBe('2 months ago');
    expect(addedLabel(sql(NOW - 7 * 86_400_000), NOW)).toBe('Added 1 week ago');
    expect(addedLabel('', NOW)).toBe('');
  });

  it('reads zone-less server times as UTC', () => {
    // the suite runs in America/Los_Angeles: a local read would be 7h off
    expect(addedLabel(sql(NOW - 2 * 3_600_000), NOW)).toBe('Added 2 hours ago');
  });

  it('says when a scheduled run is', () => {
    expect(aboutIn(30)).toBe('in under a minute');
    expect(aboutIn(20 * 60)).toBe('in about 20 minutes');
    expect(aboutIn(7150)).toBe('in about 2 hours');
    expect(aboutIn(3 * 86_400)).toBe('in about 3 days');
  });

  it('says when a find was, the day and the time apart', () => {
    const at = new Date(NOW);
    at.setHours(14, 2, 0, 0);
    expect(foundWhen(at.getTime(), NOW + 3_600_000)).toEqual({ day: 'today', time: '14:02' });
    expect(foundWhen(at.getTime() - 86_400_000, at.getTime()).day).toBe('yesterday');
    expect(monthYear('2026-03-02')).toBe('Mar 2026');
    expect(monthYear('2025')).toBe('2025');
    expect(monthYear(null)).toBe('');
  });
});

describe('the schedule lines', () => {
  const list = [
    {
      id: 1,
      name: 'Auto-Process Wishlist',
      is_system: 1,
      action_type: 'process_wishlist',
      enabled: 1,
      trigger_config: { interval: 30, unit: 'minutes' },
    },
    { id: 9, name: 'Mine', is_system: 0, action_type: 'process_wishlist', enabled: 1 },
  ];

  it('finds the system automation and its interval', () => {
    expect(findSystemAutomation(list, 'process_wishlist')?.name).toBe('Auto-Process Wishlist');
    expect(findSystemAutomation({ error: 'x' }, 'process_wishlist')).toBeNull();
    expect(intervalText({ interval: 30, unit: 'minutes' })).toBe('every 30 minutes');
    expect(intervalText({ interval: 1, unit: 'hours' })).toBe('every hour');
    expect(intervalText({ interval: 'x', unit: 'hours' })).toBe('');
  });

  it('is off, paused, or says when', () => {
    const automation = findSystemAutomation(list, 'process_wishlist');
    expect(scheduleState({ nextRunSeconds: 7200, automation, paused: true })).toEqual({
      kind: 'paused',
    });
    expect(scheduleState({ nextRunSeconds: 0, automation, paused: false })).toEqual({
      kind: 'off',
    });
    expect(
      scheduleState({
        nextRunSeconds: 60,
        automation: { ...automation!, enabled: 0 },
        paused: false,
      }),
    ).toEqual({ kind: 'off' });
    expect(scheduleState({ nextRunSeconds: 7200, automation, paused: false })).toEqual({
      kind: 'next',
      when: 'in about 2 hours',
      name: 'Auto-Process Wishlist',
      every: 'every 30 minutes',
    });
    expect(cycleText('singles')).toBe('singles and EPs');
  });
});

describe('followed artists', () => {
  function artist(id: number, name: string, over: Partial<WatchlistArtist> = {}): WatchlistArtist {
    return {
      id,
      artist_name: name,
      date_added: '2026-01-01T00:00:00',
      last_scan_timestamp: '2026-10-20T06:00:00',
      created_at: null,
      updated_at: null,
      image_url: null,
      spotify_artist_id: `sp-${id}`,
      itunes_artist_id: null,
      deezer_artist_id: null,
      discogs_artist_id: null,
      musicbrainz_artist_id: null,
      amazon_artist_id: null,
      include_albums: true,
      include_eps: true,
      include_singles: true,
      include_live: false,
      include_remixes: false,
      include_acoustic: false,
      include_compilations: false,
      ...over,
    };
  }
  const summaries = [
    {
      id: 1,
      library_releases: 9,
      latest_release: null,
      last_found: {
        album_name: 'Tidewater',
        found_at: new Date(NOW - 2 * 86_400_000).toISOString(),
        added_to_wanted: true,
      },
      new_release: true,
    },
    {
      id: 2,
      library_releases: 0,
      latest_release: { album_name: 'Driftwood', release_date: '2026-01-14' },
      last_found: null,
      new_release: false,
    },
  ];
  const rows = buildFollowedRows(
    [
      artist(1, 'Pale Harbour'),
      artist(2, 'Low Tide Collective', { include_live: true }),
      artist(3, 'Marrow & Pine', { last_scan_timestamp: null }),
    ],
    summaries,
    new Map([['pale harbour', 5]]),
    NOW,
  );

  it('gives each artist a status, its numbers and its latest release', () => {
    expect(rows.map((r) => r.status)).toEqual(['new', 'quiet', 'unchecked']);
    expect(followedMeta(rows[0])).toBe('9 releases in your library · 5 on Wanted');
    expect(followedMeta(rows[1])).toBe('Nothing in your library yet');
    expect(followedMeta(rows[2])).toBe('');
    expect(followedLatest(rows[0], NOW)).toEqual({
      label: 'Last found',
      album: 'Tidewater',
      when: '2 days ago',
    });
    expect(followedLatest(rows[1], NOW)).toEqual({
      label: 'Latest',
      album: 'Driftwood',
      when: 'Jan 2026',
    });
    expect(followedLatest(rows[2], NOW)).toBeNull();
  });
});

describe('failure copy', () => {
  it('never shows a code alone', () => {
    expect(whyItFailed({ name: 'TimeoutError' })).toBe("SoulSync didn't answer in 10 seconds.");
    expect(whyItFailed({ name: 'HTTPError' })).toBe('SoulSync ran into a problem reading it.');
    expect(whyItFailed(new TypeError('Failed to fetch'))).toBe("SoulSync didn't answer.");
  });
});
