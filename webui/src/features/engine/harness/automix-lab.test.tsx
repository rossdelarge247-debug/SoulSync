import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import { CUE_WHY_NOT } from '../outputs';
import AutomixLab from './automix-lab';

const track = (id: string, title: string, bpm: number, key: string) => ({
  id,
  title,
  artist_name: 'Saltmarsh',
  album_title: 'Lantern',
  artist_id: '1',
  album_id: '10',
  duration_ms: 240000,
  file_path: `/m/${id}.flac`,
  bitrate: 1000,
  image_url: null,
  dj: { bpm, key, analyzed: true },
});

describe('the auto-mix lab page', () => {
  it('finds two tracks, shows their plan, and says why a second output is impossible here', async () => {
    server.use(
      http.get('*/api/library/dj/browse', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q');
        const tracks =
          q === 'night'
            ? [track('1', 'Night Ferry', 124, '8A')]
            : [track('2', 'Static Bloom', 126, '9A')];
        return HttpResponse.json({
          tracks,
          total: 1,
          page: 1,
          limit: 8,
          has_more: false,
          sort: 'title',
        });
      }),
      http.get('*/api/library/dj/plan', ({ request }) => {
        const u = new URL(request.url);
        expect(u.searchParams.get('from')).toBe('1');
        expect(u.searchParams.get('to')).toBe('2');
        return HttpResponse.json({
          success: true,
          plan: {
            status: 'ok',
            style: 'long_blend',
            label: 'Long blend',
            bars: 32,
            chosen_by: 'auto',
            why: '8A → 9A, +2 BPM: the keys mix and the tempo is close',
            beatmatch: true,
            tempo: { relation: 'same', rate: 0.98413, speed_change_ok: true },
            out: { start: 154.951, bar: 80 },
            in: { start: 0.2, bar: 0 },
          },
        });
      }),
    );
    render(<AutomixLab />);
    expect(screen.getByRole('heading', { name: 'Auto-mix lab' })).toBeInTheDocument();
    expect(screen.getByText(CUE_WHY_NOT)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /On another output/ })).toBeDisabled();
    const play = screen.getByRole('button', { name: 'Play the mix' });
    expect(play).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find the outgoing track' }), {
      target: { value: 'night' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Night Ferry/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Find the incoming track' }), {
      target: { value: 'static' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Static Bloom/ }));
    expect(play).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Show the plan' }));
    await waitFor(() =>
      expect(screen.getByText(/the keys mix and the tempo is close/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/154.95 s \(bar 80\)/)).toBeInTheDocument();
  });
});
