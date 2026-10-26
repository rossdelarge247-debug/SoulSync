import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

/**
 * The Artist page (Artist v2, boards 2g and 2h) against a stubbed API shaped
 * like the board: Pale Harbour, 14 releases, 9 in the library, 5 on Wanted.
 */

type Own = [number, number, string[], string] | null;
const RELEASES: [string, string, string, string, number, Own][] = [
  ['sp-tw', 'Tidewater', 'album', '2026-03-02', 12, [11, 12, ['FLAC'], 'L-tw']],
  ['sp-nf', 'Night Ferry', 'album', '2023-05-12', 10, [10, 10, ['FLAC'], 'L-nf']],
  ['sp-ll', 'Low Light', 'album', '2021-09-03', 11, [11, 11, ['MP3-320'], 'L-ll']],
  ['sp-ph', 'Pale Harbour', 'album', '2019-02-01', 9, null],
  ['sp-nfl', 'Night Ferry (Live)', 'single', '2024-11-01', 1, null],
  ['sp-hl', 'Harbour Light', 'ep', '2022-08-19', 4, [4, 4, ['FLAC'], 'L-hl']],
  ['sp-sw', 'Slack Water', 'single', '2020-07-03', 2, null],
  ['sp-ds', 'Driftwood Sessions', 'ep', '2018-10-12', 5, [5, 5, ['FLAC'], 'L-ds']],
  ['sp-ut', 'Undertow', 'single', '2017-03-03', 1, [1, 1, ['FLAC'], 'L-ut']],
  ['sp-sh', 'Shoreline', 'ep', '2016-06-10', 4, [4, 4, ['FLAC'], 'L-sh']],
  ['sp-gu', 'Gull', 'single', '2015-01-09', 1, null],
  ['sp-fl', 'First Light', 'single', '2014-04-18', 2, [2, 2, ['FLAC'], 'L-fl']],
  ['sp-es', 'Estuary', 'ep', '2013-05-24', 4, null],
  ['sp-eb', 'Ebb', 'single', '2012-02-17', 1, [1, 1, ['MP3-320'], 'L-eb']],
];

const cardOf = ([id, title, type, date, tracks]: (typeof RELEASES)[number]) => ({
  id,
  title,
  name: title,
  album_type: type,
  release_date: date,
  track_count: tracks,
  owned: null,
  track_completion: 'checking',
  image_url: null,
});
const bucket = (...types: string[]) => RELEASES.filter((r) => types.includes(r[2])).map(cardOf);

function detail(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    artist: {
      id: 42,
      name: 'Pale Harbour',
      server_source: 'plex',
      spotify_artist_id: 'sp-artist-ph',
      musicbrainz_id: 'mb-ph',
      lastfm_bio: 'A four-piece from the north coast.',
      lastfm_listeners: 182340,
    },
    spotify_artist: { spotify_artist_id: 'sp-artist-ph', spotify_artist_name: 'Pale Harbour' },
    discography: {
      albums: bucket('album'),
      eps: bucket('ep'),
      singles: bucket('single'),
      source: 'spotify',
    },
    enrichment_coverage: { total_tracks: 132 },
    ...overrides,
  };
}

function completionFrames(): string {
  const lines = [`data: ${JSON.stringify({ type: 'start', total_items: RELEASES.length })}`];
  for (const [id, , type, , tracks, own] of RELEASES) {
    const category = type === 'album' ? 'albums' : type === 'ep' ? 'eps' : 'singles';
    lines.push(
      `data: ${JSON.stringify(
        own
          ? {
              type: 'completion',
              id,
              category,
              status: own[0] >= own[1] ? 'completed' : 'partial',
              owned_tracks: own[0],
              expected_tracks: own[1],
              completion_percentage: Math.round((own[0] / own[1]) * 100),
              formats: own[2],
              library_album_id: own[3],
            }
          : {
              type: 'completion',
              id,
              category,
              status: 'missing',
              owned_tracks: 0,
              expected_tracks: tracks,
              formats: [],
              library_album_id: null,
            },
      )}`,
    );
  }
  lines.push(`data: ${JSON.stringify({ type: 'complete' })}`);
  return lines.join('\n\n') + '\n\n';
}

const wish = (id: string, album: string, albumId: string, tries: number) => ({
  id,
  spotify_track_id: id,
  spotify_data: {
    id,
    name: `${album} track`,
    artists: [{ name: 'Pale Harbour' }],
    album: { id: albumId, name: album, album_type: 'album', images: [] },
  },
  retry_count: tries,
  date_added: '2026-10-18 09:00:00',
});

const FOLLOWED_ROW = {
  id: 7,
  artist_name: 'Pale Harbour',
  date_added: '2025-03-14T10:00:00',
  last_scan_timestamp: '2026-10-21T06:00:00',
  spotify_artist_id: 'sp-artist-ph',
  itunes_artist_id: null,
  deezer_artist_id: null,
  discogs_artist_id: null,
  musicbrainz_artist_id: null,
  amazon_artist_id: null,
};

interface Call {
  url: string;
  path: string;
  method: string;
  body: string;
}

