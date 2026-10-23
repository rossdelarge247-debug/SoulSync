import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

import { HISTORY_RANGE_KEY, type MusicPlay } from '../-library.history';

/**
 * Library → Listening history (13a, 13b) through the real router: Kind and
 * Range drive the requests, the rows carry the board's meta line, tag and
 * actions. Stamps are fixed strings and the clock is fixed per test; the suite
 * runs in America/Los_Angeles, so 21:02 UTC is 14:02.
 */

function play(over: Partial<MusicPlay> & { id: number; title: string }): MusicPlay {
  return {
    kind: 'music',
    played_at: '2026-10-23 21:02:00',
    day: '2026-10-23',
    artist: 'Saltmarsh',
    album: 'Lantern',
    track_id: String(over.id),
    artist_id: 'ar1',
    album_id: 'al1',
    file_path: '/m/x.flac',
    bitrate: 2304,
    format: 'FLAC 24/96',
    below_target: false,
    length_s: 276,
    image_url: null,
    in_library: true,
    was_in_library: false,
    server_source: 'soulsync_web',
    player_name: null,
    heard_on: null,
    ...over,
  };
}

const MUSIC = {
  success: true,
  items: [
    play({ id: 1, title: 'Static Bloom' }),
    play({
      id: 2,
      title: 'Night Ferry (Dub)',
      played_at: '2026-10-23 20:51:00',
      artist: 'Tidewater',
      album: 'single',
      album_id: null,
      format: 'MP3 320',
      below_target: true,
      length_s: 372,
    }),
    play({
      id: 3,
      title: 'Glasshouse',
      played_at: '2026-10-23 18:20:00',
      server_source: 'plex',
      player_name: 'Living room',
      artist: 'Marrow Field',
      album: 'Glasshouse EP',
    }),
    play({
      id: 4,
      title: 'Orchard Sodium',
      played_at: '2026-10-23 04:40:00',
      day: '2026-10-22',
      artist: 'The Quiet Rooms',
      album: '',
      track_id: null,
      artist_id: null,
      album_id: null,
      file_path: null,
      format: null,
      in_library: false,
      was_in_library: true,
    }),
  ],
  total: 412,
  offset: 0,
  days: { '2026-10-23': 31, '2026-10-22': 58 },
  sources: ['soulsync_web', 'plex'],
  shared_with: 0,
};

const PODCASTS = {
  success: true,
  items: [
    {
      play_id: 10,
      kind: 'podcast',
      media_id: 'g48',
      title: 'Episode 48: Rooms within rooms',
      subtitle: 'Quiet Rooms',
      src: 'https://cdn.example/48.mp3',
      duration_s: 1800,
      position_s: 420,
      finished: false,
      played_at: '2026-10-23 15:40:00',
      day: '2026-10-23',
    },
    {
      play_id: 11,
      kind: 'podcast',
      media_id: 'g47',
      title: 'Episode 47: The long hallway',
      subtitle: 'Quiet Rooms',
      src: 'https://cdn.example/47.mp3',
      duration_s: 1800,
      position_s: 1790,
      finished: true,
      played_at: '2026-10-23 05:10:00',
      day: '2026-10-22',
    },
  ],
  total: 6,
  offset: 0,
  days: { '2026-10-23': 1, '2026-10-22': 1 },
};

const COUNTS = {
  success: true,
  counts: {
    music: { today: 31, '7d': 412, '30d': 900, all: 1204 },
    podcast: { today: 1, '7d': 6, '30d': 20, all: 38 },
    audiobook: { today: 0, '7d': 0, '30d': 1, all: 4 },
  },
};

let requested: string[] = [];
let empty = false;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T22:00:00Z'));
  window.SoulSyncWebShellBridge = createShellBridge();
  window.showLibraryDownloadsSection = vi.fn();
  window.showToast = vi.fn();
  window.playNext = vi.fn();
  window.startLibraryRadio = vi.fn(async () => undefined);
  requested = [];
  empty = false;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      const u = new URL(url, 'http://x');
      let body: unknown = {};
      if (u.pathname.endsWith('/api/library/listening-history/counts')) body = COUNTS;
      else if (u.pathname.endsWith('/api/library/listening-history'))
        body = empty ? { ...MUSIC, items: [], total: 0, days: {}, sources: [] } : MUSIC;
      else if (u.pathname.endsWith('/api/player/plays')) body = PODCASTS;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.SoulSyncWebShellBridge;
  delete window.showLibraryDownloadsSection;
  delete window.playNext;
});

function renderPage(entry = '/library?view=history') {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createAppRouter({ history, queryClient });
  return { router, ...render(<AppRouterProvider router={router} queryClient={queryClient} />) };
}

const calls = (path: string) =>
  requested.filter((u) => new URL(u, 'http://x').pathname.endsWith(path));
const lastParams = (path: string) => new URL(calls(path).at(-1)!, 'http://x').searchParams;

