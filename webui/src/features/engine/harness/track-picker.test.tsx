/**
 * The lab's track pickers (Ross, 27 October): one a deck, picking from the
 * queue, recent plays, starred tracks, a set or a playlist, Mixes well with
 * the outgoing track (the incoming deck), or search; every row with its BPM,
 * key and analysis state.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DjTrack } from '@/features/dj/dj.api';

import { analysisStore, resetAnalysisRequests } from '@/features/dj/analysis.api';
import { HttpResponse, http, server } from '@/test/msw';

import { TrackPicker } from './track-picker';

const dj = (bpm: number, key: string, analyzed = true) => ({
  bpm,
  bpm_source: 'analysis',
  key,
  key_name: null,
  key_long: null,
  key_source: 'analysis',
  key_confidence: 0.9,
  key_uncertain: false,
  energy: 6,
  analyzed,
});

const track = (id: string, title: string, info: ReturnType<typeof dj> | null) => ({
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
  dj: info,
});

let progress: Record<string, unknown> = {};

beforeEach(() => {
  resetAnalysisRequests();
  analysisStore.reset();
  progress = {};
  server.use(
    http.post('*/api/library/dj/progress', () =>
      HttpResponse.json({ success: true, tracks: progress, sweep: { running: false } }),
    ),
    http.post('*/api/library/dj/tracks', () =>
      HttpResponse.json({
        success: true,
        tracks: { '1': dj(124, '8A'), '2': dj(126, '9A'), '5': dj(123, '7B', false) },
      }),
    ),
  );
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({
      index: 0,
      queue: [
        {
          id: '1',
          title: 'Night Ferry',
          artist: 'Tidewater',
          file_path: '/m/1.flac',
          is_library: true,
        },
        {
          id: '2',
          title: 'Static Bloom',
          artist: 'Saltmarsh',
          file_path: '/m/2.flac',
          is_library: true,
        },
        { id: 'r', title: 'A station', artist: '', file_path: null, is_library: false },
      ],
    }),
  };
});

afterEach(() => {
  cleanup();
  analysisStore.reset();
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
});

function picker(deck: 'out' | 'in', outgoing: DjTrack | null = null) {
  const picked: DjTrack[] = [];
  render(
    <TrackPicker
      label={deck === 'out' ? 'Outgoing track' : 'Incoming track'}
      deck={deck}
      chosen={null}
      onPick={(t) => picked.push(t)}
      outgoing={outgoing}
    />,
  );
  return picked;
}

const source = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));