type Handler = (call: Call) => Response | Promise<Response> | undefined;

interface Fixture {
  detail: unknown;
  following: boolean;
  wishAlbums: unknown[];
  wishSingles: unknown[];
  handlers: Handler[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let calls: Call[] = [];
let fixture: Fixture;

function stubApi(overrides: Partial<Fixture> = {}) {
  fixture = {
    detail: detail(),
    following: true,
    wishAlbums: [wish('w-tw', 'Tidewater', 'sp-tw', 1)],
    wishSingles: [
      wish('w-nfl', 'Night Ferry (Live)', 'sp-nfl', 22),
      wish('w-sw1', 'Slack Water', 'sp-sw', 2),
      wish('w-gu', 'Gull', 'sp-gu', 1),
      wish('w-es', 'Estuary', 'sp-es', 0),
    ],
    handlers: [],
    ...overrides,
  };
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), 'http://localhost');
      const call: Call = {
        url: url.toString(),
        path: url.pathname,
        method: (request?.method ?? init?.method ?? 'GET').toUpperCase(),
        body: request
          ? await request.clone().text()
          : typeof init?.body === 'string'
            ? init.body
            : '',
      };
      calls.push(call);
      for (const handler of fixture.handlers) {
        const answer = handler(call);
        if (answer) return answer;
      }
      const p = call.path;
      if (p.startsWith('/api/artist-detail/')) return json(fixture.detail);
      if (p === '/api/library/completion-stream')
        return new Response(completionFrames(), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      if (p === '/api/wishlist/tracks')
        return json({
          tracks:
            url.searchParams.get('category') === 'albums'
              ? fixture.wishAlbums
              : fixture.wishSingles,
        });
      if (p === '/api/quality/artist/42')
        return json({
          success: true,
          tracks: 132,
          below_target: 12,
          target: { name: 'FLAC or better', preset: 'flac' },
          albums: [
            { id: 'L-ll', title: 'Low Light', tracks: 11, below_target: 11, formats: ['MP3 320'] },
          ],
        });
      if (p === '/api/watchlist/check')
        return json({ success: true, is_watching: fixture.following });
      if (p === '/api/watchlist/artists')
        return json({ success: true, artists: fixture.following ? [FOLLOWED_ROW] : [] });
      if (p === '/api/watchlist/add') {
        fixture.following = true;
        return json({ success: true, message: 'Added' });
      }
      if (p === '/api/watchlist/remove') {
        fixture.following = false;
        return json({ success: true, message: 'Removed' });
      }
      if (p.startsWith('/api/artist/similar/'))
        return json({
          success: true,
          similar_artists: [
            { id: 'sp-sim-0', name: 'Saltmarsh', source: 'spotify', genres: ['indie folk'] },
            { id: '', name: 'Unmatched' },
          ],
        });
      if (p === '/api/artist/0/lastfm-top-tracks')
        return json({ success: true, tracks: [{ name: 'Harbour Bell', playcount: 412000 }] });
      if (p === '/api/library/artist/42/enhanced')
        return json({
          success: true,
          artist: { id: 42, name: 'Pale Harbour' },
          albums: [
            {
              id: 'L-nf',
              title: 'Night Ferry',
              year: 2023,
              record_type: 'album',
              tracks: [
                {
                  id: 't1',
                  title: 'Ferry One',
                  track_number: 1,
                  duration: 200000,
                  file_path: '/m/1.flac',
                  bitrate: 900,
                },
                {
                  id: 't2',
                  title: 'Ferry Two',
                  track_number: 2,
                  duration: 210000,
                  file_path: '/m/2.flac',
                  bitrate: 900,
                },
              ],
            },
          ],
        });
      return json({ success: false });
    }),
  );
}

function renderArtist(path = '/artist-detail/library/42?name=Pale%20Harbour') {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, queryClient });
  const view = render(<AppRouterProvider router={router} queryClient={queryClient} />);
  return { router, history, queryClient, ...view };
}

const search = (router: ReturnType<typeof createAppRouter>) =>
  router.state.location.search as Record<string, unknown>;
const callsTo = (path: string, method?: string) =>
  calls.filter((c) => c.path === path && (!method || c.method === method));
const card = (title: string) => screen.getByRole('article', { name: title });

