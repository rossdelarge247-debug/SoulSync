import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

/*
 * The music Wishlist is the Wanted tab of /wanted now. These pin what moved:
 * old links land on the same thing, and what the Wishlist page could do that
 * the Wanted boards first left out (the nebula, now redrawn as board 9a; the
 * audiobook wishlist; the downloads.js dialogs) is still there. The video side's tabs
 * (?media=movies|tv|youtube) stay on /wishlist; -video.route.test.tsx covers
 * them.
 */

vi.setConfig({ testTimeout: 40_000 });

const res = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function albumRow(artist: string, album: string, name: string, retry = 0) {
  return {
    spotify_track_id: `${artist}-${album}-${name}`,
    retry_count: retry,
    date_added: '2026-10-01 10:00:00',
    spotify_data: {
      name,
      album: {
        name: album,
        album_type: 'album',
        total_tracks: 9,
        images: [{ url: `${album}.jpg` }],
      },
      artists: [{ name: artist }],
    },
  };
}

interface StubOptions {
  albums?: unknown[];
  singles?: unknown[];
  processing?: boolean;
  routed?: string[];
  calls?: string[];
  bulk?: { action: string; ids: string[] }[];
  /** extra answers, checked first */
  extra?: (url: string, input: RequestInfo | URL) => Promise<Response | null> | Response | null;
}

function stubFetch(options: StubOptions = {}) {
  const {
    albums = [albumRow('Aphex Twin', 'SAW', 'Xtal')],
    singles = [],
    processing = false,
    routed = [],
  } = options;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      options.calls?.push(url);
      const extra = await options.extra?.(url, input);
      if (extra) return extra;
      if (url.includes('/api/audiobook-routes/check')) {
        const body = (await (input as Request).clone().json()) as { names?: string[] };
        return res({ success: true, routed: (body.names ?? []).filter((n) => routed.includes(n)) });
      }
      if (url.includes('/api/wishlist/bulk')) {
        const body = (await (input as Request).clone().json()) as {
          action: string;
          track_ids: string[];
        };
        options.bulk?.push({ action: body.action, ids: body.track_ids });
        return res({
          success: true,
          results: body.track_ids.map((id) => ({ id, ok: true, message: 'ok' })),
        });
      }
      if (url.includes('/api/wishlist/stats'))
        return res({
          total: albums.length + singles.length,
          albums: albums.length,
          singles: singles.length,
          next_run_in_seconds: 600,
          is_auto_processing: processing,
        });
      if (url.includes('/api/wishlist/cycle')) return res({ cycle: 'albums' });
      if (url.includes('/api/wishlist/found')) return res({ success: true, items: [] });
      if (url.includes('category=albums')) return res({ tracks: albums, artist_images: {} });
      if (url.includes('category=singles')) return res({ tracks: singles, artist_images: {} });
      if (url.includes('/api/wishlist/remove-')) return res({ success: true });
      if (url.includes('/api/active-processes')) return res({ active_processes: [] });
      if (url.includes('/api/watchlist/count'))
        return res({ success: true, count: 0, next_run_in_seconds: 0 });
      if (url.includes('/api/watchlist/artists')) return res({ success: true, artists: [] });
      if (url.includes('/api/automations')) return res([]);
      if (url.includes('/api/quality-profile/custom')) return res({ success: true, profiles: [] });
      if (url.includes('/api/modules')) return res({ success: true, modules: [] });
      if (url.includes('/api/library/artist-index')) return res({ success: true, artists: [] });
      if (url.includes('/api/audiobooks/wishlist'))
        return res({ success: true, items: [], counts: {}, worker: {} });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderRoute(entry = '/wanted') {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createAppRouter({ history, queryClient });
  render(<AppRouterProvider router={router} queryClient={queryClient} />);
  return { router, history };
}

const where = (router: ReturnType<typeof createAppRouter>) =>
  `${router.state.location.pathname}${router.state.location.searchStr}`;

async function pageMenu(item: string) {
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  fireEvent.click(document.querySelector<HTMLElement>('button[aria-label="More for Wanted"]')!);
  const menu = await screen.findByRole('menu');
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
  return menu;
}

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showToast = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.SoulSyncWebShellBridge;
  delete window.showToast;
  delete window.showConfirmDialog;
  delete window._navigateToArtistFromWishlist;
  delete window._nebulaDownload;
  delete window.cleanupWishlistOverview;
  // the list / nebula choice is remembered per browser; don't carry it over
  window.localStorage.removeItem('soulsync_wanted_view');
});

