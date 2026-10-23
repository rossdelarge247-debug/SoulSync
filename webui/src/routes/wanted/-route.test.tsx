import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

// whole-page route tests: role queries over a page of rows are slow in jsdom,
// more so on a loaded CI runner
vi.setConfig({ testTimeout: 40_000 });

vi.mock('@/features/downloads/inspector-modal', () => ({
  openWishlistInspector: vi.fn(),
}));

const { openWishlistInspector } = await import('@/features/downloads/inspector-modal');

const DAY = 86_400_000;
const sql = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

function track(o: {
  id: string;
  name: string;
  artist: string;
  album: string;
  type?: string;
  total?: number;
  tries?: number;
  reason?: string;
  ago?: number;
  source?: string;
}) {
  return {
    spotify_track_id: o.id,
    spotify_data: {
      name: o.name,
      artists: [{ name: o.artist }],
      album: {
        name: o.album,
        album_type: o.type ?? 'album',
        total_tracks: o.total ?? 11,
        images: [],
      },
    },
    retry_count: o.tries ?? 0,
    last_attempted: o.tries ? sql(3_600_000) : null,
    failure_reason: o.reason ?? null,
    date_added: sql(o.ago ?? DAY),
    source_type: o.source ?? 'manual',
    source_info: null,
    quality_profile_id: 1,
  };
}

const ALBUMS = [
  track({
    id: 'hl',
    name: 'Harbour Light',
    artist: 'Pale Harbour',
    album: 'Tidewater',
    ago: 3 * DAY,
    tries: 1,
  }),
  track({
    id: 'ln1',
    name: 'Lantern One',
    artist: 'Saltmarsh',
    album: 'Lantern',
    ago: 7 * DAY,
    tries: 14,
  }),
  track({
    id: 'ln2',
    name: 'Lantern Two',
    artist: 'Saltmarsh',
    album: 'Lantern',
    ago: 7 * DAY,
    tries: 14,
  }),
];
const SINGLES = [
  track({
    id: 'nf',
    name: 'Night Ferry (Live)',
    artist: 'Pale Harbour',
    album: 'Night Ferry (Live)',
    type: 'single',
    total: 1,
    tries: 22,
    reason: 'User went offline',
    ago: 21 * DAY,
  }),
];
const FOUND = [
  {
    id: 'sb',
    title: 'Static Bloom',
    artist: 'Saltmarsh',
    album: 'Lantern',
    quality: 'FLAC 24/96',
    image: '',
    found_at: new Date(Date.now() - 3_600_000).toISOString(),
    reason: 'download_complete',
  },
];

function watchArtist(id: number, name: string, extra: Record<string, unknown> = {}) {
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
    ...extra,
  };
}
const ARTISTS = [
  watchArtist(1, 'Pale Harbour'),
  watchArtist(2, 'Saltmarsh'),
  watchArtist(3, 'Marrow & Pine', { last_scan_timestamp: null }),
];
const SUMMARY = [
  {
    id: 1,
    library_releases: 9,
    latest_release: null,
    last_found: {
      album_name: 'Tidewater',
      found_at: new Date(Date.now() - 2 * DAY).toISOString(),
      added_to_wanted: true,
    },
    new_release: true,
  },
  {
    id: 2,
    library_releases: 3,
    latest_release: { album_name: 'Lantern', release_date: '2025-10-01' },
    last_found: null,
    new_release: false,
  },
  { id: 3, library_releases: 0, latest_release: null, last_found: null, new_release: false },
];

const ago = (ms: number) => new Date(Date.now() - ms).toISOString().slice(0, 19) + 'Z';
const secsAgo = (ms: number) => Math.floor((Date.now() - ms) / 1000);
const HOUR = 3_600_000;

/** Found by the label check yesterday, still on Wanted: Hessle Audio's new release. */
const LABEL_TRACK = {
  ...track({ id: 'hes', name: 'HES053 A1', artist: 'Bruce', album: 'HES053', ago: DAY }),
  source_type: 'watchlist_label',
  source_info: { label_mbid: 'mb-hessle', label_name: 'Hessle Audio', album_name: 'HES053' },
};

const LABELS = [
  {
    id: 1,
    musicbrainz_label_id: 'mb-hessle',
    discogs_label_id: null,
    label_name: 'Hessle Audio',
    source: 'musicbrainz',
    backlog: false,
    date_added: sql(40 * DAY),
    last_scan_timestamp: sql(DAY),
  },
  {
    id: 2,
    musicbrainz_label_id: 'mb-light',
    discogs_label_id: null,
    label_name: 'Lighttown Recordings',
    source: 'musicbrainz',
    backlog: false,
    date_added: sql(10 * 60_000),
    last_scan_timestamp: null,
  },
];

const PODCASTS = [
  {
    id: 1,
    feed_url: 'https://feeds.example.com/exchange',
    itunes_id: 761,
    title: 'Resident Advisor Exchange',
    author: 'Resident Advisor',
    artwork_url: null,
    auto_download: true,
    retention_days: 14,
    episode_count: 212,
    date_added: sql(90 * DAY),
    last_scan_timestamp: sql(HOUR),
  },
  {
    id: 2,
    feed_url: 'https://feeds.example.com/quiet',
    itunes_id: null,
    title: 'Quiet Hours',
    author: 'Someone',
    artwork_url: null,
    auto_download: false,
    retention_days: 7,
    episode_count: 40,
    date_added: sql(90 * DAY),
    last_scan_timestamp: sql(2 * HOUR),
  },
];
const PODCAST_SUMMARY = [
  {
    feed_url: 'https://feeds.example.com/exchange',
    kept: 40,
    latest_episode: { title: 'EX.761', downloaded_at: ago(3 * HOUR) },
    new_episode: true,
  },
  {
    feed_url: 'https://feeds.example.com/quiet',
    kept: 0,
    latest_episode: null,
    new_episode: false,
  },
];

