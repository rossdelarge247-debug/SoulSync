import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

import type { BasicAlbum, BasicResult, BasicTrack } from './-basic.types';

import { resetPersistedSearch } from './-search.use-controller';
import { resetFileSearchCache } from './-soulseek.stream';
import { resetSearchPageMemory } from './-ui/search-page';

// ── fixtures ────────────────────────────────────────────────────────────

const TIDEWATER = ['Harbour Light', 'Slack Water', 'Lantern Room'];

function file(title: string, over: Partial<BasicTrack> = {}): BasicTrack {
  return {
    result_type: 'track',
    username: 'slackwater88',
    filename: `Music/Pale Harbour - Tidewater/01 - ${title}.flac`,
    size: 32_000_000,
    bitrate: 1000,
    duration: 240_000,
    quality: 'flac',
    free_upload_slots: 1,
    upload_speed: 1_200_000,
    queue_length: 0,
    sample_rate: 44100,
    bit_depth: 16,
    artist: 'Pale Harbour',
    title,
    album: 'Tidewater',
    track_number: 1,
    quality_score: 0.8,
    ...over,
  };
}

function folder(path: string, user: string, over: Partial<BasicTrack> = {}): BasicAlbum {
  const tracks = TIDEWATER.map((t, i) =>
    file(t, {
      username: user,
      filename: `${path}/0${i + 1} - ${t}.${over.quality ?? 'flac'}`,
      track_number: i + 1,
      ...over,
    }),
  );
  return {
    result_type: 'album',
    username: user,
    album_path: path,
    album_title: 'Tidewater',
    artist: 'Pale Harbour',
    track_count: tracks.length,
    total_size: 120_000_000,
    tracks,
    dominant_quality: over.quality ?? 'flac',
    year: '2026',
    free_upload_slots: 1,
    upload_speed: 3_100_000,
    queue_length: 0,
    quality_score: 0.9,
  };
}

const FLAC_FOLDER = folder('Music/Pale Harbour - Tidewater (2026) [FLAC]', 'harbourmaster');
const MP3_FOLDER = folder('rips/Pale Harbour - Tidewater (2026) MP3', 'vinylrips', {
  quality: 'mp3',
  bitrate: 320,
  bit_depth: null,
  sample_rate: null,
});
const LONE_TRACK = file('Harbour Light');
const ALL_FILES: BasicResult[] = [FLAC_FOLDER, MP3_FOLDER, LONE_TRACK];

/** What the library check says, by title: one wanted, two owned in FLAC. */
function ownership(name: string) {
  if (name === 'Harbour Light') return { in_library: false, in_wishlist: true };
  if (TIDEWATER.includes(name))
    return { in_library: true, in_wishlist: false, file_path: `/m/${name}.flac`, bitrate: 1000 };
  return { in_library: false, in_wishlist: false };
}

const PRESETS = {
  success: true,
  total: 100,
  unknown_format: 0,
  presets: [],
  current: {
    preset: 'flac',
    name: 'FLAC or better',
    updated_at: 1,
    targets: [{ label: 'FLAC 16-bit', format: 'flac', bit_depth: 16 }],
  },
};

const CATALOG = {
  spotify_artists: [{ id: 'sp-a', name: 'Pale Harbour', source: 'spotify' }],
  spotify_albums: [
    {
      id: 'sp1',
      name: 'Pale Harbour',
      artist: 'Pale Harbour',
      album_type: 'album',
      release_date: '2019-04-02',
      total_tracks: 9,
      source: 'spotify',
    },
  ],
  spotify_playlists: [
    {
      id: 'pl1',
      name: 'Pale Harbour: Harbour Nights',
      creator: 'Spotify',
      track_count: 40,
      source: 'spotify',
    },
  ],
};

const ndjson = (...events: unknown[]) =>
  new HttpResponse(events.map((e) => `${JSON.stringify(e)}\n`).join(''), {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });

/** A stream the test feeds line by line. */
function liveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: () =>
      new HttpResponse(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    send: (event: unknown) =>
      controller.enqueue(new Uint8Array(Buffer.from(`${JSON.stringify(event)}\n`))),
    end: () => controller.close(),
  };
}

interface Seen {
  streams: string[];
  catalog: string[];
  library: string[];
  lookups: string[];
}