describe('old Wishlist links', () => {
  it('/wishlist opens the Wanted tab', async () => {
    stubFetch();
    const { router } = renderRoute('/wishlist');
    await waitFor(() => expect(where(router)).toBe('/wanted?tab=wanted'));
    expect(await screen.findByText('Xtal')).toBeInTheDocument();
  });

  it('keeps the filter text and turns the Failing chip into Not found yet', async () => {
    stubFetch();
    const { router } = renderRoute('/wishlist?q=canada&failing=true');
    await waitFor(() => expect(router.state.location.pathname).toBe('/wanted'));
    const params = new URLSearchParams(router.state.location.searchStr);
    expect(Object.fromEntries(params)).toEqual({ tab: 'wanted', q: 'canada', filter: 'not-found' });
  });

  it("the video side's tabs stay on /wishlist", async () => {
    stubFetch({
      extra: (url) => {
        if (url.includes('/api/video/wishlist'))
          return res({ success: true, items: [], total: 0, counts: {}, pages: 1 });
        if (url.includes('/api/video/')) return res({ success: true });
        return null;
      },
    });
    const { router } = renderRoute('/wishlist?media=tv');
    await waitFor(() => expect(document.querySelector('.wlp--video')).toBeTruthy());
    expect(router.state.location.pathname).toBe('/wishlist');
    expect(new URLSearchParams(router.state.location.searchStr).get('media')).toBe('tv');
  });

  it('the Audiobooks tab, and the old /audiobooks/wishlist, open Audiobooks on Wanted', async () => {
    stubFetch();
    const { router } = renderRoute('/audiobooks/wishlist');
    await waitFor(() => expect(where(router)).toBe('/wanted?tab=wanted&media=audiobooks'));
    expect(
      await screen.findByRole('heading', { name: 'Audiobooks on Wanted' }),
    ).toBeInTheDocument();
  });
});