const AUTHORS = [
  {
    name: 'Ursula K. Le Guin',
    role: 'author',
    cover_url: '',
    since_date: '2026-01-01',
    last_scanned_at: secsAgo(DAY),
    found_total: 1,
    last_error: '',
    added_at: secsAgo(100 * DAY),
    auto_wishlist: 1,
    narrator_mode: 'exact',
  },
];
const BOOKS = [
  {
    id: 1,
    asin: 'B0DISPO',
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
    added_at: secsAgo(30 * DAY),
  },
];

interface Setup {
  labels?: unknown[];
  podcasts?: unknown[];
  authors?: unknown[];
  modules?: unknown[];
  scan?: Record<string, unknown>;
  albums?: unknown[];
  singles?: unknown[];
  found?: unknown[];
  artists?: unknown[];
  tracksStatus?: number;
  artistsStatus?: number;
  /** never answer the track lists (the loading state) */
  hangTracks?: boolean;
  posts?: { path: string; body: unknown }[];
}

function mockApi(setup: Setup = {}) {
  const posts = setup.posts ?? [];
  const record = async (request: Request) => {
    const url = new URL(request.url);
    let body: unknown = null;
    try {
      body = await request.clone().json();
    } catch {
      body = null;
    }
    posts.push({ path: url.pathname, body });
  };
  server.use(
    http.get('*/api/wishlist/tracks', ({ request }) => {
      if (setup.hangTracks) return new Promise(() => {});
      if (setup.tracksStatus)
        return HttpResponse.json({ error: 'database is locked' }, { status: setup.tracksStatus });
      const category = new URL(request.url).searchParams.get('category');
      return HttpResponse.json({
        tracks: category === 'albums' ? (setup.albums ?? ALBUMS) : (setup.singles ?? SINGLES),
        artist_images: {},
      });
    }),
    http.get('*/api/wishlist/stats', () =>
      HttpResponse.json({
        albums: 3,
        singles: 1,
        total: 4,
        next_run_in_seconds: 7150,
        is_auto_processing: false,
      }),
    ),
    http.get('*/api/wishlist/cycle', () => HttpResponse.json({ cycle: 'albums' })),
    http.get('*/api/wishlist/found', () =>
      HttpResponse.json({ success: true, days: 7, items: setup.found ?? FOUND }),
    ),
    http.get('*/api/wishlist/retry-profile', () =>
      HttpResponse.json({
        success: true,
        profile: {
          name: 'standard',
          label: 'Standard',
          description: 'The default cadence.',
          ladder: {},
          max_cooldown: 0,
        },
        profiles: [
          {
            name: 'standard',
            label: 'Standard',
            description: 'The default cadence.',
            ladder: {},
            max_cooldown: 0,
          },
          {
            name: 'patient',
            label: 'Patient',
            description: 'More room.',
            ladder: {},
            max_cooldown: 0,
          },
        ],
      }),
    ),
    http.get('*/api/automations', () =>
      HttpResponse.json([
        {
          id: 1,
          name: 'Auto-Process Wishlist',
          is_system: 1,
          action_type: 'process_wishlist',
          enabled: 1,
          trigger_config: { interval: 6, unit: 'hours' },
        },
        {
          id: 2,
          name: 'Auto-Scan Watchlist',
          is_system: 1,
          action_type: 'scan_watchlist',
          enabled: 1,
          trigger_config: { interval: 24, unit: 'hours' },
        },
      ]),
    ),
    http.get('*/api/automations/master', () => HttpResponse.json({ music: true })),
    http.get('*/api/quality-profile/custom', () =>
      HttpResponse.json({
        success: true,
        profiles: [{ id: 1, name: 'FLAC or better', is_default: true }],
      }),
    ),
    http.get('*/api/modules', () =>
      HttpResponse.json({ success: true, modules: setup.modules ?? [] }),
    ),
    http.get('*/api/labels/watchlist', () => HttpResponse.json({ labels: setup.labels ?? [] })),
    http.get('*/api/podcasts/watchlist', () =>
      HttpResponse.json({ success: true, podcasts: setup.podcasts ?? [] }),
    ),
    http.get('*/api/podcasts/watchlist/summary', () =>
      HttpResponse.json({ success: true, new_episode_days: 7, podcasts: PODCAST_SUMMARY }),
    ),
    http.get('*/api/audiobooks/watchlist', () =>
      HttpResponse.json({ success: true, authors: setup.authors ?? [] }),
    ),
    http.get('*/api/audiobooks/wishlist', () =>
      HttpResponse.json({ success: true, items: BOOKS, counts: {}, worker: null }),
    ),
    http.post('*/api/labels/watchlist/remove', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, is_watching: false });
    }),
    http.post('*/api/labels/watchlist/backlog', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true });
    }),
    http.post('*/api/podcasts/watchlist/settings', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true });
    }),
    http.post('*/api/audiobook-routes/check', () =>
      HttpResponse.json({ success: true, routed: [] }),
    ),
    http.get('*/api/active-processes', () => HttpResponse.json({ active_processes: [] })),
    http.get('*/api/watchlist/count', () =>
      HttpResponse.json({
        success: true,
        count: (setup.artists ?? ARTISTS).length,
        next_run_in_seconds: 9 * 3600,
      }),
    ),
    http.get('*/api/watchlist/artists', () =>
      setup.artistsStatus
        ? HttpResponse.json({ success: false, error: 'locked' }, { status: setup.artistsStatus })
        : HttpResponse.json({ success: true, artists: setup.artists ?? ARTISTS }),
    ),
    http.get('*/api/watchlist/artists/summary', () =>
      HttpResponse.json({ success: true, new_release_days: 7, artists: SUMMARY }),
    ),
    http.get('*/api/watchlist/scan/status', () =>
      HttpResponse.json({ success: true, status: 'idle', summary: {}, ...setup.scan }),
    ),
    http.get('*/api/watchlist/global-config', () =>
      HttpResponse.json({
        success: true,
        config: {
          global_override_enabled: false,
          include_albums: true,
          include_eps: true,
          include_singles: true,
        },
      }),
    ),
    http.post('*/api/wishlist/bulk', async ({ request }) => {
      await record(request);
      const body = (await request.clone().json()) as { track_ids: string[] };
      return HttpResponse.json({
        success: true,
        results: body.track_ids.map((id) => ({ id, ok: true, message: 'ok' })),
      });
    }),
    http.post('*/api/wishlist/remove-track', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true });
    }),
    http.post('*/api/wishlist/process', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true });
    }),
    http.post('*/api/watchlist/remove-batch', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true });
    }),
    http.get('*/api/library/artists', () =>
      HttpResponse.json({ artists: [{ id: 77, name: 'Pale Harbour' }] }),
    ),
  );
  return posts;
}

