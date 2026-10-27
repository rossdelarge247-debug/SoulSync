/**
 * The player's side of auto-mix (stage C), through the REAL functions of
 * static/media-player.js:
 *
 * - the crossfade asks auto-mix for a hint: Smart crossfade starts where it
 *   says (a downbeat, past the silence), the next track past its own
 *   silence and at the last one's loudness, then back to its own level;
 *   with none it's the plain crossfade, exactly as before; DJ mix with none
 *   doesn't crossfade (its decks mix, or the track plays to its end); an
 *   album in order stays gapless;
 * - 'ended' leaves the advance to auto-mix while its decks play;
 * - Up next draws a gap after each row from the playing one while DJ mix is
 *   on, and none without it;
 * - Between tracks is read from its own key, else from the crossfade's.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractFunction } from './vanilla-extract';

const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const pick = (...names: string[]) => names.map((n) => extractFunction(n, source)).join('\n');

afterEach(() => {
  delete (window as unknown as { SoulSyncAutomix?: unknown }).SoulSyncAutomix;
  localStorage.removeItem('soulsync-between-tracks');
  vi.useRealTimers();
});

describe('Between tracks', () => {
  it('its own key, else the crossfade’s switch', () => {
    const read = new Function(
      'localStorage',
      'on',
      `const NP_BETWEEN_KEY = 'soulsync-between-tracks'; let npCrossfadeOn = on;
       ${pick('npBetweenTracks')} return npBetweenTracks();`,
    );
    const store = (v: string | null) => ({ getItem: () => v });
    expect(read(store(null), false)).toBe('off');
    expect(read(store(null), true)).toBe('smart');
    expect(read(store('dj'), true)).toBe('dj');
    expect(read(store('nonsense'), false)).toBe('off');
    const throws = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(read(throws, true)).toBe('smart');
  });
});

function tickHarness(opts: {
  between?: string;
  crossfadeOn?: boolean;
  hint?: unknown;
  owns?: () => boolean;
}) {
  const started: unknown[] = [];
  const crossfade = vi.fn(() => opts.hint ?? null);
  (window as unknown as { SoulSyncAutomix: unknown }).SoulSyncAutomix = {
    crossfade,
    ownsAdvance: opts.owns ?? (() => false),
  };
  localStorage.setItem('soulsync-between-tracks', opts.between ?? 'smart');
  const audioPlayer = { duration: 300, currentTime: 0 };
  const tick = new Function(
    'window',
    'localStorage',
    'audioPlayer',
    'started',
    `const NP_BETWEEN_KEY = 'soulsync-between-tracks';
     let npCrossfadeOn = ${opts.crossfadeOn ?? true}, npXfadeActive = false, npRepeatMode = 'off',
       npSleepEndOfTrack = false, npShuffleOn = false, npQueueIndex = 0, currentTrack = { id: '1' };
     const npQueue = [{ id: '1', is_library: true, file_path: '/a' }, { id: '2', is_library: true, file_path: '/b' }];
     const npCrossfadeSeconds = () => 6;
     const npStartCrossfade = (i, next, hint) => started.push({ i, id: next.id, hint });
     ${pick('npBetweenTracks', 'npAutomix', 'npAutomixOwnsAdvance', 'npCrossfadeTick')}
     return npCrossfadeTick;`,
  )(window, localStorage, audioPlayer, started) as () => void;
  return {
    started,
    crossfade,
    at(t: number) {
      audioPlayer.currentTime = t;
      tick();
    },
  };
}

describe('the crossfade’s timing', () => {
  it('plain, with no hint: the last 6 s, as it always was', () => {
    const h = tickHarness({});
    h.at(293.9);
    expect(h.started).toHaveLength(0);
    h.at(294.1);
    expect(h.started).toEqual([{ i: 1, id: '2', hint: null }]);
    // auto-mix is asked about the queue's own rows (they have the file and the chip)
    expect(h.crossfade).toHaveBeenCalledWith(
      { id: '1', is_library: true, file_path: '/a' },
      { id: '2', is_library: true, file_path: '/b' },
      1,
    );
  });

  it('Smart crossfade: where auto-mix says, with its hint', () => {
    const hint = { startAt: 280.5, inAt: 1.2, gain: 0.8 };
    const h = tickHarness({ hint });
    h.at(280);
    expect(h.started).toHaveLength(0);
    h.at(280.6);
    expect(h.started).toEqual([{ i: 1, id: '2', hint }]);
  });

  it('an album in order stays gapless', () => {
    const h = tickHarness({ hint: { skip: true } });
    h.at(299);
    expect(h.started).toHaveLength(0);
  });

  it('DJ mix: no hint, no crossfade (the decks mix, or it plays to its end); a fallback’s does', () => {
    const none = tickHarness({ between: 'dj', crossfadeOn: false });
    none.at(299.5);
    expect(none.started).toHaveLength(0);
    const fallback = tickHarness({
      between: 'dj',
      crossfadeOn: false,
      hint: { startAt: 250, seconds: 6, inAt: 3 },
    });
    fallback.at(250.1);
    expect(fallback.started).toHaveLength(1);
  });

  it('Off: nothing', () => {
    const h = tickHarness({ between: 'off', crossfadeOn: false, hint: { startAt: 1 } });
    h.at(299);
    expect(h.started).toHaveLength(0);
  });
});

describe('[gauntlet H3] a set played as a mix, with Smart crossfade on', () => {
  it('no plain crossfade over the decks while they own the advance; as before once they let go', () => {
    let owns = true;
    const h = tickHarness({ between: 'smart', hint: { startAt: 280, inAt: 1 }, owns: () => owns });
    h.at(280.5);
    h.at(294.5);
    h.at(299.5);
    expect(h.started).toHaveLength(0);
    expect(h.crossfade).not.toHaveBeenCalled();
    owns = false;
    h.at(294.6);
    expect(h.started).toHaveLength(1);
  });
});

describe('[gauntlet H2] every loader that isn’t the queue’s tells auto-mix first', () => {
  it.each([
    'clearTrack',
    'startStream',
    'stopStream',
    'npPlayMedia',
    'npPlayRadio',
    'startAudioPlayback',
  ])('%s calls the stop hook before anything else', (name) => {
    const body = extractFunction(name, source);
    const first = body
      .slice(body.indexOf(') {') + 3)
      .trim()
      .split('\n')[0];
    expect(first).toContain('npAutomixStop()');
  });

  it('the hook reaches auto-mix, and never throws into playback', () => {
    const stop = vi.fn();
    const run = new Function(
      'window',
      `${pick('npAutomix', 'npAutomixStop')} return npAutomixStop;`,
    )(window) as () => void;
    (window as unknown as { SoulSyncAutomix: unknown }).SoulSyncAutomix = { stop };
    run();
    expect(stop).toHaveBeenCalledTimes(1);
    (window as unknown as { SoulSyncAutomix: unknown }).SoulSyncAutomix = {
      stop: () => {
        throw new Error('gone');
      },
    };
    expect(() => run()).not.toThrow();
    delete (window as unknown as { SoulSyncAutomix?: unknown }).SoulSyncAutomix;
    expect(() => run()).not.toThrow();
  });
});

describe('the crossfade with a hint', () => {
  beforeEach(() => vi.useFakeTimers());

  it('starts the next track past its silence and at the last one’s loudness, then settles', async () => {
    const finished: unknown[] = [];
    const xa = {
      src: '',
      volume: 1,
      play: vi.fn(async () => {}),
      pause: vi.fn(),
    };
    const audioPlayer = { volume: 0.5 };
    const start = new Function(
      'document',
      'audioPlayer',
      'finished',
      `let npXfadeActive = false, npXfadeAudio = null, npXfadeMainVol = null, npXfadeTimer = null;
       const npCrossfadeSeconds = () => 6;
       const npFinishCrossfade = (i, vol, gain) => finished.push({ i, vol, gain });
       ${pick('npStartCrossfade')}
       return npStartCrossfade;`,
    )({ getElementById: () => xa }, audioPlayer, finished) as (
      i: number,
      next: unknown,
      hint: unknown,
    ) => void;
    start(1, { id: '2', file_path: '/m/b.flac' }, { inAt: 1.234, gain: 0.8, seconds: 2 });
    expect(xa.src).toMatch(
      /^\/stream\/library-audio\?path=%2Fm%2Fb\.flac&track_id=2&t=\d+#t=1\.23$/,
    );
    await vi.advanceTimersByTimeAsync(2100);
    // the new track came up to 80% of the player's level, the old one down
    expect(xa.volume).toBeCloseTo(0.4, 6);
    expect(audioPlayer.volume).toBe(0);
    expect(finished).toEqual([{ i: 1, vol: 0.5, gain: 0.8 }]);
  });

  it('back to the player’s own level over 3 s', async () => {
    const audioPlayer = { volume: 0 };
    const settle = new Function(
      'audioPlayer',
      `let npSettleTimer = null, npMuted = false, npVolumePercent = 50;
       ${pick('npSettleVolume')}
       return npSettleVolume;`,
    )(audioPlayer) as (g: number) => void;
    settle(0.8);
    expect(audioPlayer.volume).toBeCloseTo(0.4, 6);
    await vi.advanceTimersByTimeAsync(1500);
    expect(audioPlayer.volume).toBeCloseTo(0.45, 2);
    await vi.advanceTimersByTimeAsync(1600);
    expect(audioPlayer.volume).toBeCloseTo(0.5, 6);
  });
});

describe('the advance', () => {
  it('ended leaves it to auto-mix while its decks play', () => {
    const next = vi.fn();
    const run = (owns: boolean) => {
      (window as unknown as { SoulSyncAutomix: unknown }).SoulSyncAutomix = {
        ownsAdvance: () => owns,
      };
      new Function(
        'window',
        'playNextInQueue',
        `let npSleepEndOfTrack = false, npXfadeActive = false, npLoadingQueueItem = false, npShuffleOn = false,
           npRepeatMode = 'off', npRadioMode = false, npQueueIndex = 0, currentTrack = { id: '1' };
         const npQueue = [{ id: '1' }, { id: '2' }];
         const setPlayingState = () => {}, npSpokenOnEnded = () => {};
         ${pick('npAutomix', 'npAutomixOwnsAdvance', 'onAudioEnded')}
         onAudioEnded();`,
      )(window, next);
    };
    run(true);
    expect(next).not.toHaveBeenCalled();
    run(false);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('Up next’s gaps (26a)', () => {
  function draw(gaps: boolean, index: number) {
    document.body.innerHTML = '<div id="np-queue-list"></div>';
    (window as unknown as { SoulSyncAutomix: unknown }).SoulSyncAutomix = {
      gapsWanted: () => gaps,
    };
    new Function(
      'document',
      'window',
      `let npQueue = [
         { title: 'A', artist: 'X', file_path: '/a' }, { title: 'B', artist: 'X', file_path: '/b' },
         { title: 'C', artist: 'X', file_path: '/c' }, { title: 'D', artist: 'X', file_path: '/d' }
       ], npQueueIndex = ${index};
       const npQueueStatusLabel = () => '', npUpdateUpNext = () => {}, npPersistQueue = () => {},
         npQueueDragStart = () => {}, npQueueDragOver = () => {}, npQueueDrop = () => {}, npQueueDragEnd = () => {},
         playQueueItem = () => {}, formatTime = (s) => String(s);
       ${pick('npAutomix', 'renderNpQueue', 'npFocusQueueAction')}
       renderNpQueue();`,
    )(document, window);
    return Array.from(document.querySelectorAll<HTMLElement>('[data-automix-gap]'));
  }

  it('one after each row from the playing one on, each naming the track coming in', () => {
    const gaps = draw(true, 1);
    expect(gaps.map((g) => g.dataset.automixGap)).toEqual(['1', '2']);
    expect(gaps[0].previousElementSibling?.textContent).toContain('B');
    expect(gaps[0]).toHaveAttribute('aria-label', 'Transition into C');
    expect(gaps[0]).toHaveAttribute('role', 'listitem');
  });

  it('none without DJ mix', () => {
    expect(draw(false, 1)).toHaveLength(0);
  });
});
