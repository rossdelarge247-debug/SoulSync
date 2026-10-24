/**
 * The Sleep timer for a station (Design 147, board 16b): at zero the station
 * stops, as its Stop does (a paused live stream isn't what the timer
 * promises); music still pauses and keeps its queue.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { extractFunction } from './vanilla-extract';

const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const fn = extractFunction('npFireSleepTimer', source);

let stop: ReturnType<typeof vi.fn>;
let calls: string[];

function fire(track: unknown, audio: { paused: boolean; pause: () => void }) {
  return new Function(
    'window',
    'currentTrack',
    'audioPlayer',
    'calls',
    `const npCancelCrossfade = () => calls.push('crossfade');
     const setPlayingState = (on) => calls.push('playing:' + on);
     const npClearSleepTimer = () => calls.push('clear');
     ${fn}
     return npFireSleepTimer;`,
  )(window, track, audio, calls) as () => void;
}

beforeEach(() => {
  calls = [];
  stop = vi.fn(async () => undefined);
  (window as unknown as { SoulSyncRadio?: unknown }).SoulSyncRadio = { stop };
});

afterEach(() => {
  delete (window as unknown as { SoulSyncRadio?: unknown }).SoulSyncRadio;
});

it('stops a station and clears the timer', () => {
  const audio = { paused: false, pause: vi.fn() };
  fire({ kind: 'radio', title: 'NTS 1' }, audio)();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(audio.pause).not.toHaveBeenCalled();
  expect(calls).toEqual(['clear']);
});

it('pauses music and keeps it', () => {
  const audio = { paused: false, pause: vi.fn() };
  fire({ kind: 'library', title: 'Harbour Light' }, audio)();
  expect(stop).not.toHaveBeenCalled();
  expect(audio.pause).toHaveBeenCalledTimes(1);
  expect(calls).toEqual(['crossfade', 'playing:false', 'clear']);
});