function renderRoute(entry = '/wanted') {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createAppRouter({ history, queryClient });
  render(<AppRouterProvider router={router} queryClient={queryClient} />);
  return { router, history };
}

const search = (router: ReturnType<typeof createAppRouter>) =>
  new URLSearchParams(router.state.location.searchStr);
const list = (name: string) => screen.getByRole('list', { name });
const tab = (name: RegExp) => screen.getByRole('tab', { name });

/** Open a "…" menu by its button's label. Looked up by selector: a role
 *  query over a page of rows costs seconds in jsdom. The phone row's "⋮" is
 *  display:none at desktop width; jsdom still clicks it. */
async function openMenu(label: string): Promise<HTMLElement> {
  // one menu at a time: wait for the last one to close first
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  const button = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  expect(button, `no menu button "${label}"`).not.toBeNull();
  fireEvent.click(button!);
  return waitFor(() => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    return menu!;
  });
}

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showToast = vi.fn();
});

afterEach(() => {
  delete window.SoulSyncWebShellBridge;
  delete window.showToast;
  delete window._navigateToArtistFromWishlist;
  delete window.openWishlistIgnoreModal;
  delete window.clearEntireWishlist;
  delete window.openWatchlistHistoryModal;
  delete (window as { canDownload?: () => boolean }).canDownload;
  vi.mocked(openWishlistInspector).mockReset();
  try {
    window.localStorage.removeItem('soulsync_wanted_view');
  } catch {
    /* jsdom always has it */
  }
});

