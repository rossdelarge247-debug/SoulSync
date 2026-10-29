/**
 * The player's side of auto-mix (stage C), through the REAL functions of
 * static/media-player.js:
 *
 * - no crossfade (Ross, 27 October): the player has none left to start;
 * - a load handed a quieter second audio goes back to its own level;
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
  it('Auto mix (dj) or Off: Smart crossfade and the old crossfade switch read as Off', () => {
    const read = new Function(
      'localStorage',
      'on',
      `const NP_BETWEEN_KEY = 'soulsync-between-tracks'; let npCrossfadeOn = on;
       ${pick('npBetweenTracks')} return npBetweenTracks();`,
    );
    const store = (v: string | null) => ({ getItem: () => v });
    expect(read(store(null), false)).toBe('off');
    expect(read(store(null), true)).toBe('off');
    expect(read(store('smart'), false)).toBe('off');
    expect(read(store('dj'), true)).toBe('dj');
    expect(read(store('nonsense'), false)).toBe('off');
    const throws = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(read(throws, true)).toBe('off');
  });
});

describe('no crossfade (Ross, 27 October)', () => {
  it('the player has no crossfade left to start: no tick, no start, no window API', () => {
    for (const name of ['npCrossfadeTick', 'npStartCrossfade', 'npFinishCrossfade'])
      expect(source).not.toMatch(new RegExp(`function ${name}\\b`));
    expect(source).not.toMatch(/addEventListener\('timeupdate', npCrossfadeTick\)/);
    expect(source).not.toMatch(/\bcrossfadeInto\s*\(/);
    const v2 = readFileSync(resolve(process.cwd(), 'static/media-player-v2.js'), 'utf8');
    expect(v2).not.toMatch(/np-v2-xfade-secs/);
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

describe('[gauntlet M1b] moveNext: the incoming row straight after the playing one', () => {
  function queueOf(ids: string[], playing: string) {
    return new Function(
      'ids',
      'playing',
      `let npQueue = ids.map((id) => ({ id })), npQueueIndex = ids.indexOf(playing);
       const renderNpQueue = () => {}, updateNpPrevNextButtons = () => {},
         npScheduleQueuePrefetch = () => {}, npPersistQueue = () => {};
       ${pick('npReorderQueue', 'npMoveNext')}
       return {
         move: (i) => npMoveNext(i),
         get ids() { return npQueue.map((t) => t.id); },
         get index() { return npQueueIndex; },
       };`,
    )(ids, playing) as { move: (i: number) => number; ids: string[]; index: number };
  }

  it.each([
    // [queue, playing, the incoming row's index, the queue after, playing index after]
    [['B', 'P', 'Q'], 'P', 0, ['P', 'B', 'Q'], 0],
    [['X', 'B', 'P'], 'P', 1, ['X', 'P', 'B'], 1],
    [['P', 'Q', 'R', 'B'], 'P', 3, ['P', 'B', 'Q', 'R'], 0],
    [['A', 'P', 'Q', 'B', 'R'], 'P', 3, ['A', 'P', 'B', 'Q', 'R'], 1],
    [['P', 'B', 'Q'], 'P', 1, ['P', 'B', 'Q'], 0],
  ])('%j playing %s, the incoming at %i', (ids, playing, from, after, index) => {
    const q = queueOf(ids as string[], playing as string);
    const at = q.move(from as number);
    expect(q.ids).toEqual(after);
    expect(q.index).toBe(index);
    // the index it returns is the incoming row's, straight after the playing one
    expect(at).toBe((index as number) + 1);
    expect(q.ids[at]).toBe('B');
  });

  it('an index that isn’t a row: -1, nothing moved', () => {
    const q = queueOf(['P', 'B'], 'P');
    expect(q.move(5)).toBe(-1);
    expect(q.ids).toEqual(['P', 'B']);
  });
});

describe('the level after a load handed a second audio', () => {
  beforeEach(() => vi.useFakeTimers());

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
       ], npQueueIndex = ${index}, isPlaying = true, npLoadingQueueItem = false, npBuffering = false;
       let npMoveIndex = null;
    const npQueueStatusLabel = () => '', npUpdateUpNext = () => {}, npPersistQueue = () => {},
         npIsSpokenWord = () => false, npStartMoveMode = () => {}, npEndMoveMode = () => {},
         playQueueItem = () => {}, formatTime = (s) => String(s);
       ${pick('npAutomix', 'renderNpQueue', 'npFocusQueueAction', 'npQueuePlayingLabel')}
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

describe("[gauntlet review H1] 'ended' says when the next track is owed, through the real onAudioEnded", () => {
  function player(opts: { owns?: boolean; sleep?: boolean; loading?: boolean; index?: number }) {
    return new Function(
      'opts',
      `let npAdvanceOwed = false;
       let npSleepEndOfTrack = Boolean(opts.sleep), npXfadeActive = false, npRadioMode = false;
       let npQueue = [{ id: '1' }, { id: '2' }, { id: '3' }], npQueueIndex = opts.index ?? 0;
       let npShuffleOn = false, npRepeatMode = 'off', npLoadingQueueItem = Boolean(opts.loading);
       let currentTrack = { id: '1', kind: 'library' };
       const played = [];
       const setPlayingState = () => {}, npSpokenOnEnded = () => {};
       const npAutomixOwnsAdvance = () => Boolean(opts.owns);
       const playNextInQueue = () => played.push(npQueueIndex + 1);
       const npFetchRadioTracks = () => {};
       // the real sleep timer's end of track: it pauses and clears its flag
       function npFireSleepTimer() { npSleepEndOfTrack = false; }
       ${pick('onAudioEnded', 'onAudioLoadStart')}
       return { ended: onAudioEnded, loadstart: onAudioLoadStart,
                get owed() { return npAdvanceOwed; }, get sleep() { return npSleepEndOfTrack; }, played };`,
    )(opts) as {
      ended: () => void;
      loadstart: () => void;
      owed: boolean;
      sleep: boolean;
      played: number[];
    };
  }

  it('the sleep timer at the end of a track owes nothing, once its flag is cleared', () => {
    const p = player({ sleep: true });
    p.ended();
    expect(p.sleep).toBe(false);
    expect(p.owed).toBe(false);
    expect(p.played).toEqual([]);
  });

  it('handed to auto-mix, or turned away by a load in flight, it is owed until the next load', () => {
    const handed = player({ owns: true });
    handed.ended();
    expect(handed.owed).toBe(true);
    handed.loadstart();
    expect(handed.owed).toBe(false);
    const busy = player({ loading: true });
    busy.ended();
    expect(busy.owed).toBe(true);
  });

  it('the player that moves on itself, or the queue that ends, owes nothing', () => {
    const p = player({});
    p.ended();
    expect(p.played).toEqual([1]);
    expect(p.owed).toBe(false);
    const last = player({ index: 2, loading: true });
    last.ended();
    expect(last.owed).toBe(false);
  });
});

describe('[gauntlet review M3] a set played from the playing track, through the real npQueueAfterPlaying', () => {
  it('queues its later rows next, each once, and draws and saves once', () => {
    const run = new Function(
      `let npQueue = [{ id: 'A' }, { id: 'P' }, { id: '3' }, { id: 'X' }], npQueueIndex = 1;
       const calls = { render: 0, persist: 0 };
       const renderNpQueue = () => calls.render++, npPersistQueue = () => calls.persist++;
       const updateNpPrevNextButtons = () => {}, npScheduleQueuePrefetch = () => {};
       const npPrepareQueueTracks = (list) => list.map((t) => ({ ...t }));
       ${pick('npQueueAfterPlaying')}
       const at = npQueueAfterPlaying([{ id: '2' }, { id: '3' }, { id: '4' }]);
       return { at, ids: npQueue.map((t) => t.id), index: npQueueIndex, calls };`,
    ) as () => {
      at: number;
      ids: string[];
      index: number;
      calls: { render: number; persist: number };
    };
    const out = run();
    expect(out.at).toBe(2);
    expect(out.ids).toEqual(['A', 'P', '2', '3', '4', 'X']);
    expect(out.index).toBe(1);
    expect(out.calls).toEqual({ render: 1, persist: 1 });
  });
});
