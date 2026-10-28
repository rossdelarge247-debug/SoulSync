/**
 * Auto-mix in the player (26a–26h) placed into the shell's markup: Up next's
 * chips (only with DJ mix on), the floating style picker, the first gap's
 * "in 2:58", Mix now and X, the waveform's mark, and Player settings →
 * Between tracks; then the handover's pieces as they draw a mix (26d, 26e).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DJ_ANALYSED_EVENT,
  analysisStore,
  resetAnalysisRequests,
} from '@/features/dj/analysis.api';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import type { AutomixView } from './controller';

import { AutomixHost } from './automix-host';
import { BarStatus, HandoverDeck, HandoverRecord } from './handover';
import { readPrefs, refreshPrefs } from './prefs';

vi.mock('@/platform/shell/route-controllers', () => ({
  useProfile: () => ({ profileId: 1, isAdmin: true }),
}));
// jsdom has no AudioWorklet: the decks' support is the browser's, tested on its own
const support = vi.hoisted(() => ({ why: null as string | null }));
vi.mock('./support', () => ({ mixSupport: () => support.why }));
const saved = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./set-play', async (original) => ({
  ...(await original<typeof import('./set-play')>()),
  saveTransitionToSet: async (...args: unknown[]) => {
    saved.calls.push(args);
  },
}));

function track(id: string, title: string) {
  return { id, title, artist: 'Tidewater', file_path: `/m/${id}.flac`, is_library: true } as Record<
    string,
    unknown
  >;
}

let queue: Record<string, unknown>[];
/** analyse on demand: what the host asked for, and the progress route's tracks */
let asked: unknown[] = [];
let progress: Record<string, unknown> = {};
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
  resetAnalysisRequests();
  analysisStore.reset();
  asked = [];
  progress = {};
  server.use(
    http.post('*/api/library/dj/analyse', async ({ request }) => {
      asked.push(await request.json());
      return HttpResponse.json(
        {
          success: true,
          asked: 3,
          queued: 1,
          already_queued: 0,
          already_done: 2,
          cant: 0,
          over_limit: 0,
          limit: 200,
          yours: 1,
          started: true,
        },
        { status: 202 },
      );
    }),
    http.post('*/api/library/dj/progress', () =>
      HttpResponse.json({ success: true, tracks: progress, sweep: { running: true } }),
    ),
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

function mount(qc = createTestQueryClient()) {
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

  it('[gauntlet L2] a transition saved to its set: the set’s page reads it again', async () => {
    const mixSet = { id: 9, name: 'Sunday Set', row: 0, transition: null };
    queue[0].mix_set = mixSet;
    queue[1].mix_set = { ...mixSet, row: 1 };
    const qc = createTestQueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    mount(qc);
    fireEvent.click(
      await screen.findByRole('button', { name: /^Transition from Night Ferry to Static Bloom/ }),
    );
    const picker = await screen.findByRole('dialog', {
      name: 'How Night Ferry goes into Static Bloom',
    });
    fireEvent.click(within(picker).getByRole('radio', { name: 'Echo out' }));
    fireEvent.click(await within(picker).findByRole('button', { name: 'Save to Sunday Set' }));
    await within(picker).findByText('Saved to Sunday Set.');
    expect(saved.calls).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sets', 'set', 1, 9] });
  });

  it('no chips with DJ mix off; they come with it', async () => {
    localStorage.setItem('soulsync-between-tracks', 'off');
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

describe('analyse on demand in Up next', () => {
  const waitingFor2 = () =>
    server.use(
      http.get('*/api/library/dj/plan', ({ request }) => {
        const u = new URL(request.url);
        const waits = u.searchParams.get('to') === '2' || u.searchParams.get('from') === '2';
        return HttpResponse.json({
          success: true,
          plan: waits
            ? {
                status: 'waiting',
                style: null,
                bars: null,
                waiting_for: u.searchParams.get('to') === '2' ? 'to' : 'from',
                reason: 'not_analyzed',
                why: 'Waiting for the analysis',
                styles: [],
                key: { from: '8A', to: null, relation: null },
                tempo: null,
              }
            : {
                status: 'ok',
                style: 'long_blend',
                bars: 32,
                beatmatch: true,
                why: '8A → 9A, +2 BPM: the keys mix and the tempo is close',
                pair: '8A → 9A, +2 BPM',
                key: { from: '8A', to: '9A', relation: 'up' },
                tempo: { relation: 'same', rate: 0.98, speed_change_ok: true },
                out: { start: 278.2, bar: 140 },
                in: { start: 0.2, bar: 0 },
                length_s: 62,
                styles: [],
              },
        });
      }),
    );

  it("with DJ mix on, the queue's coming tracks jump the analysis queue", async () => {
    mount();
    // "Up next" is why they're in line (the popover's words, Brief A); the
    // next transition's pair goes ahead of every other ask (review L10)
    await waitFor(
      () =>
        expect(asked).toEqual([
          { track_ids: ['1', '2'], reason: 'auto', source: 'up_next', soon: true },
          { track_ids: ['3'], reason: 'auto', source: 'up_next' },
        ]),
      { timeout: 3000 },
    );
  });

  it('[re-review L10] a pair turned away by a Stop goes as soon again after it', async () => {
    let held = true;
    server.use(
      http.post('*/api/library/dj/analyse', async ({ request }) => {
        asked.push(await request.json());
        if (held)
          return HttpResponse.json(
            { success: false, code: 'held', error: 'Analysis is stopped' },
            { status: 409 },
          );
        return HttpResponse.json({ success: true, asked: 2, queued: 2 }, { status: 202 });
      }),
    );
    mount();
    await waitFor(() => expect(asked).toHaveLength(2), { timeout: 3000 });
    // Resume: the next drawing of Up next asks for the same pair as soon again
    held = false;
    asked = [];
    act(() => {
      window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: 'queue' } }));
    });
    await waitFor(
      () =>
        expect(asked).toContainEqual({
          track_ids: ['1', '2'],
          reason: 'auto',
          source: 'up_next',
          soon: true,
        }),
      { timeout: 3000 },
    );
  });

  it('with DJ mix off nothing is asked for', async () => {
    localStorage.setItem('soulsync-between-tracks', 'off');
    refreshPrefs();
    mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(asked).toEqual([]);
  });

  it('a Waiting chip shows the step of the track it waits for (31c)', async () => {
    waitingFor2();
    progress = { '2': { state: 'working', step: 'key', percent: 35 } };
    mount();
    // the chip's line is the analysis: the bar (3 of 6) and the step, named
    const words = await screen.findAllByText('Analysing Static Bloom · key (3 of 6)');
    const marker = words[0]!.closest('[data-analysis-marker]')!;
    expect(marker.querySelector('[data-step="3"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Analyse now' })).toBeNull();
  });

  it('once it is analysed, the pair is planned again', async () => {
    // a pair no other test planned (the shared controller keeps its answers)
    queue = [track('7', 'Sand Script'), track('2', 'Static Bloom')];
    waitingFor2();
    mount();
    await waitFor(() => expect(window.SoulSyncAutomix?.view().plan?.status).toBe('waiting'));
    server.use(
      http.get('*/api/library/dj/plan', () =>
        HttpResponse.json({
          success: true,
          plan: {
            status: 'ok',
            style: 'long_blend',
            bars: 32,
            beatmatch: true,
            why: 'the keys mix',
            pair: '8A → 9A',
            key: { from: '8A', to: '9A', relation: 'up' },
            tempo: { relation: 'same', rate: 0.98, speed_change_ok: true },
            out: { start: 278.2, bar: 140 },
            in: { start: 0.2, bar: 0 },
            length_s: 62,
            styles: [],
          },
        }),
      ),
    );
    act(() => {
      window.dispatchEvent(new CustomEvent(DJ_ANALYSED_EVENT, { detail: { ids: ['2'] } }));
    });
    await waitFor(() => expect(window.SoulSyncAutomix?.view().plan?.status).toBe('ok'));
  });
});

