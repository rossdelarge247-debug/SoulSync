/** The hook before a Spotify call a person started (board 12b). */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { spotifyGate, untilSpotifyFree } from './spotify-gate';

const PAUSED = {
  rate_limited: true,
  rate_limit: { remaining_seconds: 30, retry_after: 720, source: 'spotify', trigger: 'x' },
};

function statusFetch(...slices: unknown[]) {
  let i = 0;
  return vi.fn(async () => {
    const spotify = slices[Math.min(i, slices.length - 1)];
    i += 1;
    return new Response(JSON.stringify({ spotify }), { status: 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'ssOpenSpotifyPaused');
});

describe('spotifyGate', () => {
  it('goes ahead at once while Spotify is fine or only easing back in', async () => {
    const open = vi.fn();
    expect(await spotifyGate('x', { fetchImpl: statusFetch({ rate_limited: false }), open })).toBe(
      true,
    );
    expect(
      await spotifyGate('x', {
        fetchImpl: statusFetch({ rate_limited: false, post_ban_cooldown: 300 }),
        open,
      }),
    ).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it('goes ahead when the status can’t be read, as it always did', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.reject(new Error('down')),
    ) as unknown as typeof fetch;
    expect(await spotifyGate('x', { fetchImpl, open: vi.fn() })).toBe(true);
  });

  it('opens the dialog while paused, naming what waits', async () => {
    const open = vi.fn(async () => 'closed' as const);
    expect(
      await spotifyGate('Mirroring “A” needs Spotify’s playlist, so it waits.', {
        fetchImpl: statusFetch(PAUSED),
        open,
      }),
    ).toBe(false);
    expect(open).toHaveBeenCalledWith({
      description: 'Mirroring “A” needs Spotify’s playlist, so it waits.',
      status: PAUSED,
    });
  });

  it('Try again now goes ahead straight away', async () => {
    const open = vi.fn(async () => 'cleared' as const);
    expect(await spotifyGate('x', { fetchImpl: statusFetch(PAUSED), open })).toBe(true);
  });

  it('Wait for it goes ahead once the pause is over', async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => 'wait' as const);
    const fetchImpl = statusFetch(PAUSED, PAUSED, { rate_limited: false });
    let done = false;
    const gate = spotifyGate('x', { fetchImpl, open }).then((v) => {
      done = v;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBe(false);
    // the countdown's end (30.5 s): still paused, so it asks again later
    await vi.advanceTimersByTimeAsync(21_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    await gate;
    expect(done).toBe(true);
  });

  it('uses the page’s dialog when there is one, and none when there isn’t', async () => {
    expect(await spotifyGate('x', { fetchImpl: statusFetch(PAUSED) })).toBe(true);
    window.ssOpenSpotifyPaused = vi.fn(async () => 'closed' as const);
    expect(await spotifyGate('x', { fetchImpl: statusFetch(PAUSED) })).toBe(false);
  });
});

describe('untilSpotifyFree', () => {
  it('ends on the status push that says Spotify is back', async () => {
    let done = false;
    const wait = untilSpotifyFree(PAUSED, { fetchImpl: statusFetch(PAUSED) }).then(() => {
      done = true;
    });
    window.dispatchEvent(
      new CustomEvent('ss:service-status', { detail: { spotify: { rate_limited: false } } }),
    );
    await wait;
    expect(done).toBe(true);
  });
});
