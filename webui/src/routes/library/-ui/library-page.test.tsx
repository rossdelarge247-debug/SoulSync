import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

import type { LibraryRelease } from '../-library.types';

/**
 * Library → Albums, Genres and Artists (7a–7g), through the real router and
 * the real manifest: the URL drives every filter, so the requests the page
 * makes are what's checked, with the routes stubbed.
 */

function release(over: Partial<LibraryRelease> & { id: string; title: string }): LibraryRelease {
  return {
    kind: 'library',
    album_id: over.id.replace('album:', ''),
    artist_id: '1',
    artist_name: 'Pale Harbour',
    year: 2024,
    art_url: null,
    genres: ['Ambient'],
    album_type: 'album',
    tracks_total: 10,
    tracks_owned: 10,
    below_target: 0,
    format: 'FLAC',
    state: 'owned',
    wanted: null,
    added_at: '2026-01-01',
    source: null,
    source_id: null,
    ...over,
  };
}

const RELEASES: LibraryRelease[] = [
  release({ id: 'album:1', title: 'Night Ferry' }),
  release({
    id: 'album:2',
    title: 'Tidewater',
    state: 'partial',
    tracks_total: 12,
    tracks_owned: 11,
  }),
  release({
    id: 'album:3',
    title: 'Low Light',
    state: 'below_target',
    below_target: 9,
    format: 'MP3 320',
  }),
  release({
    id: 'release:spotify:x1',
    title: 'Lantern',
    kind: 'missing',
    album_id: null,
    state: 'missing',
    tracks_owned: 0,
    tracks_total: 11,
    format: null,
    wanted: { status: 'not_found', tracks: 11 },
  }),
  release({
    id: 'release:spotify:x2',
    title: 'Weather Systems',
    kind: 'missing',
    album_id: null,
    state: 'missing',
    artist_id: '2',
    artist_name: 'Field Recordings Dept.',
    tracks_owned: 0,
    tracks_total: 9,
    format: null,
    year: 2020,
  }),
];

const TOTALS = {
  albums: 494,
  library: 410,
  missing: 61,
  below: 23,
  tracks: 4980,
  genres: 38,
  artists: 186,
  following: 18,
  incomplete: 41,
};

function releasesBody(url: URL) {
  const page = Number(url.searchParams.get('page') ?? 1);
  const genre = url.searchParams.get('genre') ?? '';
  const body: Record<string, unknown> = {
    success: true,
    releases: page === 1 ? RELEASES : [release({ id: 'album:99', title: 'Second Page Album' })],
    total: 494,
    page,
    limit: 50,
    has_more: page === 1,
    show: url.searchParams.get('show') ?? 'all',
    sort: url.searchParams.get('sort') ?? 'recent',
    genre: genre ? 'Ambient' : '',
    show_counts: { all: 494, library: 410, missing: 61, below: 23 },
    genre_total: 494,
    genres: [
      { key: 'electronic', name: 'Electronic', count: 212 },
      { key: 'jazz', name: 'Jazz', count: 96 },
      { key: 'folk', name: 'Folk', count: 61 },
      { key: 'ambient', name: 'Ambient', count: 48 },
      { key: 'soul', name: 'Soul', count: 44 },
      { key: 'post-rock', name: 'Post-rock', count: 33 },
      { key: 'classical', name: 'Classical', count: 21 },
      { key: 'hip-hop', name: 'Hip-hop', count: 19 },
      { key: 'dub', name: 'Dub', count: 4 },
    ],
    totals: TOTALS,
    missing_summary: { count: 61, tracks: 520, artists: [], sample: [] },
    target: { name: 'FLAC or better' },
  };
  if (genre) {
    body.genre_summary = {
      name: 'Ambient',
      albums: 48,
      library: 31,
      missing: 17,
      below: 4,
      wantable: { count: 17, tracks: 189, artists: [], sample: [] },
      below_album_ids: [3],
    };
  }
  return body;
}

const SUMMARY = {
  success: true,
  count: 17,
  tracks: 189,
  artists: [
    { id: '1', name: 'Pale Harbour' },
    { id: '2', name: 'Field Recordings Dept.' },
  ],
  sample: RELEASES.slice(3),
  selected: 17,
  already_have: 0,
  already_wanted: 0,
  types: { album: 16, ep: 1 },
  target: { name: 'FLAC or better' },
  following: ['1'],
};