describe('a deck’s picker', () => {
  it('starts on the playing track and Up next, each with its BPM, key and analysis state', async () => {
    const picked = picker('out');
    const sources = within(screen.getByRole('radiogroup', { name: 'Pick the outgoing track from' }))
      .getAllByRole('radio')
      .map((r) => r.textContent);
    expect(sources).toEqual([
      'Playing & Up next',
      'Recent',
      'Starred',
      'Sets & playlists',
      'Search',
    ]);
    const row = (await screen.findByRole('button', { name: 'Pick Night Ferry' })).closest('li')!;
    await waitFor(() => expect(row).toHaveTextContent('124 BPM · 8A · Analysed · Playing'));
    expect(
      screen.getByRole('button', { name: 'Pick Static Bloom' }).closest('li'),
    ).toHaveTextContent('Up next');
    // only library tracks with a file
    expect(screen.queryByRole('button', { name: 'Pick A station' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pick Static Bloom' }));
    expect(picked[0]).toMatchObject({ id: '2', title: 'Static Bloom' });
    expect(picked[0]?.dj?.bpm).toBe(126);
  });

  it('a track being analysed shows its bar and step', async () => {
    progress = { '2': { state: 'working', step: 'grid', percent: 60 } };
    picker('out');
    const bar = await screen.findByRole('progressbar', { name: 'Analysis of Static Bloom' });
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText('Finding the beat grid · 60%')).toBeInTheDocument();
  });

  it('Recent: your last plays of library tracks, once each', async () => {
    server.use(
      http.get('*/api/library/listening-history', () =>
        HttpResponse.json({
          items: [
            { track_id: '5', title: 'Sand Script', artist: 'Okan Dere' },
            { track_id: '5', title: 'Sand Script', artist: 'Okan Dere' },
            { track_id: null, title: 'Gone', artist: 'Someone' },
          ],
          total: 3,
        }),
      ),
    );
    picker('out');
    source('Recent');
    const row = (await screen.findByRole('button', { name: 'Pick Sand Script' })).closest('li')!;
    await waitFor(() => expect(row).toHaveTextContent('123 BPM · 7B · Not analysed yet'));
    expect(screen.getAllByRole('button', { name: /^Pick / })).toHaveLength(1);
  });

  it('Starred, then a set, then a playlist matched to your library', async () => {
    const asked: string[] = [];
    server.use(
      http.get('*/api/library/dj/browse', ({ request }) => {
        asked.push(new URL(request.url).search);
        return HttpResponse.json({ tracks: [track('7', 'Copper Sky', dj(120, '8B'))] });
      }),
      http.get('*/api/sets', () => HttpResponse.json({ sets: [{ id: 3, name: 'Sunday Set' }] })),
      http.get('*/api/mirrored-playlists', () =>
        HttpResponse.json([{ id: 9, name: 'Late night' }]),
      ),
      http.get('*/api/sets/3', () =>
        HttpResponse.json({
          rows: [{ track: track('8', 'Undertow', dj(124, '8A')) }, { track: null }],
        }),
      ),
      http.get('*/api/mirrored-playlists/9', () =>
        HttpResponse.json({
          tracks: [
            { track_name: 'Foghorn Study', artist_name: 'Pale Harbour' },
            { track_name: 'Not mine', artist_name: 'Nobody' },
          ],
        }),
      ),
      http.post('*/api/stars/status', () =>
        HttpResponse.json({ songs: [{ track_id: '6' }, { track_id: null }] }),
      ),
    );
    picker('out');
    source('Starred');
    expect(await screen.findByRole('button', { name: 'Pick Copper Sky' })).toBeInTheDocument();
    expect(asked[0]).toContain('starred=1');
    source('Sets & playlists');
    const select = await screen.findByRole('combobox', {
      name: 'A mix set or playlist for the outgoing track',
    });
    await waitFor(() => expect(select).toHaveTextContent('Set: Sunday Set'));
    fireEvent.change(select, { target: { value: 'set:3' } });
    expect(await screen.findByRole('button', { name: 'Pick Undertow' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'playlist:9' } });
    expect(await screen.findByRole('button', { name: 'Pick Foghorn Study' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick Not mine' })).toBeNull();
  });

  it('the incoming deck: Mixes well with the outgoing track, with its reasons', async () => {
    server.use(
      http.get('*/api/library/dj/mixes/1', ({ request }) => {
        expect(new URL(request.url).searchParams.get('rank')).toBe('mix');
        return HttpResponse.json({
          matches: [
            {
              ...track('2', 'Static Bloom', dj(126, '9A')),
              reason: 'One step on the wheel · +1.6% BPM',
            },
          ],
        });
      }),
    );
    const outgoing = track('1', 'Night Ferry', dj(124, '8A')) as DjTrack;
    picker('in', outgoing);
    expect(screen.getByRole('radio', { name: 'Mixes well with' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const row = (await screen.findByRole('button', { name: 'Pick Static Bloom' })).closest('li')!;
    expect(row).toHaveTextContent('126 BPM · 9A');
    expect(row).toHaveTextContent('One step on the wheel · +1.6% BPM');
  });

  it('Mixes well with waits for an outgoing track', () => {
    picker('in');
    expect(screen.getByRole('radio', { name: 'Mixes well with' })).toBeDisabled();
  });
});
