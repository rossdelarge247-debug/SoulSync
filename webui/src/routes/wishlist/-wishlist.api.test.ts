import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bulkWishlistActionChunked,
  BULK_WISHLIST_MAX_IDS,
  WISHLIST_TRACKS_TIMEOUT_MS,
  wishlistTracksQueryOptions,
} from './-wishlist.api';

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('bulkWishlistActionChunked', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends one call when the ids fit the server cap', async () => {
    const seen: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const body = (await (input as Request).json()) as { track_ids: string[] };
        seen.push(body.track_ids);
        return jsonResponse({
          success: true,
          results: body.track_ids.map((id) => ({ id, ok: true, message: 'Queued' })),
        });
      }),
    );

    const response = await bulkWishlistActionChunked('grab', ['a', 'b']);
    expect(seen).toEqual([['a', 'b']]);
    expect(response.results).toHaveLength(2);
  });

  it('splits oversized selections into capped chunks and merges results', async () => {
    const seen: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const body = (await (input as Request).json()) as { track_ids: string[] };
        seen.push(body.track_ids);
        return jsonResponse({
          success: true,
          results: body.track_ids.map((id) => ({ id, ok: true, message: 'Queued' })),
        });
      }),
    );

    const ids = Array.from({ length: BULK_WISHLIST_MAX_IDS + 50 }, (_, i) => `t${i}`);
    const response = await bulkWishlistActionChunked('retry', ids);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(BULK_WISHLIST_MAX_IDS);
    expect(seen[1]).toHaveLength(50);
    // Merged back into one per-item list, in order.
    expect(response.results?.map((r) => r.id)).toEqual(ids);
  });

  it('reports partial progress when a later chunk fails', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls += 1;
        const body = (await (input as Request).json()) as { track_ids: string[] };
        if (calls === 2) {
          return new Response(JSON.stringify({ error: 'busy' }), { status: 409 });
        }
        return jsonResponse({
          success: true,
          results: body.track_ids.map((id) => ({ id, ok: true, message: 'ok' })),
        });
      }),
    );

    const ids = Array.from({ length: BULK_WISHLIST_MAX_IDS + 10 }, (_, i) => `t${i}`);
    await expect(bulkWishlistActionChunked('grab', ids)).rejects.toThrow(
      `stopped after ${BULK_WISHLIST_MAX_IDS} of ${ids.length} tracks`,
    );
  });
});

describe('wishlistTracksQueryOptions', () => {
  // a fetch that answers when the test says so, and gives up when aborted
  function slowFetch() {
    let answer: () => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: RequestInfo | URL) =>
          new Promise<Response>((resolve, reject) => {
            const signal = (input as Request).signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
            answer = () =>
              resolve(
                jsonResponse({ tracks: [], category: 'albums', total: 0, artist_images: {} }),
              );
          }),
      ),
    );
    return () => answer();
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps waiting for a slow list well past ten seconds', async () => {
    const answer = slowFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const read = client.fetchQuery(wishlistTracksQueryOptions(1, 'albums'));
    let settled = false;
    void read.then(
      () => (settled = true),
      () => (settled = true),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    expect(client.getQueryState(wishlistTracksQueryOptions(1, 'albums').queryKey)?.status).toBe(
      'pending',
    );

    answer();
    await expect(read).resolves.toMatchObject({ category: 'albums', total: 0 });
  });

  it('gives up after a minute', async () => {
    slowFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const read = client.fetchQuery(wishlistTracksQueryOptions(1, 'singles'));
    const failed = expect(read).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(WISHLIST_TRACKS_TIMEOUT_MS + 1_000);
    await failed;
    expect(WISHLIST_TRACKS_TIMEOUT_MS).toBe(60_000);
  });
});
