/**
 * Design's 38e and 38g (the consistency pass, 2 November): an Up next row is
 * title / artist · format, its length and Play, never the track's key or
 * BPM (they're Tracks' columns and DJ mode's data), and Up next's empty
 * words are "Nothing next. Add from Tracks, an album or Search."
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, expect, it } from 'vitest';

import { UP_NEXT_EMPTY } from '@/shell/player';

import { extractFunction } from './vanilla-extract';

const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const functions = ['npQueueRowMeta', 'renderNpQueue', 'npFocusQueueAction', 'npQueuePlayingLabel']
  .map((name) => extractFunction(name, source))
  .join('\n');

beforeEach(() => {
  document.body.innerHTML =
    '<div id="np-queue-empty" class="hidden"></div><div id="np-queue-list"></div>';
  new Function(
    'document',
    `
    let npQueue = [
      { title: 'Night Ferry', artist: 'Tidewater', file_path: '/a.flac', duration: 312,
        key: '8A', bpm: 124, dj: { key: '8A', bpm: 124, energy: 6 } },
      { title: 'Static Bloom', artist: 'Ferrous', file_path: '/b.flac', duration: 340,
        key: '9A', bpm: 123, camelot: '9A', dj_bpm: 123 }
    ], npQueueIndex = 0, isPlaying = true, npLoadingQueueItem = false, npBuffering = false;
    let npMoveIndex = null;
    const getFileExtension = (p) => p.split('.').pop();
    const formatTime = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    const npQueueStatusLabel = () => '', npUpdateUpNext = () => {}, npPersistQueue = () => {},
      npIsSpokenWord = () => false, npMixHoldsNext = () => false,
      npFirstFreeIndex = () => npQueueIndex + 1, npStartMoveMode = () => {}, npEndMoveMode = () => {},
      updateNpPrevNextButtons = () => {}, npScheduleQueuePrefetch = () => {}, removeFromQueue = () => {},
      playQueueItem = () => {}, togglePlayback = () => {};
    ${functions}
    renderNpQueue();
  `,
  )(document);
});

it('38g: a row is title / artist · format, its length and Play, with no key or BPM', () => {
  const row = document.querySelectorAll<HTMLElement>('.np-queue-item')[1]!;
  expect(row.querySelector('.np-queue-item-title')!.textContent).toBe('Static Bloom');
  expect(row.querySelector('.np-queue-item-artist')!.textContent).toBe('Ferrous · FLAC');
  expect(row.querySelector('.np-queue-item-duration')!.textContent).toBe('5:40');
  expect(row.querySelector('[aria-label="Play Static Bloom now"]')).not.toBeNull();
  for (const r of document.querySelectorAll('.np-queue-item')) {
    expect(r.textContent).not.toMatch(/\b(8A|9A|124|123)\b|BPM/);
  }
});

it("38g: Up next's empty words, in the page and in the player", () => {
  expect(UP_NEXT_EMPTY).toBe('Nothing next. Add from Tracks, an album or Search.');
  expect(html).toContain(
    'id="np-queue-empty">Nothing next. Add from Tracks, an album or Search.</div>',
  );
  const player = readFileSync(resolve(process.cwd(), 'src/shell/player.ts'), 'utf8');
  expect(player).toContain('setText(empty, UP_NEXT_EMPTY)'); // pin-ok: the source names the constant
  expect(player).not.toContain('Nothing after this track');
});