function routes(): Seen {
  const seen: Seen = { streams: [], catalog: [], library: [], lookups: [] };
  server.use(
    http.get('/status', () => HttpResponse.json({ metadata_source: { source: 'spotify' } })),
    http.get('/api/settings/config-status', () =>
      HttpResponse.json({ spotify: { configured: true }, deezer: { configured: true } }),
    ),
    http.get('/api/search/sources', () =>
      HttpResponse.json({
        mode: 'soulseek',
        sources: [{ name: 'soulseek', display_name: 'Soulseek' }],
      }),
    ),
    http.get('/api/quality/presets', () => HttpResponse.json(PRESETS)),
    http.get('/api/library/artists', ({ request }) => {
      seen.library.push(new URL(request.url).searchParams.get('search') ?? '');
      return HttpResponse.json({
        success: true,
        artists: [
          { id: 7, name: 'Pale Harbour', album_count: 9, track_count: 93, is_watched: true },
        ],
        pagination: { total_count: 1 },
      });
    }),
    http.get('/api/library/albums', () =>
      HttpResponse.json({
        success: true,
        albums: [
          {
            id: 11,
            title: 'Night Ferry',
            year: 2023,
            artist_id: 7,
            artist_name: 'Pale Harbour',
            track_count: 10,
          },
        ],
        pagination: { total_count: 1 },
      }),
    ),
    http.get('/api/library/search-tracks', () => HttpResponse.json({ success: true, tracks: [] })),
    http.get('/api/library/albums/:id/tracks', () =>
      HttpResponse.json({
        success: true,
        tracks: [
          { id: 1, title: 'Night Ferry', track_number: 1, file_path: '/m/a.flac', bitrate: 1000 },
        ],
      }),
    ),
    http.post('/api/search/stream', async ({ request }) => {
      seen.streams.push(((await request.json()) as { query: string }).query);
      return ndjson({ type: 'done', files: 7, users: 3, results: ALL_FILES });
    }),
    http.post('/api/enhanced-search/library-check', async ({ request }) => {
      const body = (await request.json()) as {
        albums?: unknown[];
        tracks?: { name: string }[];
      };
      return HttpResponse.json({
        // albums answer with a plain yes or no
        albums: (body.albums ?? []).map(() => false),
        tracks: (body.tracks ?? []).map((t) => ownership(t.name)),
      });
    }),
    http.post('/api/enhanced-search', async ({ request }) => {
      seen.catalog.push(((await request.json()) as { query: string }).query);
      return HttpResponse.json(CATALOG);
    }),
    http.post('/api/enhanced-search/by-id', async ({ request }) => {
      seen.lookups.push(((await request.json()) as { query: string }).query);
      return HttpResponse.json({ available: false, message: 'No match for that link.' });
    }),
    http.post('/api/labels/search', () =>
      HttpResponse.json({ labels: [{ id: 'l1', name: 'Warp' }] }),
    ),
    http.get('/api/artist/:id/image', () => HttpResponse.json({ success: false })),
  );
  return seen;
}

function renderRoute(path: string) {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, queryClient });
  render(<AppRouterProvider router={router} queryClient={queryClient} />);
  return router;
}

/** The status line is written twice, the wide and the phone copy. */
const findStatus = async (text: string) => (await screen.findAllByText(text))[0];

const settled = () => screen.findByRole('heading', { level: 1, name: 'Search' });
const input = () => document.getElementById('enhanced-search-input') as HTMLInputElement;
const section = (id: string) => document.getElementById(id) as HTMLElement;

/** Type into the field the way a keystroke does. */
function type(value: string) {
  fireEvent.change(input(), { target: { value } });
}

beforeEach(() => {
  resetPersistedSearch();
  resetFileSearchCache();
  resetSearchPageMemory();
  window.localStorage.removeItem('soulsyncRecentSearches');
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showToast = vi.fn();
});

afterEach(() => {
  cleanup();
  delete window._searchPageSetQuery;
  delete window.showSearchDownloadBubbles;
  delete window.showToast;
});

// ── tests ───────────────────────────────────────────────────────────────

