import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Station } from '@/features/radio/radio.types';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

function station(id: string, name: string, over: Partial<Station> = {}): Station {
  return {
    id,
    name,
    kind: 'eclectic',
    kind_label: 'Eclectic tastemakers',
    genre: 'Eclectic',
    city: 'London',
    country: 'United Kingdom',
    logo_url: '',
    homepage: 'https://www.nts.live/',
    description: 'Live radio from London.',
    source: 'built_in',
    favourite: false,
    auto_add: false,
    has_now_playing: true,
    has_tracklists: true,
    quality: { codec: 'AAC', bitrate_kbps: 256, lossless: false, label: 'AAC 256 kbps' },
    tags: [],
    sends_titles: null,
    added_by: null,
    streams: [
      { id: 'aac', codec: 'AAC', bitrate_kbps: 256, lossless: false, label: 'AAC 256 kbps' },
    ],
    ...over,
  };
}

const NTS = station('nts-1', 'NTS 1', { favourite: true });
const RP = station('rp-main', 'Radio Paradise · Main Mix', {
  quality: { codec: 'FLAC', bitrate_kbps: 1000, lossless: true, label: 'FLAC lossless' },
});
const LINK = station('link-1', 'Lowlands Radio', {
  source: 'your_link',
  added_by: 'ross',
  has_tracklists: false,
});
const electronic = Array.from({ length: 6 }, (_, i) =>
  station(`e${i}`, `Electronic ${i}`, { kind: 'electronic' }),
);

