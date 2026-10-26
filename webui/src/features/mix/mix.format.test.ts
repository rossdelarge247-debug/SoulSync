import { describe, expect, it } from 'vitest';

import type { ViewRow } from '@/features/sets/sets.api';

import { findPlayingInSet, lastPlayable, rowNumbers, stripCells } from './mix-model';
import {
  addLabel,
  addedLabel,
  clockWords,
  matchesFoot,
  setMetaWords,
  stepWord,
  stripLine,
  trackOfWords,
  vibeOffWords,
  workingSetName,
} from './mix.format';

function row(id: string | null, energy: number | null = 5, playable = true): ViewRow {
  return {
    track_id: id,
    artist: 'A',
    title: `T${id}`,
    state: id ? 'owned' : 'missing',
    track:
      id && playable
        ? ({ id, title: `T${id}`, dj: energy ? { energy, key: '8A' } : null } as ViewRow['track'])
        : null,
  } as ViewRow;
}

describe('words', () => {
  it('names a new working set by the day (29d)', () => {
    expect(workingSetName(new Date(2026, 9, 26))).toBe('Set from Monday 26 Oct');
  });
  it('says the primary and the add', () => {
    expect(addLabel('Night Ferry', 'Sunday Set')).toBe('Add Night Ferry to Sunday Set');
    expect(addedLabel(7)).toBe('✓ Added · #7');
    expect(trackOfWords(4, 12)).toBe('Track 4 of 12');
  });
  it('says the set and the time', () => {
    expect(setMetaWords(6, 2280)).toBe('6 tracks · 38 min');
    expect(setMetaWords(6, 2280, true)).toBe('6 · 38 min');
    expect(setMetaWords(1, 0)).toBe('1 track');
    expect(clockWords(134)).toBe('2:14');
    expect(clockWords(3729)).toBe('1:02:09');
  });
  it('words the step and Vibe', () => {
    expect(stepWord({ kind: 'smooth', reason: '', steps: 0, bpm_diff: 0 })).toBe('Smooth');
    expect(stepWord({ kind: 'jump', reason: '', steps: 2, bpm_diff: 0 })).toBe('Jump');
    expect(stepWord({ kind: 'unknown', reason: '', steps: null, bpm_diff: null })).toBe(
      'Not known yet',
    );
    expect(vibeOffWords('cap_reached')).toMatch(/budget is spent/);
    expect(vibeOffWords(null)).toBe('');
    expect(matchesFoot({})).toBe('From your library, files present · starred first among equals');
    expect(matchesFoot({ vibeLine: 'Warmer first.' })).toBe(
      'Ordered for feel by the AI · Warmer first.',
    );
  });
  it('draws the strip’s line: the set solid, the step to now dashed', () => {
    const line = stripLine([4, 5, 6, 6]);
    expect(line.solid.split(' ')).toHaveLength(3);
    expect(line.dashed.split(' ')).toHaveLength(2);
    expect(stripLine([null, 6]).dashed).toBe('');
  });
});

describe('the working set while it plays', () => {
  const rows = [row('4'), row(null), row('1'), row('5'), row('9', 5, false)];
  it('numbers rows as the set’s page does', () => {
    expect(rowNumbers(rows)).toEqual([1, null, 2, 3, 4]);
    expect(lastPlayable(rows)?.track_id).toBe('5');
  });
  it('knows the set is playing only when the queue follows it', () => {
    const steps = [
      null,
      null,
      { kind: 'smooth', reason: 'r', steps: 1, bpm_diff: 2 },
      null,
      null,
    ] as never;
    const playing = findPlayingInSet(rows, steps, '1', { ids: ['4', '1', '5'], index: 1 });
    expect(playing).toMatchObject({ number: 2, total: 4, rowIndex: 2 });
    expect(playing?.next?.track_id).toBe('5');
    expect(findPlayingInSet(rows, steps, '1', { ids: ['1', '8'], index: 0 })).toBeNull();
    // the last one counts on the one before
    expect(findPlayingInSet(rows, steps, '5', { ids: ['1', '5'], index: 1 })?.number).toBe(3);
  });
  it('fills the strip with the last three, then the playing track', () => {
    const cells = stripCells(rows, { id: '7', title: 'Night Ferry' }, null, null);
    expect(cells.map((c) => c.pos)).toEqual(['#2', '#3', '#4', 'now']);
    const playing = findPlayingInSet(rows, [], '5', { ids: ['1', '5'], index: 1 });
    expect(stripCells(rows, { id: '5', title: 'T5' }, null, playing).map((c) => c.pos)).toEqual([
      '#1',
      '#2',
      '#3',
    ]);
  });
});