describe('the Search page', () => {
  it('renders without the shell’s .page class, idle with Browse', async () => {
    routes();
    renderRoute('/search');
    await settled();

    const host = document.getElementById('webui-react-root') ?? document.body;
    expect(host.querySelector('.page')).toBeNull();
    expect(input()).toHaveAttribute('placeholder', 'Artists, albums, tracks, or paste a link');
    expect(screen.getByRole('heading', { name: 'Browse' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Everything' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows your recent searches when idle, and runs one again', async () => {
    routes();
    window.localStorage.setItem('soulsyncRecentSearches', JSON.stringify(['low light']));
    const router = renderRoute('/search');
    await settled();

    // a recent search is a submitted one: Soulseek too
    fireEvent.click(screen.getByRole('button', { name: 'low light' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'low light', files: 1 }));
  });
});

describe('the query and type live in the URL', () => {
  it('reads both from the URL', async () => {
    routes();
    renderRoute('/search?q=pale%20harbour&type=albums');
    await settled();

    expect(input().value).toBe('pale harbour');
    expect(screen.getByRole('button', { name: 'Albums' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('treats arriving with ?q= as a submitted search', async () => {
    const seen = routes();
    const router = renderRoute('/search?q=pale%20harbour');
    await settled();

    await waitFor(() =>
      expect(router.state.location.search).toEqual({ q: 'pale harbour', files: 1 }),
    );
    await waitFor(() => expect(seen.streams).toEqual(['pale harbour']));
  });

  it('writes the type, dropping the default and keeping the submit', async () => {
    const seen = routes();
    const router = renderRoute('/search?q=pale%20harbour&files=1');
    await settled();

    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        q: 'pale harbour',
        type: 'tracks',
        files: 1,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Everything' }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ q: 'pale harbour', files: 1 }),
    );
    // the same submitted query: Soulseek was asked once
    expect(seen.streams).toEqual(['pale harbour']);
  });

  it('searches the library and the service as you type, and Soulseek only on Enter', async () => {
    const seen = routes();
    const router = renderRoute('/search');
    await settled();

    type('pale har');
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'pale har' }), {
      timeout: 3000,
    });
    await waitFor(() => expect(seen.library).toEqual(['pale har']));
    await waitFor(() => expect(seen.catalog).toEqual(['pale har']));
    const prompt = await screen.findByTestId('soulseek-prompt');
    expect(prompt).toHaveTextContent('Press Enter to search Soulseek for “pale har”');
    expect(seen.streams).toEqual([]);

    type('pale harbour');
    fireEvent.submit(input().closest('form')!);
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ q: 'pale harbour', files: 1 }),
    );
    await waitFor(() => expect(seen.streams).toEqual(['pale harbour']));
    expect(screen.queryByTestId('soulseek-prompt')).toBeNull();
    expect(await findStatus('7 files from 3 users')).toBeInTheDocument();
  });

  it('offers a secondary "Search Soulseek" while the typed query differs from the submitted one', async () => {
    const seen = routes();
    const router = renderRoute('/search?q=pale%20harbour&files=1');
    await settled();
    await findStatus('7 files from 3 users');

    type('low light');
    const prompt = screen.getByTestId('soulseek-prompt');
    expect(prompt).toHaveTextContent('Press Enter to search Soulseek for “low light”');
    const button = within(prompt).getByRole('button', { name: 'Search Soulseek' });
    expect(button).toHaveAttribute('data-variant', 'default');
    // the one primary belonged to a Soulseek row, which isn't on screen now
    expect(
      document.querySelectorAll('[data-testid="search-page"] button[data-variant="primary"]'),
    ).toHaveLength(0);

    fireEvent.click(button);
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'low light', files: 1 }));
    await waitFor(() => expect(seen.streams).toEqual(['pale harbour', 'low light']));
  });

  it('goes back to a submitted search with its Soulseek results, without searching again', async () => {
    const seen = routes();
    const router = renderRoute('/search?q=pale%20harbour&files=1');
    await settled();
    await findStatus('7 files from 3 users');

    type('low light');
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(seen.streams).toEqual(['pale harbour', 'low light']));

    act(() => router.history.back());
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ q: 'pale harbour', files: 1 }),
    );
    expect(input().value).toBe('pale harbour');
    expect(await findStatus('7 files from 3 users')).toBeInTheDocument();
    expect(screen.queryByTestId('soulseek-prompt')).toBeNull();
    // the finished search is kept for the session
    expect(seen.streams).toEqual(['pale harbour', 'low light']);

    act(() => router.history.forward());
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'low light', files: 1 }));
    expect(input().value).toBe('low light');
  });

  it('clears the query back to the idle page', async () => {
    routes();
    const router = renderRoute('/search?q=pale%20harbour&files=1');
    await settled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(await screen.findByRole('heading', { name: 'Browse' })).toBeInTheDocument();
  });

  it('doesn’t search a single character', async () => {
    const seen = routes();
    const router = renderRoute('/search');
    await settled();

    type('a');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800));
    });
    expect(router.state.location.search).toEqual({});
    expect(seen.streams).toEqual([]);
  });
});

