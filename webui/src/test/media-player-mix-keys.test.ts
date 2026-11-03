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
const automixFn = extractFunction('npAutomix', source);
const table = /const NP_LETTER_KEYS = \{[\s\S]*?\n\};/.exec(source)![0];

let mute: ReturnType<typeof vi.fn>;
let next: ReturnType<typeof vi.fn>;
let mixKey: ReturnType<typeof vi.fn>;
let automixKey: ReturnType<typeof vi.fn>;

function handler() {
  return new Function(
    'document',
    'window',
    'handleNpMuteToggle',
    'playNextInQueue',
    `const audioPlayer = null, npQueue = [{ id: '2' }], npVolumePercent = 50, currentTrack = { id: '1' };
     const npSetVolume = () => {}, togglePlayback = () => {};
     const playPreviousInQueue = () => window.__previous && window.__previous();
     ${table}
     ${automixFn}
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
  automixKey = vi.fn(() => true);
  (window as unknown as { SoulSyncAutomix?: unknown }).SoulSyncAutomix = { key: automixKey };
});

afterEach(() => {
  delete (window as unknown as { SoulSyncMix?: unknown }).SoulSyncMix;
  delete (window as unknown as { SoulSyncAutomix?: unknown }).SoulSyncAutomix;
});

describe('the table (one place for 287)', () => {
  it('maps M, ⇧M, N, ⇧N, A, X, T, D, B and ⇧P, and nothing else', () => {
    expect(handler().table).toEqual({
      M: ['dj:M', 'mix:M', 'mute'],
      '⇧M': ['mute'],
      N: ['mix:N', 'next'],
      '⇧N': ['next'],
      A: ['mix:A'],
      X: ['automix:X'],
      T: ['dj:T', 'lyrics:T'],
      D: ['dj:D'],
      B: ['dj:B'],
      '⇧P': ['dj:⇧P'],
      '1': ['dj:1'],
      '2': ['dj:2'],
      '3': ['dj:3'],
      '4': ['dj:4'],
      Z: ['dj:Z'],
      '-': ['dj:-'],
      '+': ['dj:+'],
      '⇧+': ['dj:+'],
      '=': ['dj:+'],
    });
  });

  it('3b: M, 1–4, Z, − and + ask DJ mode first; M mutes when DJ mode doesn’t take it', () => {
    const djKey = vi.fn((k: string) => k !== 'M');
    const w = window as unknown as { SoulSyncDj?: unknown; SoulSyncMix?: unknown };
    w.SoulSyncDj = { key: djKey };
    delete w.SoulSyncMix;
    try {
      const { handle } = handler();
      for (const k of ['1', '4', 'z', '-', '+', '=']) {
        const e = key(k);
        handle(e);
        expect(e.defaultPrevented).toBe(true);
      }
      expect(djKey.mock.calls.map(([k]) => k)).toEqual(['1', '4', 'Z', '-', '+', '+']);
      const m = key('m');
      handle(m);
      expect(djKey).toHaveBeenCalledWith('M');
      expect(mute).toHaveBeenCalledTimes(1);
    } finally {
      delete w.SoulSyncDj;
    }
  });

  it('⇧P is DJ mode’s Play B while it acts; otherwise P and ⇧P are Previous (37p)', () => {
    const djKey = vi.fn(() => true);
    const previous = vi.fn();
    const w = window as unknown as { SoulSyncDj?: unknown; __previous?: unknown };
    w.SoulSyncDj = { key: djKey };
    w.__previous = previous;
    try {
      const { handle } = handler();
      const shiftP = key('P', { shiftKey: true });
      handle(shiftP);
      expect(djKey).toHaveBeenCalledWith('⇧P');
      expect(shiftP.defaultPrevented).toBe(true);
      expect(previous).not.toHaveBeenCalled();
      // plain P never asks DJ mode
      djKey.mockClear();
      handle(key('p'));
      expect(djKey).not.toHaveBeenCalled();
      expect(previous).toHaveBeenCalledTimes(1);
      // DJ mode off (or no B): ⇧P is Previous as before
      djKey.mockImplementation(() => false);
      handle(key('P', { shiftKey: true }));
      expect(previous).toHaveBeenCalledTimes(2);
    } finally {
      delete w.SoulSyncDj;
      delete w.__previous;
    }
  });

  it('d and b: DJ mode’s (37p), left to the page when it doesn’t act; T asks DJ mode first', () => {
    const djKey = vi.fn((k: string) => k === 'D');
    const lyricsKey = vi.fn(() => true);
    const w = window as unknown as { SoulSyncDj?: unknown; SoulSyncLyrics?: unknown };
    w.SoulSyncDj = { key: djKey };
    w.SoulSyncLyrics = { key: lyricsKey };
    try {
      const { handle } = handler();
      const d = key('d');
      handle(d);
      expect(djKey).toHaveBeenCalledWith('D');
      expect(d.defaultPrevented).toBe(true);
      // B: Browse not there (DJ mode off), so the key stays the page's
      const b = key('b');
      handle(b);
      expect(djKey).toHaveBeenCalledWith('B');
      expect(b.defaultPrevented).toBe(false);
      // T: DJ mode off, so the lyrics take it
      handle(key('t'));
      expect(djKey).toHaveBeenCalledWith('T');
      expect(lyricsKey).toHaveBeenCalledWith('T');
      // DJ mode on: T says the lyrics come back later, and the layer isn't asked
      djKey.mockImplementation(() => true);
      lyricsKey.mockClear();
      handle(key('t'));
      expect(lyricsKey).not.toHaveBeenCalled();
      // ⇧D isn't bound; nothing else hears D
      djKey.mockClear();
      handle(key('D', { shiftKey: true }));
      expect(djKey).not.toHaveBeenCalled();
      expect(mixKey).not.toHaveBeenCalled();
      expect(mute).not.toHaveBeenCalled();
      // a page that claims d (the Import inbox) keeps it
      document.documentElement.dataset.letterKeys = 'jkadx';
      handle(key('d'));
      expect(djKey).not.toHaveBeenCalled();
      // ... but not under the Visuals overlay, which covers the page (review M4)
      document.body.insertAdjacentHTML('beforeend', '<div id="np-modal-overlay"></div>');
      const d2 = key('d');
      handle(d2);
      expect(djKey).toHaveBeenCalledWith('D');
      expect(d2.defaultPrevented).toBe(true);
      document.getElementById('np-modal-overlay')!.classList.add('hidden');
      djKey.mockClear();
      handle(key('d'));
      expect(djKey).not.toHaveBeenCalled();
      document.getElementById('np-modal-overlay')!.remove();
    } finally {
      delete document.documentElement.dataset.letterKeys;
      delete w.SoulSyncDj;
      delete w.SoulSyncLyrics;
    }
    // without DJ mode loaded D does nothing
    const ev = key('d');
    handler().handle(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('t: lyrics over the visuals, and left to the page when the layer doesn’t act (27a)', () => {
    const lyricsKey = vi.fn(() => true);
    (window as unknown as { SoulSyncLyrics?: unknown }).SoulSyncLyrics = { key: lyricsKey };
    try {
      const { handle } = handler();
      const ev = key('t');
      handle(ev);
      expect(lyricsKey).toHaveBeenCalledWith('T');
      expect(ev.defaultPrevented).toBe(true);
      expect(mixKey).not.toHaveBeenCalled();
      lyricsKey.mockReturnValue(false);
      const ev2 = key('T');
      handle(ev2);
      expect(ev2.defaultPrevented).toBe(false);
      // ⇧T isn't bound
      lyricsKey.mockClear();
      handle(key('T', { shiftKey: true }));
      expect(lyricsKey).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as { SoulSyncLyrics?: unknown }).SoulSyncLyrics;
    }
    // without the layer loaded nothing happens
    const ev3 = key('t');
    handler().handle(ev3);
    expect(ev3.defaultPrevented).toBe(false);
  });

  it('x: Mix now through auto-mix only, and left to the page when it doesn’t act (26a)', () => {
    const { handle } = handler();
    const ev = key('x');
    handle(ev);
    expect(automixKey).toHaveBeenCalledWith('X');
    expect(mixKey).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    automixKey.mockReturnValue(false);
    const ev2 = key('X');
    handle(ev2);
    expect(ev2.defaultPrevented).toBe(false);
    // ⇧X isn't bound, and without auto-mix loaded nothing happens
    automixKey.mockClear();
    handle(key('X', { shiftKey: true }));
    expect(automixKey).not.toHaveBeenCalled();
    delete (window as unknown as { SoulSyncAutomix?: unknown }).SoulSyncAutomix;
    const ev3 = key('x');
    handle(ev3);
    expect(ev3.defaultPrevented).toBe(false);
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

describe('the mixing features hidden (Settings → Library → DJ): SoulSyncMix says no, no SoulSyncAutomix', () => {
  beforeEach(() => {
    // mix-host.tsx keeps SoulSyncMix while hidden, its key() answering false
    // (keyAction checks mixTabShown); the automix host isn't mounted at all
    (window as unknown as { SoulSyncMix?: unknown }).SoulSyncMix = {
      key: () => false,
      available: () => false,
      drawerOpen: () => false,
      closeDrawer: () => undefined,
    };
    delete (window as unknown as { SoulSyncAutomix?: unknown }).SoulSyncAutomix;
  });

  it('M mutes and N skips; A and X do nothing and stay the page’s', () => {
    const { handle } = handler();
    const m = key('m');
    handle(m);
    expect(m.defaultPrevented).toBe(true);
    expect(mute).toHaveBeenCalledTimes(1);
    const n = key('n');
    handle(n);
    expect(n.defaultPrevented).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    for (const k of ['a', 'x']) {
      const ev = key(k);
      handle(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(mute).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('[gauntlet L1] a page that claims letters keeps them', () => {
  afterEach(() => {
    delete document.documentElement.dataset.letterKeys;
  });

  it('X and A go to the page (the Import inbox) and not to the player', () => {
    const { handle } = handler();
    document.documentElement.dataset.letterKeys = 'jkadx';
    const x = key('x');
    handle(x);
    expect(automixKey).not.toHaveBeenCalled();
    expect(x.defaultPrevented).toBe(false);
    handle(key('a'));
    expect(mixKey).not.toHaveBeenCalled();
    // shifted letters, M and N stay the player's
    handle(key('M', { shiftKey: true }));
    expect(mute).toHaveBeenCalledTimes(1);
    handle(key('n'));
    expect(mixKey).toHaveBeenCalledWith('N');
  });

  it('once the page lets go, they’re the player’s again', () => {
    const { handle } = handler();
    handle(key('x'));
    expect(automixKey).toHaveBeenCalledWith('X');
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
    handle(key('x'));
  }
  document.body.focus();
  handle(key('x', { ctrlKey: true }));
  handle(key('a', { ctrlKey: true }));
  handle(key('m', { metaKey: true }));
  handle(key('n', { altKey: true }));
  expect(mixKey).not.toHaveBeenCalled();
  expect(automixKey).not.toHaveBeenCalled();
  expect(mute).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});