/** Wait for the page, the library check and the Wanted list to land. */
async function ready() {
  await screen.findByRole('heading', { level: 1, name: 'Pale Harbour' });
  await waitFor(() =>
    expect(within(card('Low Light')).getByText('Below quality target')).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(within(card('Tidewater')).getByText('11 of 12 · Searching')).toBeInTheDocument(),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function choose(menuName: string, item: string) {
  fireEvent.click(screen.getByRole('button', { name: menuName }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showToast = vi.fn();
  window._updateSidebarLibraryBreadcrumb = vi.fn();
  stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.SoulSyncWebShellBridge = undefined;
  delete document.body.dataset.artistSource;
  delete window.playTrackList;
  delete window.showLoadingOverlay;
  delete window.hideLoadingOverlay;
  delete window.openDownloadMissingModalForArtistAlbum;
  delete window.registerArtistDownload;
});

describe('the route', () => {
  it('renders the React page rather than handing off to the legacy shell', async () => {
    renderArtist('/artist-detail/spotify/2YZyLoL8N0Wb9xBt1NhZWg');
    await screen.findByRole('heading', { level: 1, name: 'Pale Harbour' });
    expect(window.SoulSyncWebShellBridge?.navigateToArtistDetail).not.toHaveBeenCalled();
  });

  it('survives an all-digits artist name (311) and sends it on', async () => {
    renderArtist('/artist-detail/deezer/2481?name=311');
    await screen.findByRole('heading', { level: 1, name: 'Pale Harbour' });
    const url = callsTo('/api/artist-detail/2481')[0]?.url ?? '';
    expect(url).toContain('name=311');
    expect(url).toContain('source=deezer');
  });

  it('never sends "library" as a source', async () => {
    renderArtist();
    await screen.findByRole('heading', { level: 1, name: 'Pale Harbour' });
    const url = callsTo('/api/artist-detail/42')[0]?.url ?? '';
    expect(url).toContain('/api/artist-detail/42');
    expect(url).not.toContain('source=library');
  });

  it('tags the body and hands the artist to the shell, then takes it back', async () => {
    const { unmount } = renderArtist();
    await screen.findByRole('heading', { level: 1, name: 'Pale Harbour' });
    await waitFor(() => expect(document.body.dataset.artistSource).toBe('library'));
    expect(window._updateSidebarLibraryBreadcrumb).toHaveBeenCalled();
    unmount();
    expect(document.body.dataset.artistSource).toBeUndefined();
  });
});

describe('old links', () => {
  it('?album= opens the Tracks tab with the tag and file tools for an admin', async () => {
    const { router } = renderArtist('/artist-detail/library/42?album=L-nf');
    await waitFor(() =>
      expect(search(router)).toMatchObject({ tab: 'tracks', manage: true, album: 'L-nf' }),
    );
  });

  it('?album= opens the Tracks tab, scrolled to that album, for everyone else', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      getCurrentProfileContext: vi.fn(() => ({ profileId: 3, isAdmin: false })),
    });
    const { router } = renderArtist('/artist-detail/library/42?album=L-nf');
    await waitFor(() => expect(search(router)).toMatchObject({ tab: 'tracks', album: 'L-nf' }));
    expect(search(router).manage).toBeUndefined();
    expect(await screen.findByText('Ferry One')).toBeInTheDocument();
  });
});

