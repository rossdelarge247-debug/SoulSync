/** Where Data's readout comes from (30i): the library's details, a station's stream, a file name. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { infoKey, loadDataInfo } from './data-source';

type W = { SoulSyncPlayer?: unknown; SoulSyncRadio?: unknown };

function player(track: Record<string, unknown> | null, kind: string | null) {
  (window as unknown as W).SoulSyncPlayer = { state: () => ({ track, kind }) };
}

afterEach(() => {
  delete (window as unknown as W).SoulSyncPlayer;
  delete (window as unknown as W).SoulSyncRadio;
});

describe('the readout’s sources', () => {
  it('a library track reads the player’s details: channels, depth, on disk', async () => {
    player({ id: 't1', filename: '/m/a.flac', is_library: true }, 'library');
    const f = vi.fn(async () =>
      Response.json({
        format: 'FLAC',
        sample_rate: 96000,
        bit_depth: 24,
        channels: 2,
        bitrate_kbps: 2900,
        on_disk_kbps: 2875,
      }),
    );
    const info = await loadDataInfo(window, f);
    expect(f).toHaveBeenCalledWith('/api/library/tracks/t1/details');
    expect(info).toMatchObject({
      format: 'FLAC',
      fileRate: 96000,
      bitDepth: 24,
      channels: 2,
      onDiskKbps: 2875,
      lossless: true,
      station: null,
    });
  });

  it('a lossy library file is lossless: false even with a depth', async () => {
    player({ id: 't2', filename: '/m/a.mp3' }, 'library');
    const f = vi.fn(async () => Response.json({ format: 'MP3', bit_depth: null, channels: 1 }));
    const info = await loadDataInfo(window, f);
    expect(info.lossless).toBe(false);
    expect(info.channels).toBe(1);
  });

  it('a failed read falls back to the file name', async () => {
    player({ id: 't3', filename: '/m/a.flac' }, 'library');
    const info = await loadDataInfo(window, async () => new Response('', { status: 404 }));
    expect(info.format).toBe('FLAC');
    expect(info.bitDepth).toBeNull();
  });

  it('a station: its stream’s codec and bitrate, and its name; nothing is fetched', async () => {
    player({ id: 'r1', kind: 'radio' }, 'radio');
    (window as unknown as W).SoulSyncRadio = {
      state: () => ({
        station: { name: 'BBC Radio 6 Music' },
        stream: { codec: 'AAC', bitrate_kbps: 320, lossless: false },
      }),
    };
    const f = vi.fn();
    const info = await loadDataInfo(window, f);
    expect(f).not.toHaveBeenCalled();
    expect(info).toMatchObject({ format: 'AAC', bitrateKbps: 320, station: 'BBC Radio 6 Music' });
    expect(infoKey(window)).toBe('radio:BBC Radio 6 Music:AAC');
  });

  it('a stream from a search: the extension, nothing fetched', async () => {
    player({ id: 'x', filename: 'peer/Some Song.opus' }, 'stream');
    const f = vi.fn();
    const info = await loadDataInfo(window, f);
    expect(f).not.toHaveBeenCalled();
    expect(info.format).toBe('Opus');
    expect(info.lossless).toBe(false);
  });

  it('nothing playing: nothing known', async () => {
    player(null, null);
    expect((await loadDataInfo(window)).format).toBeNull();
    expect(infoKey(window)).toBe('');
  });
});
