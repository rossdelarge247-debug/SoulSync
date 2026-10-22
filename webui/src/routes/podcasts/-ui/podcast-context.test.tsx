import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import * as api from '../-podcasts.api';
import { PodcastProvider, usePodcastContext } from './podcast-context';

function DownloadProbe() {
  const { downloads, handleDownloadEpisode } = usePodcastContext();
  return (
    <>
      <button
        onClick={() =>
          handleDownloadEpisode(
            {
              guid: 'episode-1',
              title: 'Episode',
              enclosure_url: 'https://example.com/episode.mp3',
              enclosure_type: 'audio/mpeg',
              description: '',
              show_notes: '',
              episode_type: 'full',
              duration_seconds: 120,
            },
            'Show',
            'cover.jpg',
          )
        }
      >
        Download
      </button>
      <output>{JSON.stringify(downloads)}</output>
    </>
  );
}

function records() {
  return JSON.parse(screen.getByRole('status').textContent!);
}

describe('podcast download lifecycle', () => {
  it.each([true, false])('reconciles the temporary record when success is %s', async (success) => {
    vi.spyOn(api, 'fetchPodcastDownloads').mockResolvedValue([]);
    vi.spyOn(api, 'fetchWatchlistPodcasts').mockResolvedValue([]);
    const pending = Promise.withResolvers<{ success: boolean; download_id?: string }>();
    vi.spyOn(api, 'downloadPodcastEpisode').mockReturnValue(pending.promise);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);

    await act(async () => {
      render(
        <PodcastProvider>
          <DownloadProbe />
        </PodcastProvider>,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    const queued = records()['temp-1000-episode-1'];
    expect(queued).toEqual({
      download_id: 'temp-1000-episode-1',
      title: 'Episode',
      show_title: 'Show',
      artwork_url: 'cover.jpg',
      enclosure_url: 'https://example.com/episode.mp3',
      duration_seconds: 120,
      status: 'queued',
      progress_bytes: 0,
      total_bytes: 0,
      percent: 0,
      started_at: 1,
    });

    now.mockReturnValue(2000);
    await act(async () => pending.resolve({ success, download_id: 'download-7' }));
    expect(records()).toEqual(
      success ? { 'download-7': { ...queued, download_id: 'download-7', started_at: 2 } } : {},
    );
  });
});

function PlayProbe() {
  const { activePlayback, handlePlayEpisode } = usePodcastContext();
  return (
    <>
      <button
        onClick={() =>
          handlePlayEpisode(
            {
              guid: 'episode-1',
              title: 'Episode',
              enclosure_url: 'https://example.com/episode.mp3',
              enclosure_type: 'audio/mpeg',
              description: '',
              show_notes: '',
              episode_type: 'full',
              duration_seconds: 120,
              chapter_url: 'https://example.com/chapters.json',
            },
            { title: 'Show', artwork_url: 'cover.jpg', episodes: [] } as never,
          )
        }
      >
        Play
      </button>
      <output>
        {activePlayback
          ? `${activePlayback.episode.title}:${activePlayback.isPlaying ? 'playing' : 'paused'}`
          : 'none'}
      </output>
    </>
  );
}

describe('podcast playback goes to the app player (board 6a)', () => {
  it('hands the episode to the one player and follows what it has loaded', async () => {
    vi.spyOn(api, 'fetchPodcastDownloads').mockResolvedValue([]);
    vi.spyOn(api, 'fetchWatchlistPodcasts').mockResolvedValue([]);
    const player = {
      current: { track: null as null | { kind: string; media_id: string }, playing: false },
      playMedia: vi.fn(async () => undefined),
      toggle: vi.fn(),
      state: () => player.current,
    };
    (window as { SoulSyncPlayer?: unknown }).SoulSyncPlayer = player;
    try {
      await act(async () => {
        render(
          <PodcastProvider>
            <PlayProbe />
          </PodcastProvider>,
        );
      });
      expect(screen.getByRole('status').textContent).toBe('none');
      fireEvent.click(screen.getByRole('button', { name: 'Play' }));
      expect(player.playMedia).toHaveBeenCalledWith({
        kind: 'podcast',
        id: 'episode-1',
        src: 'https://example.com/episode.mp3',
        title: 'Episode',
        subtitle: 'Show',
        artUrl: 'cover.jpg',
        durationHint: 120,
        chaptersUrl: 'https://example.com/chapters.json',
      });
      await act(async () => {
        player.current = { track: { kind: 'podcast', media_id: 'episode-1' }, playing: true };
        window.dispatchEvent(new CustomEvent('ss:player'));
      });
      expect(screen.getByRole('status').textContent).toBe('Episode:playing');
    } finally {
      delete (window as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
    }
  });
});