describe('the header', () => {
  it('says what there is, what you have and what is wanted, and who you follow', async () => {
    renderArtist();
    await ready();
    expect(
      screen.getByText('14 releases · 9 in your library (132 tracks) · 5 on Wanted'),
    ).toBeInTheDocument();
    expect(screen.getByText('14 releases · 9 in library · 5 wanted')).toBeInTheDocument();
    expect(screen.getAllByText('Following since March 2025').length).toBeGreaterThan(0);
    expect(screen.getByText(/Latest: Tidewater, March 2026/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Spotify' })).toHaveAttribute(
      'href',
      'https://open.spotify.com/artist/sp-artist-ph',
    );
    expect(screen.getByRole('button', { name: 'Following Pale Harbour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText(/each new release is added to Wanted/)).toBeNull();
  });

  it('explains following, in one line, while you do not follow', async () => {
    stubApi({ following: false });
    renderArtist();
    await ready();
    expect(
      screen.getByText(
        'Follow Pale Harbour and each new release is added to Wanted as it comes out, at your quality target.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Follow Pale Harbour' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByText(/Following since/)).toBeNull();
  });

  it('falls back from the artist photo to Deezer’s, then the placeholder', async () => {
    stubApi({
      detail: detail({
        artist: {
          id: 42,
          name: 'Pale Harbour',
          server_source: 'plex',
          image_url: 'https://img/ph.jpg',
          deezer_id: 77,
        },
      }),
    });
    renderArtist();
    await screen.findByRole('heading', { level: 1, name: 'Pale Harbour' });
    const img = () => document.querySelector('header img');
    await waitFor(() => expect(img()).toHaveAttribute('src', 'https://img/ph.jpg'));
    fireEvent.error(img()!);
    await waitFor(() =>
      expect(img()).toHaveAttribute('src', 'https://api.deezer.com/artist/77/image?size=big'),
    );
    fireEvent.error(img()!);
    await waitFor(() => expect(img()).toBeNull());
  });

  it('says an artist who is not in the library is not, and runs no library check', async () => {
    stubApi({
      detail: detail({ artist: { id: 'dz1', name: 'Pale Harbour' }, spotify_artist: undefined }),
    });
    renderArtist('/artist-detail/deezer/dz1?name=Pale%20Harbour');
    await screen.findByText('14 releases · not in your library · 5 on Wanted');
    expect(callsTo('/api/library/completion-stream')).toHaveLength(0);
    expect(callsTo('/api/quality/artist/dz1')).toHaveLength(0);
  });
});

describe('the guided tour', () => {
  // static/helper.js's artist tour points at these; a step whose anchor is
  // missing is skipped, so a lost attribute silently shortens the tour
  it('finds every anchor it points at', async () => {
    renderArtist();
    await ready();
    for (const anchor of [
      'artist-header',
      'artist-actions',
      'artist-tabs',
      'artist-filters',
      'artist-releases',
    ]) {
      expect(document.querySelector(`[data-tour="${anchor}"]`), anchor).not.toBeNull();
    }
    expect(document.querySelector('[data-tour="artist-tabs"]')).toHaveAttribute('role', 'tablist');
    expect(document.querySelector('[data-tour="artist-releases"]')).toHaveAttribute(
      'aria-label',
      'Releases by Pale Harbour',
    );
  });
});

describe('Follow / Following', () => {
  it('follows at once and keeps it when the server agrees', async () => {
    stubApi({ following: false });
    const gate = deferred<Response>();
    fixture.handlers.push((call) => {
      if (call.path !== '/api/watchlist/add') return undefined;
      return gate.promise.then((r) => {
        fixture.following = true;
        return r;
      });
    });
    renderArtist();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Follow Pale Harbour' }));
    // optimistic: flipped before the server answers
    expect(await screen.findByRole('button', { name: 'Following Pale Harbour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(JSON.parse(callsTo('/api/watchlist/add')[0].body)).toMatchObject({
      artist_id: 'sp-artist-ph',
      artist_name: 'Pale Harbour',
    });
    await act(async () => gate.resolve(json({ success: true })));
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/^Following Pale Harbour/),
        'success',
      ),
    );
    expect(screen.getByRole('button', { name: 'Following Pale Harbour' })).toBeInTheDocument();
  });

  it('flips back and says why when following fails', async () => {
    stubApi({ following: false });
    const gate = deferred<Response>();
    fixture.handlers.push((call) =>
      call.path === '/api/watchlist/add' ? gate.promise : undefined,
    );
    renderArtist();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Follow Pale Harbour' }));
    await screen.findByRole('button', { name: 'Following Pale Harbour' });
    await act(async () => gate.resolve(json({ success: false, error: 'Unknown source' }, 400)));
    expect(await screen.findByRole('button', { name: 'Follow Pale Harbour' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't follow Pale Harbour"),
      'error',
    );
  });

  it('asks before unfollowing, and says what stays on Wanted', async () => {
    renderArtist();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Following Pale Harbour' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unfollow Pale Harbour?' });
    expect(
      within(dialog).getByText(
        /SYNCHRO\.S stops checking Pale Harbour for new releases. The 5 things already on Wanted stay there and keep being searched for./,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Nothing in your library changes.')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep following' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo('/api/watchlist/remove')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Following Pale Harbour' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Unfollow Pale Harbour?' })).getByRole(
        'button',
        {
          name: 'Unfollow',
        },
      ),
    );
    expect(await screen.findByRole('button', { name: 'Follow Pale Harbour' })).toBeInTheDocument();
    // removed by the followed row's own id
    expect(JSON.parse(callsTo('/api/watchlist/remove')[0].body)).toEqual({
      artist_id: 'sp-artist-ph',
    });
  });

  it('goes back to Following when unfollowing fails', async () => {
    fixture.handlers.push((call) =>
      call.path === '/api/watchlist/remove'
        ? json({ success: false, error: 'Locked' }, 500)
        : undefined,
    );
    renderArtist();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Following Pale Harbour' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Unfollow Pale Harbour?' })).getByRole(
        'button',
        {
          name: 'Unfollow',
        },
      ),
    );
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        expect.stringContaining("Couldn't unfollow"),
        'error',
      ),
    );
    expect(screen.getByRole('button', { name: 'Following Pale Harbour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('release cards', () => {
  it('carry their state in Wanted’s words', async () => {
    renderArtist();
    await ready();
    expect(within(card('Night Ferry')).getByText('In your library')).toBeInTheDocument();
    expect(
      within(card('Night Ferry')).getByText('2023 · Album · 10 tracks · FLAC'),
    ).toBeInTheDocument();
    expect(
      within(card('Low Light')).getByText('2021 · Album · 11 tracks · MP3 320'),
    ).toBeInTheDocument();
    expect(
      within(card('Night Ferry (Live)')).getByText('Wanted · not found yet'),
    ).toBeInTheDocument();
    expect(within(card('Slack Water')).getByText('Wanted · Searching')).toBeInTheDocument();
    expect(
      within(card('Pale Harbour')).getByRole('button', { name: 'Add to Wanted' }),
    ).toBeInTheDocument();
    expect(card('Pale Harbour')).toHaveAttribute('data-quiet', 'true');
  });

  it('give a partly complete album its progress', async () => {
    renderArtist();
    await ready();
    const bar = within(card('Tidewater')).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '11');
    expect(bar).toHaveAttribute('aria-valuemax', '12');
    expect(bar).toHaveAccessibleName('Tidewater: 11 of 12 tracks in your library');
  });

  it('say they are still being checked, with a word, until the library answers', async () => {
    fixture.handlers.push((call) =>
      call.path === '/api/library/completion-stream' ? new Promise<Response>(() => {}) : undefined,
    );
    renderArtist();
    await screen.findByRole('heading', { level: 1, name: 'Pale Harbour' });
    expect(
      within(await screen.findByRole('article', { name: 'Night Ferry' })).getByText(
        'Checking your library…',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add all missing to Wanted' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Checking what’s in your library first.')).toBeInTheDocument();
  });

  it('open the release’s tracks in the download modal', async () => {
    window.openDownloadMissingModalForArtistAlbum = vi.fn();
    window.registerArtistDownload = vi.fn();
    fixture.handlers.push((call) =>
      call.path === '/api/album/sp-nf/tracks'
        ? json({ success: true, tracks: [{ id: 't1', name: 'Ferry One' }] })
        : undefined,
    );
    renderArtist();
    await ready();
    fireEvent.click(within(card('Night Ferry')).getByRole('button', { name: 'Night Ferry' }));
    await waitFor(() =>
      expect(window.openDownloadMissingModalForArtistAlbum).toHaveBeenCalledTimes(1),
    );
    const args = (window.openDownloadMissingModalForArtistAlbum as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(args[2]).toEqual([{ id: 't1', name: 'Ferry One' }]);
  });

  it('play a release you have from the library', async () => {
    window.playTrackList = vi.fn();
    fixture.handlers.push((call) => {
      if (call.path === '/api/album/sp-nf/tracks')
        return json({ success: true, tracks: [{ id: 'sp-1', name: 'Ferry One' }] });
      if (call.path === '/api/library/check-tracks')
        return json({
          success: true,
          owned_tracks: { 'Ferry One': { owned: true, file_path: '/m/1.flac', format: 'FLAC' } },
        });
      return undefined;
    });
    renderArtist();
    await ready();
    await choose('More for Night Ferry', 'Play');
    await waitFor(() => expect(window.playTrackList).toHaveBeenCalledTimes(1));
    expect((window.playTrackList as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      [expect.objectContaining({ title: 'Ferry One', file_path: '/m/1.flac', is_library: true })],
      'Night Ferry',
    ]);
  });
});

/** The NDJSON the add endpoint streams. */
const ndjson = (...lines: unknown[]) =>
  new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });

