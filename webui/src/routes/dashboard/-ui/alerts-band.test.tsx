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

  describe('a Spotify pause', () => {
    const PAUSED = {
      ...HEALTHY,
      metadata_source: { source: 'spotify', connected: false },
      spotify: {
        authenticated: true,
        rate_limited: true,
        rate_limit: {
          active: true,
          remaining_seconds: 125,
          retry_after: 720,
          source: 'spotify',
          trigger: "checking an artist's albums",
        },
      },
    };

    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(window, 'SoulSyncWebShellBridge');
    });

    it('says whose number the time is and counts down live', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      const view = await mountWith(PAUSED);
      const title = () => view.container.querySelector('[data-slot="notice-title"]')!.textContent;
      expect(title()).toBe(
        "Spotify asked us to wait 2 min 5 s (after checking an artist's albums)",
      );
      expect(view.container.textContent).toContain('That time came from Spotify');
      // no live region: a ticking alert would be read out every second
      expect(view.container.querySelector('[data-card="alerts"]')!.getAttribute('role')).toBe(
        'note',
      );
      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(title()).toBe(
        "Spotify asked us to wait 1 min 59 s (after checking an artist's albums)",
      );
      // members don't get Try again now
      expect(screen.queryByRole('button', { name: 'Try again now' })).toBeNull();
    });

    it('lets an admin try again now, and says the pause can come back', async () => {
      window.SoulSyncWebShellBridge = {
        getCurrentProfileContext: () => ({ profileId: 1, isAdmin: true }),
      } as unknown as typeof window.SoulSyncWebShellBridge;
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

    it('an estimate says so', async () => {
      const view = await mountWith({
        ...PAUSED,
        spotify: {
          ...PAUSED.spotify,
          rate_limit: { ...PAUSED.spotify.rate_limit, source: 'estimate', remaining_seconds: 600 },
        },
      });
      expect(view.container.textContent).toContain(
        "Paused Spotify for 10 min to be safe (after checking an artist's albums)",
      );
      expect(view.container.textContent).toContain('SYNCHRO.S’s estimate');
    });
  });
});