describe('Player settings → Between tracks (26h)', () => {
  it('Off / Auto mix (no crossfade); Auto mix adds Mix automatically and Auto’s lean', async () => {
    mount();
    const group = await screen.findByRole('radiogroup', { name: 'Between tracks' });
    const cards = within(group).getAllByRole('radio');
    expect(cards.map((c) => c.querySelector('strong')?.textContent)).toEqual(['Off', 'Auto mix']);
    expect(cards[1]).toHaveAttribute('aria-checked', 'true');
    expect(group.textContent).not.toMatch(/crossfade/i);
    expect(screen.getByRole('switch', { name: 'Mix automatically' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Mix automatically' }));
    expect(localStorage.getItem('soulsync-dj-auto')).toBe('0');
    expect(
      screen.getByText('Off: Auto mix waits for Mix now, and tracks play to their end.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: /Style when Auto can choose/ }), {
      target: { value: 'long' },
    });
    expect(localStorage.getItem('soulsync-dj-lean')).toBe('long');
    fireEvent.click(cards[0]);
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('off');
    expect(localStorage.getItem('soulsync-crossfade')).toBe('0');
    expect(screen.queryByRole('switch', { name: 'Mix automatically' })).toBeNull();
    expect(screen.getByText(/Podcasts, audiobooks and radio always play as Off/)).toBeTruthy();
    fireEvent.click(cards[1]);
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('dj');
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

  it('the bar: counting down in bars with Cancel; mixing with both titles; no crossfade line', () => {
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
    rerender(<BarStatus view={view({ stage: 'cut', transition: null })} actions={actions} />);
    expect(document.body.textContent).not.toMatch(/crossfad/i);
  });
});

describe('no crossfade on a page that can’t run the decks', () => {
  it('Up next shows no chips (the pairs play on), and Mix now says why', async () => {
    support.why = 'Auto mix needs SYNCHRO.S on https';
    try {
      mount();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });
      expect(document.querySelector('[data-automix-gap]')).not.toBeNull();
      expect(screen.queryByRole('button', { name: /^Transition from/ })).toBeNull();
      expect(document.body.textContent).not.toMatch(/crossfad/i);
      await waitFor(() =>
        expect(window.SoulSyncAutomix?.view().mixNowWhy).toBe('Auto mix needs SYNCHRO.S on https'),
      );
    } finally {
      support.why = null;
    }
  });
});

describe('no crossfade: the stored setting moves on (Ross, 27 October)', () => {
  it('Smart crossfade and the old crossfade switch become Off; DJ mix is Auto mix', () => {
    localStorage.setItem('soulsync-between-tracks', 'smart');
    localStorage.setItem('soulsync-crossfade', '1');
    expect(readPrefs().between).toBe('off');
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('off');
    expect(localStorage.getItem('soulsync-crossfade')).toBe('0');
    localStorage.removeItem('soulsync-between-tracks');
    localStorage.setItem('soulsync-crossfade', '1');
    expect(readPrefs().between).toBe('off');
    expect(localStorage.getItem('soulsync-crossfade')).toBe('0');
    localStorage.setItem('soulsync-between-tracks', 'dj');
    expect(readPrefs().between).toBe('dj');
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('dj');
  });
});
