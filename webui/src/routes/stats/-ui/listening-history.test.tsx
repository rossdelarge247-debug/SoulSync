/**
 * Library → Listening history's Kind filter (HANDOFF 46): Music by default,
 * Podcasts and Audiobooks from this profile's plays of them.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import { ListeningHistory } from './listening-history';

afterEach(() => {
  cleanup();
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
});

function renderHistory(withAudiobook = false) {
  const seen: string[] = [];
  server.use(
    http.get('/api/player/plays', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind') ?? '';
      seen.push(kind);
      if (kind === 'audiobook')
        return HttpResponse.json({
          success: true,
          items: withAudiobook
            ? [
                {
                  play_id: 2,
                  kind: 'audiobook',
                  media_id: 'book-1',
                  title: 'The Long Shore',
                  subtitle: 'Tide Lines',
                  src: 'https://cdn.example/sample.mp3',
                  duration_s: 240,
                  played_at: '2026-10-22 11:57:00',
                  position_s: 60,
                  finished: false,
                },
              ]
            : [],
        });
      return HttpResponse.json({
        success: true,
        items: [
          {
            play_id: 1,
            kind: 'podcast',
            media_id: 'guid-12',
            title: 'Episode 12',
            subtitle: 'Quiet Rooms',
            src: 'https://cdn.example/ep12.mp3',
            duration_s: 1800,
            played_at: '2026-10-22 11:57:00',
            position_s: 420,
            finished: false,
          },
        ],
      });
    }),
  );
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ListeningHistory
        music={[
          { title: 'Harbour Light', artist: 'Pale Harbour', played_at: '2026-10-22 11:00:00' },
        ]}
        formatPlayedAt={() => '1h ago'}
        renderMusic={(tracks) => <p>{tracks.map((t) => t.title).join(', ')}</p>}
      />
    </QueryClientProvider>,
  );
  return seen;
}

describe('Listening history', () => {
  it('shows music by default, with Music selected', () => {
    const seen = renderHistory();
    expect(screen.getByRole('group', { name: 'Kind' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Music' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Podcasts' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText('Harbour Light')).toBeInTheDocument();
    expect(seen).toEqual([]);
  });

  it('Podcasts lists the profile’s episodes with where each got to, and plays from there', async () => {
    const playMedia = vi.fn(async () => ({}));
    (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = { playMedia };
    const seen = renderHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Podcasts' }));
    expect(await screen.findByText('Episode 12')).toBeInTheDocument();
    expect(screen.getByText('Quiet Rooms · 23 min left')).toBeInTheDocument();
    expect(screen.queryByText('Harbour Light')).toBeNull();
    expect(seen).toEqual(['podcast']);
    fireEvent.click(screen.getByRole('button', { name: 'Play Episode 12' }));
    expect(playMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'podcast',
        id: 'guid-12',
        src: 'https://cdn.example/ep12.mp3',
      }),
    );
  });

  it('says "sample" in an audiobook’s meta line (HANDOFF 67)', async () => {
    renderHistory(true);
    fireEvent.click(screen.getByRole('button', { name: 'Audiobooks' }));
    expect(await screen.findByText('The Long Shore')).toBeInTheDocument();
    expect(screen.getByText('Tide Lines · sample · 3 min left')).toBeInTheDocument();
  });

  it('says so when there are no audiobooks yet', async () => {
    renderHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Audiobooks' }));
    expect(await screen.findByText(/No audiobooks played yet/)).toBeInTheDocument();
  });
});
