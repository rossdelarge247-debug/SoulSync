/**
 * Review M1: DJ mode's ask for analysis goes through the real
 * `requestAnalysis`, forced, so an automatic ask for the same track a moment
 * earlier doesn't swallow it; and the lane asks once per session.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { requestAnalysis, resetAnalysisRequests } from '@/features/dj/analysis.api';
import { HttpResponse, http, server } from '@/test/msw';

import { DjModeStore } from './dj-mode-store';

afterEach(() => {
  resetAnalysisRequests();
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
});

describe('DJ mode’s analysis ask (review M1)', () => {
  it('reaches the server although the track was asked for automatically a moment ago', async () => {
    const bodies: { track_ids: string[]; reason: string; source?: string }[] = [];
    server.use(
      http.post('*/api/library/dj/analyse', async ({ request }) => {
        bodies.push((await request.json()) as (typeof bodies)[number]);
        return HttpResponse.json({ success: true, asked: 1, queued: 1, started: true });
      }),
      http.post('*/api/library/dj/progress', () =>
        HttpResponse.json({ success: true, tracks: {}, sweep: null }),
      ),
    );
    (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
      state: () => ({
        track: { id: '42', title: 'Night Ferry', is_library: true, filename: '/m/42.flac' },
        kind: 'library',
      }),
    };
    // a page asked for it automatically (Up next, a set) just now
    void requestAnalysis(['42'], { reason: 'auto' }).catch(() => undefined);
    const store = new DjModeStore({
      fetch: async (url: string) =>
        url.includes('/dj/grid/')
          ? new Response(
              JSON.stringify({ grid: { track_id: '42', analyzed: false, reason: 'not_analyzed' } }),
            )
          : new Response('{}', { status: 404 }),
      phone: () => false,
      say: () => undefined,
    });
    store.setOn(true);
    await expect
      .poll(() => bodies.filter((b) => b.source === 'dj_now').length, { timeout: 5000 })
      .toBe(1);
    const mine = bodies.find((b) => b.source === 'dj_now')!;
    expect(mine).toMatchObject({ track_ids: ['42'], reason: 'asked' });
    // D off and on: not asked again this session
    store.setOn(false);
    store.setOn(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(bodies.filter((b) => b.source === 'dj_now')).toHaveLength(1);
    store.dispose();
  }, 10_000);
});
