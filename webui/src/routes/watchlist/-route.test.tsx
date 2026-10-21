import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

/*
 * The Watchlist page is the Followed artists tab of /wanted now. These pin
 * what moved: old links land on the same thing, and what the Watchlist page
 * did that the Followed boards don't draw (Labels, Podcasts, the settings
 * modals, the artist panel, the live scan deck, the shared vanilla modals) is
 * still there.
 */

// whole-page route tests: role queries over the page are slow in jsdom
vi.setConfig({ testTimeout: 40_000 });

function createResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function artistRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    artist_name: 'Aphex Twin',
    date_added: '2026-01-01T00:00:00Z',
    last_scan_timestamp: '2026-01-02T00:00:00Z',
    created_at: null,
    updated_at: null,
    image_url: null,
    spotify_artist_id: 'sp-aphex',
    itunes_artist_id: null,
    deezer_artist_id: null,
    discogs_artist_id: null,
    musicbrainz_artist_id: null,
    amazon_artist_id: null,
    include_albums: true,
    include_eps: false,
    include_singles: true,
    include_live: false,
    include_remixes: false,
    include_acoustic: false,
    include_compilations: false,
    ...overrides,
  };
}

const THREE = [
  artistRow({ id: 1, artist_name: 'Aphex Twin', spotify_artist_id: 'sp-1' }),
  artistRow({ id: 2, artist_name: 'Boards of Canada', spotify_artist_id: 'sp-2' }),
  artistRow({ id: 3, artist_name: 'Clark', spotify_artist_id: 'sp-3' }),
];

const WARP = {
  id: 5,
  musicbrainz_label_id: 'mb-warp',
  discogs_label_id: null,
  label_name: 'Warp Records',
  source: 'musicbrainz',
  backlog: false,
  date_added: null,
  last_scan_timestamp: null,
};

const SYNTAX = {
  id: 10,
  feed_url: 'https://example.com/feed.xml',
  itunes_id: 998877,
  title: 'Syntax Podcast',
  author: 'Wes & Scott',
  auto_download: false,
  retention_days: 14,
  episode_count: 700,
};

interface StubOptions {
  count?: number;
  nextRunInSeconds?: number;
  artists?: Record<string, unknown>[];
  globalOverride?: boolean;
  labels?: Record<string, unknown>[];
  podcasts?: Record<string, unknown>[];
  scanCompletedAt?: string | null;
  /** false = an artist matched on no provider at all, which the server allows. */
  configProviderIds?: boolean;
  /** The global auto-download default the server reports. */
  globalAutoDownload?: boolean;
  /** The artist's stored three-state auto-download preference. */
  autoDownloadPref?: number | null;
  /** Collects what was POSTed, for tests that care about the payload. */
  bodies?: { url: string; body: Record<string, unknown> }[];
  /** Artist names filed as audiobooks ("Treat as audiobook"). */
  routed?: string[];
}

