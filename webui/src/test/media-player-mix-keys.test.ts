/**
 * The Mix tab's keys (24a): A adds the playing track to the working set, N
 * plays the top match next, M switches the tray to Mix. They go through the
 * player's one handler, so S's guard holds: nothing fires in a text field, a
 * dialog or a menu. The bindings are one table (NP_LETTER_KEYS); each
 * mapping is tested. Ross answered 287: ⇧M mutes and ⇧N skips, always; where
 * there's no Mix tab, plain M still mutes and N skips.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractFunction } from './vanilla-extract';

const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const fn = extractFunction('handlePlayerKeyboardShortcuts', source);
const action = extractFunction('npLetterKeyAction', source);
const table = /const NP_LETTER_KEYS = \{[\s\S]*?\n\};/.exec(source)![0];

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
     ${table}
     ${action}
     ${fn}
     return { handle: handlePlayerKeyboardShortcuts, table: NP_LETTER_KEYS };`,
  )(document, window, mute, next) as {
    handle: (e: KeyboardEvent) => void;
    table: Record<string, string[]>;
  };
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

describe('the table (one place for 287)', () => {
  it('maps M, ⇧M, N, ⇧N and A, and nothing else', () => {
    expect(handler().table).toEqual({
      M: ['mix:M', 'mute'],
      '⇧M': ['mute'],
      N: ['mix:N', 'next'],
      '⇧N': ['next'],
      A: ['mix:A'],
    });
  });

  it.each([
    ['m', 'M', 'mute'],
    ['n', 'N', 'next'],
  ] as const)('%s: the Mix tab first, then %s where there is none', (k, mixAs, fallback) => {
    const { handle } = handler();
    const ev = key(k);
    handle(ev);
    expect(mixKey).toHaveBeenLastCalledWith(mixAs);
    expect(ev.defaultPrevented).toBe(true);
    expect(mute).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    mixKey.mockReturnValue(false);
    const ev2 = key(k);
    handle(ev2);
    expect(ev2.defaultPrevented).toBe(true);
    expect((fallback === 'mute' ? mute : next).mock.calls).toHaveLength(1);
  });

  it.each([
    ['M', 'mute'],
    ['N', 'next'],
  ] as const)('⇧%s always does %s, Mix tab or not (287)', (k, what) => {
    for (const mixActs of [true, false]) {
      mixKey.mockReturnValue(mixActs);
      const { handle } = handler();
      const ev = key(k, { shiftKey: true });
      handle(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(mixKey).not.toHaveBeenCalled();
    expect((what === 'mute' ? mute : next).mock.calls).toHaveLength(2);
    expect((what === 'mute' ? next : mute).mock.calls).toHaveLength(0);
  });

  it('a: the Mix tab only, and left to the page when it doesn’t act', () => {
    const { handle } = handler();
    const ev = key('a');
    handle(ev);
    expect(mixKey).toHaveBeenCalledWith('A');
    expect(ev.defaultPrevented).toBe(true);
    mixKey.mockReturnValue(false);
    const ev2 = key('a');
    handle(ev2);
    expect(ev2.defaultPrevented).toBe(false);
    // ⇧A isn't bound
    mixKey.mockClear();
    handle(key('A', { shiftKey: true }));
    expect(mixKey).not.toHaveBeenCalled();
  });
});

it('leaves text fields, dialogs, menus and modified keys alone', () => {
  document.body.innerHTML =
    '<input id="i"><div role="dialog" data-open><button id="d">x</button></div><div class="ss-player-menu"><button id="m">x</button></div>';
  const { handle } = handler();
  for (const id of ['i', 'd', 'm']) {
    document.getElementById(id)!.focus();
    handle(key('a'));
    handle(key('m'));
    handle(key('n'));
  }
  document.body.focus();
  handle(key('a', { ctrlKey: true }));
  handle(key('m', { metaKey: true }));
  handle(key('n', { altKey: true }));
  expect(mixKey).not.toHaveBeenCalled();
  expect(mute).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});
