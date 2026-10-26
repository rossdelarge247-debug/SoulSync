/**
 * The Mix tab's keys (24a): A adds the playing track to the working set, N
 * plays the top match next, M switches the tray to Mix. They go through the
 * player's one handler, so S's guard holds: nothing fires in a text field, a
 * dialog or a menu. Where there's no Mix tab, M still mutes and N skips.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { extractFunction } from './vanilla-extract';

const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const fn = extractFunction('handlePlayerKeyboardShortcuts', source);

let mute: ReturnType<typeof vi.fn>;
let next: ReturnType<typeof vi.fn>;
let mixKey: ReturnType<typeof vi.fn>;

function handler() {
  return new Function(
    'document',
    'window',
    'handleNpMuteToggle',
    'playNextInQueue',
    `const audioPlayer = null, npQueue = [{ id: '2' }], npVolumePercent = 50, currentTrack = { id: '1' };
     const npSetVolume = () => {}, togglePlayback = () => {}, playPreviousInQueue = () => {};
     ${fn}
     return handlePlayerKeyboardShortcuts;`,
  )(document, window, mute, next) as (e: KeyboardEvent) => void;
}

const key = (k: string, extra: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key: k, cancelable: true, ...extra });

beforeEach(() => {
  document.body.innerHTML = '<div id="page"></div>';
  mute = vi.fn();
  next = vi.fn();
  mixKey = vi.fn(() => true);
  (window as unknown as { SoulSyncMix?: unknown }).SoulSyncMix = { key: mixKey };
});

afterEach(() => {
  delete (window as unknown as { SoulSyncMix?: unknown }).SoulSyncMix;
});

it('hands A, N and M to the Mix tab', () => {
  for (const k of ['a', 'N', 'm']) {
    const ev = key(k);
    handler()(ev);
    expect(ev.defaultPrevented).toBe(true);
  }
  expect(mixKey.mock.calls.map((c) => c[0])).toEqual(['A', 'N', 'M']);
  expect(mute).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

it('mutes and skips where there is no Mix tab', () => {
  mixKey.mockReturnValue(false);
  handler()(key('m'));
  handler()(key('n'));
  const a = key('a');
  handler()(a);
  expect(mute).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(1);
  expect(a.defaultPrevented).toBe(false);
});

it('leaves text fields, dialogs, menus and modified keys alone', () => {
  document.body.innerHTML =
    '<input id="i"><div role="dialog" data-open><button id="d">x</button></div><div class="ss-player-menu"><button id="m">x</button></div>';
  for (const id of ['i', 'd', 'm']) {
    document.getElementById(id)!.focus();
    handler()(key('a'));
    handler()(key('m'));
  }
  document.body.focus();
  handler()(key('a', { ctrlKey: true }));
  handler()(key('m', { metaKey: true }));
  handler()(key('A', { shiftKey: true }));
  expect(mixKey).not.toHaveBeenCalled();
  expect(mute).not.toHaveBeenCalled();
});
