/** Data's per-channel taps (review L6): hooked on the first read, unhooked when released, hooked again lazily. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAudioTap } from './visuals-audio';

function node() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    fftSize: 0,
    getFloatTimeDomainData: vi.fn(),
  };
}

afterEach(() => {
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
});

describe('the per-channel taps', () => {
  it('hook the splitter once, release it, and hook it again on the next read', () => {
    const split = node();
    const ctx = {
      sampleRate: 48000,
      createChannelSplitter: vi.fn(() => split),
      createAnalyser: vi.fn(() => node()),
    };
    const shared = { ...node(), context: ctx };
    (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = { analyser: () => shared };
    const tap = createAudioTap(window);
    const l = new Float32Array(4);
    const r = new Float32Array(4);
    expect(tap.floats!(l, r)).toBe(true);
    expect(tap.floats!(l, r)).toBe(true);
    expect(shared.connect).toHaveBeenCalledTimes(1);
    tap.releaseFloats!();
    expect(shared.disconnect).toHaveBeenCalledWith(split);
    tap.releaseFloats!();
    expect(shared.disconnect).toHaveBeenCalledTimes(1);
    expect(tap.floats!(l, r)).toBe(true);
    expect(shared.connect).toHaveBeenCalledTimes(2);
    expect(ctx.createChannelSplitter).toHaveBeenCalledTimes(1);
  });
});