function stubFetch(options: StubOptions = {}) {
  const {
    artists = [artistRow()],
    count = artists.length,
    nextRunInSeconds = 3600,
    globalOverride = false,
    labels = [],
    podcasts = [],
    scanCompletedAt = null,
    configProviderIds = true,
    globalAutoDownload = true,
    autoDownloadPref = null,
    bodies,
    routed = [],
  } = options;

  const calls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (bodies) {
        // ky hands fetch a Request, so the payload is on the Request and not
        // in init.body
        const raw =
          input instanceof Request
            ? await input.clone().text()
            : typeof init?.body === 'string'
              ? init.body
              : '';
        if (raw) bodies.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
      }

      if (url.includes('/api/audiobook-routes/check')) {
        const body = (await (input as Request).clone().json()) as { names?: string[] };
        return createResponse({
          success: true,
          routed: (body.names ?? []).filter((name) => routed.includes(name)),
        });
      }
      // what the Wanted half of the page reads
      if (url.includes('/api/wishlist/tracks')) return createResponse({ tracks: [] });
      if (url.includes('/api/wishlist/stats'))
        return createResponse({ total: 0, albums: 0, singles: 0, next_run_in_seconds: 0 });
      if (url.includes('/api/wishlist/cycle')) return createResponse({ cycle: 'albums' });
      if (url.includes('/api/wishlist/found')) return createResponse({ success: true, items: [] });
      if (url.includes('/api/automations')) return createResponse([]);
      if (url.includes('/api/quality-profile/custom'))
        return createResponse({ success: true, profiles: [] });
      if (url.includes('/api/library/artists')) return createResponse({ artists: [] });

      if (url.includes('/api/watchlist/count')) {
        return createResponse({ success: true, count, next_run_in_seconds: nextRunInSeconds });
      }
      if (url.includes('/api/watchlist/artists/summary')) {
        return createResponse({ success: true, new_release_days: 7, artists: [] });
      }
      if (url.includes('/api/watchlist/artists')) {
        return createResponse({ success: true, artists });
      }
      if (url.includes('/api/watchlist/scan/status')) {
        return createResponse({
          success: true,
          status: scanCompletedAt ? 'completed' : 'idle',
          completed_at: scanCompletedAt,
          summary: scanCompletedAt
            ? { total_artists: 4, new_tracks_found: 3, tracks_added_to_wishlist: 2 }
            : {},
        });
      }
      if (url.includes('/api/watchlist/global-config')) {
        return createResponse({
          success: true,
          config: {
            global_override_enabled: globalOverride,
            include_albums: true,
            include_eps: true,
            include_singles: true,
            include_live: false,
            include_remixes: false,
            include_acoustic: false,
            include_compilations: false,
            include_instrumentals: false,
            exclude_terms: '',
            global_auto_download: globalAutoDownload,
          },
        });
      }
      if (url.includes('/api/labels/watchlist')) {
        return createResponse({ labels });
      }
      if (url.includes('/api/podcasts/watchlist/settings')) {
        return createResponse({ success: true });
      }
      if (url.includes('/api/podcasts/watchlist/remove')) {
        return createResponse({ success: true, is_watching: false });
      }
      if (url.includes('/api/podcasts/watchlist')) {
        return createResponse({ success: true, count: podcasts.length, podcasts });
      }
      if (url.includes('/link-provider')) {
        return createResponse({ success: true });
      }
      if (url.includes('/config')) {
        return createResponse({
          success: true,
          config: {
            include_albums: true,
            include_eps: false,
            include_singles: true,
            include_live: false,
            include_remixes: false,
            include_acoustic: false,
            include_compilations: false,
            include_instrumentals: false,
            lookback_days: 90,
            preferred_metadata_source: null,
            auto_download: true,
            auto_download_pref: autoDownloadPref,
            global_auto_download: globalAutoDownload,
            quality_profile_id: null,
          },
          artist: {
            id: 'sp-aphex',
            name: 'Aphex Twin',
            image_url: null,
            followers: 1234567,
            popularity: 71,
            genres: ['idm', 'ambient', 'braindance', 'electronic'],
          },
          spotify_artist_id: configProviderIds ? 'sp-aphex' : null,
          itunes_artist_id: null,
          deezer_artist_id: configProviderIds ? 'dz-aphex' : null,
          discogs_artist_id: null,
          amazon_artist_id: null,
          musicbrainz_artist_id: null,
          watchlist_name: 'Aphex Twin',
          global_metadata_source: 'deezer',
          quality_profiles: [
            { id: 1, name: 'Lossless', is_default: true },
            { id: 2, name: 'MP3 320' },
          ],
        });
      }
      if (url.includes('/api/watchlist/update-similar-artists')) {
        return createResponse({ success: true });
      }
      if (url.includes('/api/watchlist/similar-artists-status')) {
        return createResponse({ success: true, status: 'running', artists_processed: 2 });
      }
      if (url.includes('/api/watchlist/remove')) {
        return createResponse({ success: true });
      }
      if (url.endsWith('/api/watchlist/scan')) {
        return createResponse({ success: true });
      }
      if (url.includes('/api/library/search-service')) {
        return createResponse({
          success: true,
          results: [{ id: 'dz-999', name: 'Aphex Twin', extra: '2.1M fans', image: null }],
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }),
  );

  return calls;
}