describe('Wanted tab', () => {
  it('shows each wanted thing once, the finds of this week, and the counts', async () => {
    mockApi();
    renderRoute('/wanted');

    await screen.findByText('Harbour Light');
    const rows = within(list('Wanted')).getAllByRole('listitem');
    // newest first: the find (an hour ago), then by when each was added
    expect(rows.map((r) => r.querySelector('p')?.textContent)).toEqual([
      'Static Bloom',
      'Harbour Light',
      'Lantern',
      'Night Ferry (Live)',
    ]);
    // the album's two tracks are one row
    expect(within(rows[2]).getByText(/Album/)).toBeInTheDocument();
    expect(within(rows[2]).getByText('Not found yet · 14 tries')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Searching · 1 try')).toBeInTheDocument();
    expect(rows[3]).toHaveTextContent('last try: user went offline');
    expect(within(rows[0]).getByText(/Found today/)).toBeInTheDocument();

    expect(tab(/Wanted/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/Wanted/)).toHaveTextContent('3');
    // artists, labels, podcasts and audiobook follows: counted once all have answered
    await waitFor(() => expect(tab(/Following/)).toHaveTextContent('3'));
    expect(screen.getByRole('button', { name: /Searching/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Not found yet/ })).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: /Found this week/ })).toHaveTextContent('1');
    expect(
      screen.getByText(
        /Next scheduled search in about 2 hours, for albums \(Auto-Process Wishlist, every 6 hours\)\./,
      ),
    ).toBeInTheDocument();
  });

  it('carries the guided tour’s anchor on its tabs', async () => {
    mockApi();
    renderRoute();
    const tabs = await screen.findByRole('tablist', { name: 'Wanted' });
    expect(tabs).toHaveAttribute('data-tour', 'wanted-tabs');
  });

  it('keeps the filter and the sort in the URL, and reads them back', async () => {
    mockApi();
    const { router, history } = renderRoute('/wanted?tab=wanted');
    await screen.findByText('Harbour Light');

    fireEvent.click(screen.getByRole('button', { name: /Not found yet/ }));
    await waitFor(() => expect(search(router).get('filter')).toBe('not-found'));
    expect(within(list('Wanted')).queryByText('Harbour Light')).not.toBeInTheDocument();
    expect(within(list('Wanted')).getByText('Lantern')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Not found yet/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), {
      target: { value: 'oldest' },
    });
    await waitFor(() => expect(search(router).get('sort')).toBe('oldest'));
    const titles = within(list('Wanted'))
      .getAllByRole('listitem')
      .map((r) => r.querySelector('p')?.textContent);
    expect(titles).toEqual(['Night Ferry (Live)', 'Lantern']);

    // Back undoes the sort, then the filter
    act(() => history.back());
    await waitFor(() => expect(search(router).get('sort')).toBeNull());
    act(() => history.back());
    await waitFor(() => expect(search(router).get('filter')).toBeNull());
  });

  it('opens straight onto a filter and sort carried in the URL', async () => {
    mockApi();
    renderRoute('/wanted?tab=wanted&filter=found');
    await screen.findByText('Static Bloom');
    expect(within(list('Wanted')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Found this week/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('pages 50 at a time and keeps the page in the URL', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      track({
        id: `t${i}`,
        name: `Track ${i}`,
        artist: `Artist ${i}`,
        album: `Single ${i}`,
        type: 'single',
        total: 1,
        ago: DAY + i * 60_000,
      }),
    );
    mockApi({ albums: [], singles: many, found: [] });
    const { router } = renderRoute('/wanted');
    await screen.findByText('Track 0');
    // counted by selector: role queries crawl slowly over hundreds of rows
    const rowCount = () => document.querySelectorAll('ul[aria-label="Wanted"] > li').length;
    expect(rowCount()).toBe(50);
    expect(screen.getByText('50 of 120')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Show 50 more'));
    await waitFor(() => expect(search(router).get('page')).toBe('2'));
    await waitFor(() => expect(rowCount()).toBe(100));
    // the last 20 fit in one more page
    fireEvent.click(screen.getByText('Show all'));
    await waitFor(() => expect(rowCount()).toBe(120));
    expect(screen.queryByText(/^Show (all|50 more)$/)).not.toBeInTheDocument();
  });

  it('Search now on a row searches for all of its tracks', async () => {
    const posts = mockApi();
    renderRoute('/wanted');
    await screen.findByText('Lantern');
    const lantern = within(list('Wanted')).getAllByRole('listitem')[2];
    fireEvent.click(within(lantern).getByRole('button', { name: 'Search now' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/wishlist/bulk',
        body: { action: 'grab', track_ids: ['ln1', 'ln2'] },
      }),
    );
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith('Searching for “Lantern” now.', 'success'),
    );
  });

  it('the line’s Search now runs the scheduled search by hand', async () => {
    const posts = mockApi();
    renderRoute('/wanted');
    await screen.findByText('Harbour Light');
    // the line's Search now is the one in the sentence, not a row's
    const inLine = screen
      .getAllByRole('button', { name: 'Search now' })
      .find((b) => b.closest('p'));
    fireEvent.click(inLine!);
    await waitFor(() => expect(posts.map((p) => p.path)).toContain('/api/wishlist/process'));
  });

  it('the row menu: try again, search by hand, open artist, remove', async () => {
    const posts = mockApi();
    window._navigateToArtistFromWishlist = vi.fn();
    renderRoute('/wanted');
    await screen.findByText('Harbour Light');

    let menu = await openMenu('More actions for Harbour Light');
    // the desktop menu leaves Search now to the button beside it
    expect(within(menu).queryByRole('menuitem', { name: 'Search now' })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Try again on the next search' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/wishlist/bulk',
        body: { action: 'retry', track_ids: ['hl'] },
      }),
    );

    menu = await openMenu('More actions for Harbour Light');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Search by hand…' }));
    expect(openWishlistInspector).toHaveBeenCalledWith({
      id: 'hl',
      name: 'Harbour Light',
      artist: 'Pale Harbour',
      album: 'Tidewater',
    });

    menu = await openMenu('More actions for Harbour Light');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open artist' }));
    expect(window._navigateToArtistFromWishlist).toHaveBeenCalledWith('Pale Harbour');

    // one track goes straight away (it can be found again under Removed and skipped)
    menu = await openMenu('More actions for Harbour Light');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Wanted' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/wishlist/remove-track',
        body: { spotify_track_id: 'hl' },
      }),
    );
  });

  it('removing a release asks first, and Cancel removes nothing', async () => {
    const posts = mockApi();
    renderRoute('/wanted');
    await screen.findByText('Lantern');

    let menu = await openMenu('More actions for Lantern');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Wanted…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Remove “Lantern” from Wanted?' });
    expect(within(dialog).getByText(/stops searching for 2 tracks/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts.filter((p) => p.path === '/api/wishlist/bulk')).toHaveLength(0);

    menu = await openMenu('More actions for Lantern');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Wanted…' }));
    dialog = await screen.findByRole('dialog', { name: 'Remove “Lantern” from Wanted?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from Wanted' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/wishlist/bulk',
        body: { action: 'skip', track_ids: ['ln1', 'ln2'] },
      }),
    );
  });

  it('a release opens its tracks, each with its own actions', async () => {
    const posts = mockApi();
    renderRoute('/wanted');
    await screen.findByText('Lantern');
    const menu = await openMenu('More actions for Lantern');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Show the 2 tracks' }));
    const tracks = await screen.findByRole('list', { name: 'Tracks of Lantern on Wanted' });
    expect(within(tracks).getByText('Lantern One')).toBeInTheDocument();
    fireEvent.click(
      within(within(tracks).getAllByRole('listitem')[1]).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/wishlist/remove-track',
        body: { spotify_track_id: 'ln2' },
      }),
    );
  });

  it('the phone menu carries Search now, because a phone has no hover row', async () => {
    mockApi();
    renderRoute('/wanted');
    await screen.findByText('Harbour Light');
    const menu = await openMenu('Actions for Harbour Light');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual([
      'Search now',
      'Search by hand…',
      'Try again on the next search',
      'Open artist',
      'Remove from Wanted',
    ]);
  });

  it('a profile that asks an admin first gets no Search now', async () => {
    (window as { canDownload?: () => boolean }).canDownload = () => false;
    mockApi();
    renderRoute('/wanted');
    await screen.findByText('Harbour Light');
    expect(screen.queryAllByRole('button', { name: 'Search now' })).toHaveLength(0);
  });

  it('selects several and acts on them together', async () => {
    const posts = mockApi();
    renderRoute('/wanted');
    await screen.findByText('Harbour Light');
    const menu = await openMenu('More for Wanted');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Select several' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Harbour Light' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Lantern' }));
    const bar = screen.getByRole('region', { name: 'Selected' });
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Try again on the next search' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/wishlist/bulk',
        body: { action: 'retry', track_ids: ['hl', 'ln1', 'ln2'] },
      }),
    );
  });

  it('the page menu reaches what the Wishlist page could do', async () => {
    mockApi();
    window.openWishlistIgnoreModal = vi.fn();
    window.clearEntireWishlist = vi.fn();
    const { router } = renderRoute('/wanted');
    await screen.findByText('Harbour Light');

    let menu = await openMenu('More for Wanted');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual([
      'Find in this list',
      'Select several',
      'How often to try again…',
      'Download everything now…',
      'Removed and skipped tracks…',
      'Remove what’s already in your library…',
      'Audiobooks on Wanted',
      'Clear Wanted…',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Removed and skipped tracks…' }));
    expect(window.openWishlistIgnoreModal).toHaveBeenCalled();

    menu = await openMenu('More for Wanted');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Clear Wanted…' }));
    expect(window.clearEntireWishlist).toHaveBeenCalled();

    menu = await openMenu('More for Wanted');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Find in this list' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Find in this list' }), {
      target: { value: 'night' },
    });
    await waitFor(() => expect(search(router).get('q')).toBe('night'));
    expect(within(list('Wanted')).getAllByRole('listitem')).toHaveLength(1);
  });

  it('changes how often not-found tracks are tried again', async () => {
    mockApi();
    let sent: unknown = null;
    server.use(
      http.put('*/api/wishlist/retry-profile', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ success: true, profile: { name: 'patient', label: 'Patient' } });
      }),
    );
    renderRoute('/wanted');
    await screen.findByText('Harbour Light');
    const menu = await openMenu('More for Wanted');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'How often to try again…' }));
    const dialog = await screen.findByRole('dialog', { name: 'How often to try again' });
    await within(dialog).findByText('Patient');
    // the one in use can't be picked again, and says why
    expect(within(dialog).getByText('This is the timing in use.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('Patient'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use Patient' }));
    await waitFor(() => expect(sent).toEqual({ profile: 'patient' }));
  });
});

