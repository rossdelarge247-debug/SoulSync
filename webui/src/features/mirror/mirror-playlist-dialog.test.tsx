import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import type { MirrorCandidate } from './mirror.model';

import { MirrorPlaylistDialog } from './mirror-playlist-dialog';

const PLAYLISTS = [
  { id: 'p1', name: 'Coastal evenings', owner: 'Ross', track_count: 3 },
  { id: 'p2', name: 'Night drives', owner: 'Ross', track_count: 2 },
  { id: 'p3', name: 'Discover Weekly', owner: 'Spotify', track_count: 30 },
];

const TRACKS = {
  p1: ['Harbour Light', 'Slack Water', 'Lantern Room'],
  p2: ['Ferry Lights', 'Undertow'],
} as Record<string, string[]>;

const PRESETS = {
  success: true,
  total: 100,
  unknown_format: 0,
  presets: [],
  current: { preset: 'flac', name: 'FLAC or better', updated_at: 1, targets: [] },
};

interface Calls {
  mirrored: unknown[];
  automations: unknown[];
  runs: string[];
}

/** The routes the dialog uses; each test overrides the one it is about. */
function routes(): Calls {
  const calls: Calls = { mirrored: [], automations: [], runs: [] };
  server.use(
    http.get('/api/spotify/playlists', () => HttpResponse.json(PLAYLISTS)),
    http.get('/api/mirrored-playlists', () =>
      HttpResponse.json([{ id: 9, source: 'spotify', source_playlist_id: 'p3', name: 'DW' }]),
    ),
    http.get('/api/quality/presets', () => HttpResponse.json(PRESETS)),
    http.get('/api/spotify/playlist/:id', ({ params }) =>
      HttpResponse.json({
        name: PLAYLISTS.find((p) => p.id === params.id)?.name,
        owner: 'Ross',
        tracks: (TRACKS[String(params.id)] ?? []).map((name, i) => ({
          id: `${String(params.id)}-${i}`,
          name,
          artists: [{ name: 'Pale Harbour' }],
          album: { name: 'Tidewater' },
          duration_ms: 200_000,
        })),
      }),
    ),
    // the first track is in the library, the second already on Wanted
    http.post('/api/enhanced-search/library-check', async ({ request }) => {
      const body = (await request.json()) as { tracks: unknown[] };
      return HttpResponse.json({
        albums: [],
        tracks: body.tracks.map((_, i) => ({
          in_library: i === 0,
          in_wishlist: i === 1,
        })),
      });
    }),
    http.post('/api/mirror-playlist', async ({ request }) => {
      calls.mirrored.push(await request.json());
      return HttpResponse.json({ success: true, playlist_id: 42 });
    }),
    http.post('/api/automations', async ({ request }) => {
      calls.automations.push(await request.json());
      return HttpResponse.json({ success: true, id: 5 });
    }),
    http.post('/api/mirrored-playlists/:id/pipeline/run', ({ params }) => {
      calls.runs.push(String(params.id));
      return HttpResponse.json({ success: true });
    }),
  );
  return calls;
}

