import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ViewRow } from '@/features/sets/sets.api';

import { playSetAsMix, saveTransitionToSet, setQueue } from './set-play';

function row(id: string | null, file = true, transition: ViewRow['transition'] = null): ViewRow {
  return {
    track_id: id,
    artist: 'Tidewater',
    title: `T${id}`,
    state: id ? 'owned' : 'missing',
    transition,
    track: id
      ? ({
          id,
          title: `T${id}`,
          artist_name: 'Tidewater',
          album_title: 'Lantern',
          album_id: '10',
          artist_id: '1',
          file_path: file ? `/m/${id}.flac` : null,
          image_url: null,
          duration_ms: 300000,
          bitrate: 900,
        } as unknown as ViewRow['track'])
      : null,
  } as ViewRow;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { playTrackList?: unknown }).playTrackList;
});

describe('Play as a mix (28e)', () => {
  it('queues the rows with their files, each carrying its row and the set’s chip', async () => {
    const rows = [
      row('1', true, { style: 'bass_swap', bars: 16 }),
      row(null),
      row('2', false),
      row('3'),
    ];
    const q = setQueue({ id: 7, name: 'Sunday Set' }, rows);
    expect(q.map((t) => t.id)).toEqual(['1', '3']);
    expect(q[0].mix_set).toEqual({
      id: 7,
      name: 'Sunday Set',
      row: 0,
      transition: { style: 'bass_swap', bars: 16 },
    });
    expect(q[1].mix_set?.row).toBe(3);
    const play = vi.fn(async () => ({ status: 'played' }));
    (window as unknown as { playTrackList: unknown }).playTrackList = play;
    expect(await playSetAsMix({ id: 7, name: 'Sunday Set' }, rows)).toBe(true);
    expect(play).toHaveBeenCalledWith(q, 'Sunday Set · as a mix');
  });
});

describe('Save it to the set too (26i)', () => {
  it('saves the chip on the row the pair came from, at the set’s revision', async () => {
    const sent: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        const body = req.method === 'PUT' ? await req.json() : null;
        sent.push({ method: req.method, url: req.url, body });
        const answer =
          req.method === 'GET'
            ? {
                success: true,
                rows: [row('1'), row(null), row('3'), row('4')],
                steps: [],
                summary: {},
                set: { id: 7, revision: 5 },
              }
            : { success: true, id: 7, revision: 6, playlist_state: null };
        return new Response(JSON.stringify(answer), {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    // the queue said row 0, but the set moved: the pair 3 → 4 is at row 2
    await saveTransitionToSet({ id: 7, row: 0 }, '3', '4', { style: 'echo_out', bars: 4 });
    const put = sent.find((s) => s.method === 'PUT')!;
    const tracks = (put.body as { tracks: { transition: unknown }[]; base_revision: number })
      .tracks;
    expect((put.body as { base_revision: number }).base_revision).toBe(5);
    expect(tracks[2].transition).toEqual({ style: 'echo_out', bars: 4 });
    expect(tracks[0].transition).toBeNull();
    await expect(
      saveTransitionToSet({ id: 7, row: 0 }, '1', '4', { style: 'cut', bars: null }),
    ).rejects.toThrow(/no longer next to each other/);
  });
});
