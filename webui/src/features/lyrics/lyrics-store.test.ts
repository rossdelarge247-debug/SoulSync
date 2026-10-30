/**
 * The lyrics layer's state (27a–27g): what the player fetched, read and
 * shown; hidden for radio and spoken audio (they stay as today); kept per
 * browser and per track; None found and Instrumental said once for 5 s of
 * being seen; T only where the layer lives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RawLyrics } from './lyrics.logic';

import { LyricsStore, STORAGE } from './lyrics-store';

type W = { SoulSyncPlayer?: unknown };

let raw: RawLyrics | null;
let track: Record<string, unknown> | null;
let kind: string | null;

function lyrics(over: Partial<RawLyrics> = {}): RawLyrics {
  return {
    key: 'Night Ferry|Tidewater|Lantern',
    done: true,
    synced: '[00:01.00]Under a slack-water sky\n[00:04.50]Hold the lantern low',
    plain: null,
    source: 'lrclib',
    instrumental: false,
    fileName: null,
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  track = { id: 't1', title: 'Night Ferry', artist: 'Tidewater', album: 'Lantern' };
  kind = 'library';
  raw = lyrics();
  (window as unknown as W).SoulSyncPlayer = {
    state: () => ({ track, kind }),
    lyricsData: () => raw,
  };
  document.body.innerHTML = '<div id="np-modal-overlay" class="hidden"></div>';
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as W).SoulSyncPlayer;
  document.documentElement.removeAttribute('data-player-sheet');
});

describe('reading the player', () => {
  it('timed lyrics, with their source line; nothing shows until Lyrics is on', () => {
    const s = new LyricsStore(window);
    s.refresh();
    expect(s.snapshot()).toMatchObject({
      state: 'synced',
      source: 'LRCLIB · timed to the line',
      available: true,
      showing: false,
      trackKey: 'lib:t1',
    });
    s.setOn(true);
    expect(s.snapshot().showing).toBe(true);
    expect(localStorage.getItem(STORAGE.on)).toBe('1');
  });

  it('loading while the fetch is out; plain; a file beside the track', () => {
    const s = new LyricsStore(window);
    raw = lyrics({ done: false });
    s.refresh();
    expect(s.snapshot().state).toBe('loading');
    raw = lyrics({
      synced: null,
      plain: 'Words\nMore',
      source: 'sidecar',
      fileName: 'Night Ferry.flac',
    });
    s.refresh();
    expect(s.snapshot().state).toBe('plain');
    expect(s.snapshot().source).toBe(
      'From Night Ferry.txt beside the track · not timed: scrolling with the track',
    );
  });

  it('radio, a podcast and an audiobook stay as today: no layer, no Lyrics only', () => {
    const s = new LyricsStore(window);
    s.setOn(true);
    s.setOnly(true);
    for (const k of ['radio', 'podcast', 'audiobook']) {
      kind = k;
      raw = null;
      s.refresh();
      expect(s.snapshot()).toMatchObject({
        available: false,
        state: 'hidden',
        showing: false,
        onlyActive: false,
      });
    }
    kind = 'library';
    raw = lyrics();
    s.refresh();
    expect(s.snapshot().onlyActive).toBe(true);
  });
});

describe('None found and Instrumental (27g)', () => {
  it('said for 5 s of being seen, then gone; Lyrics stays on; turned on again, said again', () => {
    vi.useFakeTimers();
    const s = new LyricsStore(window);
    s.setOn(true);
    raw = lyrics({ synced: null, plain: null, instrumental: true });
    s.refresh();
    expect(s.snapshot()).toMatchObject({ state: 'instrumental', quiet: true, showing: true });
    // not seen yet: it waits
    vi.advanceTimersByTime(10000);
    expect(s.snapshot().quiet).toBe(true);
    s.seen();
    vi.advanceTimersByTime(4900);
    expect(s.snapshot().showing).toBe(true);
    vi.advanceTimersByTime(200);
    expect(s.snapshot()).toMatchObject({ quiet: false, showing: false, on: true });
    // the same track read again doesn't say it twice
    s.refresh();
    expect(s.snapshot().quiet).toBe(false);
    s.setOn(false);
    s.setOn(true);
    expect(s.snapshot().quiet).toBe(true);
  });

  it('none found, for the next track too', () => {
    const s = new LyricsStore(window);
    s.setOn(true);
    raw = lyrics({ synced: null, plain: null });
    s.refresh();
    expect(s.snapshot().state).toBe('none');
    expect(s.snapshot().title).toBe('Night Ferry');
    track = { id: 't2', title: 'Static Bloom' };
    raw = lyrics({ key: 'Static Bloom||', synced: null, plain: null });
    s.refresh();
    expect(s.snapshot()).toMatchObject({ state: 'none', quiet: true, trackKey: 'lib:t2' });
  });
});

describe('the controls (27a)', () => {
  it('Earlier and Later in 0.1 s steps, kept per track in this browser', () => {
    const s = new LyricsStore(window);
    s.refresh();
    s.nudge(1);
    s.nudge(1);
    s.nudge(1);
    expect(s.snapshot().offset).toBe(0.3);
    track = { id: 't2', title: 'Static Bloom' };
    raw = lyrics({ key: 'other' });
    s.refresh();
    expect(s.snapshot().offset).toBe(0);
    s.nudge(-1);
    expect(s.snapshot().offset).toBe(-0.1);
    const again = new LyricsStore(window);
    track = { id: 't1', title: 'Night Ferry' };
    raw = lyrics();
    again.refresh();
    expect(again.snapshot().offset).toBe(0.3);
    again.resetOffset();
    expect(JSON.parse(localStorage.getItem(STORAGE.offsets)!)).toEqual({ 'lib:t2': -0.1 });
  });

  it('text size and Lyrics only are kept per browser', () => {
    const s = new LyricsStore(window);
    s.stepSize(1);
    s.setOnly(true);
    const again = new LyricsStore(window);
    expect(again.snapshot()).toMatchObject({ size: 56, only: true });
  });

  it('T acts only while the Visuals are open or the phone’s sheet is up, and only for music', () => {
    const s = new LyricsStore(window);
    s.refresh();
    expect(s.key('T')).toBe(false);
    document.getElementById('np-modal-overlay')!.classList.remove('hidden');
    expect(s.key('T')).toBe(true);
    expect(s.snapshot().on).toBe(true);
    expect(s.key('X')).toBe(false);
    document.getElementById('np-modal-overlay')!.classList.add('hidden');
    document.documentElement.setAttribute('data-player-sheet', '');
    expect(s.key('T')).toBe(true);
    expect(s.snapshot().on).toBe(false);
    kind = 'radio';
    raw = null;
    s.refresh();
    expect(s.key('T')).toBe(false);
  });
});