function renderDialog(
  props: Partial<{
    initial: MirrorCandidate | null;
    onClose: () => void;
    onMirrored: () => void;
  }> = {},
) {
  const onClose = props.onClose ?? vi.fn();
  const queryClient = createTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MirrorPlaylistDialog
        open
        onClose={onClose}
        initial={props.initial}
        onMirrored={props.onMirrored}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

/** The first answer can take a while on a busy machine; later steps are quick. */
const SLOW = { timeout: 5000 };

const dialog = () => screen.getByRole('dialog');
const primary = (name: RegExp | string) => within(dialog()).getByRole('button', { name });

beforeEach(() => {
  window.showToast = vi.fn();
});

afterEach(() => {
  cleanup();
  delete window.showToast;
});

describe('Mirror a playlist: choosing', () => {
  it('lists your Spotify playlists and disables the one already mirrored', async () => {
    routes();
    renderDialog();

    expect(await screen.findByText('Coastal evenings', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getAllByText('Spotify connected').length).toBeGreaterThan(0);
    const rows = screen.getAllByTestId('mirror-row');
    expect(rows).toHaveLength(3);
    const discover = rows[2];
    expect(within(discover).getByRole('radio')).toBeDisabled();
    expect(within(discover).getAllByText('Already mirrored').length).toBeGreaterThan(0);
    // nothing chosen yet: the primary says why it can't go
    expect(primary('Mirror')).toHaveAttribute('aria-disabled', 'true');
  });

  it('narrows the list as you type', async () => {
    routes();
    renderDialog();
    await screen.findByText('Coastal evenings', undefined, SLOW);

    fireEvent.change(screen.getByRole('textbox', { name: 'Find a playlist' }), {
      target: { value: 'night' },
    });
    expect(screen.getAllByTestId('mirror-row')).toHaveLength(1);
    expect(screen.getByText('Night drives')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Find a playlist' }), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('None of your playlists match “zzz”.')).toBeInTheDocument();
  });

  it('counts what you have once a playlist is picked, and names it on the primary', async () => {
    routes();
    renderDialog();
    await screen.findByText('Coastal evenings', undefined, SLOW);

    fireEvent.click(within(screen.getAllByTestId('mirror-row')[0]).getByRole('radio'));

    // 3 tracks: 1 in the library, 1 on Wanted, so 1 goes to Wanted
    const line = await screen.findByTestId('mirror-consequence');
    await waitFor(() =>
      expect(line).toHaveTextContent(
        '1 track will be added to Wanted at FLAC or better, your quality target, and SoulSync starts looking for it now. 1 more track is on Wanted already.',
      ),
    );
    expect(screen.getAllByText('You have 1').length).toBeGreaterThan(0);
    expect(primary('Mirror "Coastal evenings"')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('says nothing goes to Wanted when Keep it in sync is off', async () => {
    routes();
    renderDialog();
    await screen.findByText('Coastal evenings', undefined, SLOW);
    fireEvent.click(within(screen.getAllByTestId('mirror-row')[1]).getByRole('radio'));
    await screen.findByTestId('mirror-consequence');

    fireEvent.click(screen.getByRole('switch', { name: 'Keep it in sync' }));
    expect(screen.getByTestId('mirror-consequence')).toHaveTextContent(
      'Saved to Mirrored playlists only. Nothing goes to Wanted until you run it from there.',
    );
  });
});

describe('Mirror a playlist: submitting', () => {
  async function pickFirst() {
    await screen.findByText('Coastal evenings', undefined, SLOW);
    fireEvent.click(within(screen.getAllByTestId('mirror-row')[0]).getByRole('radio'));
    await waitFor(() =>
      expect(screen.getByTestId('mirror-consequence')).toHaveTextContent('will be added'),
    );
  }

  it('mirrors, schedules the 24-hour check and starts the first one', async () => {
    const calls = routes();
    const onMirrored = vi.fn();
    const { onClose } = renderDialog({ onMirrored });
    await pickFirst();

    fireEvent.click(primary('Mirror "Coastal evenings"'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.mirrored).toHaveLength(1);
    expect(calls.mirrored[0]).toMatchObject({
      source: 'spotify',
      source_playlist_id: 'p1',
      name: 'Coastal evenings',
    });
    expect(calls.automations).toHaveLength(1);
    expect(calls.automations[0]).toMatchObject({
      name: 'Auto-Sync: Coastal evenings',
      trigger_type: 'schedule',
      trigger_config: { interval: 24, unit: 'hours' },
      owned_by: 'auto_sync',
    });
    expect(calls.runs).toEqual(['42']);
    expect(onMirrored).toHaveBeenCalledWith(42);
    expect(window.showToast).toHaveBeenCalledWith(
      'Mirrored "Coastal evenings". SoulSync is checking it now.',
      'success',
    );
  });

  it('only saves the mirror when Keep it in sync is off', async () => {
    const calls = routes();
    const { onClose } = renderDialog();
    await pickFirst();
    fireEvent.click(screen.getByRole('switch', { name: 'Keep it in sync' }));

    fireEvent.click(primary('Mirror "Coastal evenings"'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.mirrored).toHaveLength(1);
    expect(calls.automations).toHaveLength(0);
    expect(calls.runs).toHaveLength(0);
  });

  it('keeps the mirror when the first check is refused (409), and retries only the check', async () => {
    const calls = routes();
    let busy = true;
    server.use(
      http.post('/api/mirrored-playlists/:id/pipeline/run', ({ params }) => {
        calls.runs.push(String(params.id));
        return busy
          ? HttpResponse.json({ error: 'A pipeline is already running' }, { status: 409 })
          : HttpResponse.json({ success: true });
      }),
    );
    const { onClose } = renderDialog();
    await pickFirst();

    fireEvent.click(primary('Mirror "Coastal evenings"'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      '"Coastal evenings" is mirrored, but its first check is waiting',
    );
    expect(alert).toHaveTextContent('only one check runs at a time');
    expect(onClose).not.toHaveBeenCalled();
    // the other button closes now: the mirror is saved either way
    expect(within(dialog()).getByRole('button', { name: 'Close' })).toBeInTheDocument();

    busy = false;
    fireEvent.click(primary('Start the first check again'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // saved and scheduled once; the check asked twice
    expect(calls.mirrored).toHaveLength(1);
    expect(calls.automations).toHaveLength(1);
    expect(calls.runs).toEqual(['42', '42']);
  });

  it('says nothing was saved when the mirror itself fails', async () => {
    routes();
    server.use(
      http.post('/api/mirror-playlist', () =>
        HttpResponse.json({ success: false, error: 'The database is locked.' }, { status: 500 }),
      ),
    );
    const { onClose } = renderDialog();
    await pickFirst();

    fireEvent.click(primary('Mirror "Coastal evenings"'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That didn’t go through');
    expect(alert).toHaveTextContent('Nothing was saved.');
    expect(onClose).not.toHaveBeenCalled();
    // the same primary tries again
    expect(primary('Mirror "Coastal evenings"')).toBeInTheDocument();
  });

  it('retries the schedule, not the mirror, when the schedule fails', async () => {
    const calls = routes();
    server.use(
      http.post('/api/automations', () => HttpResponse.json({ error: 'Nope.' }, { status: 500 })),
    );
    renderDialog();
    await pickFirst();

    fireEvent.click(primary('Mirror "Coastal evenings"'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"Coastal evenings" is mirrored, but its schedule wasn’t saved',
    );
    expect(primary('Save the schedule again')).toBeInTheDocument();
    expect(calls.mirrored).toHaveLength(1);
  });
});

describe('Mirror a playlist: links and search results', () => {
  it('opens on a playlist handed over from Search', async () => {
    routes();
    renderDialog({
      initial: {
        source: 'spotify',
        id: 'p2',
        name: 'Night drives',
        link: 'https://open.spotify.com/playlist/p2',
      },
    });

    const rows = await screen.findAllByTestId('mirror-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByRole('radio')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Paste a link' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() =>
      expect(primary('Mirror "Night drives"')).not.toHaveAttribute('aria-disabled', 'true'),
    );
  });

  it('only offers a link when Spotify is not connected, and says why a link was refused', async () => {
    routes();
    server.use(
      http.get('/api/spotify/playlists', () => HttpResponse.json({ error: 'no' }, { status: 401 })),
    );
    renderDialog();

    expect((await screen.findAllByText('Spotify isn’t connected')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Your Spotify playlists/ })).toBeNull();
    const input = screen.getByLabelText('Playlist link');
    fireEvent.change(input, { target: { value: 'https://open.spotify.com/playlist/abc' } });
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Read link' }));
    });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getByText(/Spotify isn’t connected, so this dialog can’t read that link/),
    ).toBeInTheDocument();
  });

  it('says so when Spotify does not answer', async () => {
    routes();
    server.use(http.get('/api/spotify/playlists', () => HttpResponse.json({}, { status: 500 })));
    renderDialog();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load your Spotify playlists',
    );
  });
});
