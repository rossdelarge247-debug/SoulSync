import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { getShellRouteByPageId } from '@/platform/shell/route-manifest';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

/**
 * /library is React's: the route must not hand the page back to vanilla,
 * validateSearch must survive whatever is in the URL (old links included), and
 * the permission gate still applies.
 */

function renderRoute(entries = ['/library']) {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: entries });
  const router = createAppRouter({ history, queryClient });
  return { router, ...render(<AppRouterProvider router={router} queryClient={queryClient} />) };
}

let requested: string[] = [];

const ARTISTS = {
  success: true,
  artists: [
    {
      id: '1',
      name: 'Pale Harbour',
      image_url: null,
      genres: ['Ambient'],
      following: true,
      releases: 14,
      in_library: 9,
      missing: 5,
      wanted: 2,
      wantable: 3,
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
  has_more: false,
  show: 'all',
  sort: 'name',
  genre: '',
  show_counts: { all: 1, following: 1, incomplete: 1 },
  genre_total: 1,
  genres: [{ key: 'ambient', name: 'Ambient', count: 1 }],
  totals: {
    albums: 14,
    library: 9,
    missing: 5,
    below: 0,
    tracks: 100,
    genres: 1,
    artists: 1,
    following: 1,
    incomplete: 1,
  },
};

const lastQuery = (path: string) =>
  new URL(requested.filter((u) => u.includes(path)).at(-1)!, 'http://x').searchParams;

describe('library route', () => {
  beforeEach(() => {
    window.SoulSyncWebShellBridge = createShellBridge();
    window.showLibraryDownloadsSection = vi.fn();
    requested = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        requested.push(url);
        const body = url.includes('/api/library/artist-index') ? ARTISTS : {};
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.SoulSyncWebShellBridge;
    delete window.showLibraryDownloadsSection;
  });

  it('is owned by React', () => {
    expect(getShellRouteByPageId('library')?.kind).toBe('react');
  });

  it('renders the Artists grid instead of handing /library to vanilla', async () => {
    renderRoute();
    await screen.findByText('Pale Harbour');
    expect(window.SoulSyncWebShellBridge!.activateLegacyPath).not.toHaveBeenCalledWith('/library');
  });

  it('reads every param from the URL and leaves the defaults out of it', async () => {
    const { router } = renderRoute(['/library?show=following&genre=Ambient&sort=recent&q=123']);
    await waitFor(() =>
      expect(requested.some((u) => u.includes('/api/library/artist-index'))).toBe(true),
    );
    const q = lastQuery('/api/library/artist-index');
    // an all-digits q arrives as a number from TanStack's parse; it's still text
    expect([q.get('show'), q.get('genre'), q.get('sort'), q.get('q')]).toEqual([
      'following',
      'ambient',
      'recent',
      '123',
    ]);
    expect(router.state.location.search).not.toHaveProperty('view');
    expect(router.state.location.search).not.toHaveProperty('tab');
  });

  it('turns old links and nonsense into the defaults rather than an error', async () => {
    renderRoute([
      '/library?letter=A&page=notanumber&watchlist=unwatched&source=spotify&show=nope&sort=year_desc',
    ]);
    await screen.findByText('Pale Harbour');
    const q = lastQuery('/api/library/artist-index');
    expect(q.get('show')).toBe('all');
    expect(q.get('sort')).toBe('name');
    expect(q.get('letter')).toBeNull();
  });

  it('still respects the page permission gate', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({ isPageAllowed: vi.fn(() => false) });
    const { router } = renderRoute();
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/library'));
  });
});
