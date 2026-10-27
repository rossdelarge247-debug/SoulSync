/**
 * Auto-mix in the player (26a–26h) placed into the shell's markup: Up next's
 * chips (only with DJ mix on), the floating style picker, the first gap's
 * "in 2:58", Mix now and X, the waveform's mark, and Player settings →
 * Between tracks; then the handover's pieces as they draw a mix (26d, 26e).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import type { AutomixView } from './controller';

import { AutomixHost } from './automix-host';
import { BarStatus, HandoverDeck, HandoverRecord } from './handover';
import { refreshPrefs } from './prefs';

vi.mock('@/platform/shell/route-controllers', () => ({
  useProfile: () => ({ profileId: 1, isAdmin: true }),
}));
// jsdom has no AudioWorklet: the decks' support is the browser's, tested on its own
vi.mock('./support', () => ({ mixSupport: () => null }));

function track(id: string, title: string) {
  return { id, title, artist: 'Tidewater', file_path: `/m/${id}.flac`, is_library: true } as Record<
    string,
    unknown
  >;
}

let queue: Record<string, unknown>[];
let audio: {
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
} & EventTarget;
let player: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;

function drawQueue() {
  const list = document.getElementById('np-queue-list')!;
  list.textContent = '';
  const gaps = window.SoulSyncAutomix?.gapsWanted() ?? false;
  queue.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'np-queue-item';
    row.textContent = String(t.title);
    list.appendChild(row);
    if (gaps && i < queue.length - 1) {
      const gap = document.createElement('div');
      gap.dataset.automixGap = String(i);
      list.appendChild(gap);
    }
  });
  window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'queue' } }));
}

beforeEach(() => {
  document.body.innerHTML = `
    <section id="media-player">
      <div class="ss-player-wave" data-player-wave></div>
      <span data-automix-slot="mixnow-bar"></span>
      <div data-automix-slot="bar"></div>
      <div data-automix-slot="record"></div>
      <div data-automix-slot="deck"></div>
      <span data-automix-slot="mixnow-deck"></span>
      <div id="ss-between-tracks-settings"></div>
      <div id="np-queue-list"></div>
    </section>`;
  queue = [track('1', 'Night Ferry'), track('2', 'Static Bloom'), track('3', 'Brass Tide')];
  audio = Object.assign(new EventTarget(), {
    currentTime: 100,
    duration: 300,
    paused: false,
    playbackRate: 1,
  });
  player = {
    state: () => ({
      track: queue[0],
      kind: 'library',
      playing: true,
      queue,
      index: 0,
      shuffle: false,
      repeat: 'off',
      volume: 70,
      muted: false,
      crossfadeSeconds: 6,
    }),
    audio: () => audio,
    playIndex: vi.fn(async () => ({ status: 'played' })),
    crossfadeInto: vi.fn(() => true),
    insertNext: vi.fn(() => 1),
    renderQueue: vi.fn(() => drawQueue()),
    persistQueue: vi.fn(),
    setCrossfade: vi.fn((on: boolean) =>
      localStorage.setItem('soulsync-crossfade', on ? '1' : '0'),
    ),
  };
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = player;
  localStorage.setItem('soulsync-between-tracks', 'dj');
  refreshPrefs();
  server.use(
    http.get('*/api/library/dj/plan', ({ request }) => {
      const u = new URL(request.url);
      const style = u.searchParams.get('style') ?? 'auto';
      const chosen = style === 'auto' ? 'long_blend' : style;
      return HttpResponse.json({
        success: true,
        plan: {
          status: 'ok',
          style: chosen,
          bars: Number(u.searchParams.get('bars')) || (chosen === 'echo_out' ? 4 : 32),
          beatmatch: true,
          why: style === 'auto' ? '8A → 9A, +2 BPM: the keys mix and the tempo is close' : null,
          pair: '8A → 9A, +2 BPM',
          key: { from: '8A', to: '9A', relation: 'up' },
          tempo: {
            relation: 'same',
            rate: 0.98,
            speed_change_ok: true,
            from_bpm: 124,
            to_bpm: 126,
          },
          out: { start: 278.2, bar: 140 },
          in: { start: 0.2, bar: 0 },
          length_s: 62,
          styles: [
            {
              style: 'drop_swap',
              label: 'Drop swap',
              available: false,
              why: 'no drop found in Static Bloom',
            },
          ],
        },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
  localStorage.removeItem('soulsync-between-tracks');
  localStorage.removeItem('soulsync-crossfade');
  refreshPrefs();
});