describe('Wanted as a nebula (9a)', () => {
  /** The library's numbers for Pale Harbour (GET /api/library/artist-index). */
  function mockArtistIndex(wantable = 1) {
    server.use(
      http.get('*/api/library/artist-index', () =>
        HttpResponse.json({
          success: true,
          artists: [
            {
              id: 77,
              name: 'Pale Harbour',
              image_url: null,
              genres: [],
              following: false,
              releases: 6,
              in_library: 3,
              missing: 3,
              wanted: 2,
              wantable,
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
          has_more: false,
        }),
      ),
    );
  }

  const field = () => screen.getByRole('group', { name: 'Wanted by artist' });

  it('the view toggle replaces the menu item, and the browser remembers it', async () => {
    mockApi();
    mockArtistIndex();
    renderRoute('/wanted');
    await screen.findByText('Harbour Light');
    const view = screen.getByRole('group', { name: 'View' });
    const asList = within(view).getByRole('button', { name: 'Show as a list' });
    const asNebula = within(view).getByRole('button', { name: 'Show as a nebula' });
    expect(asList).toHaveAttribute('aria-pressed', 'true');
    expect(asNebula).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(asNebula);
    expect(await screen.findByRole('group', { name: 'Wanted by artist' })).toBeInTheDocument();
    expect(asNebula).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('soulsync_wanted_view')).toBe('nebula');
    // no Sort in the nebula, and the list is gone
    expect(screen.queryByRole('combobox', { name: 'Sort' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Wanted' })).toBeNull();

    fireEvent.click(asList);
    expect(await screen.findByRole('list', { name: 'Wanted' })).toBeInTheDocument();
    expect(window.localStorage.getItem('soulsync_wanted_view')).toBe('list');
  });

  it('opens on the nebula next time, and an old ?view=nebula link still does', async () => {
    window.localStorage.setItem('soulsync_wanted_view', 'nebula');
    mockApi();
    mockArtistIndex();
    renderRoute('/wanted');
    expect(await screen.findByRole('group', { name: 'Wanted by artist' })).toBeInTheDocument();

    window.localStorage.removeItem('soulsync_wanted_view');
    document.body.innerHTML = '';
    renderRoute('/wanted?view=nebula');
    expect(await screen.findByRole('group', { name: 'Wanted by artist' })).toBeInTheDocument();
    expect(window.localStorage.getItem('soulsync_wanted_view')).toBe('nebula');
  });

  it('three columns in the page’s words; each artist filed under its worst thing', async () => {
    window.localStorage.setItem('soulsync_wanted_view', 'nebula');
    mockApi();
    mockArtistIndex();
    renderRoute('/wanted');
    await screen.findByRole('group', { name: 'Wanted by artist' });
    const heads = within(field())
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    // the counts are things in each state, as the Show filters count them
    expect(heads).toEqual(['Searching · 1', 'Not found yet · 2', 'Found this week · 1']);
    // Pale Harbour: Harbour Light searching, Night Ferry not found → Not found yet
    const notFound = screen.getByRole('region', { name: 'Not found yet · 2' });
    expect(
      within(notFound).getByRole('button', { name: 'Pale Harbour, 2 things on Wanted' }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(
      within(notFound).getByRole('button', { name: /^Saltmarsh, 1 thing on Wanted/ }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Searching · 1' })).getByText(
        'Nothing is in its first searches.',
      ),
    ).toBeInTheDocument();
  });

  it('a Show filter keeps the three columns and says what it hides', async () => {
    window.localStorage.setItem('soulsync_wanted_view', 'nebula');
    mockApi();
    mockArtistIndex();
    renderRoute('/wanted?filter=found');
    await screen.findByRole('group', { name: 'Wanted by artist' });
    expect(
      within(screen.getByRole('region', { name: 'Not found yet · 2' })).getByText(
        'Not shown while Show is on Found this week.',
      ),
    ).toBeInTheDocument();
  });

  it('an artist opens beside the field: why it’s stuck, the items, the three actions', async () => {
    window.localStorage.setItem('soulsync_wanted_view', 'nebula');
    const posts = mockApi();
    mockArtistIndex(1);
    renderRoute('/wanted');
    await screen.findByRole('group', { name: 'Wanted by artist' });
    const artist = screen.getByRole('button', { name: 'Pale Harbour, 2 things on Wanted' });
    fireEvent.click(artist);
    expect(artist).toHaveAttribute('aria-pressed', 'true');

    const panel = await screen.findByRole('complementary', { name: 'Pale Harbour on Wanted' });
    expect(within(panel).getByRole('heading', { level: 2, name: 'Pale Harbour' })).toHaveFocus();
    expect(
      await within(panel).findByText('6 releases · 3 in your library · 2 on Wanted · Following'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        /^22 tries with Night Ferry \(Live\): user went offline\. Last try 1 hour ago\.$/,
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Not found yet · 22 tries')).toBeInTheDocument();
    expect(within(panel).getByText('Searching · 1 try')).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Search now for both' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/wishlist/bulk',
        body: { action: 'grab', track_ids: ['hl', 'nf'] },
      }),
    );

    fireEvent.click(
      within(panel).getByRole('button', { name: 'Accept any quality for Night Ferry (Live)' }),
    );
    expect(openWishlistInspector).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'nf', name: 'Night Ferry (Live)' }),
    );

    // one release to want: added at once, through the phase 3 bulk add
    fireEvent.click(
      await within(panel).findByRole('button', { name: 'Want the 1 other release you’re missing' }),
    );
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/wishlist/bulk',
        body: { action: 'add', filter: { artist_ids: [77] }, quality: 'target' },
      }),
    );
  });

  it('Remove both asks first; Escape closes the panel and gives the focus back', async () => {
    window.localStorage.setItem('soulsync_wanted_view', 'nebula');
    mockApi();
    mockArtistIndex();
    renderRoute('/wanted');
    await screen.findByRole('group', { name: 'Wanted by artist' });
    const artist = screen.getByRole('button', { name: 'Pale Harbour, 2 things on Wanted' });
    fireEvent.click(artist);
    const panel = await screen.findByRole('complementary', { name: 'Pale Harbour on Wanted' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove both from Wanted' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove 2 things from Wanted?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Pale Harbour on Wanted' })).toBeNull(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Pale Harbour, 2 things on Wanted' }),
      ).toHaveFocus(),
    );
  });
});

