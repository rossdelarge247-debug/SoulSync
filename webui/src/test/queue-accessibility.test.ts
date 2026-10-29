import { fireEvent, screen } from '@testing-library/dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { extractFunction } from './vanilla-extract';
const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const functions = [
  'renderNpQueue',
  'npFocusQueueAction',
  'npAnnounceQueue',
  'npReorderQueue',
  'removeFromQueue',
  'npQueuePlayingLabel',
  'npStartMoveMode',
  'npEndMoveMode',
  'npMoveTrack',
  'npRemoveTracks',
]
  .map((name) => extractFunction(name, source))
  .join('\n');
let queue: any;
let play: ReturnType<typeof vi.fn>;
let dropped: { words: string; undo: () => void }[];
beforeEach(() => {
  document.body.innerHTML = '<div id="np-queue-list"></div>';
  play = vi.fn();
  dropped = [];
  (window as unknown as { SoulSyncDnd: unknown }).SoulSyncDnd = {
    showDropResult: (r: { words: string; undo: () => void }) => dropped.push(r),
  };
  queue = new Function(
    'document',
    'window',
    'playQueueItem',
    `
    let npQueue = [
      { title: 'A', artist: 'Artist', file_path: '/a' },
      { title: 'B', artist: 'Artist', file_path: '/b' },
      { title: 'C', artist: 'Artist', file_path: '/c' },
      { title: 'D', artist: 'Artist', file_path: '/d' }
    ], npQueueIndex = 0, isPlaying = true, npLoadingQueueItem = false, npBuffering = false;
    let npMoveIndex = null, npMoveStart = null;
    const npQueueStatusLabel = () => '', npUpdateUpNext = () => {}, npPersistQueue = () => {},
      npIsSpokenWord = () => false,
      npMixHoldsNext = () => Boolean(window.__npMixHolds),
      npFirstFreeIndex = () => npQueueIndex + 1 + (npMixHoldsNext() ? 1 : 0),
      NP_PLAYING_NOW = "Can't undo: it's playing now", NP_INCOMING = "Can't replace the incoming track · drop after it", showToast = () => {},
      updateNpPrevNextButtons = () => {}, npScheduleQueuePrefetch = () => {}, npStopQueuePrefetchPolling = () => {};
    ${functions}
    return { render: renderNpQueue, state: () => ({ titles: npQueue.map(t => t.title), index: npQueueIndex }),
      rows: () => npQueue, moveTrack: npMoveTrack, removeTracks: npRemoveTracks,
      advance: () => { npQueueIndex += 1; renderNpQueue(); } };
  `,
  )(document, window, play);
  queue.render();
});
afterEach(() => {
  delete (window as unknown as { SoulSyncDnd?: unknown }).SoulSyncDnd;
  delete (window as unknown as { __npMixHolds?: unknown }).__npMixHolds;
});

const mixHolds = (on: boolean) => {
  (window as unknown as { __npMixHolds?: boolean }).__npMixHolds = on;
};

it('exposes named native Play controls without clickable row ambiguity', () => {
  const button = screen.getByRole('button', { name: 'Play C by Artist' });
  expect(button.tagName).toBe('BUTTON');
  fireEvent.click(button);
  expect(play).toHaveBeenCalledWith(2);
});

it('gives each row to come a grip and its place for Brief B’s drag, the playing row none (32b)', () => {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.np-queue-item'));
  expect(rows.map((r) => r.dataset.dndIndex)).toEqual(['0', '1', '2', '3']);
  expect(rows.map((r) => r.dataset.dndRow)).toEqual(['upnext', 'upnext', 'upnext', 'upnext']);
  expect(rows.map((r) => Boolean(r.querySelector('[data-dnd-grip]')))).toEqual([
    false,
    true,
    true,
    true,
  ]);
  // no HTML5 drag left beside the pointer one
  expect(rows.some((r) => r.draggable)).toBe(false);
});