function mockApi(opts: { modulesOff?: boolean; identification?: boolean; admin?: boolean } = {}) {
  const calls: string[] = [];
  server.use(
    http.get('/api/modules', () =>
      HttpResponse.json({
        success: true,
        modules: [
          {
            name: 'radio',
            display_name: 'Internet radio',
            enabled: !opts.modulesOff,
            pages: ['radio'],
          },
        ],
      }),
    ),
    http.get('/api/radio/stations', () => {
      calls.push('stations');
      return HttpResponse.json({
        success: true,
        favourites: [NTS, LINK],
        kinds: [
          { kind: 'electronic', label: 'Electronic', blurb: 'House, techno', stations: electronic },
          { kind: 'eclectic', label: 'Eclectic tastemakers', blurb: '', stations: [NTS, RP] },
        ],
        heard_count: 48,
        session: null,
        identification: opts.identification ?? true,
        is_admin: opts.admin ?? true,
      });
    }),
    http.get('/api/radio/stations/nts-1', () =>
      HttpResponse.json({
        success: true,
        station: NTS,
        now_playing: {
          station_id: 'nts-1',
          state: 'listening',
          track: null,
          playing: false,
          now: Date.now() / 1000,
        },
        session: null,
        heard_today: { identified: 14, not_identified: 3 },
        identification: opts.identification ?? true,
        is_admin: opts.admin ?? true,
        can_download: true,
      }),
    ),
    http.get('/api/radio/stations/nts-1/auto-add', () =>
      HttpResponse.json({
        success: true,
        enabled: false,
        identified_yesterday: 140,
        already_have: 31,
        would_add: 50,
        would_add_without_limit: 109,
        daily_limit: 50,
        added_today: 0,
        can_download: true,
        has_now_playing: true,
      }),
    ),
    http.put('/api/radio/stations/nts-1/auto-add', async ({ request }) => {
      const body = (await request.json()) as { enabled: boolean };
      calls.push(`auto-add:${body.enabled}`);
      return HttpResponse.json({
        success: true,
        enabled: body.enabled,
        identified_yesterday: 140,
        already_have: 31,
        would_add: 50,
        would_add_without_limit: 109,
        daily_limit: 50,
        added_today: 0,
        can_download: true,
        has_now_playing: true,
      });
    }),
    http.get('/api/radio/stations/nts-1/shows', () =>
      HttpResponse.json({
        success: true,
        publishes: true,
        shows: [
          {
            id: 'nts:flo/ep1',
            title: 'The Breakfast Show with Flo',
            aired_at: Date.now() / 1000 - 3600,
            ended_at: null,
            track_count: 18,
            missing_count: 11,
          },
        ],
      }),
    ),
    http.get('/api/radio/heard', ({ request }) => {
      const stationId = new URL(request.url).searchParams.get('station_id');
      const now = Math.floor(Date.now() / 1000);
      return HttpResponse.json({
        success: true,
        days: 7,
        keep_days: 90,
        counts: { total: 2, not_in_library: 1, identified: 2, not_identified: 0 },
        items: [
          {
            id: 1,
            heard_at: now - 60,
            station_id: stationId ?? 'nts-1',
            station_name: 'NTS 1',
            artist: 'Pale Harbour',
            title: 'Harbour Light',
            release: 'Lantern',
            source: 'station_feed',
            state: 'in_library',
            added_at: null,
            added_by_auto_add: false,
            duration_s: null,
            reason: null,
            below_target: false,
            track_id: '1',
          },
          {
            id: 2,
            heard_at: now - 600,
            station_id: stationId ?? 'nts-1',
            station_name: 'NTS 1',
            artist: 'Tidewater',
            title: 'Night Ferry (Dub)',
            release: null,
            source: 'stream_titles',
            state: 'not_added',
            added_at: null,
            added_by_auto_add: false,
            duration_s: null,
            reason: null,
            below_target: null,
            track_id: null,
          },
        ],
      });
    }),
    http.post('/api/radio/heard/2/want', () => {
      calls.push('want:2');
      return HttpResponse.json({ success: true, message: 'Added', skipped: false });
    }),
    http.get('/api/radio/directory', ({ request }) => {
      calls.push(`directory:${new URL(request.url).search}`);
      return HttpResponse.json({
        success: true,
        page: 1,
        total: 1,
        more: false,
        results: [
          station('rb-1', 'Ambient Sleeping Pill', {
            source: 'directory',
            country: 'United States',
            tags: ['ambient', 'sleep'],
            quality: { codec: 'FLAC', bitrate_kbps: 0, lossless: true, label: 'FLAC lossless' },
          }),
        ],
      });
    }),
    http.get('/api/radio/directory/countries', () =>
      HttpResponse.json({
        success: true,
        countries: [{ code: 'US', name: 'United States', stations: 9000 }],
      }),
    ),
    http.get('/api/radio/shows/*', () =>
      HttpResponse.json({
        success: true,
        show: {
          id: 'nts:flo/ep1',
          title: 'The Breakfast Show with Flo',
          aired_at: null,
          ended_at: null,
          station_id: 'nts-1',
          station_name: 'NTS 1',
          fetched_at: null,
          homepage: 'https://www.nts.live/',
        },
        tracks: [
          {
            position: 1,
            time: null,
            artist: 'Saltmarsh',
            title: 'Static Bloom',
            release: null,
            state: 'in_library',
            below_target: false,
            track_id: '1',
          },
          {
            position: 2,
            time: null,
            artist: 'Marrow Field',
            title: 'Glasshouse',
            release: null,
            state: 'not_added',
            below_target: null,
            track_id: null,
          },
          {
            position: 3,
            time: null,
            artist: null,
            title: 'Untitled (white label)',
            release: null,
            state: 'cant_match',
            below_target: null,
            track_id: null,
          },
        ],
      }),
    ),
    http.post('/api/radio/links/check', () =>
      HttpResponse.json({
        success: true,
        ok: false,
        error: "This link isn't an audio stream. The address answered with a web page.",
        codec: '',
        bitrate_kbps: 0,
        sends_titles: false,
        allows_direct: false,
        answered_in_s: null,
      }),
    ),
  );
  return calls;
}

