/** "Spotify is paused" (board 12b). */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpotifyPausedDialog } from './spotify-paused-dialog';
import { openSpotifyPaused, SpotifyPausedHost } from './spotify-paused-host';

const TOLD = {
  rate_limited: true,
  rate_limit: {
    remaining_seconds: 702,
    retry_after: 720,
    source: 'spotify',
    trigger: "checking an artist's albums for the watchlist scan",
    feature: 'the watchlist scan',
  },
};

function as(admin: boolean) {
  window.SoulSyncWebShellBridge = {
    getCurrentProfileContext: () => ({ profileId: admin ? 1 : 2, isAdmin: admin }),
  } as unknown as typeof window.SoulSyncWebShellBridge;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'SoulSyncWebShellBridge');
});

describe('the Spotify is paused dialog', () => {
  it('names what waits, then three tiles and the sentence', () => {
    as(true);
    render(
      <SpotifyPausedDialog
        open
        status={TOLD}
        description="Mirroring “Sunday Mornings” needs Spotify’s playlist, so it waits."
        onAnswer={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(screen.getByRole('heading', { name: 'Spotify is paused' })).toBeTruthy();
    expect(dialog.textContent).toContain(
      'Mirroring “Sunday Mornings” needs Spotify’s playlist, so it waits. It starts by itself when the pause ends, if this page stays open.',
    );
    expect(screen.getByTestId('spotify-paused-time').textContent).toBe('11 min 42 s');
    expect(dialog.textContent).toContain('Whose number');
    expect(dialog.textContent).toContain('Spotify’s');
    expect(dialog.textContent).toContain("Checking an artist's albums, for the watchlist scan");
    expect(dialog.textContent).toContain('Spotify said how long to wait (12 minutes)');
    expect(dialog.textContent).toContain(
      'Try again now clears SYNCHRO.S’s pause. If Spotify is still limiting, the pause comes back.',
    );
  });

  it('Wait for it is the primary and has the focus; an admin also has a ghost Try again now', () => {
    as(true);
    render(<SpotifyPausedDialog open status={TOLD} description="X waits." onAnswer={() => {}} />);
    const wait = screen.getByRole('button', { name: 'Wait for it' });
    expect(wait.getAttribute('data-variant')).toBe('primary');
    expect(screen.getByRole('button', { name: 'Try again now' }).getAttribute('data-variant')).toBe(
      'ghost',
    );
  });

  it('a member sees Wait for it alone', () => {
    as(false);
    render(<SpotifyPausedDialog open status={TOLD} description="X waits." onAnswer={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Try again now' })).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toContain('Try again now clears');
  });

  it('answers wait, cleared or closed', async () => {
    as(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"success": true}', { status: 200 })),
    );
    const onAnswer = vi.fn();
    const { unmount } = render(
      <SpotifyPausedDialog open status={TOLD} description="X waits." onAnswer={onAnswer} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Wait for it' }));
    expect(onAnswer).toHaveBeenLastCalledWith('wait');
    unmount();
    const onAnswer2 = vi.fn();
    render(<SpotifyPausedDialog open status={TOLD} description="X waits." onAnswer={onAnswer2} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again now' }));
    });
    expect(onAnswer2).toHaveBeenLastCalledWith('cleared');
    cleanup();
    const onAnswer3 = vi.fn();
    render(<SpotifyPausedDialog open status={TOLD} description="X waits." onAnswer={onAnswer3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onAnswer3).toHaveBeenLastCalledWith('closed');
  });

  it('an estimate says whose guess, and the note says "longer"', () => {
    as(true);
    render(
      <SpotifyPausedDialog
        open
        status={{
          rate_limited: true,
          rate_limit: { remaining_seconds: 540, retry_after: 600, source: 'estimate' },
        }}
        description="X waits."
        onAnswer={() => {}}
      />,
    );
    const text = screen.getByRole('dialog').textContent;
    expect(text).toContain('SYNCHRO.S’s guess');
    expect(text).toContain('the pause comes back, longer.');
  });

  it('the page-wide host opens it and passes the answer back', async () => {
    as(false);
    render(<SpotifyPausedHost />);
    let answer: string | null = null;
    act(() => {
      void openSpotifyPaused({
        description: 'Opening “A” needs Spotify’s playlist, so it waits.',
        status: TOLD,
      }).then((a) => {
        answer = a;
      });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Wait for it' }));
    await act(async () => {});
    expect(answer).toBe('wait');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