it('has no earlier or later buttons any more (HANDOFF 377): the Move mode is the phone’s way (32f)', () => {
  expect(screen.queryByRole('button', { name: 'Move C earlier' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Move D' }));
  expect(document.querySelector('.np-queue-move-head')?.textContent).toContain('Moving D · 4 of 4');
  expect(screen.getByRole('status').textContent).toContain('Moving D, 4 of 4');
  expect(screen.getByRole('button', { name: 'Move D down' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Move D up' }));
  expect(queue.state()).toEqual({ titles: ['A', 'B', 'D', 'C'], index: 0 });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move D up' }));
  expect(screen.getByRole('status').textContent).toBe('D, 3 of 4');
  // never above the playing row
  fireEvent.click(screen.getByRole('button', { name: 'Move D up' }));
  expect(screen.getByRole('button', { name: 'Move D up' })).toBeDisabled();
  expect(queue.state().titles).toEqual(['A', 'D', 'B', 'C']);
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(document.querySelector('.np-queue-move-head')).toBeNull();
  // Done says where it went with the drag's own Undo (32f)
  expect(dropped.map((d) => d.words)).toEqual(['Moved D to #2']);
  dropped[0].undo();
  expect(queue.state()).toEqual({ titles: ['A', 'B', 'C', 'D'], index: 0 });
});

it('says nothing on Done when the row didn’t move', () => {
  fireEvent.click(screen.getByRole('button', { name: 'Move B' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(dropped).toEqual([]);
});

it('restores focus after removing a queued track', () => {
  fireEvent.click(screen.getByRole('button', { name: 'Remove B from queue' }));
  expect(queue.state()).toEqual({ titles: ['A', 'C', 'D'], index: 0 });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove C from queue' }));
  expect(play).not.toHaveBeenCalled();
});

it('keeps a focused row focused when Up next is drawn again (the row grid, UX-27)', () => {
  const row = document.querySelectorAll<HTMLElement>('.np-queue-item')[2];
  row.tabIndex = 0;
  row.focus();
  queue.render();
  expect(document.activeElement).toBe(document.querySelectorAll('.np-queue-item')[2]);
});

/* ── Brief B's review: H1 and M3 ──────────────────────────────────────── */

it('[review H1] a move found by its row refuses once that row plays, so Undo never strands rows', () => {
  const D = queue.rows()[3];
  // dragged to Play next: A* D B C
  expect(queue.moveTrack(D, 1)).toBe(1);
  expect(queue.state()).toEqual({ titles: ['A', 'D', 'B', 'C'], index: 0 });
  // A ends: D plays; the drop's Undo (moveTrack(D, 3)) must not move it
  queue.advance();
  expect(queue.moveTrack(D, 3)).toBe(-2);
  expect(queue.state()).toEqual({ titles: ['A', 'D', 'B', 'C'], index: 1 });
  // a row not in Up next any more
  expect(queue.moveTrack({ title: 'Z' }, 2)).toBe(-1);
});

it('[review H1] the Move mode’s Undo says it can’t once the moved row is playing', () => {
  fireEvent.click(screen.getByRole('button', { name: 'Move D' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move D up' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move D up' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(queue.state()).toEqual({ titles: ['A', 'D', 'B', 'C'], index: 0 });
  queue.advance();
  expect(() => dropped[0].undo()).toThrow("Can't undo: it's playing now");
  expect(queue.state()).toEqual({ titles: ['A', 'D', 'B', 'C'], index: 1 });
});

it('[review M3] while a mix holds the incoming row nothing takes its place or moves it', () => {
  mixHolds(true);
  const [, B, , D] = queue.rows();
  // to Play next: lands after the incoming row instead
  expect(queue.moveTrack(D, 1)).toBe(2);
  expect(queue.state().titles).toEqual(['A', 'B', 'D', 'C']);
  // the incoming row itself doesn't move, nor go on a drop's Undo
  expect(queue.moveTrack(B, 3)).toBe(-3);
  expect(queue.removeTracks([B])).toBe(0);
  expect(queue.state().titles).toEqual(['A', 'B', 'D', 'C']);
  // the Move mode won't start on it, and its ▲ stops below it
  fireEvent.click(screen.getByRole('button', { name: 'Move B' }));
  expect(document.querySelector('.np-queue-move-head')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe(
    "Can't replace the incoming track · drop after it",
  );
  fireEvent.click(screen.getByRole('button', { name: 'Move D' }));
  expect(screen.getByRole('button', { name: 'Move D up' })).toBeDisabled();
  expect(queue.state().titles).toEqual(['A', 'B', 'D', 'C']);
});

it('[review L-d] an empty grip (played and playing rows) lets a press through to the row’s Play', () => {
  const css = readFileSync(resolve(process.cwd(), 'static/player.css'), 'utf8');
  expect(css).toMatch(
    /\.np-queue-item-grip:not\(\[data-dnd-grip\]\)\s*\{\s*pointer-events:\s*none;/,
  );
  const grips = [...document.querySelectorAll('.np-queue-item .np-queue-item-grip')];
  // the playing row's grip is the empty one; the rows to come can be lifted
  expect(grips[0].hasAttribute('data-dnd-grip')).toBe(false);
  expect(grips.slice(1).every((g) => g.hasAttribute('data-dnd-grip'))).toBe(true);
});
