import { describe, expect, it } from 'vitest';

import type {
  AudiobookFollowedAuthor,
  AudiobookWishlistEntry,
} from '../audiobooks/-audiobooks.types';
import type {
  WatchlistArtist,
  WatchlistLabel,
  WatchlistPodcast,
} from '../watchlist/-watchlist.types';
import type { WantedItem } from './-wanted.types';

import {
  artistRow,
  authorRow,
  booksFor,
  filterFollowing,
  initials,
  kindCounts,
  labelRow,
  ofKind,
  podcastRow,
  sortFollowing,
  statusCounts,
  wantedByLabel,
  type FollowingContext,
} from './-wanted.following';
import { buildFollowedRows } from './-wanted.helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const sql = (ms: number) => new Date(NOW - ms).toISOString().slice(0, 19).replace('T', ' ');
const iso = (ms: number) => new Date(NOW - ms).toISOString().slice(0, 19) + 'Z';
const secs = (ms: number) => Math.floor((NOW - ms) / 1000);

const ctx: FollowingContext = {
  now: NOW,
  nextArtistCheck: 'in about 9 hours',
  nextPodcastCheck: 'in about 40 minutes',
  nextAuthorCheck: '',
  checkingArtist: '',
};

function artist(id: number, name: string, over: Partial<WatchlistArtist> = {}): WatchlistArtist {
  return {
    id,
    artist_name: name,
    date_added: iso(200 * DAY),
    last_scan_timestamp: iso(DAY),
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

function label(over: Partial<WatchlistLabel> = {}): WatchlistLabel {
  return {
    id: 1,
    musicbrainz_label_id: 'mb-hessle',
    discogs_label_id: null,
    label_name: 'Hessle Audio',
    source: 'musicbrainz',
    backlog: false,
    date_added: sql(40 * DAY),
    last_scan_timestamp: sql(DAY),
    ...over,
  };
}

function wanted(over: Partial<WantedItem>): WantedItem {
  return {
    key: 'k',
    kind: 'album',
    title: 'HES053 A1',
    artist: 'Bruce',
    album: 'HES053',
    image: '',
    tracks: [],
    trackIds: [],
    albumTotal: 4,
    addedAt: sql(DAY),
    tries: 0,
    lastError: '',
    sourceType: 'watchlist_label',
    sourceInfo: { label_mbid: 'mb-hessle', label_name: 'Hessle Audio' },
    qualityProfileId: null,
    status: 'searching',
    ...over,
  };
}

function podcast(over: Partial<WatchlistPodcast> = {}): WatchlistPodcast {
  return {
    id: 1,
    feed_url: 'https://feeds.example.com/exchange',
    itunes_id: 761,
    title: 'Resident Advisor Exchange',
    author: 'Resident Advisor',
    description: 'Conversations',
    artwork_url: 'https://img/ra.jpg',
    auto_download: true,
    retention_days: 14,
    episode_count: 212,
    date_added: sql(90 * DAY),
    last_scan_timestamp: sql(HOUR),
    ...over,
  };
}

function author(over: Partial<AudiobookFollowedAuthor> = {}): AudiobookFollowedAuthor {
  return {
    name: 'Ursula K. Le Guin',
    role: 'author',
    cover_url: '',
    since_date: '2026-01-01',
    last_scanned_at: secs(DAY),
    found_total: 2,
    last_error: '',
    added_at: secs(100 * DAY),
    auto_wishlist: 1,
    narrator_mode: 'exact',
    ...over,
  };
}

function book(over: Partial<AudiobookWishlistEntry>): AudiobookWishlistEntry {
  return {
    id: 1,
    asin: 'B0',
    title: 'The Dispossessed',
    subtitle: '',
    authors: ['Ursula K. Le Guin'],
    narrators: ['Someone'],
    series_title: '',
    series_sequence: '',
    cover_url: '',
    runtime_minutes: 600,
    release_date: '2026-03-01',
    language: 'english',
    status: 'wanted',
    narrator_mode: 'exact',
    attempt_count: 0,
    last_attempt_at: 0,
    last_error: '',
    added_at: secs(3 * DAY),
    ...over,
  };
}

describe('artists', () => {
  const [found, quiet, fresh] = buildFollowedRows(
    [
      artist(1, 'Pale Harbour'),
      artist(2, 'Saltmarsh'),
      artist(3, 'Marrow & Pine', { last_scan_timestamp: null }),
    ],
    [
      {
        id: 1,
        library_releases: 9,
        latest_release: null,
        last_found: { album_name: 'Tidewater', found_at: iso(2 * DAY), added_to_wanted: true },
        new_release: true,
      },
      {
        id: 2,
        library_releases: 3,
        latest_release: { album_name: 'Lantern', release_date: '2025-10-01' },
        last_found: null,
        new_release: false,
      },
    ],
    new Map([['pale harbour', 2]]),
    NOW,
  );

  it('start the meta line with the kind, and say where a find went', () => {
    const row = artistRow(found, ctx);
    expect([row.kindLabel, row.meta]).toEqual([
      'Artist',
      '9 releases in your library · 2 on Wanted',
    ]);
    expect(row.latest).toBe('Last found: Tidewater · 2 days ago · on Wanted');
    expect([row.statusText, row.tone, row.round, row.openLabel]).toEqual([
      'New release',
      'info',
      true,
      'Open artist',
    ]);
    expect(artistRow(quiet, ctx).statusText).toBe('Nothing new');
    expect(artistRow(quiet, ctx).latest).toBe('Latest: Lantern · Oct 2025');
  });

  it('a never-checked artist says when its first check is', () => {
    const row = artistRow(fresh, ctx);
    expect(row.statusText).toBe('Not checked yet');
    expect(row.latest).toBe('First check in about 9 hours');
  });

  it('the artist being checked right now says so', () => {
    const row = artistRow(quiet, { ...ctx, checkingArtist: 'saltmarsh' });
    expect([row.status, row.statusText, row.latest, row.tone]).toEqual([
      'checking',
      'Checking',
      'Checking…',
      'info',
    ]);
  });
});

describe('labels', () => {
  const fromLabels = wantedByLabel([
    wanted({ key: 'a', album: 'HES053', addedAt: sql(DAY) }),
    wanted({ key: 'b', album: 'HES050', addedAt: sql(20 * DAY) }),
    wanted({ key: 'c', sourceType: 'watchlist', sourceInfo: null }),
  ]);

  it('count what their check put on Wanted and call the newest a new release', () => {
    const row = labelRow(label(), fromLabels, ctx);
    expect([row.kindLabel, row.meta]).toEqual(['Label', '2 on Wanted · new releases only']);
    expect(row.latest).toBe('Latest: HES053 · yesterday · on Wanted');
    expect([row.status, row.statusText, row.round, row.initials]).toEqual([
      'new',
      'New release',
      false,
      'HA',
    ]);
    expect(row.onWanted).toBe(2);
  });

  it('a label whose last find is older than a week has nothing new', () => {
    const older = wantedByLabel([wanted({ addedAt: sql(10 * DAY) })]);
    expect(labelRow(label(), older, ctx).statusText).toBe('Nothing new');
    expect(labelRow(label({ backlog: true }), new Map(), ctx)).toMatchObject({
      meta: 'the whole catalogue',
      latest: 'Checked yesterday',
      statusText: 'Nothing new',
    });
  });

  it('a label followed minutes ago is not checked yet, and says when it will be', () => {
    const row = labelRow(
      label({
        label_name: 'Lighttown Recordings',
        date_added: sql(10 * 60_000),
        last_scan_timestamp: null,
      }),
      new Map(),
      ctx,
    );
    expect(row.meta).toBe('followed 10 minutes ago · new releases only');
    expect(row.latest).toBe('First check in about 9 hours');
    expect(row.statusText).toBe('Not checked yet');
  });

  it('match by name when an item carries no label id', () => {
    const byName = wantedByLabel([wanted({ sourceInfo: { label_name: 'hessle audio' } })]);
    expect(labelRow(label(), byName, ctx).onWanted).toBe(1);
  });
});

describe('podcasts', () => {
  const summary = {
    feed_url: 'https://feeds.example.com/exchange',
    kept: 40,
    latest_episode: { title: 'EX.761', downloaded_at: iso(3 * HOUR) },
    new_episode: true,
  };

  it('say episodes, what is kept and whether new ones download, and the latest episode', () => {
    const row = podcastRow(podcast(), summary, ctx);
    expect([row.kindLabel, row.meta]).toEqual([
      'Podcast',
      '212 episodes · 40 kept for 14 days · new episodes download',
    ]);
    expect(row.latest).toBe('Latest: EX.761 · 3 hours ago · downloaded');
    expect([row.statusText, row.tone, row.round, row.image, row.openLabel]).toEqual([
      'New episode',
      'info',
      false,
      'https://img/ra.jpg',
      'Open podcast',
    ]);
  });

  it('a show that keeps everything says so', () => {
    expect(podcastRow(podcast({ retention_days: 0 }), summary, ctx).meta).toContain(
      '40 kept for good',
    );
  });

  it('a show that doesn’t download new episodes says that, not "Nothing new"', () => {
    const row = podcastRow(podcast({ auto_download: false }), undefined, ctx);
    expect(row.meta).toBe('212 episodes · new episodes aren’t downloaded');
    expect([row.status, row.statusText]).toEqual(['not-downloading', 'Not downloading']);
    expect(row.latest).toBe('Checked 1 hour ago');
  });

  it('a downloading show with nothing new this week has nothing new', () => {
    const row = podcastRow(podcast(), { ...summary, new_episode: false }, ctx);
    expect(row.statusText).toBe('Nothing new');
  });

  it('a show never checked says when the podcast check runs next', () => {
    const row = podcastRow(podcast({ last_scan_timestamp: null }), undefined, ctx);
    expect([row.statusText, row.latest]).toEqual([
      'Not checked yet',
      'First check in about 40 minutes',
    ]);
  });
});

describe('audiobook authors, narrators and series', () => {
  it('count what was found and what is on Wanted, and name the newest find', () => {
    const books = [
      book({ title: 'Older Book', added_at: secs(200 * DAY), release_date: '2025-01-01' }),
      book({ title: 'The Dispossessed', added_at: secs(3 * DAY) }),
      book({ title: 'Not Hers', authors: ['Someone Else'] }),
    ];
    const row = authorRow(author(), books, ctx);
    expect([row.kindLabel, row.meta]).toEqual([
      'Author',
      '2 found since you followed · 2 on Wanted',
    ]);
    expect(row.latest).toBe('Latest: The Dispossessed · 3 days ago · on Wanted');
    expect([row.statusText, row.round, row.openLabel]).toEqual([
      'New release',
      true,
      'Open author',
    ]);
  });

  it('a book added before the follow is no find, and an old find is nothing new', () => {
    const row = authorRow(author(), [book({ added_at: secs(200 * DAY) })], ctx);
    expect(row.latest).toBe('Checked yesterday');
    expect(row.statusText).toBe('Nothing new');
    expect(
      authorRow(author(), [book({ added_at: secs(30 * DAY), status: 'done' })], ctx).latest,
    ).toBe('Latest: The Dispossessed · 4 weeks ago · downloaded');
  });

  it('a check that failed says so, with the reason', () => {
    const row = authorRow(author({ last_error: 'Audible timed out' }), [], ctx);
    expect([row.status, row.statusText, row.tone]).toEqual(['failed', 'Check failed', 'warning']);
    expect(row.latest).toBe('Last check failed: Audible timed out');
    expect(row.latestWarning).toBe(true);
  });

  it('narrators and series are followed by their own field, series with square art', () => {
    const narrator = author({ name: 'Someone', role: 'narrator' });
    expect(booksFor(narrator, [book({})])).toHaveLength(1);
    const series = author({ name: 'Earthsea', role: 'series' });
    expect(booksFor(series, [book({ series_title: 'Earthsea' })])).toHaveLength(1);
    expect(authorRow(series, [], ctx)).toMatchObject({
      kindLabel: 'Series',
      round: false,
      openLabel: 'Open series',
    });
    expect(authorRow(narrator, [], ctx).kindLabel).toBe('Narrator');
  });

  it('only recording new books says so; never checked says when', () => {
    const row = authorRow(
      author({ auto_wishlist: 0, last_scanned_at: 0, found_total: 0 }),
      [],
      ctx,
    );
    expect(row.meta).toBe('new books are only recorded');
    expect(row.latest).toBe('First check at the next scheduled check');
  });
});

describe('the list', () => {
  const rows = [
    labelRow(label(), wantedByLabel([wanted({})]), ctx),
    podcastRow(podcast(), undefined, ctx),
    podcastRow(
      podcast({ feed_url: 'q', title: 'Quiet Hours', auto_download: false, author: 'Nina' }),
      undefined,
      ctx,
    ),
    authorRow(author({ last_scanned_at: 0 }), [], ctx),
  ];

  it('counts kinds and statuses', () => {
    expect(kindCounts(rows)).toEqual({ all: 4, artists: 0, labels: 1, podcasts: 2, authors: 1 });
    expect(statusCounts(rows)).toMatchObject({ all: 4, new: 1, unchecked: 1, quiet: 1 });
    expect(ofKind(rows, 'podcasts').map((r) => r.name)).toEqual([
      'Resident Advisor Exchange',
      'Quiet Hours',
    ]);
  });

  it('filters by status and by name, a podcast also by its host', () => {
    expect(filterFollowing(rows, 'new').map((r) => r.name)).toEqual(['Hessle Audio']);
    expect(filterFollowing(rows, 'quiet').map((r) => r.name)).toEqual([
      'Resident Advisor Exchange',
    ]);
    expect(filterFollowing(rows, 'all', 'nina').map((r) => r.name)).toEqual(['Quiet Hours']);
  });

  it('sorts newest activity first by default, and by name or check', () => {
    // Hessle's find yesterday; the shows followed 90 days ago (by name); the
    // author followed 100 days ago
    expect(sortFollowing(rows, 'activity').map((r) => r.name)).toEqual([
      'Hessle Audio',
      'Quiet Hours',
      'Resident Advisor Exchange',
      'Ursula K. Le Guin',
    ]);
    expect(sortFollowing(rows, 'name-desc')[0].name).toBe('Ursula K. Le Guin');
    expect(sortFollowing(rows, 'scan-oldest')[0].name).toBe('Ursula K. Le Guin');
  });

  it('makes initials for a label without art', () => {
    expect(initials('Hessle Audio')).toBe('HA');
    expect(initials('Warp')).toBe('WA');
    expect(initials('R&S Records')).toBe('RS');
    expect(initials('')).toBe('');
  });
});