describe('the nebula, redrawn in the design system (9a)', () => {
  const artistButtons = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button[data-artist]')].map((b) =>
      b.textContent?.replace(/^\d+/, ''),
    );

  it('an old ?view=nebula link opens it; one artist opens at a time and closes three ways', async () => {
    stubFetch({
      albums: [
        albumRow('Aphex Twin', 'SAW', 'Xtal'),
        albumRow('Boards of Canada', 'MHTRTC', 'Roygbiv'),
      ],
    });
    renderRoute('/wanted?view=nebula');
    await waitFor(() => expect(artistButtons()).toEqual(['Aphex Twin', 'Boards of Canada']));
    // no gradient field, no orbs: upstream's look is gone
    expect(document.querySelector('.wl-nebula-field, .wl-orb')).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();

    const aphex = screen.getByRole('button', { name: /^Aphex Twin,/ });
    const boc = screen.getByRole('button', { name: /^Boards of Canada,/ });
    fireEvent.click(aphex);
    expect(screen.getByRole('complementary', { name: 'Aphex Twin on Wanted' })).toBeTruthy();
    // opening the second closes the first
    fireEvent.click(boc);
    expect(screen.queryByRole('complementary', { name: 'Aphex Twin on Wanted' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Boards of Canada on Wanted' })).toBeTruthy();
    expect(aphex).toHaveAttribute('aria-pressed', 'false');
    expect(boc).toHaveAttribute('aria-pressed', 'true');

    // clicking the open one, the panel's close button and Escape each close it
    fireEvent.click(boc);
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(aphex);
    fireEvent.click(screen.getByRole('button', { name: 'Close Aphex Twin' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(aphex);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
  });

  it('files each artist under its worst thing and says why it’s stuck in words', async () => {
    const stuck = (artist: string, reason: string) => ({
      ...albumRow(artist, `${artist} LP`, 'Song', 4),
      failure_reason: reason,
      last_attempted: '2026-10-01 10:00:00',
    });
    stubFetch({
      albums: [
        albumRow('Healthy', 'Fine', 'Waiting', 0),
        stuck('Nomatch', 'No matching track found'),
        stuck(
          'Clipped',
          'File integrity check failed: Incomplete audio: only ~30s actually decodes of a 234s file (13%)',
        ),
      ],
    });
    renderRoute('/wanted?view=nebula');
    const searching = await screen.findByRole('region', { name: 'Searching · 1' });
    expect(searching).toHaveTextContent('Healthy');
    const notFound = screen.getByRole('region', { name: 'Not found yet · 2' });
    expect(notFound).toHaveTextContent('Nomatch');
    expect(notFound).toHaveTextContent('Clipped');

    fireEvent.click(screen.getByRole('button', { name: /^Clipped,/ }));
    expect(screen.getByRole('complementary', { name: 'Clipped on Wanted' })).toHaveTextContent(
      'Why it’s stuck: 4 tries: only ~30s of 3:54 played, so it was thrown out.',
    );
  });

  it('follows the filter text', async () => {
    stubFetch({
      albums: [
        albumRow('Aphex Twin', 'SAW', 'Xtal', 5),
        albumRow('Boards of Canada', 'MHTRTC', 'Roygbiv'),
      ],
    });
    renderRoute('/wanted?view=nebula&q=canada');
    await waitFor(() => expect(artistButtons()).toEqual(['Boards of Canada']));
  });

  it('Not found yet keeps the three columns and shows only its artists', async () => {
    stubFetch({
      albums: [
        albumRow('Aphex Twin', 'SAW', 'Xtal', 5),
        albumRow('Boards of Canada', 'MHTRTC', 'Roygbiv'),
      ],
    });
    renderRoute('/wanted?view=nebula&filter=not-found');
    await waitFor(() => expect(artistButtons()).toEqual(['Aphex Twin']));
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3);
  });

  it('the view toggle switches between the list and the nebula', async () => {
    stubFetch();
    renderRoute('/wanted');
    await screen.findByText('Xtal');
    fireEvent.click(screen.getByRole('button', { name: 'Show as a nebula' }));
    await waitFor(() => expect(artistButtons()).toEqual(['Aphex Twin']));
    fireEvent.click(screen.getByRole('button', { name: 'Show as a list' }));
    await waitFor(() => expect(artistButtons()).toEqual([]));
    expect(await screen.findByText('Xtal')).toBeInTheDocument();
  });

  it('searches for and removes an artist’s things by their exact track ids', async () => {
    const bulk: { action: string; ids: string[] }[] = [];
    stubFetch({
      albums: [
        albumRow('Aphex Twin', 'SAW', 'Xtal'),
        albumRow('Aphex Twin', 'SAW', 'Ageispolis'),
        albumRow('Aphex Twin', 'Drukqs', 'Avril 14th'),
      ],
      bulk,
      extra: (url) => {
        if (url.includes('remove-album') || url.includes('remove-artist'))
          throw new Error('removing by name must not be used for an artist');
        return null;
      },
    });
    renderRoute('/wanted?view=nebula');
    fireEvent.click(await screen.findByRole('button', { name: /^Aphex Twin,/ }));
    const panel = screen.getByRole('complementary', { name: 'Aphex Twin on Wanted' });

    fireEvent.click(within(panel).getByRole('button', { name: 'Search now for both' }));
    await waitFor(() => expect(bulk).toHaveLength(1));
    expect(bulk[0]).toEqual({
      action: 'grab',
      ids: ['Aphex Twin-SAW-Xtal', 'Aphex Twin-SAW-Ageispolis', 'Aphex Twin-Drukqs-Avril 14th'],
    });

    fireEvent.click(within(panel).getByRole('button', { name: 'Remove both from Wanted' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove 2 things from Wanted?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 2 things' }));
    await waitFor(() => expect(bulk).toHaveLength(2));
    expect(bulk[1]).toEqual({
      action: 'skip',
      ids: ['Aphex Twin-SAW-Xtal', 'Aphex Twin-SAW-Ageispolis', 'Aphex Twin-Drukqs-Avril 14th'],
    });
  });
});

describe('what downloads.js still owns', () => {
  it('renders the ids its download dialog reads its counts from', async () => {
    stubFetch({ albums: [albumRow('A', 'X', 'a1')], singles: [] });
    renderRoute('/wanted');
    await waitFor(() =>
      expect(document.getElementById('wishlist-stat-albums')?.textContent).toBe('1'),
    );
    expect(document.getElementById('wishlist-stat-singles')?.textContent).toBe('0');
  });

  it('opens its dialogs from the page menu', async () => {
    stubFetch();
    window._nebulaDownload = vi.fn();
    window.cleanupWishlistOverview = vi.fn();
    renderRoute('/wanted');
    await screen.findByText('Xtal');
    await pageMenu('Download everything now…');
    expect(window._nebulaDownload).toHaveBeenCalled();
    await pageMenu('Remove what’s already in your library…');
    expect(window.cleanupWishlistOverview).toHaveBeenCalled();
  });

  it('refreshes when it announces a wishlist change', async () => {
    const calls: string[] = [];
    stubFetch({ calls });
    renderRoute('/wanted');
    await screen.findByText('Xtal');
    const before = calls.filter((u) => u.includes('category=albums')).length;
    act(() => {
      window.dispatchEvent(new CustomEvent('ss:wishlist-changed'));
    });
    await waitFor(() =>
      expect(calls.filter((u) => u.includes('category=albums')).length).toBeGreaterThan(before),
    );
  });
});

describe('artists filed as audiobooks', () => {
  const albums = [
    albumRow('Aphex Twin', 'SAW', 'Xtal'),
    albumRow('Aphex Twin', 'SAW', 'Ageispolis'),
    albumRow('Bobby & Max', 'Folge 93', 'Teil 1'),
    albumRow('Bobby & Max', 'Folge 93', 'Teil 2'),
    albumRow('Bobby & Max', 'Folge 93', 'Teil 3'),
  ];

  it('are left out of the music rows and the count', async () => {
    stubFetch({ albums, routed: ['Bobby & Max'] });
    renderRoute('/wanted');
    await waitFor(() => expect(screen.queryByText('Folge 93')).not.toBeInTheDocument());
    expect(await screen.findByText('SAW')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('tab', { name: /Wanted/ })).toHaveTextContent('1'));
  });

  it('are listed under Audiobooks on Wanted, and its Search now sends them too', async () => {
    const bulk: { action: string; ids: string[] }[] = [];
    let passes = 0;
    stubFetch({
      albums,
      routed: ['Bobby & Max'],
      bulk,
      extra: (url) => {
        if (url.includes('/api/audiobooks/wishlist/search')) {
          passes += 1;
          return res({ success: true, summary: { checked: 0, grabbed: 0 } });
        }
        return null;
      },
    });
    renderRoute('/wanted?tab=wanted&media=audiobooks');
    const section = await waitFor(() => {
      const found = document.querySelector('.wlp-routed');
      expect(found).toBeInTheDocument();
      return found as HTMLElement;
    });
    expect(section.textContent).toContain('Bobby & Max');
    expect(section.textContent).not.toContain('Aphex Twin');

    fireEvent.click(screen.getByRole('button', { name: 'Search now' }));
    await waitFor(() => expect(bulk).toHaveLength(1));
    expect(passes).toBe(1);
    expect(bulk[0]).toEqual({
      action: 'grab',
      ids: [
        'Bobby & Max-Folge 93-Teil 1',
        'Bobby & Max-Folge 93-Teil 2',
        'Bobby & Max-Folge 93-Teil 3',
      ],
    });
  });
});

describe('a backend outage', () => {
  it('renders the page with its failure state, not "Something went wrong"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ error: 'backend down' }, 500)),
    );
    const { router } = renderRoute('/wishlist');
    await waitFor(() =>
      expect(window.SoulSyncWebShellBridge!.showReactHost).toHaveBeenCalledWith('wanted'),
    );
    expect(await screen.findByText("Couldn't load your list")).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(router.state.location.pathname).toBe('/wanted');
  });
});
