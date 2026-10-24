/**
 * Space while a station plays (Design 145, 167): it stops the station, as the
 * bar's and the Visuals transport's Stop do; with music it still plays or
 * pauses. A focused control keeps its own Space.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { extractFunction } from './vanilla-extract';

const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const fn = extractFunction('handlePlayerKeyboardShortcuts', source);

let toggle: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;

function handler(track: unknown) {
  return new Function(
    'document',
    'window',
    'togglePlayback',
    'currentTrack',
    `const audioPlayer = null, npQueue = [], npVolumePercent = 50;
     const npSetVolume = () => {}, handleNpMuteToggle = () => {}, playNextInQueue = () => {},
       playPreviousInQueue = () => {};
     ${fn}
     return handlePlayerKeyboardShortcuts;`,
  )(document, window, toggle, track) as (e: KeyboardEvent) => void;
}

const space = () => new KeyboardEvent('keydown', { key: ' ', cancelable: true });

beforeEach(() => {
  document.body.innerHTML = '<div id="page"></div>';
  toggle = vi.fn();
  stop = vi.fn(async () => undefined);
  (window as unknown as { SoulSyncRadio?: unknown }).SoulSyncRadio = { stop };
});

afterEach(() => {
  delete (window as unknown as { SoulSyncRadio?: unknown }).SoulSyncRadio;
});

it('stops a station', () => {
  const ev = space();
  handler({ kind: 'radio', title: 'NTS 1' })(ev);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(toggle).not.toHaveBeenCalled();
  expect(ev.defaultPrevented).toBe(true);
});

it('plays or pauses music', () => {
  handler({ kind: 'library', title: 'Harbour Light' })(space());
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(stop).not.toHaveBeenCalled();
});

it('leaves Space to a focused button', () => {
  document.body.innerHTML = '<button id="b">Stop</button>';
  document.getElementById('b')!.focus();
  handler({ kind: 'radio', title: 'NTS 1' })(space());
  expect(stop).not.toHaveBeenCalled();
});
