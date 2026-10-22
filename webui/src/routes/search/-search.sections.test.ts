/**
 * The pure pieces behind the library and metadata-service sections, and the
 * NDJSON reader behind the Soulseek one.
 */

import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '@/test/msw';

import type { FileSearchEvent } from './-soulseek.stream';

import { catalogCounts, catalogMeta, catalogRows, catalogShortMeta } from './-catalog.model';
import {
  albumMeta,
  artistMeta,
  fetchLibraryResults,
  libraryCounts,
  qualityVerdict,
  shortMeta,
  trackMeta,
} from './-search.library';
import { EMPTY_OWNERSHIP } from './-search.ownership';
import { streamFileSearch } from './-soulseek.stream';

const FLAC_BAR = [{ format: 'flac', bit_depth: 16 }];

describe('the library section', () => {
  it('judges an album by most of its files', () => {
    const flac = { file_path: '/m/a.flac', bitrate: 1000 };
    const mp3 = { file_path: '/m/b.mp3', bitrate: 320 };
    expect(qualityVerdict([flac, flac, mp3], FLAC_BAR)).toEqual({ label: 'MP3 320', below: false });
    expect(qualityVerdict([mp3, mp3, flac], FLAC_BAR)).toEqual({ label: 'MP3 320', below: true });
    expect(qualityVerdict([], FLAC_BAR)).toBeNull();
    expect(qualityVerdict([mp3], null)?.below).toBe(false);
  });

  it('writes the meta lines, long and short', () => {
    const artist = {
      id: 7,
      name: 'Pale Harbour',
      album_count: 9,
      track_count: 93,
      is_watched: true,
    };
    expect(artistMeta(artist)).toBe('Artist · 9 albums · 93 tracks in your library · Following');
    expect(shortMeta({ kind: 'artist', item: artist }, null)).toBe('Artist · 9 albums · Following');
    const album = {
      id: 11,
      title: 'Night Ferry',
      year: 2023,
      artist_name: 'Pale Harbour',
      track_count: 10,
    };
    const verdict = { label: 'FLAC', below: false };
    expect(albumMeta(album, verdict)).toBe('Pale Harbour · Album · 2023 · 10 tracks · FLAC');
    expect(shortMeta({ kind: 'album', item: album }, verdict)).toBe('Album · 2023 · FLAC');
    expect(
      trackMeta(
        { id: 1, title: 'x', artist_name: 'Pale Harbour', album_title: 'Night Ferry' },
        verdict,
      ),
    ).toBe('Pale Harbour · Night Ferry · FLAC');
  });

  it('asks the three library searches together, and survives one failing', async () => {
    server.use(
      http.get('/api/library/artists', () => HttpResponse.json({}, { status: 500 })),
      http.get('/api/library/albums', () =>
        HttpResponse.json({
          success: true,
          albums: [{ id: 1, title: 'Night Ferry' }],
          pagination: { total_count: 4 },
        }),
      ),
      http.get('/api/library/search-tracks', () =>
        HttpResponse.json({
          success: true,
          tracks: Array.from({ length: 50 }, (_, i) => ({ id: i, title: `t${i}` })),
        }),
      ),
    );
    const results = await fetchLibraryResults('pale');
    expect(results.partial).toBe(true);
    expect(results.albumTotal).toBe(4);
    expect(results.tracksCapped).toBe(true);
    expect(libraryCounts(results)).toBe('4 albums · 50+ tracks');
  });

  it('fails only when all three fail', async () => {
    server.use(
      http.get('/api/library/artists', () => HttpResponse.json({}, { status: 500 })),
      http.get('/api/library/albums', () => HttpResponse.json({}, { status: 500 })),
      http.get('/api/library/search-tracks', () => HttpResponse.json({}, { status: 500 })),
    );
    await expect(fetchLibraryResults('pale')).rejects.toThrow(
      'SoulSync didn’t answer the library search.',
    );
  });
});