describe('loading, empty and failure', () => {
  it('says it is loading, keeps the header and tabs, and shimmers the count', async () => {
    mockApi({ hangTracks: true });
    renderRoute('/wanted');
    expect(await screen.findByRole('status')).toHaveTextContent('Loading your list…');
    expect(screen.getByRole('heading', { name: 'Wanted' })).toBeInTheDocument();
    expect(tab(/Wanted/).querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Not found yet/ })).not.toBeInTheDocument();
  });

  it('an empty Wanted explains itself and offers a way in', async () => {
    mockApi({ albums: [], singles: [], found: [] });
    renderRoute('/wanted');
    expect(await screen.findByRole('heading', { name: 'Nothing wanted yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search for music' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mirror a playlist' })).toBeInTheDocument();
    expect(tab(/Wanted/)).toHaveTextContent('0');
  });

  it('a list that fails keeps the header and tabs, says why, and tries again', async () => {
    mockApi({ tracksStatus: 500 });
    renderRoute('/wanted');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load your list")).toBeInTheDocument();
    expect(alert).toHaveTextContent('SYNCHRO.S ran into a problem reading it. Your list is safe.');
    expect(within(alert).getByRole('button', { name: 'Run Setup check' })).toBeInTheDocument();
    // no counts while the list is unknown
    expect(tab(/Wanted/)).toHaveTextContent(/^Wanted\s*Wanted$/);

    mockApi();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Harbour Light')).toBeInTheDocument();
  });

  it('following nothing explains itself and opens the follow search', async () => {
    mockApi({ artists: [] });
    renderRoute('/wanted?tab=followed');
    expect(
      await screen.findByRole('heading', { name: "You're not following anyone yet" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search for an artist' }));
    expect(await screen.findByRole('dialog', { name: 'Follow an artist' })).toBeInTheDocument();
  });

  it('a Following list that fails to load says so', async () => {
    mockApi({ artistsStatus: 500 });
    renderRoute('/wanted?tab=followed');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load who you follow")).toBeInTheDocument();
  });
});

describe('tabs', () => {
  it('switches tabs through the URL, and Back returns', async () => {
    mockApi();
    const { router, history } = renderRoute('/wanted?tab=wanted&filter=found');
    await screen.findByText('Static Bloom');

    fireEvent.click(tab(/Following/));
    await waitFor(() => expect(search(router).get('tab')).toBe('followed'));
    // the other tab's filter doesn't come along
    expect(search(router).get('filter')).toBeNull();
    expect(await screen.findByText('Marrow & Pine')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Follow…' })).toBeInTheDocument();

    act(() => history.back());
    await waitFor(() => expect(search(router).get('tab')).toBe('wanted'));
    expect(await screen.findByText('Static Bloom')).toBeInTheDocument();
  });

  it('arrow keys move between the tabs', async () => {
    mockApi();
    const { router } = renderRoute('/wanted');
    await screen.findByText('Harbour Light');
    fireEvent.keyDown(tab(/Wanted/), { key: 'ArrowRight' });
    await waitFor(() => expect(search(router).get('tab')).toBe('followed'));
  });

  it('a profile without the Wishlist page lands on Following', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      isPageAllowed: vi.fn((id) => id !== 'wishlist'),
    });
    mockApi();
    const { router } = renderRoute('/wanted?tab=wanted');
    await waitFor(() => expect(search(router).get('tab')).toBe('followed'));
    expect(screen.queryByRole('tab', { name: /^Wanted/ })).not.toBeInTheDocument();
  });

  it('a profile with neither page goes home', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      isPageAllowed: vi.fn((id) => id !== 'wishlist' && id !== 'watchlist'),
    });
    mockApi();
    server.use(http.get('*/api/*', () => HttpResponse.json({})));
    const { router } = renderRoute('/wanted');
    await waitFor(() => expect(router.state.location.pathname).toBe('/discover'));
  });
});