function mount() {
  const qc = createTestQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AutomixHost />
    </QueryClientProvider>,
  );
}

describe('Up next with DJ mix on (26a, 26b)', () => {
  it('a chip in every gap, the first saying when it starts', async () => {
    mount();
    const first = await screen.findByRole('button', {
      name: 'Transition from Night Ferry to Static Bloom: Long blend · 32 bars, auto. Change it',
    });
    expect(
      screen.getByRole('button', {
        name: 'Transition from Static Bloom to Brass Tide: Long blend · 32 bars, auto. Change it',
      }),
    ).toBeTruthy();
    const gap = first.closest('[data-automix-gap]')!;
    expect(gap).toHaveTextContent('auto · 8A → 9A, +2 BPM');
    // Design's 249: out.start less the playback position
    await waitFor(() => expect(gap).toHaveTextContent('in 2:58'));
    // the waveform marks where the mix starts
    const wave = document.querySelector<HTMLElement>('[data-player-wave]')!;
    await waitFor(() => expect(wave.dataset.automixMark).toBe(''));
    expect(wave.style.getPropertyValue('--automix-at')).toBe('92.73%');
  });

  it('the picker floats over the tray; a style chosen lasts for this queue, as yours', async () => {
    mount();
    const chip = await screen.findByRole('button', {
      name: /^Transition from Night Ferry to Static Bloom/,
    });
    fireEvent.click(chip);
    const picker = await screen.findByRole('dialog', {
      name: 'How Night Ferry goes into Static Bloom',
    });
    expect(picker.parentElement).toBe(document.body);
    const radios = within(picker).getAllByRole('radio').slice(0, 8);
    expect(radios[0]).toHaveAttribute('aria-label', 'Auto: Long blend');
    expect(radios[7]).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(radios[7]);
    expect(queue[0].automix).toBeUndefined();
    fireEvent.click(within(picker).getByRole('radio', { name: 'Echo out' }));
    expect(queue[0].automix).toEqual({ style: 'echo_out', bars: 4 });
    expect(player.persistQueue).toHaveBeenCalled();
    // the picker stays open for the length
    fireEvent.click(within(picker).getByRole('radio', { name: '8 bars' }));
    expect(queue[0].automix).toEqual({ style: 'echo_out', bars: 8 });
    fireEvent.click(within(picker).getByRole('button', { name: 'Done' }));
    await screen.findByRole('button', {
      name: 'Transition from Night Ferry to Static Bloom: Echo out · 8 bars, your choice. Change it',
    });
  });

  it('no chips with DJ mix off; they come with it', async () => {
    localStorage.setItem('soulsync-between-tracks', 'smart');
    refreshPrefs();
    mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole('button', { name: /^Transition from/ })).toBeNull();
    expect(document.querySelector('[data-automix-gap]')).toBeNull();
    expect(document.querySelector('[data-automix-mixnow]')).toBeNull();
  });

  it('Mix now beside Next, and X through the player’s keys', async () => {
    mount();
    await screen.findByRole('button', { name: /^Transition from Night Ferry/ });
    const buttons = await screen.findAllByRole('button', { name: 'Mix now' });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('aria-keyshortcuts', 'X');
    await waitFor(() => expect(window.SoulSyncAutomix?.view().canMixNow).toBe(true));
    expect(window.SoulSyncAutomix?.key('Q')).toBe(false);
    expect(window.SoulSyncAutomix?.key('X')).toBe(true);
    await waitFor(() => expect(window.SoulSyncAutomix?.view().manual).toBe(true));
  });
});

describe('Player settings → Between tracks (26h)', () => {
  it('Off / Smart crossfade / DJ mix; DJ mix adds Mix automatically and Auto’s lean', async () => {
    mount();
    const group = await screen.findByRole('radiogroup', { name: 'Between tracks' });
    const cards = within(group).getAllByRole('radio');
    expect(cards.map((c) => c.querySelector('strong')?.textContent)).toEqual([
      'Off',
      'Smart crossfade',
      'DJ mix',
    ]);
    expect(cards[2]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Mix automatically' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Mix automatically' }));
    expect(localStorage.getItem('soulsync-dj-auto')).toBe('0');
    expect(
      screen.getByText('Off: DJ mix waits for Mix now, and tracks play to their end.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: /Style when Auto can choose/ }), {
      target: { value: 'long' },
    });
    expect(localStorage.getItem('soulsync-dj-lean')).toBe('long');
    fireEvent.click(cards[1]);
    expect(player.setCrossfade).toHaveBeenCalledWith(true);
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('smart');
    expect(screen.queryByRole('switch', { name: 'Mix automatically' })).toBeNull();
    expect(screen.getByText(/Podcasts, audiobooks and radio always play as Off/)).toBeTruthy();
    fireEvent.click(cards[0]);
    expect(player.setCrossfade).toHaveBeenLastCalledWith(false);
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('off');
    localStorage.removeItem('soulsync-dj-auto');
    localStorage.removeItem('soulsync-dj-lean');
  });
});