describe('Add to Wanted', () => {
  it('reads as wanted straight away, then keeps it', async () => {
    const gate = deferred<Response>();
    fixture.handlers.push((call) =>
      call.path === '/api/artist/42/download-discography' ? gate.promise : undefined,
    );
    renderArtist();
    await ready();
    fireEvent.click(within(card('Pale Harbour')).getByRole('button', { name: 'Add to Wanted' }));
    expect(await within(card('Pale Harbour')).findByText('Wanted · Searching')).toBeInTheDocument();
    const body = JSON.parse(callsTo('/api/artist/42/download-discography')[0].body);
    expect(body).toMatchObject({
      artist_name: 'Pale Harbour',
      source: 'spotify',
      albums: [{ id: 'sp-ph', name: 'Pale Harbour', album_type: 'album', source: 'spotify' }],
    });
    fixture.wishAlbums = [...fixture.wishAlbums, wish('w-ph', 'Pale Harbour', 'sp-ph', 0)];
    await act(async () =>
      gate.resolve(
        ndjson(
          { album_id: 'sp-ph', name: 'Pale Harbour', status: 'done', tracks_added: 9 },
          { status: 'complete', total_added: 9, failed_releases: [] },
        ),
      ),
    );
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/^Added Pale Harbour to Wanted/),
        'success',
      ),
    );
    expect(within(card('Pale Harbour')).getByText('Wanted · Searching')).toBeInTheDocument();
  });

  it('goes back to Add to Wanted, and says why, when nothing was added', async () => {
    fixture.handlers.push((call) =>
      call.path === '/api/artist/42/download-discography'
        ? ndjson(
            { album_id: 'sp-ph', status: 'error', message: 'Album not found' },
            { status: 'complete', total_added: 0, failed_releases: [{ album_id: 'sp-ph' }] },
          )
        : undefined,
    );
    renderArtist();
    await ready();
    fireEvent.click(within(card('Pale Harbour')).getByRole('button', { name: 'Add to Wanted' }));
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        "Pale Harbour wasn't added: Album not found.",
        'warning',
      ),
    );
    expect(
      within(card('Pale Harbour')).getByRole('button', { name: 'Add to Wanted' }),
    ).toBeInTheDocument();
  });

  it('goes back when the server fails outright', async () => {
    fixture.handlers.push((call) =>
      call.path === '/api/artist/42/download-discography'
        ? json({ success: false, error: 'database is locked' }, 500)
        : undefined,
    );
    renderArtist();
    await ready();
    fireEvent.click(within(card('Pale Harbour')).getByRole('button', { name: 'Add to Wanted' }));
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        expect.stringContaining("Couldn't add Pale Harbour to Wanted: database is locked"),
        'error',
      ),
    );
    expect(
      within(card('Pale Harbour')).getByRole('button', { name: 'Add to Wanted' }),
    ).toBeInTheDocument();
  });

  it('adds all missing after asking, with a way to choose instead', async () => {
    stubApi({ wishSingles: [], wishAlbums: [] });
    fixture.handlers.push((call) =>
      call.path === '/api/artist/42/download-discography'
        ? ndjson({ status: 'complete', total_added: 0, failed_releases: [] })
        : undefined,
    );
    renderArtist();
    await screen.findByRole('heading', { level: 1, name: 'Pale Harbour' });
    await waitFor(() =>
      expect(within(card('Low Light')).getByText('Below quality target')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add all missing to Wanted' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add 6 releases to Wanted?' });
    expect(within(dialog).getByText(/from 2 albums and 4 EPs and singles/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Choose releases…' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 6 releases' }));
    await waitFor(() => expect(callsTo('/api/artist/42/download-discography')).toHaveLength(1));
    const ids = JSON.parse(callsTo('/api/artist/42/download-discography')[0].body).albums.map(
      (a: { id: string }) => a.id,
    );
    // the missing ones and the partly complete Tidewater; nothing owned in full
    expect(ids.sort()).toEqual(['sp-es', 'sp-gu', 'sp-nfl', 'sp-ph', 'sp-sw', 'sp-tw']);
  });

  it('says why it is off when there is nothing to add', async () => {
    stubApi({
      wishAlbums: [wish('w-tw', 'Tidewater', 'sp-tw', 1), wish('w-ph', 'Pale Harbour', 'sp-ph', 1)],
    });
    renderArtist();
    await ready();
    expect(screen.getByRole('button', { name: 'Add all missing to Wanted' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      screen.getByText('Everything here is in your library or on Wanted.'),
    ).toBeInTheDocument();
  });
});