const ADD_RESULT = {
  success: true,
  added: 15,
  already_wanted: 2,
  already_have: 0,
  failed: 0,
  refused: 0,
  tracks_added: 170,
  asks_first: false,
  followed: null,
  results: [],
};

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
    {
      id: '2',
      name: 'Vera Lund',
      image_url: null,
      genres: ['Jazz'],
      following: false,
      releases: 5,
      in_library: 4,
      missing: 1,
      wanted: 0,
      wantable: 1,
    },
    {
      id: '3',
      name: 'Halide',
      image_url: null,
      genres: [],
      following: false,
      releases: 9,
      in_library: 9,
      missing: 0,
      wanted: 0,
      wantable: 0,
    },
  ],
  total: 186,
  page: 1,
  limit: 50,
  has_more: true,
  show: 'all',
  sort: 'name',
  genre: '',
  show_counts: { all: 186, following: 18, incomplete: 41 },
  genre_total: 186,
  genres: [{ key: 'electronic', name: 'Electronic', count: 64 }],
  totals: TOTALS,
};

const GENRES = {
  success: true,
  genres: [
    {
      key: 'electronic',
      name: 'Electronic',
      albums: 212,
      library: 180,
      missing: 32,
      wantable: 32,
      below: 11,
      covers: [],
    },
    {
      key: 'classical',
      name: 'Classical',
      albums: 21,
      library: 21,
      missing: 0,
      wantable: 0,
      below: 0,
      covers: [],
    },
  ],
  total: 2,
  show_counts: { all: 38, gaps: 23 },
  totals: TOTALS,
  target: { name: 'FLAC or better' },
};

let requested: string[] = [];
let posted: { url: string; body: unknown }[] = [];

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showLibraryDownloadsSection = vi.fn();
  window.showToast = vi.fn();
  window.playTrackList = vi.fn(async () => undefined);
  requested = [];
  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (input instanceof Request && input.method === 'POST') {
        posted.push({ url, body: await input.clone().json() });
      }
      const u = new URL(url, 'http://x');
      let body: unknown = {};
      if (u.pathname.endsWith('/api/library/releases')) body = releasesBody(u);
      else if (u.pathname.endsWith('/api/library/releases/summary')) body = SUMMARY;
      else if (u.pathname.endsWith('/api/wishlist/bulk')) body = ADD_RESULT;
      else if (u.pathname.endsWith('/api/library/artist-index')) body = ARTISTS;
      else if (u.pathname.endsWith('/api/library/genres')) body = GENRES;
      else if (u.pathname.endsWith('/api/library/artists/follow'))
        body = { success: true, followed: 1, already_following: 0, no_id: 0 };
      else if (u.pathname.includes('/api/library/albums/') && u.pathname.endsWith('/tracks'))
        body = {
          success: true,
          tracks: [{ id: 't1', title: 'One', file_path: '/m/1.flac', track_number: 1 }],
        };
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

function renderPage(entry = '/library?view=albums') {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createAppRouter({ history, queryClient });
  return { router, ...render(<AppRouterProvider router={router} queryClient={queryClient} />) };
}

const releaseCalls = () =>
  requested.filter((u) => new URL(u, 'http://x').pathname.endsWith('/api/library/releases'));
const lastReleases = () => new URL(releaseCalls().at(-1)!, 'http://x').searchParams;

