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

import { AutomixHost, liveKey, liveWords } from './automix-host';
import { BarStatus, HandoverDeck, HandoverRecord, MixNowButton, countWords } from './handover';
import { readPrefs, refreshPrefs } from './prefs';

vi.mock('@/platform/shell/route-controllers', () => ({
  useProfile: () => ({ profileId: 1, isAdmin: true }),
}));
// jsdom has no AudioWorklet: the decks' support is the browser's, tested on its own
const support = vi.hoisted(() => ({ why: null as string | null }));
vi.mock('./support', async (original) => ({
  ...(await original<typeof import('./support')>()),
  mixSupport: () => support.why,
}));
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
      <div id="ss-between-tracks-library"></div>
      <div id="ss-https-note"></div>
      <div data-automix-slot="menu-between"></div>
      <div data-automix-slot="upnext-head"></div>
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
      name: 'How Night Ferry goes into Static Bloom: Long blend · 32 bars, auto. Change it',
    });
    expect(
      screen.getByRole('button', {
        name: 'How Static Bloom goes into Brass Tide: Long blend · 32 bars, auto. Change it',
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
      name: /^How Night Ferry goes into Static Bloom/,
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
    // kept with the track it was chosen for (283)
    expect(queue[0].automix).toEqual({ style: 'echo_out', bars: 4, to: '2' });
    expect(player.persistQueue).toHaveBeenCalled();
    // the picker stays open for the length
    fireEvent.click(within(picker).getByRole('radio', { name: '8 bars' }));
    expect(queue[0].automix).toEqual({ style: 'echo_out', bars: 8, to: '2' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Done' }));
    await screen.findByRole('button', {
      name: 'How Night Ferry goes into Static Bloom: Echo out · 8 bars, your choice. Change it',
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
      await screen.findByRole('button', { name: /^How Night Ferry goes into Static Bloom/ }),
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
    expect(screen.queryByRole('button', { name: /^How .+ goes into/ })).toBeNull();
    expect(document.querySelector('[data-automix-gap]')).toBeNull();
    expect(document.querySelector('[data-automix-mixnow]')).toBeNull();
  });

  it('Mix now beside Next, and X through the player’s keys', async () => {
    mount();
    await screen.findByRole('button', { name: /^How Night Ferry goes into/ });
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

describe('Between tracks, Off / Auto mix, in its places (33e)', () => {
  it('Settings → Library → DJ: two radio cards, the style, key lock and the note; no Mix automatically', async () => {
    mount();
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '#ss-between-tracks-library [data-between-tracks]',
      );
      if (!el) throw new Error('not yet');
      return el;
    });
    const group = within(card).getByRole('radiogroup', { name: 'Between tracks' });
    const cards = within(group).getAllByRole('radio');
    expect(cards.map((c) => c.querySelector('strong')?.textContent)).toEqual(['Off', 'Auto mix']);
    expect(cards[1]).toHaveAttribute('aria-checked', 'true');
    expect(cards[1]).toHaveTextContent(
      "Beat-matched where both tracks are ready; an echo out or a cut where they can't be; straight on where nothing's known.",
    );
    expect(card.textContent).not.toMatch(/crossfade|Mix automatically/i);
    fireEvent.change(within(card).getByRole('combobox', { name: 'Style when Auto can choose' }), {
      target: { value: 'long' },
    });
    expect(localStorage.getItem('soulsync-dj-lean')).toBe('long');
    // 307: Key lock in DJ now, off by default
    const lock = within(card).getByRole('combobox', { name: 'Key lock in DJ now' });
    expect(lock).toHaveValue('off');
    fireEvent.change(lock, { target: { value: 'on' } });
    expect(localStorage.getItem('soulsync-dj-keylock')).toBe('1');
    expect(readPrefs().keyLock).toBe(true);
    expect(card).toHaveTextContent(
      'Not for podcasts, audiobooks or radio. Auto mix needs SYNCHRO.S on https or opened on its own computer. Kept per browser.',
    );
    fireEvent.click(cards[0]);
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('off');
    expect(localStorage.getItem('soulsync-crossfade')).toBe('0');
    // arrows move the choice and the focus together
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('dj');
    localStorage.removeItem('soulsync-dj-lean');
    localStorage.removeItem('soulsync-dj-keylock');
    refreshPrefs();
  });

  it('the same control, small, in Player settings, the "…" and Up next\'s head; Off said once there (320)', async () => {
    localStorage.setItem('soulsync-between-tracks', 'off');
    refreshPrefs();
    mount();
    const head = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-upnext-head]');
      if (!el) throw new Error('not yet');
      return el;
    });
    for (const slot of ['#ss-between-tracks-settings', '[data-automix-slot="menu-between"]']) {
      const box = document.querySelector<HTMLElement>(slot)!;
      const seg = within(box).getByRole('radiogroup', { name: 'Between tracks' });
      expect(
        within(seg)
          .getAllByRole('radio')
          .map((r) => r.textContent),
      ).toEqual(['Off', 'Auto mix']);
    }
    expect(
      within(document.querySelector<HTMLElement>('#ss-between-tracks-settings')!).getByRole(
        'button',
        {
          name: 'Settings → Library → DJ',
        },
      ),
    ).toBeTruthy();
    expect(head).toHaveTextContent('Auto mix is off: tracks play straight on · Turn it on');
    // once, never a line per step
    expect(document.body.textContent?.match(/Auto mix is off/g)?.length).toBe(1);
    fireEvent.click(within(head).getByRole('button', { name: 'Turn it on' }));
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('dj');
    await waitFor(() => expect(head).not.toHaveTextContent('Auto mix is off'));
    expect(within(head).getByRole('radio', { name: 'Auto mix' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('312, one truth: over http Auto mix is still a choice that cuts and plays straight on, said in each place', async () => {
    support.why = 'Auto mix needs SYNCHRO.S on https, or opened on its own computer';
    localStorage.setItem('soulsync-between-tracks', 'off');
    refreshPrefs();
    try {
      mount();
      await waitFor(() => expect(document.querySelector('[data-upnext-head]')).not.toBeNull());
      const autos = screen.getAllByRole('radio', { name: /^Auto mix/ });
      expect(autos.length).toBe(4);
      for (const a of autos) expect(a).not.toHaveAttribute('aria-disabled');
      const words = 'Cuts and straight on only here · blends need https or localhost';
      // the card (as its sentence) and the three small controls
      expect(screen.getAllByText(new RegExp(words)).length).toBe(4);
      fireEvent.click(autos[0]);
      expect(localStorage.getItem('soulsync-between-tracks')).toBe('dj');
      expect(document.querySelector('[data-https-note]')).toHaveAttribute(
        'data-https-note',
        'insecure',
      );
      expect(document.querySelector('[data-https-note]')).toHaveTextContent(
        /Open SYNCHRO.S on https/,
      );
    } finally {
      support.why = null;
    }
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
    cancelled: false,
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
    failed: null,
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
    // 323: hidden until DJ now (Brief E) brings "Open DJ now"
    expect(screen.queryByRole('button', { name: /Decks|DJ now/ })).toBeNull();
    // the phone's line goes only under the mixing sheet (324)
    expect(document.querySelector('[data-automix-phone-note]')).toBeNull();
  });

  it("324: a phone's mixing sheet says 308's words, once", () => {
    render(<HandoverDeck view={view()} actions={actions} phone />);
    expect(document.querySelector('[data-automix-phone-note]')).toHaveTextContent(
      "If a call or the lock stops the sound, SYNCHRO.S cuts to the next track when it's back.",
    );
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
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel: Night Ferry plays out straight on' }),
    );
    expect(actions.cancel).toHaveBeenCalled();
    rerender(<BarStatus view={view()} actions={actions} />);
    expect(screen.getByText('Night Ferry → Static Bloom')).toBeTruthy();
    expect(screen.getByText('Mixing · bar 12 of 32')).toBeTruthy();
    // UX-20: the bar's Back is named for the track it goes back to
    expect(screen.getByRole('button', { name: 'Back to Night Ferry' })).toHaveTextContent('Back');
    rerender(<BarStatus view={view({ stage: 'cut', transition: null })} actions={actions} />);
    expect(document.body.textContent).not.toMatch(/crossfad/i);
  });

  it("314 and 302: a cut on the phrase counts down too, with Cancel and Design's sentence", () => {
    const cut = {
      status: 'cut',
      style: 'cut',
      bars: null,
      fallback: { kind: 'cut', code: 'tempo_gap', reason: 'the tempos are 9.7% apart' },
      out: { start: 280, bar: 112 },
      in: { start: 0 },
    };
    render(
      <BarStatus
        view={view({ stage: 'cut', transition: null, lanes: null, barsToGo: 6, plan: cut })}
        actions={actions}
      />,
    );
    expect(screen.getByText('Cutting to Static Bloom in 6 bars…')).toBeTruthy();
    expect(
      screen.getByText("Couldn't beat-match: cutting on the phrase · the tempos are 9.7% apart"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
    expect(actions.cancel).toHaveBeenCalled();
  });

  it('314: the bar keeps "in 2:58" beside Mix now until the countdown', () => {
    const { rerender } = render(
      <MixNowButton
        view={view({ stage: 'planned', transition: null, inSeconds: 178, canMixNow: true })}
        onMixNow={actions.mixNow}
        compact
      />,
    );
    expect(screen.getByText('in 2:58')).toBeTruthy();
    rerender(
      <MixNowButton
        view={view({ stage: 'planned', transition: null, inSeconds: 20, barsToGo: 10 })}
        onMixNow={actions.mixNow}
        compact
      />,
    );
    expect(screen.queryByText(/^in \d/)).toBeNull();
  });

  it('UX-15: each state is said once, the bar count never; Cancel and Back are said', () => {
    const counting = view({ stage: 'counting', barsToGo: 16 });
    const key = liveKey(counting);
    expect(liveWords(key, counting)).toBe('Mixing into Static Bloom in 16 bars');
    // the next bar doesn't change what's said
    expect(liveKey(view({ stage: 'counting', barsToGo: 15 }))).toBe(key);
    expect(liveWords(liveKey(view({ stage: 'mixing' })), view())).toBe('Mixing now');
    expect(liveWords(liveKey(view({ stage: 'handback' })), view())).toBe(
      'Now playing Static Bloom',
    );
    const cancelled = view({ stage: 'planned', transition: null, cancelled: true });
    expect(liveWords(liveKey(cancelled), cancelled)).toBe('Mix cancelled');
    expect(liveWords(liveKey(view({ stage: 'back' })), view())).toBe('Back to Night Ferry');
  });
});

describe('no crossfade on a page that can’t run the decks', () => {
  it('Up next says the pairs that need the decks play straight on, and Mix now says why', async () => {
    support.why = 'Auto mix needs SYNCHRO.S on https';
    try {
      mount();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });
      expect(document.querySelector('[data-automix-gap]')).not.toBeNull();
      // a blend needs the decks: the chip says it plays straight on, and why
      const chip = await screen.findByRole('button', {
        name: /^How Night Ferry goes into Static Bloom: Straight on/,
      });
      expect(chip.parentElement).toHaveTextContent('blends need https or localhost');
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

describe('[review] Mix automatically is gone: said once to whoever had it off', () => {
  it("migrates once, says so in Up next's head with Off and Dismiss, and never again", async () => {
    localStorage.removeItem('soulsync-dj-auto-migrated');
    localStorage.removeItem('soulsync-dj-auto-gone');
    localStorage.setItem('soulsync-dj-auto', '0');
    refreshPrefs();
    expect(localStorage.getItem('soulsync-dj-auto')).toBe('1');
    expect(localStorage.getItem('soulsync-dj-auto-migrated')).toBe('1');
    mount();
    const notice = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-automix-auto-gone]');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(notice).toHaveTextContent(
      'Mix automatically is gone: Auto mix now mixes every pair. Choose Off to play tracks straight on.',
    );
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(document.querySelector('[data-automix-auto-gone]')).toBeNull());
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('dj');
    // something writing the old 0 again later isn't migrated a second time
    localStorage.setItem('soulsync-dj-auto', '0');
    refreshPrefs();
    expect(readPrefs().autoGone).toBe(false);
  });

  it('Off from the notice turns Auto mix off and closes it', async () => {
    localStorage.removeItem('soulsync-dj-auto-migrated');
    localStorage.setItem('soulsync-dj-auto', '0');
    refreshPrefs();
    mount();
    const notice = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-automix-auto-gone]');
      if (!el) throw new Error('not yet');
      return el;
    });
    fireEvent.click(within(notice).getByRole('button', { name: 'Off' }));
    expect(localStorage.getItem('soulsync-between-tracks')).toBe('off');
    expect(localStorage.getItem('soulsync-dj-auto-gone')).toBe('0');
  });
});

describe('[review] the countdown of an echo out placed by time counts seconds, not bars', () => {
  it('says "in 12 s" where there are no bars to count', () => {
    const echo = {
      status: 'ok',
      style: 'echo_out',
      bars: 4,
      fallback: { kind: 'echo_out', code: 'no_beat', reason: 'Sand Script has no steady beat' },
      out: { start: 120, bar: null },
      in: { start: 0.2, bar: 0 },
    };
    const v = view({
      stage: 'planned',
      transition: null,
      lanes: null,
      barsToGo: 6,
      inSeconds: 11.4,
      plan: echo,
    });
    expect(countWords(v)).toBe('12 s');
    render(<BarStatus view={v} actions={actions} />);
    expect(screen.getByText('Mixing into Static Bloom in 12 s…')).toBeTruthy();
    expect(liveWords('counting:2', v)).toBe('Mixing into Static Bloom in 12 s');
    expect(countWords(view({ stage: 'counting', barsToGo: 6 }))).toBe('6 bars');
  });
});

describe("UX-9: a mix that couldn't start says so", () => {
  it('in the bar and the tray, with Try again, and once to a screen reader', () => {
    const failed = view({
      stage: 'idle',
      transition: null,
      barsToGo: null,
      failed: "the tracks didn't load in time",
    });
    const mixNow = vi.fn();
    const actions = { mixNow, cancel: vi.fn(), finishNow: vi.fn(), back: vi.fn() };
    const bar = render(<BarStatus view={failed} actions={actions} />);
    const line = bar.container.querySelector('[data-automix-failed]')!;
    expect(line).toHaveTextContent(
      "Couldn't start the mixthe tracks didn't load in time · Night Ferry plays on straight",
    );
    fireEvent.click(within(line as HTMLElement).getByRole('button', { name: 'Try again' }));
    expect(mixNow).toHaveBeenCalledTimes(1);
    bar.unmount();
    const deck = render(<HandoverDeck view={failed} actions={actions} />);
    expect(deck.container.querySelector('[data-automix-deck="failed"]')).toBeTruthy();
    deck.unmount();
    expect(liveWords(liveKey(failed), failed)).toBe(
      "Couldn't start the mix: the tracks didn't load in time. Night Ferry plays on straight",
    );
    // Mix now keeps the reason on its title, and stays pressable for another go
    const button = render(<MixNowButton view={{ ...failed, canMixNow: true }} onMixNow={mixNow} />);
    expect(button.getByRole('button', { name: /Mix now/ })).toHaveAttribute(
      'title',
      "Couldn't start the mix: the tracks didn't load in time. Try again (X)",
    );
  });
});
