/**
 * Up next in Brief B's model (32b, 32c): Play next at its top, a place
 * lower down, a transition gap previewing both new chips from the plans
 * already cached (327: never asked for on a hover), the first gap closed
 * while a mix runs, a row moved within it with its Undo, and Space and the
 * arrows on its rows (32d).
 */
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_CHOICE, planKey } from '@/features/automix/plans';
import { getPrefs } from '@/features/automix/prefs';

import { getDnd, resetDndForTests, type Drag } from './dnd-engine';
import { bindUpNext, cachedChip, upNextLine, upNextTarget } from './up-next-dnd';

type Row = Record<string, unknown>;

let queue: Row[];
let index: number;
let announced: string[];
let view: { stage: string; barsToGo: number | null } | null;
let gaps = false;

function render() {
  const list = document.getElementById('np-queue-list')!;
  list.innerHTML = queue
    .map(
      (t, i) =>
        `<div class="np-queue-item" data-dnd-row="upnext" data-dnd-index="${i}">${
          i > index ? '<span data-dnd-grip></span>' : ''
        }<button data-queue-action="play-now">Play</button><button data-queue-action="remove">x</button>${String(t.title)}</div>`,
    )
    .join('');
}

beforeEach(() => {
  document.body.innerHTML =
    '<div id="np-queue-panel"><div id="np-queue-list"></div></div><div id="toast-container"></div>';
  queue = [
    { id: 'a', title: 'Night Ferry', file_path: '/a', dj: { key: '8A', bpm: 124 } },
    { id: 'b', title: 'Static Bloom', file_path: '/b', dj: { key: '9A', bpm: 124 } },
    { id: 'c', title: 'Brass Tide', file_path: '/c', dj: { key: '4B', bpm: 126 } },
  ];
  index = 0;
  announced = [];
  view = null;
  gaps = false;
  const panel = document.getElementById('np-queue-panel')!;
  panel.getClientRects = () => [{}] as unknown as DOMRectList;
  (window as unknown as { SoulSyncPlayer: unknown }).SoulSyncPlayer = {
    state: () => ({ queue, index, track: queue[index] }),
    insertAt: (at: number, tracks: Row[]) => {
      queue.splice(at, 0, ...tracks);
      render();
      return tracks;
    },
    moveTrack: (row: Row, to: number) => {
      const from = queue.indexOf(row);
      if (from < 0) return -1;
      queue.splice(from, 1);
      queue.splice(to, 0, row);
      render();
      return queue.indexOf(row);
    },
    removeTracks: () => 0,
    announce: (w: string) => announced.push(w),
    focusRow: () => {},
  };
  (window as unknown as { SoulSyncAutomix: unknown }).SoulSyncAutomix = {
    view: () => view ?? { stage: 'idle', barsToGo: null },
    gapsWanted: () => gaps,
  };
  window.showToast = vi.fn() as never;
  render();
});
afterEach(() => {
  resetDndForTests();
  delete (window as unknown as { SoulSyncPlayer?: unknown }).SoulSyncPlayer;
  delete (window as unknown as { SoulSyncAutomix?: unknown }).SoulSyncAutomix;
});

const fromTracks = (id = 'x', title = 'Harbour Lights'): Drag => ({
  items: [{ id, title, key: '8A', bpm: 124, queue: { id, title, file_path: `/${id}` } }],
  source: { kind: 'tracks', listId: 'tracks', indexes: [0] },
  via: 'mouse',
});

