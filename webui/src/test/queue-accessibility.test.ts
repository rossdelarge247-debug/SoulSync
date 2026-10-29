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
      npIsSpokenWord = () => false, showToast = () => {},
      updateNpPrevNextButtons = () => {}, npScheduleQueuePrefetch = () => {}, npStopQueuePrefetchPolling = () => {};
    ${functions}
    return { render: renderNpQueue, state: () => ({ titles: npQueue.map(t => t.title), index: npQueueIndex }) };
  `,
  )(document, window, play);
  queue.render();
});
afterEach(() => {
  delete (window as unknown as { SoulSyncDnd?: unknown }).SoulSyncDnd;
});

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