describe('Albums (7a)', () => {
  it('shows the counts line, the tabs, Show with counts and the tags only where they matter', async () => {
    renderPage();
    await screen.findByText('Night Ferry');
    expect(
      screen.getByText("494 albums · 4,980 tracks · 38 genres · 61 you don't have yet"),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Albums\s*494/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: /Genres\s*38/ })).toBeTruthy();
    const show = screen.getByRole('group', { name: 'Show' });
    expect(within(show).getByRole('button', { name: /In your library\s*410/ })).toBeTruthy();
    expect(within(show).getByRole('button', { name: /Below target\s*23/ })).toBeTruthy();
    const tile = (title: string) => screen.getByText(title).closest('li')!;
    // an album you have whole carries no tag
    expect(within(tile('Night Ferry')).queryByText(/library|target|found|Wanted/)).toBeNull();
    expect(within(tile('Night Ferry')).getByText('Pale Harbour · 2024 · FLAC')).toBeTruthy();
    expect(within(tile('Tidewater')).getByText('11 of 12 found')).toBeTruthy();
    expect(within(tile('Tidewater')).getByText('Pale Harbour · 2024 · 12 tracks')).toBeTruthy();
    expect(within(tile('Low Light')).getByText('Below quality target')).toBeTruthy();
    expect(within(tile('Lantern')).getByText('Wanted · not found')).toBeTruthy();
    expect(within(tile('Weather Systems')).getByText('Not in your library')).toBeTruthy();
    // the hover actions: Play for yours, Add to Wanted for one you don't have
    expect(
      within(tile('Night Ferry')).getByRole('button', { name: 'Play Night Ferry' }),
    ).toBeTruthy();
    expect(
      within(tile('Weather Systems')).getByRole('button', {
        name: 'Add Weather Systems to Wanted',
      }),
    ).toBeTruthy();
    expect(within(tile('Lantern')).queryByRole('button', { name: /Add/ })).toBeNull();
    // it opens the Artist page, at the album when you have it
    expect(
      within(tile('Night Ferry')).getByRole('link', { name: 'Night Ferry' }).getAttribute('href'),
    ).toBe('/artist-detail/library/1?album=1');
  });

  it('the genre chips: the top seven, the rest under "N more", and a pick goes in the URL', async () => {
    const { router } = renderPage();
    await screen.findByText('Night Ferry');
    const row = screen.getByRole('group', { name: 'Genre' });
    expect(
      within(row)
        .getByRole('button', { name: /All\s*494/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(row).getByRole('button', { name: /Classical\s*21/ })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /^Hip-hop/ })).toBeNull();
    expect(within(row).getByRole('button', { name: /2 more/ })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: /Ambient\s*48/ }));
    await waitFor(() => expect(lastReleases().get('genre')).toBe('ambient'));
    expect(router.state.location.search).toMatchObject({ view: 'albums', genre: 'ambient' });
  });

  it('Show and Sort go to the server and combine with the genre', async () => {
    renderPage('/library?view=albums&genre=ambient');
    await screen.findByText('Night Ferry');
    fireEvent.click(screen.getByRole('button', { name: /Missing\s*61/ }));
    await waitFor(() => expect(lastReleases().get('show')).toBe('missing'));
    expect(lastReleases().get('genre')).toBe('ambient');
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'genre' } });
    await waitFor(() => expect(lastReleases().get('sort')).toBe('genre'));
  });

  it('the filter field offers "Genre: Ambient" first and picks the chip', async () => {
    const { router } = renderPage();
    await screen.findByText('Night Ferry');
    fireEvent.change(screen.getByLabelText('Filter albums'), { target: { value: 'amb' } });
    const option = await screen.findByRole('option', { name: /Genre: Ambient/ });
    fireEvent.click(option);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ genre: 'ambient' }));
    expect((screen.getByLabelText('Filter albums') as HTMLInputElement).value).toBe('');
  });

  it('typed text filters titles, artists and genres after a pause', async () => {
    renderPage();
    await screen.findByText('Night Ferry');
    fireEvent.change(screen.getByLabelText('Filter albums'), { target: { value: 'ferry' } });
    await waitFor(() => expect(lastReleases().get('q')).toBe('ferry'));
  });

  it('"Show 50 more" adds the next page and keeps what is there', async () => {
    renderPage();
    await screen.findByText('Night Ferry');
    expect(screen.getByText('5 of 494')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
    await screen.findByText('Second Page Album');
    expect(screen.getByText('Night Ferry')).toBeTruthy();
    expect(lastReleases().get('page')).toBe('2');
  });

  it("a missing album's Add to Wanted adds it at once, and the toast says how it went", async () => {
    renderPage();
    await screen.findByText('Weather Systems');
    fireEvent.click(screen.getByRole('button', { name: 'Add Weather Systems to Wanted' }));
    await waitFor(() =>
      expect(posted.some((p) => p.url.endsWith('/api/wishlist/bulk'))).toBe(true),
    );
    expect(posted.find((p) => p.url.endsWith('/api/wishlist/bulk'))!.body).toEqual({
      action: 'add',
      release_ids: ['release:spotify:x2'],
      quality: 'target',
    });
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        'Added 15 albums to Wanted · 2 already wanted',
        'success',
      ),
    );
  });

  it('Play queues the album you have', async () => {
    renderPage();
    await screen.findByText('Night Ferry');
    fireEvent.click(screen.getByRole('button', { name: 'Play Night Ferry' }));
    await waitFor(() => expect(window.playTrackList).toHaveBeenCalled());
  });
});