describe('tabs, filters and paging live in the URL', () => {
  it('shows the first 8 releases and all 14 on request', async () => {
    const { router } = renderArtist();
    await ready();
    expect(
      within(screen.getByRole('list', { name: 'Releases by Pale Harbour' })).getAllByRole(
        'article',
      ),
    ).toHaveLength(8);
    expect(screen.getByText('8 of 14 releases')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 14' }));
    await waitFor(() => expect(search(router).all).toBe(true));
    expect(
      within(screen.getByRole('list', { name: 'Releases by Pale Harbour' })).getAllByRole(
        'article',
      ),
    ).toHaveLength(14);
    expect(screen.queryByText('8 of 14 releases')).toBeNull();
  });

  it('shows 4 on a phone', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    renderArtist();
    await ready();
    expect(
      within(screen.getByRole('list', { name: 'Releases by Pale Harbour' })).getAllByRole(
        'article',
      ),
    ).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Show all 14' })).toBeInTheDocument();
  });

  it('offers All, In your library, Missing and Albums, in that order', async () => {
    renderArtist();
    await ready();
    const group = screen.getByRole('group', { name: 'Show' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All', 'In your library', 'Missing', 'Albums']);
  });

  it('filters In your library: whole or in part, as the header counts it', async () => {
    const { router } = renderArtist();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'In your library' }));
    await waitFor(() => expect(search(router).show).toBe('library'));
    const titles = within(screen.getByRole('list', { name: 'Releases by Pale Harbour' }))
      .getAllByRole('article')
      .map((a) => a.getAttribute('aria-label'));
    // the header's 9 in your library, the first 8 of them on the page
    expect(titles).toHaveLength(8);
    expect(screen.getByText('8 of 9 releases')).toBeInTheDocument();
    expect(titles).toContain('Tidewater');
    expect(titles).not.toContain('Pale Harbour');
    expect(screen.getByRole('button', { name: 'In your library' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('filters Albums and Missing', async () => {
    const { router } = renderArtist();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Albums' }));
    await waitFor(() => expect(search(router).show).toBe('albums'));
    const titles = () =>
      within(screen.getByRole('list', { name: 'Releases by Pale Harbour' }))
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label'));
    expect(titles()).toEqual(['Tidewater', 'Night Ferry', 'Low Light', 'Pale Harbour']);
    fireEvent.click(screen.getByRole('button', { name: 'Missing' }));
    await waitFor(() => expect(search(router).show).toBe('missing'));
    expect(titles()).toEqual([
      'Tidewater',
      'Pale Harbour',
      'Night Ferry (Live)',
      'Slack Water',
      'Gull',
      'Estuary',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(search(router).show).toBeUndefined());
  });

  it('opens a tab from the URL, and Back steps between tabs', async () => {
    const { router, history } = renderArtist();
    await ready();
    expect(screen.getByRole('tab', { name: /Releases/ })).toHaveAttribute('aria-selected', 'true');
    expect(
      within(screen.getByRole('tab', { name: /Releases/ })).getByText('14'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('tab', { name: /Tracks/ })).getByText('132'),
    ).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/Releases/);
    fireEvent.click(screen.getByRole('tab', { name: /Similar artists/ }));
    await waitFor(() => expect(search(router).tab).toBe('similar'));
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/Similar artists/);
    expect(await screen.findByRole('link', { name: /Saltmarsh/ })).toHaveAttribute(
      'href',
      '/artist-detail/spotify/sp-sim-0?name=Saltmarsh',
    );
    // no id on any source: shown, not linked
    expect(screen.getByText('Unmatched').closest('a')).toBeNull();
    act(() => history.back());
    await waitFor(() => expect(search(router).tab).toBeUndefined());
    expect(screen.getByRole('tab', { name: /Releases/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('lists popular and library tracks, with the tag tools for an admin', async () => {
    const { router } = renderArtist('/artist-detail/library/42?name=Pale%20Harbour&tab=tracks');
    expect(await screen.findByText('Harbour Bell')).toBeInTheDocument();
    expect(await screen.findByText('Ferry One')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit tags and files' }));
    await waitFor(() => expect(search(router).manage).toBe(true));
    expect(
      await screen.findByRole('heading', { name: 'Tags, files and matches' }),
    ).toBeInTheDocument();
  });

  it('keeps the tag tools from everyone but admins', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      getCurrentProfileContext: vi.fn(() => ({ profileId: 3, isAdmin: false })),
    });
    renderArtist('/artist-detail/library/42?name=Pale%20Harbour&tab=tracks&manage=true');
    expect(await screen.findByText('Ferry One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit tags and files' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tags, files and matches' })).toBeNull();
  });
});

describe('loading, empty and failure', () => {
  it('says what is loading beside card placeholders, with the header and tabs in place', async () => {
    fixture.handlers.push((call) =>
      call.path.startsWith('/api/artist-detail/') ? new Promise<Response>(() => {}) : undefined,
    );
    renderArtist();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading Pale Harbour…');
    expect(screen.getByRole('heading', { level: 1, name: 'Pale Harbour' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Releases/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add all missing to Wanted' })).toBeNull();
  });

  it('says it could not load, why, and that nothing is at risk; Try again works', async () => {
    let fail = true;
    fixture.handlers.push((call) =>
      call.path.startsWith('/api/artist-detail/') && fail
        ? json({ success: false, error: 'database is locked' }, 500)
        : undefined,
    );
    renderArtist();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load Pale Harbour")).toBeInTheDocument();
    expect(alert).toHaveTextContent('Your library and Wanted are safe; this is a display problem.');
    expect(within(alert).getByRole('button', { name: 'Run Setup check' })).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await ready();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps Run Setup check from members, who cannot open it', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      getCurrentProfileContext: vi.fn(() => ({ profileId: 3, isAdmin: false })),
    });
    fixture.handlers.push((call) =>
      call.path.startsWith('/api/artist-detail/')
        ? json({ success: false, error: 'nope' }, 500)
        : undefined,
    );
    renderArtist();
    const alert = await screen.findByRole('alert');
    expect(within(alert).queryByRole('button', { name: 'Run Setup check' })).toBeNull();
  });

  it('shows an empty panel when nothing lists any releases', async () => {
    stubApi({
      detail: detail({ discography: { albums: [], eps: [], singles: [], source: 'spotify' } }),
    });
    renderArtist();
    expect(await screen.findByText('No releases listed for Pale Harbour')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search for music' })).toBeInTheDocument();
  });

  it('warns, without failing the page, when the metadata source did not answer', async () => {
    stubApi({
      detail: detail({
        provider_error: { state: 'error', error: 'Deezer timed out', source: 'deezer' },
      }),
    });
    renderArtist();
    expect(await screen.findByText("Showing only what's in your library")).toBeInTheDocument();
    expect(
      screen.getByText(/couldn't get the full discography from deezer: Deezer timed out/),
    ).toBeInTheDocument();
  });
});

describe('the "…" menu keeps what the old page did', () => {
  it('offers radio, choosing releases, better copies, following settings and the admin tools', async () => {
    renderArtist();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Pale Harbour' }));
    for (const name of [
      'Play artist radio',
      'Choose releases to add…',
      'Find better copies…',
      'Following settings…',
      'About Pale Harbour…',
      'More filters…',
      'Change photo…',
      'Check matches on each source…',
      'Refresh from your media server',
      'Database record…',
      'Report a problem…',
      'Remove from library…',
    ]) {
      expect(await screen.findByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('plays artist radio through the classic player', async () => {
    window.playArtistRadio = vi.fn();
    renderArtist();
    await ready();
    await choose('More actions for Pale Harbour', 'Play artist radio');
    expect(window.playArtistRadio).toHaveBeenCalled();
  });

  it('tells the artist’s story in About, with what the followed-artist check knows', async () => {
    fixture.handlers.push((call) =>
      call.path === '/api/watchlist/artist/sp-artist-ph/config'
        ? json({
            success: true,
            config: {},
            artist: {
              id: 'sp-artist-ph',
              name: 'Pale Harbour',
              followers: 52000,
              popularity: 64,
              label: 'Tide Records',
            },
          })
        : undefined,
    );
    renderArtist();
    await ready();
    await choose('More actions for Pale Harbour', 'About Pale Harbour…');
    const dialog = await screen.findByRole('dialog', { name: 'About Pale Harbour' });
    expect(within(dialog).getByText('A four-piece from the north coast.')).toBeInTheDocument();
    expect(within(dialog).getByText('182.3K')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Following since March 2025 · last checked/),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText('52,000')).toBeInTheDocument();
    expect(within(dialog).getByText('Tide Records')).toBeInTheDocument();
  });

  it('removes the artist through the Safe action, to the recycle bin (HANDOFF 74)', async () => {
    fixture.handlers.push((call) => {
      if (call.path === '/api/library/albums/remove-preview')
        return json({
          success: true,
          plan_id: 'p1',
          total: 2,
          total_bytes: 2048,
          sample: [
            {
              path: '/m/Pale Harbour/Night Ferry/01.flac',
              reason: 'Pale Harbour · Night Ferry',
              size: 1024,
            },
            {
              path: '/m/Pale Harbour/Night Ferry/02.flac',
              reason: 'Pale Harbour · Night Ferry',
              size: 1024,
            },
          ],
          meta: { albums: 1, album_ids: ['L-nf'], artist_id: '42' },
          created_at: 1,
          expires_at: 4102444800,
        });
      if (call.path === '/api/library/albums/remove')
        return json({
          success: true,
          albums_removed: 1,
          files_moved: 2,
          skipped: 0,
          errors: [],
          artist_removed: true,
        });
      return undefined;
    });
    renderArtist();
    await ready();
    await choose('More actions for Pale Harbour', 'Remove from library…');
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove Pale Harbour from your library?',
    });
    await within(dialog).findByText(/go(es)? to the recycle bin/);
    expect(JSON.parse(callsTo('/api/library/albums/remove-preview')[0].body)).toEqual({
      artist_id: '42',
    });
    // no database-only delete any more, and nothing moves before the confirm
    expect(callsTo('/api/library/artist/42', 'DELETE')).toHaveLength(0);
    expect(callsTo('/api/library/albums/remove')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I checked the list' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 1 album' }));
    await waitFor(() => expect(callsTo('/api/library/albums/remove')).toHaveLength(1));
    expect(JSON.parse(callsTo('/api/library/albums/remove')[0].body)).toEqual({ plan_id: 'p1' });
    // the done state follows the remove's answer and a refetch; give a busy
    // CI runner longer than findBy's default second
    expect(
      await screen.findByText('Removed Pale Harbour from your library', undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
  });

  it('lets More filters choose what the page lists, as the old filter bar did', async () => {
    renderArtist();
    await ready();
    await choose('More actions for Pale Harbour', 'More filters…');
    const dialog = await screen.findByRole('dialog', { name: 'More filters' });
    fireEvent.click(within(dialog).getByText('Singles'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(
        screen.getByText('8 releases · 6 in your library (132 tracks) · 2 on Wanted'),
      ).toBeInTheDocument(),
    );
  });

  it('lists releases only another source knows (#1067), badged, adding from that source', async () => {
    window.localStorage.removeItem('discog_gapfill');
    fixture.handlers.push((call) => {
      if (call.path === '/api/artist/42/discography/gap-fill')
        return json({
          success: true,
          gaps: {
            albums: [{ id: 'dz-777', title: 'Tidal Atlas', year: 2025, gap_source: 'deezer' }],
          },
        });
      if (call.path === '/api/artist/42/download-discography')
        return ndjson(
          { album_id: 'dz-777', status: 'done', tracks_added: 8 },
          { status: 'complete', total_added: 8, failed_releases: [] },
        );
      return undefined;
    });
    renderArtist('/artist-detail/library/42?name=Pale%20Harbour&all=true');
    await ready();
    expect(screen.queryByRole('article', { name: 'Tidal Atlas' })).toBeNull();
    await choose('More actions for Pale Harbour', 'More filters…');
    const dialog = await screen.findByRole('dialog', { name: 'More filters' });
    fireEvent.click(within(dialog).getByText('Releases only your other metadata sources list'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    const gap = await screen.findByRole('article', { name: 'Tidal Atlas' });
    expect(gap).toHaveAttribute('data-gap-source', 'deezer');
    expect(within(gap).getByText('Listed by Deezer only')).toBeInTheDocument();
    expect(callsTo('/api/artist/42/discography/gap-fill')[0].url).toContain('base_source=spotify');
    fireEvent.click(within(gap).getByRole('button', { name: 'Add to Wanted' }));
    await waitFor(() => expect(callsTo('/api/artist/42/download-discography')).toHaveLength(1));
    expect(JSON.parse(callsTo('/api/artist/42/download-discography')[0].body).albums).toEqual([
      expect.objectContaining({ id: 'dz-777', source: 'deezer' }),
    ]);
    window.localStorage.removeItem('discog_gapfill');
  });

  it('hides the library-only tools for an artist who is not in the library', async () => {
    stubApi({
      detail: detail({ artist: { id: 'dz1', name: 'Pale Harbour' }, spotify_artist: undefined }),
    });
    renderArtist('/artist-detail/deezer/dz1?name=Pale%20Harbour');
    await screen.findByText('14 releases · not in your library · 5 on Wanted');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Pale Harbour' }));
    expect(
      await screen.findByRole('menuitem', { name: 'About Pale Harbour…' }),
    ).toBeInTheDocument();
    for (const name of [
      'Play artist radio',
      'Change photo…',
      'Remove from library…',
      'Database record…',
    ]) {
      expect(screen.queryByRole('menuitem', { name })).toBeNull();
    }
  });
});