function renderAt(path: string, admin = true) {
  window.SoulSyncWebShellBridge = createShellBridge({
    getCurrentProfileContext: vi.fn(() => ({ profileId: admin ? 1 : 3, isAdmin: admin })),
  });
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, queryClient });
  return render(<AppRouterProvider router={router} queryClient={queryClient} />);
}

describe('the Radio pages', () => {
  const play = vi.fn(async () => undefined);
  beforeEach(() => {
    window.showToast = vi.fn();
    window.SoulSyncRadio = {
      state: () => ({
        status: 'idle',
        station: null,
        sessionId: null,
        mode: null,
        stream: null,
        nowPlaying: null,
        error: null,
        skew: 0,
        adding: false,
      }),
      play,
      stop: vi.fn(),
      retry: vi.fn(),
      addToWanted: vi.fn(async () => true),
      refresh: vi.fn(),
    };
  });
  afterEach(() => {
    window.SoulSyncWebShellBridge = undefined;
    window.SoulSyncRadio = undefined;
    window.showToast = undefined;
    play.mockClear();
  });

  it('lays out Favourites (with your links) then the kinds four at a time', async () => {
    mockApi();
    renderAt('/radio');
    expect(await screen.findByRole('heading', { level: 1, name: 'Radio' })).toBeInTheDocument();
    const favourites = screen.getByRole('region', { name: 'Favourites' });
    expect(within(favourites).getByText('Your link · added by ross')).toBeInTheDocument();
    const electronicRow = screen.getByRole('region', { name: /Electronic/ });
    expect(within(electronicRow).getAllByTestId('station-card')).toHaveLength(4);
    fireEvent.click(within(electronicRow).getByRole('button', { name: 'All 6' }));
    expect(within(electronicRow).getAllByTestId('station-card')).toHaveLength(6);
    // FLAC is a success tag on the card
    expect(screen.getAllByText('FLAC')[0]).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Heard on radio/ })).toHaveTextContent('48');
  });

  it('Play hands the station to the player’s radio session', async () => {
    mockApi();
    renderAt('/radio');
    fireEvent.click(await screen.findByRole('button', { name: 'Play Radio Paradise · Main Mix' }));
    expect(play).toHaveBeenCalledWith(
      'rp-main',
      expect.objectContaining({ station: expect.anything() }),
    );
  });

  it('says identification is off, with Settings for admins', async () => {
    mockApi({ identification: false });
    renderAt('/radio');
    expect(await screen.findByText('Track identification is off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Settings → Radio' })).toBeInTheDocument();
  });

  it('shows the turned-off module instead of the page', async () => {
    const calls = mockApi({ modulesOff: true });
    renderAt('/radio');
    expect(await screen.findByText(/Internet radio is turned off/i)).toBeInTheDocument();
    expect(calls).not.toContain('stations');
  });

  it('the Heard tab lists every station and adds to Wanted', async () => {
    const calls = mockApi();
    renderAt('/radio?tab=heard');
    const rows = await screen.findAllByTestId('heard-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('In your library')).toBeInTheDocument();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Add to Wanted' }));
    await waitFor(() => expect(calls).toContain('want:2'));
  });

  it('a station: Now playing, auto-add asks first with the numbers, shows with tracklists', async () => {
    const calls = mockApi();
    renderAt('/radio/station/nts-1');
    expect(await screen.findByRole('heading', { level: 1, name: 'NTS 1' })).toBeInTheDocument();
    expect(screen.getByText('Not playing')).toBeInTheDocument();
    expect(await screen.findByText('The Breakfast Show with Flo')).toBeInTheDocument();
    const sw = await screen.findByRole('switch', { name: /Auto-add what NTS 1 plays to Wanted/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Add everything NTS 1 plays to Wanted?')).toBeInTheDocument();
    expect(within(dialog).getByText('140')).toBeInTheDocument();
    expect(within(dialog).getByText('of 109, at the daily limit')).toBeInTheDocument();
    expect(calls).not.toContain('auto-add:true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on auto-add for NTS 1' }));
    await waitFor(() => expect(calls).toContain('auto-add:true'));
  });

  it('the tracklist: Add the N you don’t have, and Can’t be matched rows', async () => {
    mockApi();
    renderAt('/radio/tracklist?show=nts%3Aflo%2Fep1');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'The Breakfast Show with Flo' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add the 1 you don’t have to Wanted' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Can’t be matched')).toBeInTheDocument();
    expect(screen.getByText('No artist to search for')).toBeInTheDocument();
  });

  it('directory search: codec buttons and quality on every row', async () => {
    const calls = mockApi();
    renderAt('/radio/search?q=ambient');
    expect(await screen.findByText('Ambient Sleeping Pill')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'FLAC' }));
    await waitFor(() => expect(calls.some((c) => c.includes('codec=FLAC'))).toBe(true));
    expect(
      screen.getByRole('button', { name: 'Add Ambient Sleeping Pill to Favourites' }),
    ).toBeInTheDocument();
  });

  it('the admin’s Add a stream link refuses a web page and keeps Add disabled with the reason', async () => {
    mockApi();
    renderAt('/radio?add=link');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Stream link'), {
      target: { value: 'https://www.example.org/listen' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check' }));
    expect(await within(dialog).findByText("This link isn't an audio stream")).toBeInTheDocument();
    expect(within(dialog).getByText('Check a working link to add it.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add station' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('members don’t get Add a stream link', async () => {
    mockApi({ admin: false });
    renderAt('/radio', false);
    await screen.findByRole('heading', { level: 1, name: 'Radio' });
    expect(screen.queryByRole('button', { name: 'Add a stream link' })).toBeNull();
  });
  it('tags a station without a now-playing feed "Identified while you listen" (HANDOFF 53)', async () => {
    mockApi();
    const quiet = station('link-2', 'Cashmere Radio', { has_now_playing: false });
    server.use(
      http.get('/api/radio/stations', () =>
        HttpResponse.json({
          success: true,
          favourites: [NTS, quiet],
          kinds: [],
          heard_count: 0,
          session: null,
          identification: true,
          is_admin: true,
        }),
      ),
    );
    renderAt('/radio');
    const favourites = await screen.findByRole('region', { name: 'Favourites' });
    const cards = within(favourites).getAllByTestId('station-card');
    expect(within(cards[1]!).getByText('Identified while you listen')).toBeInTheDocument();
    // a station with a feed doesn't carry it
    expect(within(cards[0]!).queryByText('Identified while you listen')).toBeNull();
  });

  it('the auto-add card’s heading carries the same tag, and the sentence stays', async () => {
    mockApi();
    server.use(
      http.get('/api/radio/stations/nts-1', () =>
        HttpResponse.json({
          success: true,
          station: { ...NTS, has_now_playing: false },
          now_playing: null,
          session: null,
          heard_today: { identified: 0, not_identified: 0 },
          identification: true,
          is_admin: true,
          can_download: true,
        }),
      ),
    );
    renderAt('/radio/station/nts-1');
    const title = await screen.findByRole('heading', {
      level: 2,
      name: 'Auto-add what NTS 1 plays to Wanted',
    });
    expect(
      within(title.parentElement!).getByText('Identified while you listen'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        /This station has no now-playing feed, so it adds only while someone listens\./,
      ),
    ).toBeInTheDocument();
  });

  it('points to nts.live while there are no tracklists yet (HANDOFF 56)', async () => {
    mockApi();
    server.use(
      http.get('/api/radio/stations/nts-1/shows', () =>
        HttpResponse.json({ success: true, publishes: true, shows: [] }),
      ),
    );
    renderAt('/radio/station/nts-1');
    const link = await screen.findByRole('link', { name: 'nts.live' });
    expect(link).toHaveAttribute('href', 'https://www.nts.live');
    expect(link.parentElement).toHaveTextContent(
      'No tracklists yet. They appear after SYNCHRO.S sees a show on NTS live. Until then, nts.live has them.',
    );
  });
});