function view(over: Partial<AutomixView> = {}): AutomixView {
  return {
    dj: true,
    stage: 'mixing',
    pair: {
      fromId: '1',
      toId: '2',
      fromTitle: 'Night Ferry',
      fromArtist: 'Tidewater',
      toTitle: 'Static Bloom',
      toArtist: 'Saltmarsh',
      toIndex: 1,
      choice: { style: 'auto', bars: null },
      fromSet: null,
    },
    plan: null,
    planError: null,
    loadError: null,
    inSeconds: null,
    outStart: 155,
    barsToGo: null,
    manual: false,
    transition: {
      phase: 'mixing',
      style: 'long_blend',
      label: 'Long blend',
      bar: 12,
      bars: 32,
      secondsLeft: 23,
      beatmatch: true,
      marker: { beat: 64, label: 'bass swap' },
      modes: { out: 'resample', in: 'resample' },
      rates: { out: 1.006, in: 0.984 },
      fallback: null,
      canGoBack: true,
    },
    phi: 45,
    lanes: {
      phi0: -8,
      phi1: 136,
      beats: 128,
      marker: { beat: 64, label: 'bass swap' },
      a: { levels: new Float32Array(160).fill(0.6) },
      b: { levels: new Float32Array(160).fill(0.4) },
    },
    fallback: null,
    canMixNow: false,
    mixNowWhy: 'Mixing now',
    incomingBpm: { bpm: 124, pct: -1.6 },
    unsupported: null,
    ...over,
  };
}

const actions = { mixNow: vi.fn(), cancel: vi.fn(), finishNow: vi.fn(), back: vi.fn() };

describe('the handover (26d–26f)', () => {
  it('the record: both tracks, going out and coming in with its tempo change', () => {
    render(<HandoverRecord view={view()} />);
    expect(screen.getByText('Mixing · bar 12 of 32')).toBeTruthy();
    expect(screen.getByText('Tidewater · going out')).toBeTruthy();
    expect(screen.getByText('Saltmarsh · coming in · 124.0 (−1.6%)')).toBeTruthy();
  });

  it('the lanes on one bar ruler, the line, Back, Finish now; Decks waits', () => {
    render(<HandoverDeck view={view()} actions={actions} />);
    expect(screen.getByRole('img', { name: /The mix's 32 bars/ })).toBeTruthy();
    expect(
      screen.getByText('Long blend · 32 bars · bass swaps at bar 16 · 0:23 left'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Night Ferry' }));
    expect(actions.back).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish now' }));
    expect(actions.finishNow).toHaveBeenCalled();
    const decks = screen.getByRole('button', { name: 'Watch it on Decks' });
    expect(decks).toHaveAttribute('aria-disabled', 'true');
    expect(decks).toHaveAccessibleDescription('Decks comes in a later step');
  });

  it('Back near the end is disabled with why (305)', () => {
    render(
      <HandoverDeck
        view={view({ transition: { ...view().transition!, canGoBack: false } })}
        actions={actions}
      />,
    );
    const back = screen.getByRole('button', { name: 'Back to Night Ferry' });
    expect(back).toHaveAttribute('aria-disabled', 'true');
    expect(back).toHaveAccessibleDescription('Too near the end of Night Ferry to go back');
  });

  it('the bar: counting down in bars with Cancel; mixing with both titles; the fallback’s line', () => {
    const { rerender } = render(
      <BarStatus
        view={view({ stage: 'planned', transition: null, lanes: null, barsToGo: 6 })}
        actions={actions}
      />,
    );
    expect(screen.getByText('Mixing into Static Bloom in 6 bars…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(actions.cancel).toHaveBeenCalled();
    rerender(<BarStatus view={view()} actions={actions} />);
    expect(screen.getByText('Night Ferry → Static Bloom')).toBeTruthy();
    expect(screen.getByText('Mixing · bar 12 of 32')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    rerender(
      <BarStatus
        view={view({
          stage: 'fallback',
          transition: null,
          fallback: 'Sand Script has no steady beat',
        })}
        actions={actions}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      "Couldn't beat-match: crossfading · Sand Script has no steady beat",
    );
  });
});
