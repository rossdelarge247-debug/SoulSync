/**
 * The player's lyrics fetch (static/media-player.js), as the Visuals' lyrics
 * layer reads it through SoulSyncPlayer.lyricsData(): the answer kept as it
 * came (with LRCLIB's instrumental mark and the file beside the track), and a
 * quick skip no longer leaves the next track without lyrics (the fetch for
 * the track before is dropped when it lands).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { extractFunction } from './vanilla-extract';

const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const state = /const _npLyricsState = \{[\s\S]*?\n\};/.exec(source)![0];
const load = extractFunction('_npLyricsLoadForTrack', source);
const key = extractFunction('_npLyricsTrackKey', source);
const parse = extractFunction('_npLyricsParseLrc', source);

function harness(fetchImpl: (body: Record<string, unknown>) => Promise<unknown>) {
  const notify = vi.fn();
  return new Function(
    'fetch',
    'npNotify',
    `const audioPlayer = { duration: 200 };
     const _stripSourceIdPrefix = (s) => s;
     const _npLyricsResetUI = () => {};
     const _npLyricsRenderSynced = () => {};
     const _npLyricsRenderPlain = () => {};
     ${state}
     ${key}
     ${parse}
     ${load}
     return { load: _npLyricsLoadForTrack, state: _npLyricsState, notify: npNotify };`,
  )(
    async (_url: string, init: { body: string }) => ({
      json: () => fetchImpl(JSON.parse(init.body) as Record<string, unknown>),
    }),
    notify,
  ) as {
    load: (t: Record<string, unknown>) => Promise<void>;
    state: { raw: Record<string, unknown> | null; synced: boolean };
    notify: ReturnType<typeof vi.fn>;
  };
}

const night = {
  title: 'Night Ferry',
  artist: 'Tidewater',
  album: 'Lantern',
  is_library: true,
  filename: '/music/Tidewater/Lantern/01 Night Ferry.flac',
};
const bloom = { title: 'Static Bloom', artist: 'Tidewater', album: 'Lantern', is_library: false };

describe('the player’s lyrics, for the layer', () => {
  it('keeps the answer as it came, with the file’s name and the instrumental mark', async () => {
    const h = harness(async () => ({
      success: false,
      synced: null,
      plain: null,
      source: 'lrclib',
      instrumental: true,
    }));
    await h.load(night);
    expect(h.state.raw).toMatchObject({
      done: true,
      instrumental: true,
      source: 'lrclib',
      fileName: '01 Night Ferry.flac',
    });
    expect(h.notify).toHaveBeenCalledWith('lyrics');
  });

  it('a quick skip: the second track’s lyrics load, the first’s answer is dropped', async () => {
    const pending: ((v: unknown) => void)[] = [];
    const h = harness(
      (body) =>
        new Promise((r) => {
          pending.push(() =>
            r({ success: true, synced: `[00:01.00]${String(body.title)}`, source: 'lrclib' }),
          );
        }),
    );
    const first = h.load(night);
    const second = h.load(bloom);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(pending).toHaveLength(2);
    pending[1]!(null);
    await second;
    expect(h.state.raw).toMatchObject({ done: true, synced: '[00:01.00]Static Bloom' });
    pending[0]!(null);
    await first;
    expect(h.state.raw).toMatchObject({ synced: '[00:01.00]Static Bloom' });
    expect(h.state.synced).toBe(true);
  });
});