describe('the genre line (7b) and the confirm (7d)', () => {
  it('says what the genre holds and asks before adding the missing ones', async () => {
    renderPage('/library?view=albums&genre=ambient');
    await screen.findByText('Night Ferry');
    expect(screen.getByText(/48 albums · 31 in your library/)).toBeTruthy();
    expect(screen.getByText("17 you don't have")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade the 4 below target' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add the 17 missing to Wanted' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Add 17 albums to Wanted?');
    expect(within(dialog).getByText('189')).toBeTruthy();
    expect(within(dialog).getByText('FLAC or better')).toBeTruthy();
    expect(
      within(dialog).getByText(/Everything tagged Ambient that isn't in your library\./),
    ).toBeTruthy();
    expect(within(dialog).getByText('Weather Systems')).toBeTruthy();
    expect(within(dialog).getByText('2 of 17')).toBeTruthy();
    // following is its own promise, off by default; Pale Harbour is followed already
    expect(within(dialog).getByText(/Also follow Field Recordings Dept\./)).toBeTruthy();
    const summaryPost = posted.find((p) => p.url.endsWith('/api/library/releases/summary'))!;
    expect(summaryPost.body).toEqual({ filter: { genre: 'ambient' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 17 to Wanted' }));
    await waitFor(() =>
      expect(posted.some((p) => p.url.endsWith('/api/wishlist/bulk'))).toBe(true),
    );
    expect(posted.find((p) => p.url.endsWith('/api/wishlist/bulk'))!.body).toEqual({
      action: 'add',
      filter: { genre: 'ambient' },
      quality: 'target',
      follow_artists: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the upgrade line is for admins only', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      getCurrentProfileContext: vi.fn(() => ({ profileId: 5, isAdmin: false })),
    });
    renderPage('/library?view=albums&genre=ambient');
    await screen.findByText('Night Ferry');
    expect(screen.queryByRole('button', { name: /Upgrade the/ })).toBeNull();
  });
});

describe('selection mode (7c)', () => {
  it('Select turns squares into toggles and the bar counts them', async () => {
    renderPage();
    await screen.findByText('Night Ferry');
    const select = screen.getByRole('button', { name: 'Select' });
    expect(select.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(select);
    expect(screen.getByRole('button', { name: 'Done', pressed: true })).toBeTruthy();
    const bar = screen.getByRole('toolbar', { name: 'Selected albums' });
    // nothing picked: the primary is the neutral disabled one, with its reason
    const add = within(bar).getByRole('button', { name: 'Add to Wanted' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(within(bar).getByText('Click albums to select them')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select Weather Systems' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Tidewater' }));
    expect(
      screen.getByRole('button', { name: 'Select Weather Systems' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(bar).getByText('2 albums selected · 21 tracks')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: /Add 2 to Wanted/ }));
    await screen.findByRole('dialog');
    await waitFor(() =>
      expect(posted.find((p) => p.url.endsWith('/api/library/releases/summary'))?.body).toEqual({
        release_ids: ['release:spotify:x2', 'album:2'],
      }),
    );
  });

  it('"Select all N missing" follows the Show filter; unticking excludes; the selection survives a genre change', async () => {
    renderPage('/library?view=albums&show=missing');
    await screen.findByText('Weather Systems');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected albums' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Select all 61 missing' }));
    expect(
      screen.getByRole('button', { name: 'Select Weather Systems' }).getAttribute('aria-pressed'),
    ).toBe('true');
    // a wanted album isn't "missing to add"
    expect(
      screen.getByRole('button', { name: 'Select Lantern' }).getAttribute('aria-pressed'),
    ).toBe('false');
    expect(within(bar).getByText('61 albums selected · 520 tracks')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select Weather Systems' }));
    expect(within(bar).getByText('60 albums selected · 511 tracks')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Jazz\s*96/ }));
    await waitFor(() => expect(lastReleases().get('genre')).toBe('jazz'));
    expect(
      within(screen.getByRole('toolbar', { name: 'Selected albums' })).getByText(
        /60 albums selected/,
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('toolbar', { name: 'Selected albums' })).getByRole('button', {
        name: /Add 60 to Wanted/,
      }),
    );
    await screen.findByRole('dialog');
    await waitFor(() =>
      expect(posted.find((p) => p.url.endsWith('/api/library/releases/summary'))?.body).toEqual({
        release_ids: [],
        filter: { show: 'missing', genre: '', q: '' },
        exclude_ids: ['release:spotify:x2'],
      }),
    );
  });

  it('Escape and Done leave selection mode and clear it', async () => {
    renderPage();
    await screen.findByText('Night Ferry');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Night Ferry' }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByRole('toolbar', { name: 'Selected albums' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(
      screen.getByRole('button', { name: 'Select Night Ferry' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('the "…" holds Follow, a different quality and, for admins, Remove from library', async () => {
    renderPage();
    await screen.findByText('Night Ferry');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Night Ferry' }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions for the selection' }));
    expect(await screen.findByRole('menuitem', { name: 'Follow these artists' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Hold to a different quality…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Remove 1 album from library…' })).toBeTruthy();
  });
});

describe('Genres (7e)', () => {
  it('tiles say what you have and open Albums with the chip picked', async () => {
    const { router } = renderPage('/library?view=albums&tab=genres');
    await screen.findByText('Electronic');
    expect(screen.getByText('212 albums · 180 in your library')).toBeTruthy();
    expect(screen.getByText("32 you don't have · 11 below quality target")).toBeTruthy();
    expect(screen.getByText('All of it in your library')).toBeTruthy();
    expect(screen.getByRole('button', { name: /With gaps\s*23/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add 32 missing to Wanted' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Electronic' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ view: 'albums', genre: 'electronic' }),
    );
    expect(router.state.location.search).not.toHaveProperty('tab');
  });

  it('Select picks genres: "Add 32 missing across 1 genre"', async () => {
    renderPage('/library?view=albums&tab=genres');
    await screen.findByText('Electronic');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Electronic' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected genres' });
    fireEvent.click(within(bar).getByRole('button', { name: /Add 32 missing across 1 genre/ }));
    await screen.findByRole('dialog');
    await waitFor(() =>
      expect(posted.find((p) => p.url.endsWith('/api/library/releases/summary'))?.body).toEqual({
        filter: { genres: ['electronic'] },
      }),
    );
  });
});

describe('Artists (7f)', () => {
  it('square art, "9 of 14 releases", Following, and the artist page', async () => {
    renderPage('/library');
    await screen.findByText('Pale Harbour');
    expect(
      screen.getByText("186 artists · 18 you follow · 41 with releases you don't have"),
    ).toBeTruthy();
    const tile = screen.getByText('Pale Harbour').closest('li')!;
    expect(within(tile).getByText('9 of 14 releases')).toBeTruthy();
    expect(within(tile).getByText('Following')).toBeTruthy();
    expect(within(tile).getByRole('link', { name: 'Pale Harbour' }).getAttribute('href')).toBe(
      '/artist-detail/library/1',
    );
    expect(screen.getByRole('button', { name: /Following\s*18/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Incomplete\s*41/ })).toBeTruthy();
    // a complete artist plays instead
    const halide = screen.getByText('Halide').closest('li')!;
    expect(within(halide).getByRole('button', { name: "Play Halide's top tracks" })).toBeTruthy();
  });

  it('hover adds: one missing at once, several through the confirm', async () => {
    renderPage('/library');
    await screen.findByText('Vera Lund');
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 missing to Wanted' }));
    await waitFor(() =>
      expect(posted.find((p) => p.url.endsWith('/api/wishlist/bulk'))?.body).toEqual({
        action: 'add',
        filter: { artist_ids: ['2'] },
        quality: 'target',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 missing to Wanted' }));
    await screen.findByRole('dialog');
    await waitFor(() =>
      expect(posted.find((p) => p.url.endsWith('/api/library/releases/summary'))?.body).toEqual({
        filter: { artist_ids: ['1'] },
      }),
    );
  });

  it('Select picks artists and Follow these artists follows them', async () => {
    renderPage('/library');
    await screen.findByText('Vera Lund');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Vera Lund' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Halide' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected artists' });
    expect(within(bar).getByText('2 artists selected · 1 missing')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'More actions for the selection' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Follow these artists' }));
    await waitFor(() =>
      expect(posted.find((p) => p.url.endsWith('/api/library/artists/follow'))?.body).toEqual({
        artist_ids: ['2', '3'],
      }),
    );
  });
});