describe('the three sections', () => {
  it('come in order: your library, Soulseek, then the metadata service', async () => {
    routes();
    renderRoute('/search?q=pale%20harbour');
    await settled();

    await screen.findByText('Night Ferry');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['In your library', 'Soulseek', 'Spotify']);
  });

  it('links a library artist to its library page and a found one to its source', async () => {
    routes();
    renderRoute('/search?q=pale%20harbour');
    await settled();

    const library = section('search-library');
    const owned = await within(library).findByRole('link', { name: 'Pale Harbour' });
    expect(owned).toHaveAttribute('href', '/artist-detail/library/7?name=Pale%20Harbour');

    const catalog = section('search-catalog');
    const found = await within(catalog).findByRole('link', { name: 'Pale Harbour' });
    expect(found).toHaveAttribute('href', '/artist-detail/spotify/sp-a?name=Pale%20Harbour');

    // a label is the fourth row: past the first three, under "All 4"
    fireEvent.click(await within(catalog).findByRole('button', { name: 'All 4' }));
    const label = await within(catalog).findByRole('link', { name: 'Warp' });
    expect(label).toHaveAttribute('href', '/label-detail/l1?name=Warp');
  });

  it('leaves Soulseek out of an Artists search', async () => {
    const seen = routes();
    renderRoute('/search?q=pale%20harbour&type=artists');
    await settled();

    await screen.findByRole('heading', { level: 2, name: 'In your library' });
    expect(screen.queryByRole('heading', { level: 2, name: 'Soulseek' })).toBeNull();
    expect(seen.streams).toEqual([]);
  });

  it('says nothing was found anywhere, and offers to clear the search', async () => {
    routes();
    server.use(
      http.get('/api/library/artists', () => HttpResponse.json({ success: true, artists: [] })),
      http.get('/api/library/albums', () => HttpResponse.json({ success: true, albums: [] })),
      http.post('/api/search/stream', () =>
        ndjson({ type: 'done', files: 0, users: 0, results: [] }),
      ),
      http.post('/api/enhanced-search', () => HttpResponse.json({})),
    );
    renderRoute('/search?q=zzzz');
    await settled();

    expect(
      await screen.findByText('Nothing found for “zzzz”', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear the search' })).toBeInTheDocument();
  });

  it('shows each section’s own failure, and the others still answer', async () => {
    routes();
    server.use(
      http.get('/api/library/artists', () => HttpResponse.json({}, { status: 500 })),
      http.get('/api/library/albums', () => HttpResponse.json({}, { status: 500 })),
      http.get('/api/library/search-tracks', () => HttpResponse.json({}, { status: 500 })),
      http.post('/api/search/stream', () =>
        ndjson({ type: 'error', error: 'Soulseek isn’t connected.' }),
      ),
    );
    renderRoute('/search?q=pale%20harbour');
    await settled();

    const library = await within(section('search-library')).findByRole('alert');
    expect(library).toHaveTextContent('Couldn’t search your library');
    const files = await within(section('search-soulseek')).findByRole('alert');
    expect(files).toHaveTextContent('Couldn’t search Soulseek');
    expect(files).toHaveTextContent('Soulseek isn’t connected. Nothing was downloaded.');
    expect(within(files).getByRole('link', { name: 'Run Setup check' })).toBeInTheDocument();
    // the metadata service still answered
    expect(
      await within(section('search-catalog')).findByText('Pale Harbour: Harbour Nights'),
    ).toBeInTheDocument();
  });

  it('tries the file search again from its failure', async () => {
    const seen = routes();
    let fail = true;
    server.use(
      http.post('/api/search/stream', async ({ request }) => {
        seen.streams.push(((await request.json()) as { query: string }).query);
        return fail
          ? ndjson({ type: 'error', error: 'Soulseek isn’t connected.' })
          : ndjson({ type: 'done', files: 7, users: 3, results: ALL_FILES });
      }),
    );
    renderRoute('/search?q=pale%20harbour');
    await settled();
    const alert = await within(section('search-soulseek')).findByRole('alert');

    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await findStatus('7 files from 3 users')).toBeInTheDocument();
    expect(seen.streams).toEqual(['pale harbour', 'pale harbour']);
  });

  it('shows the metadata service’s failure with a retry', async () => {
    routes();
    server.use(http.post('/api/enhanced-search', () => HttpResponse.json({}, { status: 500 })));
    renderRoute('/search?q=pale%20harbour');
    await settled();

    const alert = await within(section('search-catalog')).findByRole('alert', undefined, {
      timeout: 3000,
    });
    expect(alert).toHaveTextContent('Couldn’t search Spotify');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('the Soulseek section', () => {
  it('counts files and users as they stream in, then settles', async () => {
    routes();
    const live = liveStream();
    server.use(http.post('/api/search/stream', () => live.response()));
    renderRoute('/search?q=pale%20harbour');
    await settled();

    expect(
      await within(section('search-soulseek')).findByText('Asking Soulseek users for files…'),
    ).toBeInTheDocument();

    live.send({ type: 'progress', files: 3, users: 1, results: [FLAC_FOLDER] });
    expect(await findStatus('Still searching · 3 files from 1 user so far')).toBeInTheDocument();
    expect(within(section('search-soulseek')).getAllByTestId('soulseek-row')).toHaveLength(1);

    live.send({ type: 'done', files: 7, users: 3, results: ALL_FILES });
    live.end();
    expect(await findStatus('7 files from 3 users')).toBeInTheDocument();
  });

  it('stops a search and keeps what arrived', async () => {
    routes();
    const live = liveStream();
    server.use(http.post('/api/search/stream', () => live.response()));
    renderRoute('/search?q=pale%20harbour');
    await settled();
    live.send({ type: 'progress', files: 3, users: 1, results: [FLAC_FOLDER] });
    await findStatus('Still searching · 3 files from 1 user so far');

    fireEvent.click(within(section('search-soulseek')).getByRole('button', { name: 'Stop' }));
    expect(await findStatus('Stopped · 3 files from 1 user')).toBeInTheDocument();
    expect(
      within(section('search-soulseek')).getByRole('button', { name: 'Search again' }),
    ).toBeInTheDocument();
    expect(within(section('search-soulseek')).getAllByTestId('soulseek-row')).toHaveLength(1);
  });

  it('shows copies at your target by default, and the rest on Any quality', async () => {
    routes();
    renderRoute('/search?q=pale%20harbour');
    await settled();
    await findStatus('7 files from 3 users');
    const files = section('search-soulseek');

    const target = within(files).getByRole('button', { name: 'At your target (FLAC+)' });
    expect(target).toHaveAttribute('aria-pressed', 'true');
    // the MP3 folder is a copy of the same album, below the target
    expect(within(files).queryByRole('button', { name: /other cop/ })).toBeNull();

    fireEvent.click(within(files).getByRole('button', { name: 'Any quality' }));
    fireEvent.click(within(files).getByRole('button', { name: '1 other copy' }));
    const copy = within(files).getByTestId('soulseek-copy');
    expect(copy).toHaveTextContent('Pale Harbour - Tidewater (2026) MP3');
    expect(copy).toHaveTextContent('MP3 320');
  });

  it('groups by folder with the best copy first, and says what each row means for you', async () => {
    routes();
    renderRoute('/search?q=pale%20harbour');
    await settled();
    const files = section('search-soulseek');

    await waitFor(() =>
      expect(within(files).getAllByText("has the 1 track you're missing").length).toBeGreaterThan(
        0,
      ),
    );
    const rows = within(files).getAllByTestId('soulseek-row');
    expect(rows[0]).toHaveTextContent('Pale Harbour - Tidewater (2026) [FLAC]');
    expect(within(rows[1]).getAllByText('on your Wanted list').length).toBeGreaterThan(0);
    expect(
      within(files).getByText(/grouped by folder, best copy of each first/),
    ).toBeInTheDocument();
  });

  it('gives the page one primary button: the row that completes what you want', async () => {
    routes();
    renderRoute('/search?q=pale%20harbour');
    await settled();
    const files = section('search-soulseek');
    await waitFor(() =>
      expect(within(files).getAllByText("has the 1 track you're missing").length).toBeGreaterThan(
        0,
      ),
    );
    await within(section('search-catalog')).findByText('Pale Harbour: Harbour Nights');

    const primaries = document.querySelectorAll(
      '[data-testid="search-page"] button[data-variant="primary"]',
    );
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent('Download missing');
    // the lone track on your Wanted list completes something too, but stays secondary
    expect(
      within(files).getByRole('button', { name: /^Download: 01 - Harbour Light\.flac/ }),
    ).toHaveAttribute('data-variant', 'default');
    expect(within(files).getByRole('button', { name: /^Download all:/ })).toBeInTheDocument();
  });
});

describe('the metadata service section', () => {
  it('offers Add to Wanted for releases you don’t have, and mirrors a playlist in the dialog', async () => {
    routes();
    server.use(
      http.get('/api/spotify/playlists', () => HttpResponse.json([])),
      http.get('/api/mirrored-playlists', () => HttpResponse.json([])),
      http.get('/api/spotify/playlist/:id', () =>
        HttpResponse.json({ name: 'Pale Harbour: Harbour Nights', owner: 'Spotify', tracks: [] }),
      ),
    );
    renderRoute('/search?q=pale%20harbour');
    await settled();
    expect(
      await screen.findByRole('button', { name: 'Add Pale Harbour to Wanted' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Mirror this playlist: Pale Harbour: Harbour Nights' }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Mirror a playlist' })).toBeInTheDocument();
    expect(await within(dialog).findByText('Pale Harbour: Harbour Nights')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio')).toBeChecked();
  });
});

describe('the hand-offs other pages use', () => {
  it('searches for what _searchPageSetQuery hands over', async () => {
    const seen = routes();
    const router = renderRoute('/search');
    await settled();

    act(() => window._searchPageSetQuery?.('low light'));
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'low light', files: 1 }));
    expect(input().value).toBe('low light');
    await waitFor(() => expect(seen.streams).toEqual(['low light']));
  });

  it('submits a query written into the field with a native input event', async () => {
    const seen = routes();
    const router = renderRoute('/search');
    await settled();

    const field = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set as (
      v: string,
    ) => void;
    act(() => {
      setter.call(field, 'from the top bar');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // a hand-off (the top bar, chat, the library) is a search someone asked for
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ q: 'from the top bar', files: 1 }),
    );
    await waitFor(() => expect(seen.streams).toEqual(['from the top bar']));
  });

  it('keeps the download bubbles’ container and asks for a repaint', async () => {
    routes();
    const repaint = vi.fn();
    window.showSearchDownloadBubbles = repaint;
    renderRoute('/search');
    await settled();

    expect(document.getElementById('enhanced-main-results-area')).not.toBeNull();
    await waitFor(() => expect(repaint).toHaveBeenCalled());
  });

  it('cleans up _searchPageSetQuery when it goes', async () => {
    routes();
    renderRoute('/search');
    await settled();
    expect(typeof window._searchPageSetQuery).toBe('function');
    cleanup();
    expect(window._searchPageSetQuery).toBeUndefined();
  });

  it('sends a pasted link to the id lookup, not the text searches', async () => {
    const seen = routes();
    renderRoute(
      `/search?q=${encodeURIComponent('https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv')}`,
    );
    await settled();

    await waitFor(() =>
      expect(seen.lookups).toEqual(['https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv']),
    );
    expect(window.showToast).toHaveBeenCalledWith('No match for that link.', 'warning');
    expect(seen.catalog).toEqual([]);
    expect(seen.library).toEqual([]);
    expect(seen.streams).toEqual([]);
  });
});
