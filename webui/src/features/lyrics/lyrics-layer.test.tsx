/**
 * The layer as drawn (27a, 27c, 27g) and the phone's record (27e): the
 * lines, the pill, the states, a line that seeks, the scrim and the grounds;
 * the legacy chrome it drives (the header's button, the overlay's marks, the
 * record "…"'s rows).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RawLyrics } from './lyrics.logic';

import { LyricsLayer, LyricsRecord, outputDelay } from './lyrics-layer';
import { syncChrome } from './lyrics-mount';
import { LyricsStore } from './lyrics-store';

type W = { SoulSyncPlayer?: unknown };

let raw: RawLyrics | null;
let kind = 'library';
const audio = { currentTime: 5.2, duration: 90, paused: false };
const seek = vi.fn();

function lyrics(over: Partial<RawLyrics> = {}): RawLyrics {
  return {
    key: 'k',
    done: true,
    synced:
      '[00:01.00]Under a slack-water sky\n[00:04.50]Hold the lantern low\n[00:10.00]Where the reeds forget the shore',
    plain: null,
    source: 'lrclib',
    instrumental: false,
    fileName: null,
    ...over,
  };
}

function store(on = true): LyricsStore {
  const s = new LyricsStore(window);
  s.refresh();
  if (on) s.setOn(true);
  return s;
}

beforeEach(() => {
  localStorage.clear();
  raw = lyrics();
  kind = 'library';
  seek.mockClear();
  (window as unknown as W).SoulSyncPlayer = {
    state: () => ({ track: { id: 't1', title: 'Night Ferry', image_url: '/art.jpg' }, kind }),
    lyricsData: () => raw,
    audio: () => audio,
    outputTargets: () => ({ context: null }),
    seek,
  };
});

afterEach(() => {
  delete (window as unknown as W).SoulSyncPlayer;
  document.body.innerHTML = '';
});

describe('the layer in the Visuals (27a)', () => {
  it('the line before, the line now, the next; each a button that plays from its start', async () => {
    const s = store();
    render(<LyricsLayer store={s} open engine="milkdrop" />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await new Promise((r) => setTimeout(r, 30));
    });
    const now = screen.getByRole('button', { name: /^Hold the lantern low, at 0:04/ });
    expect(now).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Under a slack-water sky, at 0:01/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Where the reeds forget the shore/ }));
    expect(seek).toHaveBeenCalledWith(10.05);
    // a screen reader gets the line, not the sweep
    expect(screen.getByText('Hold the lantern low', { selector: 'p' })).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  it('the pill: Lyrics only, A− / A+, Earlier / Later with the offset, and the source', () => {
    const s = store();
    render(<LyricsLayer store={s} open engine="classic" />);
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics earlier by 0.1 seconds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics earlier by 0.1 seconds' }));
    expect(screen.getByText('+0.2 s')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Larger lyrics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Larger lyrics' }));
    expect(screen.getByRole('button', { name: 'Larger lyrics' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics only' }));
    expect(s.snapshot().only).toBe(true);
    expect(screen.getByRole('button', { name: 'Lyrics only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('LRCLIB · timed to the line')).toBeInTheDocument();
  });

  it('the grounds (27c): the scrim over a visual, the art blurred over the still stage, a wash for Lyrics only', () => {
    const s = store();
    const { container, rerender } = render(<LyricsLayer store={s} open engine="milkdrop" />);
    expect(container.querySelector('[data-lyrics-layer]')).toHaveAttribute('data-ground', 'visual');
    rerender(<LyricsLayer store={s} open engine="still" />);
    expect(container.querySelector('[data-lyrics-layer]')).toHaveAttribute('data-ground', 'art');
    act(() => s.setOnly(true));
    expect(container.querySelector('[data-lyrics-layer]')).toHaveAttribute('data-ground', 'only');
  });

  it('the states (27g): finding the words, none found, instrumental; nothing while closed or off', () => {
    raw = lyrics({ done: false });
    const s = store();
    const { rerender, container } = render(<LyricsLayer store={s} open engine="classic" />);
    expect(screen.getByText('Finding the words…')).toBeInTheDocument();
    expect(screen.getByText('Looking in LRCLIB and beside the track')).toBeInTheDocument();
    // no scrim until there are words
    expect(container.querySelector('[data-lyrics-pill]')).toBeNull();
    raw = lyrics({ synced: null, plain: null });
    act(() => s.refresh());
    expect(screen.getByText('No lyrics found for Night Ferry')).toBeInTheDocument();
    raw = lyrics({ key: 'k2', synced: null, plain: null, instrumental: true });
    act(() => s.refresh());
    expect(screen.getByText('LRCLIB marks it as instrumental')).toBeInTheDocument();
    rerender(<LyricsLayer store={s} open={false} engine="classic" />);
    expect(container.firstChild).toBeNull();
  });

  it('plain lyrics: all lines alike, no Earlier / Later', () => {
    raw = lyrics({ synced: null, plain: 'One line\nTwo line' });
    const s = store();
    render(<LyricsLayer store={s} open engine="classic" />);
    expect(screen.getByText('One line')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /earlier/ })).toBeNull();
    expect(screen.getByText('LRCLIB · not timed: scrolling with the track')).toBeInTheDocument();
  });
});

describe('the phone’s record (27e)', () => {
  it('four lines and the source line in the artwork’s place; nothing while off', async () => {
    const s = store(false);
    const { container } = render(<LyricsRecord store={s} active />);
    expect(container.firstChild).toBeNull();
    act(() => s.setOn(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.getByText('LRCLIB · timed to the line')).toBeInTheDocument();
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(2);
  });
});

describe('the legacy chrome', () => {
  it('the header’s Lyrics button, the overlay’s marks and the record “…” rows follow the store', () => {
    document.body.innerHTML = `
      <div id="np-modal-overlay"></div>
      <button id="np-v2-visuals-lyrics-btn" hidden aria-pressed="false"></button>
      <div class="ss-player-record"><button data-lyrics-toggle hidden></button></div>
      <button data-lyrics-menu="smaller" hidden><span data-lyrics-size-state></span></button>
      <button data-lyrics-menu="earlier" hidden><span data-lyrics-offset-state></span></button>`;
    const s = store();
    s.setOnly(true);
    s.nudge(1);
    syncChrome(document, s.snapshot(), true);
    const head = document.getElementById('np-v2-visuals-lyrics-btn')!;
    expect(head.hidden).toBe(false);
    expect(head).toHaveAttribute('aria-pressed', 'true');
    expect(document.getElementById('np-modal-overlay')).toHaveAttribute('data-lyrics-only');
    expect(document.querySelector('.ss-player-record')).toHaveAttribute('data-lyrics-on');
    expect((document.querySelector('[data-lyrics-menu="earlier"]') as HTMLElement).hidden).toBe(
      false,
    );
    expect(document.querySelector('[data-lyrics-offset-state]')!.textContent).toBe('+0.1 s');
    // on a desktop the rows stay hidden (the pill has them); for radio the button goes
    syncChrome(document, s.snapshot(), false);
    expect((document.querySelector('[data-lyrics-menu="smaller"]') as HTMLElement).hidden).toBe(
      true,
    );
    kind = 'radio';
    raw = null;
    s.refresh();
    syncChrome(document, s.snapshot(), true);
    expect(head.hidden).toBe(true);
    expect(document.getElementById('np-modal-overlay')).not.toHaveAttribute('data-lyrics');
  });

  it('allows for the browser’s output delay', () => {
    expect(outputDelay(null)).toBe(0);
    expect(
      outputDelay({ baseLatency: 0.01, outputLatency: 0.04 } as unknown as AudioContext),
    ).toBeCloseTo(0.05);
    expect(outputDelay({ baseLatency: 5 } as unknown as AudioContext)).toBe(0);
  });
});