function renderRoute(entry = '/wanted?tab=followed') {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createAppRouter({ history, queryClient });

  return {
    history,
    router,
    ...render(<AppRouterProvider router={router} queryClient={queryClient} />),
  };
}

const params = (router: ReturnType<typeof createAppRouter>) =>
  Object.fromEntries(new URLSearchParams(router.state.location.searchStr));

const followedNames = () =>
  [...document.querySelectorAll('ul[aria-label="Followed artists"] > li')].map(
    (row) => row.querySelector('p')?.textContent,
  );

/** Opens a "…" menu by its button's name and picks an item. */
async function menuItem(button: string, item: string) {
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  fireEvent.click(document.querySelector<HTMLElement>(`button[aria-label="${button}"]`)!);
  const menu = await screen.findByRole('menu');
  fireEvent.click(within(menu).getByRole('menuitem', { name: item }));
}

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.SoulSyncWebShellBridge;
  delete window.openDownloadOriginsModal;
  delete window.openWatchlistHistoryModal;
  delete window.openBlocklistModal;
  delete window.showConfirmDialog;
  delete window.showToast;
});

describe('old Watchlist links', () => {
  it('/watchlist opens Followed artists', async () => {
    stubFetch();
    const { router } = renderRoute('/watchlist');
    await waitFor(() => expect(router.state.location.pathname).toBe('/wanted'));
    expect(params(router)).toEqual({ tab: 'followed' });
    expect(await screen.findByText('Aphex Twin')).toBeInTheDocument();
  });

  it('keeps the sort and the filter text', async () => {
    stubFetch({ artists: THREE });
    const { router } = renderRoute('/watchlist?sort=name-desc&q=a');
    await waitFor(() => expect(router.state.location.pathname).toBe('/wanted'));
    expect(params(router)).toMatchObject({ tab: 'followed', sort: 'name-desc', q: 'a' });
    await waitFor(() =>
      expect(followedNames()).toEqual(['Clark', 'Boards of Canada', 'Aphex Twin']),
    );
    // the find field shows what the link filtered on, so a shared link
    // doesn't hide why the list is short
    expect(screen.getByRole('textbox', { name: 'Find in this list' })).toHaveValue('a');
  });

  it('a filter that looks like a number survives the trip', async () => {
    stubFetch();
    // TanStack JSON-parses search values, so an all-digits filter arrives as
    // a number; a bare z.string() would throw and kill the route
    renderRoute('/watchlist?q=311');
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Find in this list' })).toHaveValue('311'),
    );
  });

  it('the Labels tab opens Labels you follow', async () => {
    const calls = stubFetch({ labels: [WARP] });
    const { router } = renderRoute('/watchlist?tab=labels');
    await waitFor(() => expect(params(router)).toEqual({ tab: 'followed', list: 'labels' }));
    expect(await screen.findByText('Warp Records')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Labels you follow' })).toBeInTheDocument();
    expect(calls.some((url) => url.includes('/api/labels/watchlist'))).toBe(true);
    // the artist list belongs to the other view
    expect(screen.queryByText('Aphex Twin')).not.toBeInTheDocument();
  });

  it('settings and an artist’s settings stay open', async () => {
    stubFetch();
    const { router } = renderRoute('/watchlist?settings=true&configId=sp-aphex');
    await waitFor(() => expect(router.state.location.pathname).toBe('/wanted'));
    expect(params(router)).toEqual({
      tab: 'followed',
      settings: 'true',
      configId: 'sp-aphex',
    });
  });

  it('an artist’s panel opens the Artist page now', async () => {
    stubFetch();
    const { router } = renderRoute('/watchlist?detailId=sp-aphex');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/artist-detail/deezer/dz-aphex'),
    );
    expect(params(router)).toMatchObject({ name: 'Aphex Twin' });
  });

  it('a profile that may not see the Watchlist lands on the Wanted tab', async () => {
    stubFetch();
    window.SoulSyncWebShellBridge = createShellBridge({
      isPageAllowed: (pageId) => pageId !== 'watchlist',
    });
    const { router } = renderRoute('/watchlist');
    await waitFor(() => expect(params(router)).toEqual({ tab: 'wanted' }));
  });
});