describe('the metadata service section', () => {
  const results = {
    db_artists: [],
    artists: [{ id: 'a', name: 'Pale Harbour' }],
    albums: [
      {
        id: 'x',
        name: 'Night Ferry',
        artist: 'Pale Harbour',
        album_type: 'album',
        release_date: '2023-05-01',
        total_tracks: 10,
      },
      { id: 'y', name: 'Tidewater', artist: 'Pale Harbour', album_type: 'ep', total_tracks: 4 },
    ],
    tracks: [
      {
        id: 't',
        name: 'Harbour Light',
        artist: 'Pale Harbour',
        album: 'Tidewater',
        duration_ms: 200_000,
      },
    ],
    playlists: [
      { id: 'p', name: 'Pale Harbour: Harbour Nights', creator: 'Spotify', track_count: 40 },
    ],
    videos: [],
  };

  it('shows what you don’t have, in the order releases, playlists, tracks, artists, labels', () => {
    const owned = { ...EMPTY_OWNERSHIP, ownedAlbums: new Set<string>() };
    const { rows, hiddenOwned } = catalogRows({
      results: results as never,
      labels: [{ id: 'l', name: 'Warp' }],
      ownership: owned,
      type: 'everything',
      query: 'pale harbour',
      showOwned: false,
    });
    expect(rows.map((r) => r.kind)).toEqual([
      'album',
      'album',
      'playlist',
      'track',
      'artist',
      'label',
    ]);
    expect(hiddenOwned).toBe(0);
    expect(catalogCounts(rows)).toBe('2 releases · 1 playlist · 1 track · 1 artist · 1 label');
  });

  it('keeps to the type asked for', () => {
    const { rows } = catalogRows({
      results: results as never,
      labels: [],
      ownership: EMPTY_OWNERSHIP,
      type: 'albums',
      query: 'pale harbour',
      showOwned: false,
    });
    expect(rows.map((r) => r.kind)).toEqual(['album', 'album']);
  });

  it('describes each row', () => {
    const { rows } = catalogRows({
      results: results as never,
      labels: [],
      ownership: EMPTY_OWNERSHIP,
      type: 'everything',
      query: 'pale harbour',
      showOwned: true,
    });
    expect(catalogMeta(rows[0])).toBe(
      'Pale Harbour · Album · 2023 · 10 tracks · not in your library',
    );
    expect(catalogShortMeta(rows[0])).toBe('Album · 10 tracks · not in your library');
    expect(catalogMeta(rows[1])).toBe('Pale Harbour · EP · 4 tracks · not in your library');
    expect(catalogMeta(rows[2])).toBe('Playlist by Spotify · 40 tracks');
    expect(catalogShortMeta(rows[3])).toBe('Pale Harbour · not in your library');
  });
});

describe('the streamed file search', () => {
  function chunked(...chunks: string[]) {
    return new HttpResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(Buffer.from(chunk)));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    );
  }

  async function collect(): Promise<FileSearchEvent[]> {
    const events: FileSearchEvent[] = [];
    await streamFileSearch('pale harbour', null, (event) => events.push(event));
    return events;
  }

  it('reads lines split across chunks, and skips a bad one', async () => {
    server.use(
      http.post('/api/search/stream', () =>
        chunked(
          '{"type":"progress","files":1,"us',
          'ers":1,"results":[]}\nnot json\n',
          '{"type":"done","files":2,"users":1,"results":[]}\n',
        ),
      ),
    );
    expect((await collect()).map((e) => e.type)).toEqual(['progress', 'done']);
  });

  it('takes what arrived as the answer when the stream ends early', async () => {
    server.use(
      http.post('/api/search/stream', () =>
        chunked('{"type":"progress","files":5,"users":2,"results":[]}\n'),
      ),
    );
    const events = await collect();
    expect(events[events.length - 1]).toEqual({ type: 'done', files: 5, users: 2, results: [] });
  });

  it('passes the server’s sentence on when it refuses', async () => {
    server.use(
      http.post('/api/search/stream', () =>
        HttpResponse.json({ error: 'Enter something to search for.' }, { status: 400 }),
      ),
    );
    expect(await collect()).toEqual([{ type: 'error', error: 'Enter something to search for.' }]);
  });

  it('sends the source when one is picked', async () => {
    let body: unknown = null;
    server.use(
      http.post('/api/search/stream', async ({ request }) => {
        body = await request.json();
        return chunked('{"type":"done","files":0,"users":0,"results":[]}\n');
      }),
    );
    await streamFileSearch('pale harbour', 'tidal', () => undefined);
    expect(body).toEqual({ query: 'pale harbour', source: 'tidal' });
  });
});
