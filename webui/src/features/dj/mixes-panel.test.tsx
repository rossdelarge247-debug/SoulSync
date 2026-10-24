import { QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import { MixesPanelHost } from './mixes-panel';
import {
  FOLLOW_STORAGE_KEY,
  SEED_STORAGE_KEY,
  closeMixes,
  openMixes,
  resetMixesForTests,
} from './mixes-store';

/**
 * "Mixes well with" as the shell's docked panel (17a, 17b, 17d; HANDOFF 152,
 * 164): it lives beside the router's outlet, so it survives navigation;
 * "Follow what's playing" re-seeds it from the player; "Make a playlist from
 * these…" makes one through the playlist route; and the states 17b draws.
 */

function dj(bpm: number | null, key: string | null, long: string | null, extra = {}) {
  return {
    bpm,
    bpm_source: 'analysis',
    key,
    key_name: key ? 'Am' : null,
    key_long: long,
    key_source: key ? 'analysis' : null,
    key_confidence: 0.8,
    key_uncertain: false,
    energy: 7,
    analyzed: Boolean(key),
    ...extra,
  };
}

function track(id: string, title: string, artist: string, info: ReturnType<typeof dj> | null) {
  return {
    id,
    title,
    artist_name: artist,
    album_title: 'Night Ferry EP',
    artist_id: '1',
    album_id: '10',
    duration_ms: 362000,
    file_path: `/m/${id}.flac`,
    bitrate: 900,
    image_url: null,
    dj: info,
  };
}

const SEED = track('1', 'Night Ferry', 'Tidewater', dj(124, '8A', 'A minor'));
const MATCHES = [
  {
    ...track('2', 'Harbour Light', 'Pale Harbour', dj(122, '8A', 'A minor')),
    key_relation: 'same',
    bpm_relation: 'same',
    bpm_diff_pct: -1.6,
  },
  {
    ...track('5', 'Static Bloom', 'Saltmarsh', dj(126, '9A', 'E minor')),
    key_relation: 'up',
    bpm_relation: 'same',
    bpm_diff_pct: 1.6,
  },
];

const HARBOUR = track('2', 'Harbour Light', 'Pale Harbour', dj(122, '8A', 'A minor'));
const UNSURE = track(
  '4',
  'Saltwater Hymn',
  'Tidewater',
  dj(125, '8B', 'F major', { key_uncertain: true }),
);

let mixesAsked: string[] = [];
let started: unknown[] = [];
let made: unknown[] = [];

function serve() {
  server.use(
    http.get('/api/library/dj/mixes/:id', ({ params, request }) => {
      const within = new URL(request.url).searchParams.get('within');
      mixesAsked.push(`${String(params.id)}${within ? `@${within}` : ''}`);
      switch (params.id) {
        case '1':
          return HttpResponse.json({
            success: true,
            track: SEED,
            matches: MATCHES,
            total: 2,
            reason: null,
            within: 6,
          });
        case '2':
          return HttpResponse.json({
            success: true,
            track: HARBOUR,
            matches: [MATCHES[1]],
            total: 1,
            reason: null,
            within: 6,
          });
        case '3':
          return HttpResponse.json({
            success: true,
            track: track('3', 'Glasshouse', 'Marrow Field', null),
            matches: [],
            total: 0,
            reason: 'not_analyzed',
            within: 6,
          });
        case '4':
          return HttpResponse.json(
            within === '10'
              ? {
                  success: true,
                  track: UNSURE,
                  matches: [MATCHES[1]],
                  total: 1,
                  reason: null,
                  within: 10,
                }
              : { success: true, track: UNSURE, matches: [], total: 0, reason: 'none', within: 6 },
          );
        default:
          return HttpResponse.json(
            { success: false, error: "That track isn't in your library" },
            { status: 404 },
          );
      }
    }),
    http.get('/api/library/dj/status', () =>
      HttpResponse.json({
        success: true,
        settings: { analyze: true, write_tags: false, overwrite_tags: false },
        counts: { tracks: 3740, analyzed: 3328, failed: 0, unreachable: 0, pending: 412 },
        job: null,
        held: false,
        can_start: true,
        can_stop: true,
      }),
    ),
    http.post('/api/library/dj/start', async ({ request }) => {
      started.push(await request.json());
      return HttpResponse.json({ success: true, job: null }, { status: 202 });
    }),
    http.post('/api/user-playlists', async ({ request }) => {
      made.push(await request.json());
      return HttpResponse.json({ id: 77, added: 3, duplicates: [], track_count: 3 });
    }),
  );
}

let playing: { id: string; title: string } | null = null;

function play(next: { id: string; title: string } | null) {
  playing = next;
  act(() => {
    window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'track' } }));
  });
}