describe('Followed artists, from the URL', () => {
  it('narrows the list to the find text', async () => {
    stubFetch({ artists: THREE });
    renderRoute('/wanted?tab=followed&q=canada');
    await waitFor(() => expect(followedNames()).toEqual(['Boards of Canada']));
  });

  it('says when an artist’s downloads are filed as audiobooks', async () => {
    stubFetch({ artists: THREE, routed: ['Clark'] });
    renderRoute();
    await screen.findByText('Clark');
    const rows = [...document.querySelectorAll('ul[aria-label="Followed artists"] > li')];
    await waitFor(() => expect(rows[2].textContent).toContain('Filed in your audiobook library'));
    expect(rows[0].textContent).not.toContain('audiobook');
  });

  it('does not fetch labels until they are asked for', async () => {
    const calls = stubFetch();
    renderRoute();
    await screen.findByText('Aphex Twin');
    expect(calls.some((url) => url.includes('/api/labels/watchlist'))).toBe(false);
  });

  it('Select all takes only the artists shown when the list is narrowed', async () => {
    stubFetch({ artists: THREE });
    renderRoute('/wanted?tab=followed&q=canada');
    await waitFor(() => expect(followedNames()).toEqual(['Boards of Canada']));
    await menuItem('More for Followed artists', 'Select several');
    const bar = await screen.findByRole('region', { name: 'Selected' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Select all 1 shown' }));
    // one shown, so one selected, not all three: a narrowed Select all must
    // not unfollow everyone
    expect(within(bar).getByText('1 selected')).toBeInTheDocument();
  });

  it('a row opens the Artist page; its menu has no separate panel', async () => {
    stubFetch();
    const { router } = renderRoute();
    await screen.findByText('Aphex Twin');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Aphex Twin' }));
    expect(
      await screen.findByRole('menuitem', { name: 'Settings for this artist…' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'About this artist…' })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Open artist' })[0]);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/artist-detail/deezer/dz-aphex'),
    );
  });
});

describe('labels, podcasts and audiobook authors you follow', () => {
  it('the page menu opens each list, and Back returns to the artists', async () => {
    stubFetch({ labels: [WARP] });
    const { router } = renderRoute();
    await screen.findByText('Aphex Twin');
    await menuItem('More for Followed artists', 'Labels you follow');
    expect(await screen.findByText('Warp Records')).toBeInTheDocument();
    expect(params(router)).toMatchObject({ list: 'labels' });

    fireEvent.click(screen.getByRole('button', { name: '← Followed artists' }));
    await waitFor(() => expect(params(router)).toEqual({ tab: 'followed' }));
    expect(await screen.findByText('Aphex Twin')).toBeInTheDocument();
  });

  it('renders followed labels with their backlog and scan state', async () => {
    stubFetch({ labels: [{ ...WARP, backlog: true }] });
    renderRoute('/wanted?tab=followed&list=labels');
    expect(await screen.findByText('Warp Records')).toBeInTheDocument();
    expect(screen.getByText('Full backlog')).toBeInTheDocument();
    expect(screen.getByText('Not scanned yet')).toBeInTheDocument();
  });

  it('toggles label backlog without opening the label', async () => {
    const calls = stubFetch({ labels: [WARP] });
    renderRoute('/wanted?tab=followed&list=labels');
    await screen.findByText('Warp Records');
    fireEvent.click(screen.getByTitle('Monitoring new releases only — click for full backlog'));
    await waitFor(() => {
      expect(calls.some((url) => url.includes('/api/labels/watchlist/backlog'))).toBe(true);
    });
    expect(window.SoulSyncWebShellBridge?.navigateToLabelDetail).not.toHaveBeenCalled();
  });

  it('opens the label when the card is clicked', async () => {
    stubFetch({ labels: [WARP] });
    renderRoute('/wanted?tab=followed&list=labels');
    fireEvent.click(await screen.findByText('Warp Records'));
    expect(window.SoulSyncWebShellBridge?.navigateToLabelDetail).toHaveBeenCalledWith(
      'mb-warp',
      'Warp Records',
    );
  });

  it('shows the labels empty state when no label is followed', async () => {
    stubFetch({ labels: [] });
    renderRoute('/wanted?tab=followed&list=labels');
    expect(await screen.findByText('No labels followed yet')).toBeInTheDocument();
  });

  it('renders followed podcasts', async () => {
    stubFetch({ podcasts: [{ ...SYNTAX, author: 'Wes Bos & Scott Tolinski' }] });
    renderRoute('/wanted?tab=followed&list=podcasts');
    expect(await screen.findByText('Syntax Podcast')).toBeInTheDocument();
    expect(screen.getByText('Wes Bos & Scott Tolinski')).toBeInTheDocument();
    expect(screen.getByText('700 eps')).toBeInTheDocument();
  });

  it('shows the podcasts empty state when no podcast is followed', async () => {
    stubFetch({ podcasts: [] });
    renderRoute('/wanted?tab=followed&list=podcasts');
    expect(await screen.findByText('No podcasts in watchlist')).toBeInTheDocument();
  });

  it('saves a podcast’s download settings', async () => {
    const calls = stubFetch({ podcasts: [SYNTAX] });
    renderRoute('/wanted?tab=followed&list=podcasts');
    await screen.findByText('Syntax Podcast');
    fireEvent.click(screen.getByRole('button', { name: 'Podcast options' }));
    fireEvent.click(screen.getByRole('button', { name: /Download Settings/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Podcast Settings' });
    fireEvent.click(within(dialog).getByRole('button', { name: '30 days' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(calls.some((url) => url.includes('/api/podcasts/watchlist/settings'))).toBe(true);
    });
  });

  it('stops following a podcast after asking', async () => {
    const calls = stubFetch({ podcasts: [SYNTAX] });
    window.showConfirmDialog = vi.fn().mockResolvedValue(true);
    renderRoute('/wanted?tab=followed&list=podcasts');
    await screen.findByText('Syntax Podcast');
    fireEvent.click(screen.getByRole('button', { name: 'Podcast options' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove from Watchlist/ }));
    await waitFor(() => {
      expect(window.showConfirmDialog).toHaveBeenCalled();
      expect(calls.some((url) => url.includes('/api/podcasts/watchlist/remove'))).toBe(true);
    });
  });
});

describe('Followed artist settings (the old global settings)', () => {
  it('only shows the override warning while the override is on, and it opens the settings', async () => {
    stubFetch({ globalOverride: false });
    const { unmount } = renderRoute();
    await screen.findByText('Aphex Twin');
    expect(screen.queryByText('Global override is on')).not.toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();

    stubFetch({ globalOverride: true });
    const { router } = renderRoute();
    expect(await screen.findByText('Global override is on')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Followed artist settings' }));
    await waitFor(() => expect(params(router)).toMatchObject({ settings: 'true' }));
  });

  it('opens from the URL with the stored values and saves', async () => {
    const calls = stubFetch({ globalOverride: true });
    renderRoute('/wanted?tab=followed&settings=true');
    const dialog = await screen.findByRole('dialog', { name: 'Global Watchlist Settings' });
    expect(within(dialog).getByRole('checkbox', { name: /Enable Global Override/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Global Settings' }));
    await waitFor(() => {
      const posts = calls.filter((url) => url.includes('/api/watchlist/global-config'));
      expect(posts.length).toBeGreaterThan(1);
    });
  });

  it('refuses to save an override with no release type, and says why', async () => {
    stubFetch({ globalOverride: true });
    window.showToast = vi.fn();
    renderRoute('/wanted?tab=followed&settings=true');
    const dialog = await screen.findByRole('dialog', { name: 'Global Watchlist Settings' });
    const inDialog = within(dialog);
    // found through each box's description: a checkbox role query computes
    // every label's accessible name, which is slow in jsdom
    for (const text of [/Full-length studio albums/, /Extended plays/, /Single tracks and/]) {
      const box = inDialog.getByText(text).closest('label')!.querySelector('input')!;
      expect(box.type).toBe('checkbox');
      if (box.checked) fireEvent.click(box);
    }
    fireEvent.click(inDialog.getByRole('button', { name: 'Save Global Settings' }));
    await waitFor(() => {
      expect(window.showToast).toHaveBeenCalledWith(
        'Please select at least one release type',
        'error',
      );
    });
  });

  it('saves the auto-download default without touching the format override', async () => {
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    stubFetch({ bodies });
    renderRoute('/wanted?tab=followed&settings=true');
    const toggle = await screen.findByRole('checkbox', {
      name: /Auto-download new releases by default/,
    });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save Global Settings' }));
    await waitFor(() => {
      expect(bodies.some((call) => call.url.includes('global-config'))).toBe(true);
    });
    const saved = bodies.find((call) => call.url.includes('global-config'))!.body;
    expect(saved.global_auto_download).toBe(false);
    expect(saved.global_override_enabled).toBe(false);
  });
});

describe('settings for one artist', () => {
  const open = async () => {
    // the dialog mounts before its config query resolves, so wait on a field
    // that only exists once the payload has landed
    await waitFor(() => expect(screen.getByLabelText('Quality Profile')).toBeInTheDocument());
  };

  it('opens from the URL with the stored values', async () => {
    stubFetch();
    renderRoute('/wanted?tab=followed&configId=sp-aphex');
    await open();
    expect(screen.getByText('1,234,567')).toBeInTheDocument();
    expect(screen.getByText('71/100')).toBeInTheDocument();
    expect(screen.getByText('braindance')).toBeInTheDocument();
    expect(screen.queryByText('electronic')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Extended plays/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Single tracks and/ })).toBeChecked();
    expect(screen.getByLabelText('Scan lookback')).toHaveValue('90');
    expect(screen.getByLabelText('Quality Profile')).toHaveValue('');
  });

  it('only offers matched providers as a scan source', async () => {
    stubFetch();
    renderRoute('/wanted?tab=followed&configId=sp-aphex');
    await open();
    expect(screen.getByRole('button', { name: 'Spotify' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deezer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apple Music' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Default \(Deezer\)/ })).toBeInTheDocument();
  });

  it('saves the three-state auto-download preference, never the old boolean', async () => {
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    stubFetch({ bodies });
    renderRoute('/wanted?tab=followed&configId=sp-aphex');
    const select = await screen.findByLabelText('New releases from this artist');
    fireEvent.change(select, { target: { value: 'never' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));
    await waitFor(() => {
      expect(bodies.some((call) => call.url.includes('/config'))).toBe(true);
    });
    const saved = bodies.find((call) => call.url.includes('/config'))!.body;
    expect(saved.auto_download_pref).toBe(0);
    expect('auto_download' in saved).toBe(false);
  });

  it('refuses to save an artist with no release type', async () => {
    stubFetch();
    window.showToast = vi.fn();
    renderRoute('/wanted?tab=followed&configId=sp-aphex');
    await open();
    fireEvent.click(screen.getByRole('checkbox', { name: /Full-length studio albums/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Single tracks and/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));
    await waitFor(() => {
      expect(window.showToast).toHaveBeenCalledWith(
        'Please select at least one release type',
        'error',
      );
    });
  });

  it('links a provider match', async () => {
    const calls = stubFetch();
    renderRoute('/wanted?tab=followed&configId=sp-aphex');
    await open();
    expect(screen.getAllByRole('button', { name: 'Fix' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Match' })[0]);
    expect(screen.getByLabelText('Search Apple Music')).toHaveValue('Aphex Twin');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await waitFor(() => {
      expect(calls.some((url) => url.includes('/link-provider'))).toBe(true);
    });
  });

  it('warns while the global override is on', async () => {
    stubFetch({ globalOverride: true });
    renderRoute('/wanted?tab=followed&configId=sp-aphex');
    expect(
      await screen.findByText(/these per-artist settings are currently ignored during scans/),
    ).toBeInTheDocument();
  });
});

describe('an artist’s panel', () => {
  it('hands an old link over to the Artist page, replacing it in history', async () => {
    stubFetch();
    const { router } = renderRoute('/wanted?tab=followed&detailId=sp-aphex');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/artist-detail/deezer/dz-aphex'),
    );
    expect(router.history.length).toBe(1);
  });

  it('stays, with releases and settings, for an artist whose page can’t be opened', async () => {
    stubFetch({ configProviderIds: false });
    renderRoute('/wanted?tab=followed&detailId=sp-aphex');
    expect(await screen.findByText('1,234,567')).toBeInTheDocument();
    expect(screen.getByText('electronic')).toBeInTheDocument();
    const panel = document.querySelector<HTMLElement>('.watchlist-artist-detail-overlay')!;
    expect(within(panel).getByText('Albums')).toBeInTheDocument();
    expect(within(panel).queryByText('EPs')).not.toBeInTheDocument();
  });

  it('Settings swaps the panel for the artist’s settings', async () => {
    stubFetch({ configProviderIds: false });
    const { router } = renderRoute('/wanted?tab=followed&detailId=sp-aphex');
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(params(router)).toMatchObject({ configId: 'sp-aphex' }));
    expect(params(router).detailId).toBeUndefined();
  });

  it('Unfollow… asks first, like the row’s Unfollow', async () => {
    const calls = stubFetch({ configProviderIds: false });
    const { router } = renderRoute('/wanted?tab=followed&detailId=sp-aphex');
    await screen.findByText('1,234,567');
    fireEvent.click(await screen.findByRole('button', { name: 'Unfollow…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unfollow Aphex Twin?' });
    expect(params(router).detailId).toBeUndefined();
    expect(calls.some((url) => url.includes('/api/watchlist/remove'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unfollow' }));
    await waitFor(() => {
      expect(calls.some((url) => url.includes('/api/watchlist/remove-batch'))).toBe(true);
    });
  });

  it('disables View Discography for an artist matched nowhere', async () => {
    stubFetch({ configProviderIds: false });
    renderRoute('/wanted?tab=followed&detailId=sp-aphex');
    expect(await screen.findByRole('button', { name: 'View Discography' })).toBeDisabled();
  });
});

describe('checking for new releases', () => {
  it('Check now starts a check', async () => {
    const calls = stubFetch();
    renderRoute();
    await screen.findByText('Aphex Twin');
    expect(screen.getByText(/the next check is in about 1 hour/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => {
      expect(calls.some((url) => url.endsWith('/api/watchlist/scan'))).toBe(true);
    });
  });

  it('says what the last check found, and shows the tracks on request', async () => {
    stubFetch({ scanCompletedAt: '2026-07-25T00:00:00Z' });
    renderRoute();
    expect(
      await screen.findByText(/found 3 new tracks and added 2 to Wanted\./),
    ).toBeInTheDocument();
  });

  it('a pushed frame shows the check live, with the old deck one click away', async () => {
    stubFetch();
    renderRoute();
    await screen.findByText('Aphex Twin');
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ss:watchlist-scan', {
          detail: {
            success: true,
            status: 'scanning',
            current_artist_name: 'Boards of Canada',
            current_album: 'Geogaddi',
            current_track_name: 'Dandelion',
            current_phase: 'checking_album_2_of_5',
            current_artist_index: 3,
            total_artists: 40,
            tracks_found_this_scan: 7,
            tracks_added_this_scan: 2,
            recent_wishlist_additions: [{ track_name: 'Roygbiv', artist_name: 'Boards of Canada' }],
          },
        }),
      );
    });
    expect(await screen.findByText('Checking now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop checking' })).toBeInTheDocument();
    expect(screen.queryByText('Geogaddi')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(await screen.findByText('4 / 40 artists')).toBeInTheDocument();
    expect(screen.getByText('Checking album 2 of 5')).toBeInTheDocument();
    expect(screen.getByText('Geogaddi')).toBeInTheDocument();
    expect(screen.getByText('Roygbiv')).toBeInTheDocument();
  });

  it('when a check finishes, its result panel and track list are one click away', async () => {
    stubFetch();
    renderRoute();
    await screen.findByText('Aphex Twin');
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ss:watchlist-scan', {
          detail: {
            success: true,
            status: 'completed',
            summary: {
              total_artists: 40,
              successful_scans: 38,
              new_tracks_found: 19,
              tracks_added_to_wishlist: 10,
            },
            scan_track_events: [
              { track_name: 'Roygbiv', artist_name: 'Boards of Canada', status: 'added' },
              { track_name: 'Xtal', artist_name: 'Aphex Twin', status: 'skipped' },
            ],
          },
        }),
      );
    });
    expect(
      await screen.findByText(/The last check found 19 new tracks and added 10 to Wanted\./),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'What it found' }));
    expect(
      await screen.findByText(
        'Scan completed: 38/40 artists scanned, found 19 new tracks, added 10 to wishlist',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show tracks/ }));
    expect(screen.getByText('Added to wishlist (1)')).toBeInTheDocument();
  });

  it('Update similar artists runs, and Check now waits for it', async () => {
    const calls = stubFetch();
    renderRoute();
    await screen.findByText('Aphex Twin');
    await menuItem('More for Followed artists', 'Update similar artists');
    await waitFor(() => {
      expect(calls.some((url) => url.includes('/api/watchlist/update-similar-artists'))).toBe(true);
    });
    // both use the same worker
    expect(
      await screen.findByText('Check now is free once similar artists finish updating.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument();
  });

  it('the page menu opens the shared history, downloads and blocklist dialogs', async () => {
    stubFetch();
    window.openDownloadOriginsModal = vi.fn();
    window.openWatchlistHistoryModal = vi.fn();
    window.openBlocklistModal = vi.fn();
    renderRoute();
    await screen.findByText('Aphex Twin');
    await menuItem('More for Followed artists', 'Check history…');
    await menuItem('More for Followed artists', 'Downloads from followed artists…');
    await menuItem('More for Followed artists', 'Blocklist…');
    expect(window.openWatchlistHistoryModal).toHaveBeenCalled();
    expect(window.openDownloadOriginsModal).toHaveBeenCalledWith('watchlist');
    expect(window.openBlocklistModal).toHaveBeenCalledWith('artist');
  });
});

describe('Followed artists survive a backend outage', () => {
  it('renders the page and says what failed instead of "Something went wrong"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => createResponse({ error: 'backend down' }, 500)),
    );
    const { router } = renderRoute('/watchlist');
    await waitFor(() =>
      expect(window.SoulSyncWebShellBridge!.showReactHost).toHaveBeenCalledWith('wanted'),
    );
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(router.state.location.pathname).toBe('/wanted');
    expect(
      await screen.findByText("Couldn't load the artists you follow", {}, { timeout: 20_000 }),
    ).toBeInTheDocument();
  });
});
