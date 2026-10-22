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
});
