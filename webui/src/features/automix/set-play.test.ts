import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ViewRow } from '@/features/sets/sets.api';

import { readDraft, writeDraft } from '@/features/sets/draft-store';

import { playedAsMix, type QueueTrack } from './controller';
import {
  playSetAsMix,
  playSetFromPlaying,
  saveTransitionToDraft,
  saveTransitionToSet,
  setQueue,
} from './set-play';

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
      // the track the set's chip leads into: the next row that plays here (283)
      next: '3',
    });
    expect(q[1].mix_set?.row).toBe(3);
    expect(q[1].mix_set?.next).toBeNull();
    // 319: a draft has Play as a mix too
    expect(setQueue({ id: 0, name: 'Draft', draft: true }, rows)[0].mix_set?.draft).toBe(true);
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

describe('a draft played as a mix (319)', () => {
  it('saves a chip changed in Up next to the draft in this browser', () => {
    const base = { title: null, artist: null, state: 'owned' as const, want: 'yours' as const };
    writeDraft(41, {
      name: 'Draft',
      kind: 'hand',
      rows: [
        { ...base, track_id: '1' },
        { ...base, track_id: null },
        { ...base, track_id: '2' },
      ],
    });
    saveTransitionToDraft(41, '1', '2', { style: 'echo_out', bars: 4 });
    expect(readDraft(41)?.rows[0].transition).toEqual({ style: 'echo_out', bars: 4 });
    expect(() => saveTransitionToDraft(41, '2', '1', { style: 'cut', bars: null })).toThrow(
      /no longer next to each other/,
    );
  });
});

describe("the Mix tab's working set as a mix (Ross's report of 28 October)", () => {
  const rows = [row('1'), row('2'), row('3'), row('4')];
  function player(queue: QueueTrack[], index: number) {
    return {
      queue,
      state: () => ({ track: queue[index] ?? null, queue, index }),
      insertNext: vi.fn((t: QueueTrack) => {
        queue.splice(index + 1, 0, t);
        return index + 1;
      }),
    };
  }

  it('from the playing track: the rest of the set goes straight after it, and every pair plays as a mix', async () => {
    // the playing track was played on its own: nothing up next
    const p = player([{ id: '1', title: 'T1', file_path: '/m/1.flac' }], 0);
    const toast = vi.fn();
    vi.stubGlobal('showToast', toast);
    expect(await playSetFromPlaying({ id: 5, name: 'Working set' }, rows, p)).toBe('continued');
    expect(p.queue.map((t) => t.id)).toEqual(['1', '2', '3', '4']);
    for (let i = 0; i < 3; i++) expect(playedAsMix(p.queue[i], p.queue[i + 1])).toBe(true);
    expect(toast).toHaveBeenCalledWith('Working set plays next as a mix · 3 tracks', 'success');
  });

  it('what was up next stays after the set', async () => {
    const p = player(
      [
        { id: '2', title: 'T2', file_path: '/m/2.flac' },
        { id: '9', title: 'Other' },
      ],
      0,
    );
    await playSetFromPlaying({ id: 5, name: 'Working set' }, rows, p);
    expect(p.queue.map((t) => t.id)).toEqual(['2', '3', '4', '9']);
  });

  it('a playing track not in the set (or nothing playing) plays the set from its start', async () => {
    const play = vi.fn(async () => ({ status: 'played' }));
    (window as unknown as { playTrackList: unknown }).playTrackList = play;
    const p = player([{ id: '7', title: 'T7', file_path: '/m/7.flac' }], 0);
    expect(await playSetFromPlaying({ id: 5, name: 'Working set' }, rows, p)).toBe('started');
    expect(play).toHaveBeenCalledTimes(1);
    expect((play.mock.calls[0] as unknown[])[1]).toBe('Working set · as a mix');
    expect(await playSetFromPlaying({ id: 5, name: 'Working set' }, rows, null)).toBe('started');
  });
});
