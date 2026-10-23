/** The Alerts band in the DOM: a chosen server that was never set up reads as
 *  "No library chosen" with the card's advice, not "Media server: Disconnected". */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AlertsBand } from './alerts-band';

const HEALTHY = {
  metadata_source: { source: 'spotify', connected: true },
  spotify: { authenticated: true },
  media_server: { connected: true, type: 'plex' },
  soulseek: { connected: true },
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('down'))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'navigateToPage');
});

async function mountWith(payload: Record<string, unknown>) {
  let view: ReturnType<typeof render>;
  await act(async () => {
    view = render(<AlertsBand />);
  });
  act(() => {
    window.dispatchEvent(new CustomEvent('ss:service-status', { detail: payload }));
  });
  return view!;
}

describe('AlertsBand', () => {
  it('with no library chosen, says so and how to choose one', async () => {
    const navigateToPage = vi.fn();
    window.navigateToPage = navigateToPage;
    const view = await mountWith({
      ...HEALTHY,
      active_media_server: 'plex',
      media_server: { connected: false, type: 'plex', configured: false },
    });
    const band = view.container.querySelector('[data-card="alerts"]')!;
    expect(band).not.toBeNull();
    expect(band.textContent).toContain('No library chosen');
    expect(band.textContent).not.toContain('Disconnected');
    expect(band.querySelector('.dash-alert-text')!.textContent).toBe(
      'Downloads won’t show in your library until you choose where it lives. Go to Settings → ' +
        'Connections → Server Connections and choose Standalone, or connect Plex, Jellyfin or Navidrome.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(navigateToPage).toHaveBeenCalledWith('settings');
  });

  it('lists it as one line beside another problem', async () => {
    const view = await mountWith({
      ...HEALTHY,
      soulseek: { connected: false },
      media_server: { connected: false, configured: false },
    });
    const rows = [...view.container.querySelectorAll('.dash-alert')].map((li) => li.textContent);
    expect(rows).toContain('No library chosen');
    expect(rows).toHaveLength(2);
  });

  it('a set-up server that is down keeps the connection wording', async () => {
    const view = await mountWith({
      ...HEALTHY,
      media_server: { connected: false, type: 'plex', configured: true },
    });
    const band = view.container.querySelector('[data-card="alerts"]')!;
    expect(band.textContent).toContain('Media server: Disconnected');
    expect(band.textContent).toContain('Anything that needs it waits until it’s back.');
  });

  it('stays away while everything is healthy', async () => {
    const view = await mountWith({
      ...HEALTHY,
      media_server: { connected: true, configured: true },
    });
    expect(view.container.querySelector('[data-card="alerts"]')).toBeNull();
  });

  describe('a Spotify pause (board 12a)', () => {
    const PAUSED = {
      ...HEALTHY,
      metadata_source: { source: 'spotify', connected: false },
      spotify: {
        authenticated: true,
        rate_limited: true,
        rate_limit: {
          active: true,
          remaining_seconds: 660,
          retry_after: 720,
          source: 'spotify',
          trigger: "checking an artist's albums for the watchlist scan",
          feature: 'the watchlist scan',
        },
      },
    };
    const asAdmin = () => {
      window.SoulSyncWebShellBridge = {
        getCurrentProfileContext: () => ({ profileId: 1, isAdmin: true }),
      } as unknown as typeof window.SoulSyncWebShellBridge;
    };
    const asMember = () => {
      window.SoulSyncWebShellBridge = {
        getCurrentProfileContext: () => ({ profileId: 2, isAdmin: false }),
      } as unknown as typeof window.SoulSyncWebShellBridge;
    };

    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(window, 'SoulSyncWebShellBridge');
    });

    it('is its own warning Notice: the one fact in the title, counting down', async () => {
      asAdmin();
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'Date'] });
      const view = await mountWith(PAUSED);
      const notice = view.container.querySelector('.dash-spotify-pause')!;
      const title = () => notice.querySelector('[data-slot="notice-title"]')!.textContent;
      expect(title()).toBe('Spotify asked us to wait 11 min');
      expect(notice.getAttribute('data-tone')).toBe('warning');
      expect(notice.getAttribute('data-layout')).toBe('stacked');
      // no live region: a ticking alert would be read out every second
      expect(notice.getAttribute('role')).toBe('note');
      expect(notice.querySelector('.dash-spotify-pause-wide')!.textContent).toBe(
        "After checking an artist's albums for the watchlist scan. That time came from Spotify, so " +
          'SYNCHRO.S waits exactly that long. Searches and downloads carry on; only what asks ' +
          'Spotify (playlists, new releases, the watchlist scan) waits.',
      );
      expect(notice.querySelector('.dash-spotify-pause-narrow')!.textContent).toBe(
        "After checking an artist's albums for the watchlist scan. Searches and downloads carry " +
          'on; only what asks Spotify waits.',
      );
      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(title()).toBe('Spotify asked us to wait 10 min');
      // the state is announced once, the clock never
      expect(notice.querySelector('.dash-sr')!.textContent).toBe(
        'Spotify asked SYNCHRO.S to wait.',
      );
      // the pause alone: no Open Settings, no second alert
      expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull();
      expect(view.container.querySelector('.dash-alerts')).toBeNull();
    });

    it('a member gets "An admin can try again sooner." and no button', async () => {
      asMember();
      const view = await mountWith(PAUSED);
      expect(screen.queryByRole('button', { name: 'Try again now' })).toBeNull();
      expect(
        view.container.querySelector('.dash-spotify-pause [data-slot="notice-body"]')!.textContent,
      ).toBe(
        "After checking an artist's albums for the watchlist scan. Searches and downloads carry " +
          'on; only what asks Spotify waits. An admin can try again sooner.',
      );
    });

    it('lets an admin try again now, and says the pause can come back', async () => {
      asAdmin();
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push(`${init?.method ?? 'GET'} ${url}`);
          if (String(url).includes('/api/spotify/rate-limit/clear')) {
            return new Response('{"success": true}', { status: 200 });
          }
          return Promise.reject(new Error('down'));
        }),
      );
      const view = await mountWith(PAUSED);
      expect(view.container.querySelector('.dash-alert-note')!.textContent).toBe(
        'Clears SYNCHRO.S’s pause. If Spotify is still limiting, the pause comes back.',
      );
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again now' }));
      });
      expect(
        calls.some((c) => c.startsWith('POST') && c.includes('/api/spotify/rate-limit/clear')),
      ).toBe(true);
      expect(view.container.querySelector('.dash-alert-note')!.textContent).toBe(
        'Pause cleared. Trying Spotify again.',
      );
    });

    it('an estimate says it is a guess, and the note says "longer"', async () => {
      asAdmin();
      const view = await mountWith({
        ...PAUSED,
        spotify: {
          ...PAUSED.spotify,
          rate_limit: {
            remaining_seconds: 540,
            retry_after: 600,
            source: 'estimate',
            trigger: 'searching for tracks',
            feature: null,
          },
        },
      });
      const notice = view.container.querySelector('.dash-spotify-pause')!;
      expect(notice.querySelector('[data-slot="notice-title"]')!.textContent).toBe(
        'Paused Spotify for 9 min to be safe',
      );
      expect(notice.textContent).toContain(
        'Spotify said “too many requests” after searching for tracks, but not how long to wait, ' +
          'so this is SYNCHRO.S’s guess: 10 minutes, and twice as long if it happens again within ' +
          'the hour. Searches and downloads carry on; only what asks Spotify waits.',
      );
      expect(notice.querySelector('.dash-alert-note')!.textContent).toBe(
        'Clears SYNCHRO.S’s pause. If Spotify is still limiting, the pause comes back, longer.',
      );
    });

    it('easing back in is info, for everyone, with no button', async () => {
      asAdmin();
      const view = await mountWith({
        ...PAUSED,
        spotify: { authenticated: true, rate_limited: false, post_ban_cooldown: 300 },
      });
      const notice = view.container.querySelector('.dash-spotify-pause')!;
      expect(notice.getAttribute('data-tone')).toBe('info');
      expect(notice.querySelector('[data-slot="notice-title"]')!.textContent).toBe(
        'Spotify is back',
      );
      expect(notice.textContent).toContain(
        'Anything you do yourself uses it now. Background jobs wait 5 min more, then SYNCHRO.S ' +
          'spaces its calls out for a quarter of an hour',
      );
      expect(screen.queryByRole('button', { name: 'Try again now' })).toBeNull();
    });

    it('sits beside another problem as two Notices', async () => {
      asAdmin();
      const view = await mountWith({ ...PAUSED, soulseek: { connected: false } });
      expect(view.container.querySelector('.dash-spotify-pause')).not.toBeNull();
      expect(view.container.querySelector('.dash-alerts')!.textContent).toContain(
        'Download source',
      );
    });
  });
});