describe('the line in Up next (32b, 32c)', () => {
  it('says Play next at the top and the place lower down', () => {
    const t = upNextTarget(null);
    expect(t.preview!(fromTracks(), 0)).toEqual({ gap: 1, line: 'Play next' });
    expect(t.preview!(fromTracks(), 3)).toEqual({ gap: 3, line: 'Goes in as #4' });
  });

  it('previews both new chips in a transition gap, from the plans already cached (327)', () => {
    const qc = new QueryClient();
    const lean = getPrefs().lean;
    qc.setQueryData(planKey('b', 'x', AUTO_CHOICE, lean), {
      status: 'ok',
      style: 'long_blend',
      bars: 32,
    });
    qc.setQueryData(planKey('x', 'c', AUTO_CHOICE, lean), { status: 'ok', style: 'cut', bars: 4 });
    gaps = true;
    expect(upNextLine(qc, queue, index, 2, fromTracks().items, false)).toBe(
      'Long blend · 32 then Cut',
    );
    // a pair not planned yet: the chip comes after the drop, the hover never asks
    expect(cachedChip(qc, 'x', 'zzz')).toBeNull();
    expect(upNextLine(qc, queue, index, 3, fromTracks().items, false)).toBe('Goes in as #4');
  });

  it('closes the first gap while a mix runs or counts down (32c)', () => {
    const t = upNextTarget(null);
    view = { stage: 'mixing', barsToGo: null };
    expect(t.preview!(fromTracks(), 1).invalid).toBe(
      "Can't replace the incoming track · drop after it",
    );
    expect(t.preview!(fromTracks(), 2).invalid).toBeUndefined();
    view = { stage: 'ready', barsToGo: 12 };
    expect(t.preview!(fromTracks(), 1).invalid).toBe(
      "Can't replace the incoming track · drop after it",
    );
  });

  it('never lands at or above the playing row', () => {
    index = 1;
    render();
    expect(upNextTarget(null).preview!(fromTracks(), 0).gap).toBe(2);
  });
});

describe('a drop in Up next', () => {
  it('moves an Up next row within it, with an Undo that puts it back (32g: ● move)', async () => {
    const t = upNextTarget(null);
    const drag: Drag = {
      items: [{ id: 'c', title: 'Brass Tide', queue: queue[2] }],
      source: { kind: 'upnext', listId: 'upnext', indexes: [2] },
      via: 'mouse',
    };
    const done = await t.drop(drag, 1);
    expect(queue.map((q) => q.id)).toEqual(['a', 'c', 'b']);
    expect(done?.words).toBe('Moved Brass Tide to #2');
    await done?.undo?.();
    expect(queue.map((q) => q.id)).toEqual(['a', 'b', 'c']);
  });

  it('copies anything else in at its place (32g: ○ copy)', async () => {
    const done = await upNextTarget(null).drop(fromTracks(), 2);
    expect(queue.map((q) => q.id)).toEqual(['a', 'b', 'x', 'c']);
    expect(done?.words).toBe('Added Harbour Lights to Up next · #3');
  });

  it('refuses a track without its queue shape (not a library track)', () => {
    const drag = fromTracks();
    drag.items[0].queue = null;
    expect(upNextTarget(null).accepts(drag)).toEqual({
      ok: false,
      reason: 'Only library tracks can be mixed · Download it first',
    });
  });
});

describe('the keyboard on Up next’s rows (32d, UX-27)', () => {
  it('is one tab stop; Space lifts a row to come, the arrows move it with its steps, Enter drops', async () => {
    const off = bindUpNext(null);
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.np-queue-item'));
    expect(rows().map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(rows()[0].querySelector('button')!.getAttribute('tabindex')).toBe('-1');
    const row = rows()[2];
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(getDnd().kbd).toEqual({ targetId: 'upnext', from: 2, at: 2 });
    expect(announced.at(-1)).toBe(
      'Picked up Brass Tide, 3 of 3. Arrows move it; Enter drops; Escape cancels.',
    );
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(announced.at(-1)).toBe(
      'Brass Tide, 2 of 3. After Night Ferry: Jump, 8A to 4B, the keys clash. Before Static Bloom: Jump.',
    );
    // the playing row holds its place
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(getDnd().kbd?.at).toBe(1);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(queue.map((q) => q.id)).toEqual(['a', 'c', 'b']));
    off();
  });

  it('Delete removes the focused row (not the playing one)', () => {
    const off = bindUpNext(null);
    const removed = vi.fn();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.np-queue-item'));
    rows[1].querySelector('[data-queue-action="remove"]')!.addEventListener('click', removed);
    rows[0].querySelector('[data-queue-action="remove"]')!.addEventListener('click', removed);
    rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(removed).not.toHaveBeenCalled();
    rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(removed).toHaveBeenCalledTimes(1);
    off();
  });
});