describe('Listening history (13a)', () => {
  it('shows the header, Kind with counts, Range on 7 days and the meta line', async () => {
    renderPage();
    await screen.findByText('Static Bloom');
    expect(screen.getByRole('heading', { level: 1, name: 'Listening history' })).toBeTruthy();
    expect(screen.getByText(/Music here feeds Stats and scrobbling/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Stats' }).getAttribute('href')).toBe('/stats');
    const kind = screen.getByRole('group', { name: 'Kind' });
    expect(
      within(kind)
        .getByRole('button', { name: /Music\s*1,204/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(kind).getByRole('button', { name: /Podcasts\s*38/ })).toBeTruthy();
    const range = screen.getByRole('group', { name: 'Range' });
    expect(within(range).getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(
      screen.getByText(
        "412 plays in the last 7 days · from SYNCHRO.S's player and Plex · yours only",
      ),
    ).toBeTruthy();
    const params = lastParams('/api/library/listening-history');
    expect(params.get('range')).toBe('7d');
    expect(params.get('tz')).toBe(String(new Date().getTimezoneOffset()));
  });

  it('groups by day with the whole day count and draws each row as the board does', async () => {
    renderPage();
    await screen.findByText('Static Bloom');
    expect(screen.getByText('Today · Friday 23 October')).toBeTruthy();
    expect(screen.getByText('· 31 plays')).toBeTruthy();
    expect(screen.getByText('Yesterday · Thursday 22 October')).toBeTruthy();
    const row = (title: string) => screen.getByText(title).closest('li')!;
    const bloom = row('Static Bloom');
    expect(within(bloom).getByText('14:02')).toBeTruthy();
    expect(within(bloom).getByRole('link', { name: 'Saltmarsh' }).getAttribute('href')).toBe(
      '/artist-detail/library/ar1',
    );
    expect(within(bloom).getByRole('link', { name: 'Lantern' }).getAttribute('href')).toBe(
      '/artist-detail/library/ar1?album=al1',
    );
    expect(bloom.textContent).toContain('FLAC 24/96 · 4:36');
    expect(within(bloom).queryByText('Below your target')).toBeNull();
    // below your target: the warning tag and the format in the warning colour
    const ferry = row('Night Ferry (Dub)');
    expect(within(ferry).getByText('Below your target')).toBeTruthy();
    expect(within(ferry).getByText('MP3 320').className).toMatch(/below/);
    // the source phrase only when the play wasn't here
    expect(row('Glasshouse').textContent).toContain('on Plex, Living room');
    expect(bloom.textContent).not.toContain('on ');
    // a track that left the library: faded, its words, no Play
    const gone = row('Orchard Sodium');
    expect(gone.getAttribute('data-gone')).toBe('true');
    expect(gone.textContent).toContain('The Quiet Rooms · no longer in your library');
    expect(within(gone).queryByRole('button', { name: /Play/ })).toBeNull();
    expect(screen.getByText('4 of 412')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show 50 more' })).toBeTruthy();
  });

  it('Play queues the track after the current one', async () => {
    renderPage();
    await screen.findByText('Static Bloom');
    fireEvent.click(screen.getByRole('button', { name: 'Play Static Bloom next' }));
    expect(window.playNext).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', title: 'Static Bloom', file_path: '/m/x.flac' }),
    );
    expect(screen.getByRole('button', { name: 'More for Static Bloom' })).toBeTruthy();
  });

  it('remembers the range and sends the filter', async () => {
    renderPage();
    await screen.findByText('Static Bloom');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() =>
      expect(lastParams('/api/library/listening-history').get('range')).toBe('30d'),
    );
    expect(localStorage.getItem(HISTORY_RANGE_KEY)).toBe('30d');
    fireEvent.change(screen.getByLabelText('Filter what you played'), {
      target: { value: 'lantern' },
    });
    await waitFor(
      () => expect(lastParams('/api/library/listening-history').get('q')).toBe('lantern'),
      {
        timeout: 2000,
      },
    );
  });

  it('opens on the remembered range', async () => {
    localStorage.setItem(HISTORY_RANGE_KEY, 'today');
    renderPage();
    await screen.findByText('Static Bloom');
    expect(lastParams('/api/library/listening-history').get('range')).toBe('today');
  });

  it('says so when nothing was played, with a wider range and Shuffle', async () => {
    empty = true;
    renderPage();
    await screen.findByText('Nothing played in the last 7 days');
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle your library' }));
    expect(window.startLibraryRadio).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try 30 days' }));
    await waitFor(() =>
      expect(lastParams('/api/library/listening-history').get('range')).toBe('30d'),
    );
  });
});

describe('Podcasts and Audiobooks', () => {
  it('reads /api/player/plays with the range, and offers Resume or a ghost Play', async () => {
    renderPage('/library?view=history&kind=podcast');
    await screen.findByText('Episode 48: Rooms within rooms');
    const params = lastParams('/api/player/plays');
    expect(params.get('kind')).toBe('podcast');
    expect(params.get('range')).toBe('7d');
    expect(screen.getByText('6 episodes in the last 7 days · kept apart from Stats')).toBeTruthy();
    const resume = screen.getByRole('button', {
      name: 'Resume Episode 48: Rooms within rooms, 23 min left',
    });
    expect(resume.className).toMatch(/play/);
    expect(screen.getByText('23 min left').className).toMatch(/progress/);
    const again = screen.getByRole('button', { name: 'Play Episode 47: The long hallway again' });
    expect(again.className).toMatch(/ghostPlay/);
    expect(screen.getByText('Finished')).toBeTruthy();
  });
});
