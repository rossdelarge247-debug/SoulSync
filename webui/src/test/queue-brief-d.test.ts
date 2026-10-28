/**
 * Brief D in Up next (34b): each row's number, Play ("Play now" cuts to it),
 * Playing (three green bars, pauses) on the playing row, and Move to the top
 * (Up next's Play next) on hover and focus, with the same paths as the React
 * rows (src/features/dj/row-play.tsx).
 */
import { fireEvent, screen } from '@testing-library/dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

import { MOVE_TOP_PATH, PLAYING_PATH, PLAY_PATH } from '@/features/dj/row-play';

import { extractFunction } from './vanilla-extract';

const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const functions = [
  'renderNpQueue',
  'npFocusQueueAction',
  'npAnnounceQueue',
  'npReorderQueue',
  'npMoveNext',
  'npQueuePlayingLabel',
]
  .map((name) => extractFunction(name, source))
  .join('\n');

let queue: {
  render: () => void;
  state: () => { titles: string[]; index: number };
  setPlaying: (on: boolean) => void;
};
let play: ReturnType<typeof vi.fn>;
let toggle: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = '<div id="np-queue-list"></div>';
  play = vi.fn();
  toggle = vi.fn();
  queue = new Function(
    'document',
    'playQueueItem',
    'togglePlayback',
    `
    let npQueue = [
      { title: 'A', artist: 'Artist', file_path: '/a' },
      { title: 'B', artist: 'Artist', file_path: '/b' },
      { title: 'C', artist: 'Artist', file_path: '/c' },
      { title: 'D', artist: 'Artist', file_path: '/d' }
    ], npQueueIndex = 1, isPlaying = true;
    const npQueueStatusLabel = () => '', npUpdateUpNext = () => {}, npPersistQueue = () => {},
      npQueueDragStart = () => {}, npQueueDragOver = () => {}, npQueueDrop = () => {}, npQueueDragEnd = () => {},
      updateNpPrevNextButtons = () => {}, npScheduleQueuePrefetch = () => {}, removeFromQueue = () => {};
    ${functions}
    return { render: renderNpQueue, state: () => ({ titles: npQueue.map(t => t.title), index: npQueueIndex }),
      setPlaying: (on) => { isPlaying = on; } };
  `,
  )(document, play, toggle);
  queue.render();
});

it('numbers each row, and its Play cuts to it (34b\'s "Play now")', () => {
  const nums = [...document.querySelectorAll('.np-queue-item-num')].map((n) => n.textContent);
  expect(nums).toEqual(['1', '2', '3', '4']);
  const playC = screen.getByRole('button', { name: 'Play C now' });
  expect(playC.querySelector('path')!.getAttribute('d')).toBe(PLAY_PATH);
  fireEvent.click(playC);
  expect(play).toHaveBeenCalledWith(2);
});

it("the playing row has Playing (three bars) in Play's place, which pauses", () => {
  const pause = screen.getByRole('button', { name: 'Pause B' });
  expect(pause.dataset.kind).toBe('playing');
  expect(pause.querySelector('path')!.getAttribute('d')).toBe(PLAYING_PATH);
  fireEvent.click(pause);
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(play).not.toHaveBeenCalled();
});

it("[gauntlet L2] paused, the playing row's button says Resume", () => {
  queue.setPlaying(false);
  queue.render();
  expect(screen.getByRole('button', { name: 'Resume B' }).dataset.kind).toBe('playing');
  expect(screen.queryByRole('button', { name: 'Pause B' })).toBeNull();
});

it('Move to the top puts a queued row next; the playing row and the next one have none', () => {
  const top = screen.getByRole('button', { name: 'Move D to the top' });
  expect(top.querySelector('path')!.getAttribute('d')).toBe(MOVE_TOP_PATH);
  expect(screen.getByRole('button', { name: 'Move B to the top' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move C to the top' })).toBeDisabled();
  fireEvent.click(top);
  expect(queue.state()).toEqual({ titles: ['A', 'B', 'D', 'C'], index: 1 });
  expect(screen.getByRole('status').textContent).toBe('D moved to the top: it plays next');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Play D now' }));
});