function renderShell(initial = '/a') {
  const root = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <MixesPanelHost />
      </>
    ),
  });
  const page = (path: string, words: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>{words}</p> });
  const router = createRouter({
    routeTree: root.addChildren([
      page('/a', 'Page A'),
      page('/b', 'Page B'),
      page('/library', 'Library'),
    ]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const queryClient = createTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const panel = (title = 'Night Ferry') =>
  screen.findByRole('complementary', { name: `Mixes well with ${title}` });

beforeEach(() => {
  resetMixesForTests();
  window.localStorage.removeItem(FOLLOW_STORAGE_KEY);
  mixesAsked = [];
  started = [];
  made = [];
  playing = null;
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({ track: playing, kind: playing ? 'library' : null }),
  };
  window.showToast = vi.fn();
  window.playNext = vi.fn();
  serve();
});

afterEach(() => {
  cleanup();
  resetMixesForTests();
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
  delete window.openMirroredPlaylistModal;
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('Mixes well with, docked at the right', () => {
  it('shows the header, the wheel with the rule, Follow, the rows and the foot', async () => {
    renderShell();
    await screen.findByText('Page A');
    act(() => openMixes({ id: '1', title: 'Night Ferry' }));
    const aside = await panel();
    expect(within(aside).getByText('Mixes well with')).toBeTruthy();
    expect(within(aside).getByRole('heading', { level: 2, name: 'Night Ferry' })).toBeTruthy();
    await within(aside).findByText('Tidewater · 124 BPM · A minor');
    expect(
      within(aside).getByRole('group', { name: 'Camelot wheel: 8A, with 7A, 9A and 8B lit' }),
    ).toBeTruthy();
    expect(
      within(aside).getByText('Same key, one step round the wheel, or its relative major.'),
    ).toBeTruthy();
    expect(within(aside).getByText('Within 6% of 124 BPM, or half and double time.')).toBeTruthy();
    expect(within(aside).getByRole('checkbox', { name: "Follow what's playing" })).toBeChecked();
    const row = within(aside).getByText('Harbour Light').closest('li')!;
    expect(within(row).getByText('8A').getAttribute('data-key-hue')).toBe('0');
    expect(within(row).getByText('122')).toBeTruthy();
    expect(within(row).getByText('Same key · −1.6%')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Play Harbour Light next' }));
    expect(window.playNext).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
    expect(within(aside).getByText('2 tracks mix with it')).toBeTruthy();
    expect(within(aside).getByRole('button', { name: 'Make a playlist from these…' })).toBeTruthy();
    // the page column makes room (narrower than 1100px it lies over the page)
    expect(document.documentElement.dataset.mixesPanel).toBe('over');
  });

  it('stays open while you move between pages, and Close closes it', async () => {
    const router = renderShell();
    await screen.findByText('Page A');
    act(() => openMixes({ id: '1', title: 'Night Ferry' }));
    await panel();
    await act(() => router.navigate({ to: '/b' } as never));
    await screen.findByText('Page B');
    expect(await panel()).toBeTruthy();
    expect(mixesAsked.filter((id) => id === '1')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(document.documentElement.dataset.mixesPanel).toBeUndefined();
  });

  it('keeps its track for this tab, so a page load reopens it', async () => {
    act(() => openMixes({ id: '1', title: 'Night Ferry' }));
    expect(JSON.parse(window.sessionStorage.getItem(SEED_STORAGE_KEY)!)).toEqual({
      id: '1',
      title: 'Night Ferry',
    });
    vi.resetModules();
    const fresh = await import('./mixes-store');
    expect(fresh.getMixesState().seed).toEqual({ id: '1', title: 'Night Ferry' });
    act(() => closeMixes());
    expect(window.sessionStorage.getItem(SEED_STORAGE_KEY)).toBeNull();
  });

  it("sets Tracks' Key filter from a lit segment of the wheel", async () => {
    const router = renderShell();
    act(() => openMixes({ id: '1', title: 'Night Ferry' }));
    const aside = await panel();
    await within(aside).findByText('Harbour Light');
    fireEvent.click(within(aside).getByRole('button', { name: 'Show tracks in 9A' }));
    await screen.findByText('Library');
    expect(router.state.location.pathname).toBe('/library');
    expect(router.state.location.search).toMatchObject({ view: 'tracks', key: '9A' });
    expect(await panel()).toBeTruthy();
  });
});

describe("Follow what's playing", () => {
  it('re-seeds the panel when the player moves to another library track', async () => {
    playing = { id: '1', title: 'Night Ferry' };
    renderShell();
    act(() => openMixes({ id: '1', title: 'Night Ferry' }));
    await panel();
    play({ id: '2', title: 'Harbour Light' });
    const moved = await panel('Harbour Light');
    await within(moved).findByText('Pale Harbour · 122 BPM · A minor');
    // a stream SYNCHRO.S's library doesn't know leaves it where it is
    play({ id: '99', title: 'Somebody else’s song' });
    await waitFor(() => expect(mixesAsked).toContain('99'));
    expect(await panel('Harbour Light')).toBeTruthy();
    // a station isn't a track
    playing = { id: '1', title: 'FIP' };
    (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
      state: () => ({ track: playing, kind: 'radio' }),
    };
    act(() => {
      window.dispatchEvent(new CustomEvent('ss:player'));
    });
    expect(await panel('Harbour Light')).toBeTruthy();
  });

  it('stays on its track when switched off, and remembers that', async () => {
    renderShell();
    act(() => openMixes({ id: '1', title: 'Night Ferry' }));
    const aside = await panel();
    const follow = within(aside).getByRole('checkbox', { name: "Follow what's playing" });
    fireEvent.click(follow);
    await waitFor(() => expect(follow).not.toBeChecked());
    expect(window.localStorage.getItem(FOLLOW_STORAGE_KEY)).toBe('off');
    play({ id: '2', title: 'Harbour Light' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mixesAsked).not.toContain('2');
    expect(await panel()).toBeTruthy();
  });
});

describe('Make a playlist from these…', () => {
  it('asks the name, starts with the seed, and makes it through the playlist route', async () => {
    window.openMirroredPlaylistModal = vi.fn();
    renderShell();
    act(() => openMixes({ id: '1', title: 'Night Ferry' }));
    const aside = await panel();
    await within(aside).findByText('Harbour Light');
    fireEvent.click(within(aside).getByRole('button', { name: 'Make a playlist from these…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make a playlist from these' });
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Mixes with Night Ferry',
    );
    const start = within(dialog).getByRole('checkbox', { name: 'Start with Night Ferry' });
    expect(start).toBeChecked();
    fireEvent.click(start);
    await within(dialog).findByRole('button', { name: 'Make playlist (2)' });
    fireEvent.click(start);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Make playlist (3)' }));
    await waitFor(() => expect(made).toHaveLength(1));
    expect(made[0]).toEqual({
      name: 'Mixes with Night Ferry',
      tracks: [
        expect.objectContaining({ track_name: 'Night Ferry', artist_name: 'Tidewater' }),
        expect.objectContaining({ track_name: 'Harbour Light', artist_name: 'Pale Harbour' }),
        expect.objectContaining({ track_name: 'Static Bloom', artist_name: 'Saltmarsh' }),
      ],
    });
    await waitFor(() => expect(window.showToast).toHaveBeenCalled());
    const [words, tone, , opts] = vi.mocked(window.showToast!).mock.calls[0] as unknown as [
      string,
      string,
      unknown,
      { action?: { label: string; run: () => void } } | null,
    ];
    expect(words).toBe('Made Mixes with Night Ferry with 3 tracks');
    expect(tone).toBe('success');
    expect(opts?.action?.label).toBe('Open it');
    opts!.action!.run();
    expect(window.openMirroredPlaylistModal).toHaveBeenCalledWith(77);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe("the panel's states (17b)", () => {
  it('says a track isn’t analysed yet, and an admin can analyse it now', async () => {
    renderShell();
    act(() => openMixes({ id: '3', title: 'Glasshouse' }));
    const aside = await panel('Glasshouse');
    await within(aside).findByText(/It's in the queue \(412 left\)/);
    expect(aside.textContent).toContain(
      "SYNCHRO.S hasn't worked out this track's key yet. It's in the queue (412 left); analyse it now.",
    );
    fireEvent.click(within(aside).getByRole('button', { name: 'analyse it now' }));
    await within(aside).findByText(/Working it out now…/);
    expect(started).toEqual([{ track_id: '3' }]);
    expect(within(aside).queryByRole('button', { name: 'Make a playlist from these…' })).toBeNull();
  });

  it('says an uncertain key may not mix, outlines it, and widens to 10% when nothing matches', async () => {
    renderShell();
    act(() => openMixes({ id: '4', title: 'Saltwater Hymn' }));
    const aside = await panel('Saltwater Hymn');
    await within(aside).findByText(
      "Its key sounded like 8B, but SYNCHRO.S isn't sure, so these matches may not mix.",
    );
    expect(within(aside).getByText('Tidewater · 125 BPM · Maybe F major')).toBeTruthy();
    expect(aside.querySelector('[data-wheel-key="8B"] path')!.getAttribute('stroke')).toBeTruthy();
    expect(aside.textContent).toContain('Nothing in your library mixes with it within 6%.');
    fireEvent.click(within(aside).getByRole('button', { name: 'Widen to 10%' }));
    await within(aside).findByText('Static Bloom');
    expect(mixesAsked).toContain('4@10');
    expect(within(aside).getByText('Within 10% of 125 BPM, or half and double time.')).toBeTruthy();
  });

  it('says so when the track has left the library', async () => {
    renderShell();
    act(() => openMixes({ id: '404', title: 'Gone' }));
    const aside = await panel('Gone');
    await within(aside).findByText(/isn't in your library any more/);
  });
});

describe('on a phone (17d)', () => {
  it('is a sheet with the rows and Make a playlist, without the wheel', async () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      matches: query.includes('max-width: 768px'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    renderShell();
    act(() => openMixes({ id: '1', title: 'Night Ferry' }));
    const sheet = await screen.findByRole('dialog', { name: 'Mixes well with Night Ferry' });
    await within(sheet).findByText('Harbour Light');
    expect(within(sheet).queryByRole('group', { name: /Camelot wheel/ })).toBeNull();
    expect(within(sheet).getByText(/Same key · −1\.6%/)).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Make a playlist from these…' })).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.documentElement.dataset.mixesPanel).toBeUndefined();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