describe('Following tab', () => {
  const everything = (extra: Setup = {}) =>
    mockApi({
      labels: LABELS,
      podcasts: PODCASTS,
      authors: AUTHORS,
      albums: [...ALBUMS, LABEL_TRACK],
      ...extra,
    });
  const rowsOf = async () =>
    within(await screen.findByRole('list', { name: 'Following' })).getAllByRole('listitem');
  const rowNamed = async (name: string) =>
    (await rowsOf()).find((r) => r.querySelector('p')?.textContent === name)!;

  it('shows each artist with what you have, what is new, and the next check', async () => {
    mockApi();
    renderRoute('/wanted?tab=followed');
    const rows = await rowsOf();
    // newest activity first: Pale Harbour's find, then by name
    expect(rows.map((r) => r.querySelector('p')?.textContent)).toEqual([
      'Pale Harbour',
      'Marrow & Pine',
      'Saltmarsh',
    ]);
    expect(
      within(rows[0]).getByText('Artist · 9 releases in your library · 2 on Wanted'),
    ).toBeInTheDocument();
    expect(
      within(rows[0]).getByText('Last found: Tidewater · 2 days ago · on Wanted'),
    ).toBeInTheDocument();
    expect(within(rows[0]).getByText('New release')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Latest: Lantern · Oct 2025')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Not checked yet')).toBeInTheDocument();
    expect(within(rows[1]).getByText('First check in about 9 hours')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New release/ })).toHaveTextContent('1');
    expect(
      screen.getByText(
        /Artists and labels are checked every 24 hours \(Auto-Scan Watchlist\) and new releases go to Wanted/,
      ),
    ).toBeInTheDocument();
  });

  it('lists every kind, each row starting with its kind, and counts them all', async () => {
    everything();
    renderRoute('/wanted?tab=followed');
    const hessle = await rowNamed('Hessle Audio');
    expect(within(hessle).getByText('Label · 1 on Wanted · new releases only')).toBeInTheDocument();
    expect(within(hessle).getByText('Latest: HES053 · yesterday · on Wanted')).toBeInTheDocument();
    expect(within(hessle).getByText('New release')).toBeInTheDocument();
    expect(within(hessle).getByText('HA')).toBeInTheDocument(); // square, with its initials

    const lighttown = await rowNamed('Lighttown Recordings');
    expect(
      within(lighttown).getByText('Label · followed 10 minutes ago · new releases only'),
    ).toBeInTheDocument();
    expect(within(lighttown).getByText('Not checked yet')).toBeInTheDocument();

    const exchange = await rowNamed('Resident Advisor Exchange');
    expect(
      within(exchange).getByText(
        'Podcast · 212 episodes · 40 kept for 14 days · new episodes download',
      ),
    ).toBeInTheDocument();
    expect(
      within(exchange).getByText('Latest: EX.761 · 3 hours ago · downloaded'),
    ).toBeInTheDocument();
    expect(within(exchange).getByText('New episode')).toBeInTheDocument();
    expect(within(exchange).getByRole('button', { name: 'Open podcast' })).toBeInTheDocument();

    const quiet = await rowNamed('Quiet Hours');
    expect(within(quiet).getByText('Not downloading')).toBeInTheDocument();

    const leGuin = await rowNamed('Ursula K. Le Guin');
    expect(
      within(leGuin).getByText('Author · 1 found since you followed · 1 on Wanted'),
    ).toBeInTheDocument();
    expect(
      within(leGuin).getByText('Latest: The Dispossessed · 4 weeks ago · on Wanted'),
    ).toBeInTheDocument();
    expect(within(leGuin).getByRole('button', { name: 'Open author' })).toBeInTheDocument();

    // 3 artists, 2 labels, 2 podcasts and an author
    await waitFor(() => expect(tab(/Following/)).toHaveTextContent('8'));
    const kinds = screen.getByRole('group', { name: 'Kind' });
    expect(
      within(kinds)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All8', 'Artists3', 'Labels2', 'Podcasts2', 'Authors1']);
    expect(
      within(screen.getByRole('group', { name: 'Show' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All', 'New release3', 'Not checked yet2', 'Nothing new']);
  });

  it('filters by kind through the URL, and an old Watchlist tab link lands on its kind', async () => {
    everything();
    const { router } = renderRoute('/wanted?tab=followed');
    await rowNamed('Hessle Audio');
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Kind' })).getByRole('button', { name: /Labels/ }),
    );
    await waitFor(() => expect(search(router).get('kind')).toBe('labels'));
    // newest activity first: Lighttown was followed ten minutes ago
    expect((await rowsOf()).map((r) => r.querySelector('p')?.textContent)).toEqual([
      'Lighttown Recordings',
      'Hessle Audio',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Nothing new' }));
    await waitFor(() => expect(search(router).get('filter')).toBe('quiet'));
    expect(
      screen.getByText('Everything here has something new, or hasn’t been checked yet.'),
    ).toBeInTheDocument();
  });

  it('reads ?list= from an old link as the kind', async () => {
    everything();
    const { router } = renderRoute('/wanted?tab=followed&list=podcasts');
    await waitFor(() => expect(search(router).get('kind')).toBe('podcasts'));
    expect(search(router).get('list')).toBeNull();
    await waitFor(async () =>
      expect((await rowsOf()).map((r) => r.querySelector('p')?.textContent)).toEqual([
        'Resident Advisor Exchange',
        'Quiet Hours',
      ]),
    );
    expect(screen.getByRole('button', { name: 'Check podcasts now' })).toBeInTheDocument();
  });

  it('a podcast row opens the show, and its menu turns downloads off', async () => {
    const posts = everything();
    const { router } = renderRoute('/wanted?tab=followed&kind=podcasts');
    const exchange = await rowNamed('Resident Advisor Exchange');
    const menu = await openMenu('More actions for Resident Advisor Exchange');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Stop downloading new episodes', 'Keep and download settings…', 'Unfollow…']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Stop downloading new episodes' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/podcasts/watchlist/settings',
        body: {
          feed_url: 'https://feeds.example.com/exchange',
          itunes_id: 761,
          auto_download: false,
          retention_days: 14,
        },
      }),
    );
    fireEvent.click(within(exchange).getByRole('button', { name: 'Open podcast' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/podcasts/761'));
  });

  it('a label’s menu gets its whole catalogue, and Unfollow asks first', async () => {
    const posts = everything();
    renderRoute('/wanted?tab=followed&kind=labels');
    await rowNamed('Hessle Audio');
    let menu = await openMenu('More actions for Hessle Audio');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Also get the whole catalogue' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/labels/watchlist/backlog',
        body: { musicbrainz_label_id: 'mb-hessle', backlog: true },
      }),
    );

    menu = await openMenu('More actions for Hessle Audio');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Unfollow…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unfollow Hessle Audio?' });
    expect(dialog).toHaveTextContent(
      'SYNCHRO.S stops checking Hessle Audio for new releases. The 1 thing already on Wanted stays there and keeps being searched for.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unfollow' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/labels/watchlist/remove',
        body: { musicbrainz_label_id: 'mb-hessle' },
      }),
    );
  });

  it('Unfollow on an artist asks first and says what stays on Wanted', async () => {
    const posts = mockApi();
    renderRoute('/wanted?tab=followed');
    await screen.findByText('Pale Harbour');
    let menu = await openMenu('More actions for Pale Harbour');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Unfollow…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unfollow Pale Harbour?' });
    expect(dialog).toHaveTextContent('SYNCHRO.S stops checking Pale Harbour for new releases.');
    expect(dialog).toHaveTextContent(
      'The 2 things already on Wanted stay there and keep being searched for.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep following' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts.filter((p) => p.path === '/api/watchlist/remove-batch')).toHaveLength(0);

    menu = await openMenu('More actions for Pale Harbour');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Unfollow…' }));
    dialog = await screen.findByRole('dialog', { name: 'Unfollow Pale Harbour?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unfollow' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/watchlist/remove-batch',
        body: { artist_ids: ['sp-1'] },
      }),
    );
  });

  it('opens an artist from the library when it is there', async () => {
    mockApi();
    const { router } = renderRoute('/wanted?tab=followed');
    const row = await rowNamed('Pale Harbour');
    fireEvent.click(within(row).getByRole('button', { name: 'Open artist' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/artist-detail/library/77'));
  });

  it('the menus open an artist’s settings and the followed artist settings by URL', async () => {
    mockApi();
    const { router } = renderRoute('/wanted?tab=followed');
    await screen.findByText('Pale Harbour');
    let menu = await openMenu('More actions for Pale Harbour');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Settings for this artist…' }));
    await waitFor(() => expect(search(router).get('configId')).toBe('sp-1'));

    menu = await openMenu('More for Following');
    // the old Labels / Podcasts / Audiobook authors views are rows of this tab now
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual([
      'Find in this list',
      'Select several',
      'Followed artist settings…',
      'Update similar artists',
      'Check history…',
      'Downloads from followed artists…',
      'Blocklist…',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Followed artist settings…' }));
    await waitFor(() => expect(search(router).get('settings')).toBe('true'));
  });

  it('Follow… asks what to follow', async () => {
    mockApi();
    const { router } = renderRoute('/wanted?tab=followed');
    await screen.findByText('Pale Harbour');
    fireEvent.click(screen.getByRole('button', { name: 'Follow…' }));
    const menu = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="menu"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual([
      'An artist…',
      'A label (opens Search)',
      'A podcast (opens Podcasts)',
      'An audiobook author (opens Audiobooks)',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'An artist…' }));
    expect(await screen.findByRole('dialog', { name: 'Follow an artist' })).toBeInTheDocument();
    expect(search(router).get('tab')).toBe('followed');
  });

  it('says "Checking…" while a check runs, on the row it is checking too', async () => {
    mockApi({
      scan: {
        status: 'scanning',
        current_artist_name: 'Saltmarsh',
        artists_scanned: 1,
        total_artists: 3,
      },
    });
    renderRoute('/wanted?tab=followed');
    const saltmarsh = await rowNamed('Saltmarsh');
    expect(within(saltmarsh).getByText('Checking…')).toBeInTheDocument();
    expect(within(saltmarsh).getByText('Checking')).toBeInTheDocument();
    const live = screen
      .getAllByText('Checking…')
      .find((el) => el.closest('[data-slot="status-tag"]'));
    expect(live?.closest('[data-slot="status-tag"]')).toHaveAttribute('data-live', 'true');
  });

  it('with the Podcasts module off, there are no podcasts and no Podcasts kind', async () => {
    everything({
      modules: [
        {
          name: 'podcasts',
          display_name: 'Podcasts',
          description: '',
          enabled: false,
          restart_required: false,
          restart_reason: null,
          pages: ['podcasts'],
        },
      ],
    });
    renderRoute('/wanted?tab=followed');
    await rowNamed('Hessle Audio');
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Kind' }))
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['All6', 'Artists3', 'Labels2', 'Authors1']),
    );
    expect(screen.queryByText('Resident Advisor Exchange')).not.toBeInTheDocument();
  });

  it('selects several artists and unfollows them together', async () => {
    const posts = mockApi();
    renderRoute('/wanted?tab=followed&kind=artists');
    await screen.findByText('Pale Harbour');
    const menu = await openMenu('More for Following');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Select several' }));
    const bar = await screen.findByRole('region', { name: 'Selected' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Select all 3 shown' }));
    fireEvent.click(within(bar).getByRole('button', { name: 'Unfollow…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unfollow 3 artists?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unfollow 3 artists' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: '/api/watchlist/remove-batch',
        body: { artist_ids: ['sp-1', 'sp-2', 'sp-3'] },
      }),
    );
  });
});
