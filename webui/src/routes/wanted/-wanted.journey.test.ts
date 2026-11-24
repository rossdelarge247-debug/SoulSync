import { describe, expect, it } from 'vitest';

import type { JourneyResponse, WantedTrack } from './-wanted.types';

import {
  buildWantedItems,
  filterWantedRows,
  sortWantedRows,
  wantedCounts,
  wantedRows,
  wantedStatus,
} from './-wanted.helpers';
import {
  barLabel,
  inAbout,
  itemDetail,
  itemsFrom,
  nextTryIn,
  readJourney,
  readStoredBrowse,
  sourceKey,
  sourceLabelFor,
  sourceSummaries,
  sourceTracks,
  statesSentence,
  storeBrowse,
  trackDetail,
  trackJourney,
  withJourney,
  type DetailContext,
} from './-wanted.journey';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const HOUR = 3600;

function sql(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function track(id: string, over: Partial<WantedTrack> = {}): WantedTrack {
  return {
    id,
    title: id,
    artist: 'Pale Harbour',
    album: '',
    albumType: '',
    albumTotal: null,
    image: '',
    addedAt: sql(NOW - 86_400_000),
    tries: 0,
    lastTried: '',
    lastError: '',
    sourceType: 'manual',
    sourceInfo: null,
    qualityProfileId: null,
    ...over,
  };
}

const response: JourneyResponse = {
  success: true,
  tracks: {
    dl: { download: { status: 'downloading', phase: 'downloading', progress: 62.4 } },
    q: { download: { status: 'queued', phase: 'downloading' } },
    s: { download: { status: 'searching', phase: 'searching' } },
    held: {
      quarantine: {
        entry_id: '20261120_101010_x',
        count: 5,
        trigger: 'acoustid_unverified',
        matched_by: 'id',
      },
    },
    // a live download wins over an attempt in quarantine
    both: {
      download: { status: 'downloading', phase: 'downloading' },
      quarantine: { entry_id: '20261101_000000_y', count: 1 },
    },
  },
  playlists: [
    {
      name: 'Running',
      mirror: {
        id: 3,
        source: 'spotify',
        total: 240,
        in_library: 212,
        library_checked: 240,
        library_known: true,
      },
    },
    {
      name: 'Classical calm',
      mirror: { id: 4, total: 140, in_library: 9, library_checked: 96, library_known: false },
    },
    { name: 'Liked Songs', mirror: null },
  ],
  retry: { name: 'standard', ladder: { '2': 4 * HOUR, '3': 24 * HOUR }, max_cooldown: 168 * HOUR },
};
const journey = readJourney(response);
const ctx: DetailContext = { retry: journey.retry, now: NOW, nextSearch: 'in about 2 hours' };

describe('one status per song', () => {
  it('lets what is live win, then quarantine, then the tries', () => {
    const states = Object.fromEntries(
      ['dl', 'q', 's', 'held', 'both'].map((id) => [
        id,
        trackJourney(track(id), journey.tracks.get(id)),
      ]),
    );
    expect(states).toEqual({
      dl: 'downloading',
      q: 'downloading',
      s: 'searching',
      held: 'decision',
      both: 'downloading',
    });
    expect(trackJourney(track('a', { tries: 0 }), undefined)).toBe('waiting');
    expect(trackJourney(track('a', { tries: 2 }), undefined)).toBe('waiting');
    expect(trackJourney(track('a', { tries: 3 }), undefined)).toBe('not-found');
    // a member's read has the count but no entry: still Needs your decision
    expect(
      trackJourney(track('m'), { ...journey.tracks.get('held')!, quarantineEntry: null }),
    ).toBe('decision');
  });

  it('gives a release of several the Needs-you-first status, with how many', () => {
    const [album] = withJourney(
      buildWantedItems([
        track('s', { album: 'Exile', title: 'One' }),
        track('held', { album: 'Exile', title: 'Two' }),
        track('x', { album: 'Exile', title: 'Three', tries: 4 }),
        track('y', { album: 'Exile', title: 'Four', tries: 5 }),
      ]),
      journey.tracks,
    );
    expect(album.journey).toBe('decision');
    expect(album.quarantineEntry).toBe('20261120_101010_x');
    expect(album.quarantineCount).toBe(5);
    expect(wantedStatus(album)).toEqual({ text: 'Needs your decision · 1 of 4', tone: 'warning' });
    expect(itemDetail(album, journey.tracks, ctx)).toBe(
      '1 needs your decision · 2 not found · 1 searching',
    );
  });

  it('colours each status as the boards do, live ones pulsing', () => {
    const [dl, s] = withJourney(
      buildWantedItems([track('dl', { album: 'A' }), track('s', { album: 'B' })]),
      journey.tracks,
    );
    expect(wantedStatus(dl)).toEqual({ text: 'Downloading', tone: 'accent', live: true });
    expect(wantedStatus(s)).toEqual({ text: 'Searching', tone: 'info', live: true });
  });
});

describe('the line under the tag', () => {
  it('says where each song has got to and what happens next', () => {
    const line = (t: WantedTrack) => trackDetail(t, journey.tracks.get(t.id), ctx);
    expect(line(track('dl'))).toBe('62% downloaded');
    expect(line(track('q'))).toBe('Queued to download');
    expect(line(track('s', { tries: 1 }))).toBe('Searching now · try 2');
    expect(line(track('held'))).toBe('5 tries held back · couldn’t confirm it’s the right song');
    expect(line(track('new'))).toBe('Not tried yet · next search in about 2 hours');
    expect(line(track('once', { tries: 1, lastTried: sql(NOW - 60_000) }))).toBe(
      'Tried once · tries again on the next search',
    );
    // two tries: a 4 hour wait, an hour of it gone
    expect(line(track('two', { tries: 2, lastTried: sql(NOW - 3_600_000) }))).toBe(
      'Tried 2 times · next try in about 3 hours',
    );
    // four tries: past the ladder, the 7 day most
    expect(line(track('four', { tries: 4, lastTried: sql(NOW - 3_600_000) }))).toBe(
      'No match after 4 searches · tries again in about 7 days',
    );
    expect(line(track('due', { tries: 3, lastTried: sql(NOW - 30 * 3_600_000) }))).toBe(
      'No match after 3 searches · tries again on the next search',
    );
  });

  it('says why the last try failed, in plain words, on Waiting and Not found', () => {
    const line = (t: WantedTrack) => trackDetail(t, undefined, ctx);
    expect(
      line(
        track('a', {
          tries: 2,
          lastTried: sql(NOW - 3_600_000),
          lastError: 'User went offline.',
        }),
      ),
    ).toBe('Tried 2 times · last try: user went offline · next try in about 3 hours');
    expect(
      line(
        track('b', {
          tries: 4,
          lastTried: sql(NOW - 3_600_000),
          lastError: "AcoustID verification failed: mismatch: 'Xtal' by 'Aphex Twin' (score 0.91)",
        }),
      ),
    ).toBe(
      'No match after 4 searches · last try: the wrong song came back ("Xtal" by Aphex Twin) · tries again in about 7 days',
    );
    // "no match" is what the line says already; "Added via …" is why it's on the list
    expect(
      line(track('c', { tries: 3, lastError: 'No matching track found', lastTried: '' })),
    ).toBe('No match after 3 searches · tries again on the next search');
    expect(
      line(track('d', { tries: 1, lastError: 'Added via Download Discography', lastTried: '' })),
    ).toBe('Tried once · tries again on the next search');
  });

  it('works out the next try from the ladder, never before it is due', () => {
    expect(nextTryIn(track('a', { tries: 1, lastTried: sql(NOW) }), journey.retry, NOW)).toBe(0);
    expect(nextTryIn(track('a', { tries: 3, lastTried: sql(NOW) }), journey.retry, NOW)).toBe(
      24 * HOUR,
    );
    expect(nextTryIn(track('a', { tries: 3, lastTried: '' }), journey.retry, NOW)).toBe(0);
    expect(nextTryIn(track('a', { tries: 3, lastTried: sql(NOW) }), null, NOW)).toBe(0);
    expect(inAbout(45)).toBe('in under a minute');
    expect(inAbout(7 * 24 * HOUR)).toBe('in about 7 days');
  });

  it('counts a release’s songs Needs you first', () => {
    expect(
      statesSentence({ waiting: 4, searching: 3, downloading: 0, decision: 2, 'not-found': 5 }),
    ).toBe('2 need your decision · 5 not found · 3 searching · 4 waiting');
  });
});

describe('a release under each of its steps', () => {
  it('counts songs, lists the release under every step and says that step', () => {
    const [album] = withJourney(
      buildWantedItems([
        track('s', { album: 'Exile', title: 'One' }),
        track('x', { album: 'Exile', title: 'Two', tries: 4 }),
        track('y', { album: 'Exile', title: 'Three', tries: 5, lastTried: '' }),
      ]),
      journey.tracks,
    );
    const rows = wantedRows([album], []);
    const counts = wantedCounts([album], []);
    expect([counts.searching, counts.notFound, counts.all]).toEqual([1, 2, 3]);
    expect(filterWantedRows(rows, 'searching-now')).toHaveLength(1);
    expect(filterWantedRows(rows, 'not-found')).toHaveLength(1);
    expect(filterWantedRows(rows, 'waiting')).toHaveLength(0);
    expect(wantedStatus(album, 'searching').text).toBe('Searching · 1 of 3');
    expect(wantedStatus(album, 'not-found').text).toBe('Not found · 2 of 3');
    expect(itemDetail(album, journey.tracks, ctx, 'searching')).toBe('2 not found · 1 searching');
  });
});

describe('Needs you first', () => {
  it('sorts decisions, then not found, then what is moving, then waiting, then finds', () => {
    const items = withJourney(
      buildWantedItems([
        track('w', { album: 'W', title: 'Waits' }),
        track('nf', { album: 'N', title: 'Lost', tries: 5 }),
        track('held', { album: 'H', title: 'Held' }),
        track('dl', { album: 'D', title: 'Coming' }),
      ]),
      journey.tracks,
    );
    const rows = wantedRows(items, [
      {
        key: 'found:f',
        id: 'f',
        title: 'Arrived',
        artist: '',
        album: '',
        quality: '',
        image: '',
        foundAt: sql(NOW),
      },
    ]);
    expect(sortWantedRows(rows, 'needs-you').map((r) => r.item.title)).toEqual([
      'Held',
      'Lost',
      'Coming',
      'Waits',
      'Arrived',
    ]);
  });
});

describe('where songs came from', () => {
  it('maps every source type to one of the From names', () => {
    const label = (type: string, info: Record<string, unknown> | null = null) =>
      sourceLabelFor(type, info);
    expect(label('playlist', { playlist_name: 'Running' })).toBe('Running');
    expect(label('playlist', { playlist_name: 'Unknown Playlist' })).toBe(
      'Playlists without a name',
    );
    expect(label('watchlist')).toBe('Followed artists');
    expect(label('watchlist_label')).toBe('Followed labels');
    expect(label('discography')).toBe('Download discography');
    expect(label('enhance')).toBe('Upgrades');
    for (const type of ['redownload', 'repair']) expect(label(type)).toBe('Re-downloads');
    for (const type of ['manual', 'album', 'set', 'api', 'unknown', ''])
      expect(label(type)).toBe('Requested by me');
    expect(sourceKey('playlist', { playlist_name: ' Running ' })).toBe('playlist:running');
  });

  it('sums each source in songs, with library figures only when they are known', () => {
    const pl = (name: string) => ({
      sourceType: 'playlist',
      sourceInfo: { playlist_name: name },
    });
    const items = withJourney(
      buildWantedItems([
        track('dl', { ...pl('Running'), album: 'A' }),
        track('held', { ...pl('Running'), album: 'B' }),
        track('r3', { ...pl('Running'), album: 'C', tries: 3 }),
        track('c1', { ...pl('Classical calm'), album: 'D' }),
        track('l1', { ...pl('Liked Songs'), album: 'E' }),
        track('l2', { ...pl('Liked Songs'), album: 'F' }),
        track('f1', { sourceType: 'watchlist', album: 'G', artist: 'Gary Numan' }),
        track('m1', { sourceType: 'album', album: 'H' }),
      ]),
      journey.tracks,
    );
    const sources = sourceSummaries(items, journey.tracks, journey.playlists);
    // playlists first, busiest first; then the rest in the views' order
    expect(sources.map((s) => [s.label, s.group, s.wanted])).toEqual([
      ['Running', 'playlists', 3],
      ['Liked Songs', 'playlists', 2],
      ['Classical calm', 'playlists', 1],
      ['Followed artists', 'following', 1],
      ['Requested by me', 'requests', 1],
    ]);
    const running = sources.find((s) => s.label === 'Running')!;
    expect(running.headline).toBe('212 of 240 in your library · 28 to go');
    expect(running.meta).toBe('Spotify · mirrored');
    // a mirrored playlist's bar is the whole playlist: 212 + 3 on Wanted + 25
    // the sync checked and found neither in the library nor on Wanted
    expect(running.bar).toEqual({
      owned: 212,
      active: 1,
      waiting: 0,
      decision: 1,
      notFound: 1,
      notInLibrary: 25,
      unchecked: 0,
    });
    const calm = sources.find((s) => s.label === 'Classical calm')!;
    expect(calm.headline).toBe('96 checked so far · 1 still wanted');
    expect(calm.meta).toBe('mirrored, still checking');
    // still checking: 96 of 140 checked (none owned by the sync's flag here),
    // one song wanted; 95 checked and not in the library; 44 not checked yet
    expect(calm.bar).toEqual({
      owned: 0,
      active: 0,
      waiting: 1,
      decision: 0,
      notFound: 0,
      notInLibrary: 95,
      unchecked: 44,
    });
    expect(barLabel(calm.bar)).toBe('1 waiting, 95 not in your library yet, 44 not checked yet');
    // not mirrored: just its songs on Wanted
    const likedBar = sources.find((s) => s.label === 'Liked Songs')!.bar;
    expect([likedBar.notInLibrary, likedBar.unchecked]).toEqual([0, 0]);
    const liked = sources.find((s) => s.label === 'Liked Songs')!;
    expect(liked.headline).toBe('2 still wanted · mirror it to count what you have');
    expect(liked.meta).toBe('Not mirrored');
    expect(sources.find((s) => s.label === 'Followed artists')!.headline).toBe('1 still wanted');
    expect(sources.find((s) => s.label === 'Followed artists')!.meta).toBe(
      '1 artist · new releases',
    );
    expect(itemsFrom(items, 'playlist:running').map((i) => i.title)).toEqual(['dl', 'held', 'r3']);
    expect(sourceTracks(items, 'playlist:running', journey.tracks).map((t) => t.status)).toEqual([
      'decision',
      'not-found',
      'downloading',
    ]);
  });

  it('counts what the sync found owned among the checked tracks of a playlist still being checked', () => {
    const playlists = [
      {
        name: 'Calm',
        mirror: {
          id: 4,
          total: 10,
          in_library: 7,
          library_checked: 6,
          library_known: false,
          owned_checked: 4,
        },
      },
    ];
    const items = withJourney(
      buildWantedItems([
        track('c1', {
          sourceType: 'playlist',
          sourceInfo: { playlist_name: 'Calm' },
          album: 'Z',
        }),
      ]),
      new Map(),
    );
    const [calm] = sourceSummaries(items, new Map(), playlists);
    // 4 owned (the flag), 1 wanted, 1 checked and not in the library, 4 unchecked
    expect(calm.bar).toEqual({
      owned: 4,
      active: 0,
      waiting: 1,
      decision: 0,
      notFound: 0,
      notInLibrary: 1,
      unchecked: 4,
    });
    expect(calm.headline).toBe('6 checked so far · 1 still wanted');
  });

  it('never counts more owned than were checked, and the parts make the playlist', () => {
    const playlists = [
      {
        name: 'Calm',
        mirror: {
          id: 4,
          total: 10,
          in_library: 9,
          library_checked: 6,
          library_known: false,
          owned_checked: 9,
        },
      },
    ];
    const items = withJourney(
      buildWantedItems([
        track('c1', { sourceType: 'playlist', sourceInfo: { playlist_name: 'Calm' }, album: 'Z' }),
      ]),
      new Map(),
    );
    const [calm] = sourceSummaries(items, new Map(), playlists);
    expect(calm.bar.owned).toBe(6);
    const { owned, active, waiting, decision, notFound, notInLibrary, unchecked } = calm.bar;
    expect(owned + active + waiting + decision + notFound + notInLibrary + unchecked).toBe(10);
  });

  it('remembers Songs or Sources per profile', () => {
    window.localStorage.clear();
    expect(readStoredBrowse(1)).toBe('songs');
    storeBrowse(1, 'sources');
    expect(readStoredBrowse(1)).toBe('sources');
    expect(readStoredBrowse(2)).toBe('songs');
  });
});

describe('how often the journey is read', () => {
  it('every 30 seconds, every 5 while the quarantine is still being read', async () => {
    const { journeyRefreshMs, wantedJourneyQueryOptions } = await import('./-wanted.api');
    expect(journeyRefreshMs(undefined)).toBe(30_000);
    expect(journeyRefreshMs({ quarantine_ready: true })).toBe(30_000);
    expect(journeyRefreshMs({ quarantine_ready: false })).toBe(5_000);
    // never in a hidden tab
    expect(wantedJourneyQueryOptions(1).refetchIntervalInBackground).toBe(false);
  });
});
