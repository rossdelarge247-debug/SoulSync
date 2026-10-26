/**
 * The star (28a–28d): one store for the page (shell and React share it),
 * one request for a page of rows, optimistic toggles that go back when
 * refused, the control's states (none / off / on), S (the focused row,
 * else the playing track) and the global key in static/media-player.js.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractFunction } from '@/test/vanilla-extract';

import { StarButton } from './star-button';
import { createStarButton, starAttributes, starFromKeyboard } from './star-control';
import { createStarStore, showsStar, starStore, type StarStore } from './stars-store';

type Body = Record<string, unknown>;

function server(answers: Record<string, (body: Body) => [number, unknown]>) {
  const calls: { path: string; body: Body }[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = url instanceof Request ? url.url : url.toString();
    const path = href.replace(/^.*\/api\//, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Body) : {};
    calls.push({ path, body });
    const [status, payload] = (answers[path] ?? (() => [404, { success: false }]))(body);
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 5)));

function statusOf(starred: string[], present: string[]) {
  return (body: Body) => {
    const tracks: Record<string, unknown> = {};
    for (const id of (body.track_ids as string[]) ?? [])
      tracks[id] = { starred: starred.includes(id), can_star: present.includes(id) };
    return [200, { success: true, tracks }] as [number, unknown];
  };
}

afterEach(() => {
  delete window.SoulSyncStars;
  document.body.innerHTML = '';
});

describe('the store', () => {
  it('looks a page of rows up in one request', async () => {
    const { fetcher, calls } = server({ 'stars/status': statusOf(['2'], ['1', '2']) });
    const store = createStarStore(fetcher);
    store.want(['1', '2']);
    store.want(['2', '3']);
    await flush();
    expect(calls).toEqual([{ path: 'stars/status', body: { track_ids: ['1', '2', '3'] } }]);
    expect(store.get('1')).toEqual({ starred: false, canStar: true });
    expect(store.get('2')).toEqual({ starred: true, canStar: true });
    expect(store.get('3')).toEqual({ starred: false, canStar: false });
    store.want(['1', '2', '3']);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('skips what a page primed meanwhile', async () => {
    const { fetcher, calls } = server({ 'stars/status': statusOf([], ['9']) });
    const store = createStarStore(fetcher);
    store.want(['4', '9']);
    store.prime({ '4': { starred: true, can_star: true } });
    await flush();
    expect(calls[0].body).toEqual({ track_ids: ['9'] });
    expect(store.get('4')?.starred).toBe(true);
  });

  it('toggles at once and goes back, with a toast, when refused', async () => {
    const toast = vi.fn();
    window.showToast = toast;
    const { fetcher, calls } = server({
      stars: () => [
        409,
        { success: false, error: "Its file isn't on this computer, so it can't be starred." },
      ],
      'stars/remove': () => [200, { success: true, unstarred: ['2'], count: 0 }],
    });
    const store = createStarStore(fetcher);
    store.prime({
      '1': { starred: false, can_star: true },
      '2': { starred: true, can_star: true },
    });
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(Boolean(store.get('1')?.starred)));
    expect(await store.toggle('1', 'Copper Sky')).toBe(false);
    expect(seen).toContain(true); // shown starred at once
    expect(store.get('1')?.starred).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      "Copper Sky: Its file isn't on this computer, so it can't be starred.",
      'error',
    );
    expect(await store.toggle('2')).toBe(false);
    expect(store.count()).toBe(0);
    expect(calls.map((c) => c.path)).toEqual(['stars', 'stars/remove']);
    delete window.showToast;
  });

  it('never stars a track it can’t (no file, never starred)', async () => {
    const { fetcher, calls } = server({});
    const store = createStarStore(fetcher);
    store.prime({ '5': { starred: false, can_star: false } });
    expect(await store.toggle('5')).toBe(false);
    expect(calls).toEqual([]);
    expect(showsStar(store.get('5'))).toBe(false);
    // a starred one whose file went keeps its star, and can be taken off
    store.prime({ '6': { starred: true, can_star: false } });
    expect(showsStar(store.get('6'))).toBe(true);
  });

  it('is one per page, shared through window', () => {
    const a = starStore();
    expect(window.SoulSyncStars).toBe(a);
    expect(starStore()).toBe(a);
  });
});

describe('the control', () => {
  it('none, off and on', () => {
    expect(starAttributes(undefined, 'X', 'row')['data-star']).toBe('none');
    expect(starAttributes({ starred: false, canStar: false }, 'X', 'row')['aria-hidden']).toBe(
      'true',
    );
    const off = starAttributes({ starred: false, canStar: true }, 'Copper Sky', 'row');
    expect(off).toMatchObject({
      'data-star': 'off',
      'aria-pressed': 'false',
      'aria-label': 'Star Copper Sky',
    });
    const on = starAttributes({ starred: true, canStar: true }, 'Copper Sky', 'player');
    expect(on).toMatchObject({
      'data-star': 'on',
      'aria-pressed': 'true',
      'aria-label': 'Unstar Copper Sky',
      'data-star-variant': 'player',
    });
  });

  it('React and the shell draw the same button from the same store', async () => {
    const { fetcher } = server({
      'stars/status': statusOf([], ['4']),
      stars: () => [200, { success: true, starred: ['4'], left_out: [], count: 1 }],
    });
    const store = createStarStore(fetcher);
    window.SoulSyncStars = store;
    render(<StarButton id="4" title="Copper Sky" />);
    const shell = createStarButton('4', { title: 'Copper Sky', variant: 'player', store });
    document.body.appendChild(shell.button);
    await flush();
    const react = screen.getAllByRole('button', { name: 'Star Copper Sky' });
    expect(react).toHaveLength(2);
    fireEvent.click(shell.button);
    await flush();
    for (const b of screen.getAllByRole('button', { name: 'Unstar Copper Sky' }))
      expect(b).toHaveAttribute('data-star', 'on');
    shell.destroy();
  });
});

describe('S', () => {
  let store: StarStore;
  let calls: { path: string; body: Body }[];

  beforeEach(() => {
    const s = server({
      'stars/status': statusOf([], ['4', '9']),
      stars: (b) => [200, { success: true, starred: b.track_ids, left_out: [], count: 1 }],
    });
    calls = s.calls;
    store = createStarStore(s.fetcher);
    store.prime({
      '4': { starred: false, can_star: true },
      '9': { starred: false, can_star: true },
    });
  });

  it('stars the focused row’s track first', async () => {
    document.body.innerHTML =
      '<ul><li data-star-row="4"><button class="ss-star" data-star="off" aria-label="Star Copper Sky"></button><button id="more">…</button></li></ul>';
    document.getElementById('more')!.focus();
    expect(starFromKeyboard({ id: '9', title: 'Night Ferry' }, store)?.id).toBe('4');
    await flush();
    expect(calls.at(-1)).toEqual({ path: 'stars', body: { track_ids: ['4'] } });
  });

  it('else the playing track; nothing without one', async () => {
    expect(starFromKeyboard({ id: '9', title: 'Night Ferry' }, store)?.id).toBe('9');
    await flush();
    expect(store.get('9')?.starred).toBe(true);
    expect(starFromKeyboard(null, store)).toBeNull();
  });

  it('is the player’s global key, with Shift S left to the visuals', () => {
    const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
    const fn = extractFunction('handlePlayerKeyboardShortcuts', source);
    const handler = new Function(
      'document',
      'window',
      `const audioPlayer = null, npQueue = [], npVolumePercent = 50, currentTrack = null;
       const npSetVolume = () => {}, handleNpMuteToggle = () => {}, playNextInQueue = () => {},
         playPreviousInQueue = () => {}, togglePlayback = () => {};
       ${fn}
       return handlePlayerKeyboardShortcuts;`,
    )(document, window) as (e: KeyboardEvent) => void;
    const key = vi.fn(() => true);
    window.SoulSyncStarKey = key;
    const press = (shiftKey: boolean) => {
      const ev = new KeyboardEvent('keydown', {
        key: shiftKey ? 'S' : 's',
        shiftKey,
        cancelable: true,
      });
      handler(ev);
      return ev.defaultPrevented;
    };
    expect(press(false)).toBe(true);
    expect(press(true)).toBe(false);
    expect(key).toHaveBeenCalledTimes(1);
    delete window.SoulSyncStarKey;
  });
});
