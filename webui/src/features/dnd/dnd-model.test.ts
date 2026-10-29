import { describe, expect, it } from 'vitest';

import {
  REASONS,
  autoScrollSpeed,
  cancelledWords,
  dropMode,
  dropWords,
  duplicateNumber,
  duplicateWords,
  gapAt,
  gapToIndex,
  ghostWords,
  insertKeepingLocked,
  insertionLine,
  keyboardTarget,
  liftRefusal,
  lockedAt,
  lockedWords,
  movedWords,
  numbersWords,
  pickedUpWords,
  placedIndexes,
  removeKeepingLocked,
  snapGap,
  stepBetween,
  stepLine,
  stepSpoken,
  wheelSteps,
  type DragItem,
} from './dnd-model';

const t = (
  id: string,
  key: string | null = null,
  bpm: number | null = null,
  more: Partial<DragItem> = {},
): DragItem => ({
  id,
  title: id,
  key,
  bpm,
  ...more,
});

const row = (id: string, locked = false) => ({ id, locked });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).join('');

describe('what lifts (32b state 5, 328)', () => {
  it('lifts library tracks with their file', () => {
    expect(liftRefusal([t('a'), t('b')])).toBeNull();
  });
  it('says File missing for a missing file, and for a drive that is away (328: refused)', () => {
    expect(liftRefusal([t('a', null, null, { fileMissing: true })])).toEqual({
      reason: REASONS.fileMissing,
      action: 'find',
    });
    expect(
      liftRefusal([t('a'), t('b', null, null, { away: 'Music HD isn’t connected' })])?.reason,
    ).toBe("Can't be lifted: its file is missing");
  });
  it('says Download it first for a result that is not yours', () => {
    expect(liftRefusal([t('a', null, null, { inLibrary: false })])?.reason).toBe(
      'Only library tracks can be mixed · Download it first',
    );
  });
});

describe('move or copy (32g)', () => {
  it('moves within one list and copies anywhere else', () => {
    expect(dropMode({ kind: 'set', listId: 'set:4', indexes: [2] }, 'set:4')).toBe('move');
    expect(dropMode({ kind: 'upnext', listId: 'upnext', indexes: [3] }, 'set:4')).toBe('copy');
    expect(dropMode({ kind: 'set', listId: 'set:4', indexes: [3] }, 'upnext')).toBe('copy');
  });
});

describe('the step, by Sets’ rules (core/sets/steps.py)', () => {
  it('counts steps round the wheel', () => {
    expect(wheelSteps('8A', '9A')).toBe(1);
    expect(wheelSteps('8A', '8B')).toBe(1);
    expect(wheelSteps('7A', '4B')).toBe(4);
    expect(wheelSteps('12A', '1A')).toBe(1);
    expect(wheelSteps('8A', 'x')).toBeNull();
  });
  it('is Smooth within one step and 3 BPM, Jump past either', () => {
    expect(stepLine(stepBetween({ key: '8A', bpm: 124 }, { key: '9A', bpm: 124 })!)).toBe(
      'Smooth · 8A → 9A, +1',
    );
    expect(stepLine(stepBetween({ key: '7A', bpm: 122 }, { key: '4B', bpm: 126 })!)).toBe(
      'Jump · 7A → 4B, +4',
    );
    expect(stepLine(stepBetween({ key: '9A', bpm: 124 }, { key: '9A', bpm: 124 })!)).toBe(
      'Smooth · 9A → 9A, same key',
    );
    // the tempo makes the jump: it's said
    expect(stepLine(stepBetween({ key: '8A', bpm: 120 }, { key: '8A', bpm: 126 })!)).toBe(
      'Jump · 8A → 8A, same key, +6 BPM',
    );
    // half time is the same tempo
    expect(stepBetween({ key: '8A', bpm: 87 }, { key: '8A', bpm: 174 })?.kind).toBe('smooth');
  });
  it('is not guessed when a BPM or a key is missing (327)', () => {
    expect(stepBetween({ key: '8A', bpm: null }, { key: '9A', bpm: 124 })).toBeNull();
    expect(stepBetween({ key: null, bpm: 120 }, { key: '9A', bpm: 124 })).toBeNull();
  });
  it('is said aloud in 32d’s words', () => {
    expect(stepSpoken(stepBetween({ key: '9A', bpm: 124 }, { key: '9A', bpm: 125 })!)).toBe(
      'Smooth, 9A to 9A',
    );
    expect(stepSpoken(stepBetween({ key: '4B', bpm: 126 }, { key: '9A', bpm: 125 })!)).toBe(
      'Jump, 4B to 9A, the keys clash',
    );
    expect(stepSpoken(stepBetween({ key: '9A', bpm: 118 }, { key: '9A', bpm: 125 })!)).toBe(
      'Jump, 9A to 9A, the tempos are 7 BPM apart',
    );
  });
});

describe('the insertion line (32a)', () => {
  const before = { title: 'Harbour Lights', key: '8A', bpm: 124 };
  const after = { title: 'Brass Tide', key: '4B', bpm: 126 };
  it('previews both new steps, the count and the jump into the next track', () => {
    expect(
      insertionLine(before, [t('Static Bloom', '9A', 124), t('Undertow', '7A', 122)], after),
    ).toBe('Smooth · 8A → 9A, +1 · 2 tracks · Jump · 7A → 4B, +4 into Brass Tide');
  });
  it('leaves out a step it doesn’t know, and says nothing with neither (327)', () => {
    expect(insertionLine(before, [t('x', null, null)], after)).toBeNull();
    expect(insertionLine(null, [t('Canopy', '9A', 125)], after)).toBe(
      'Jump · 9A → 4B, +6 into Brass Tide',
    );
  });
});

describe('locked rows hold (275)', () => {
  const rows = [row('A'), row('B'), row('C'), row('D', true), row('E')];
  it('inserts with the locked rows keeping their places, as the server does', () => {
    expect(ids(insertKeepingLocked(rows, 1, [row('N')]))).toBe('ANBDCE');
    expect(ids(insertKeepingLocked(rows, 5, [row('N')]))).toBe('ABCDEN');
    expect(ids(insertKeepingLocked(rows, 0, [row('N'), row('M')]))).toBe('NMADBCE');
  });
  it('never opens the line at a locked row’s place: it lands after it', () => {
    expect(snapGap(rows, 3)).toBe(4);
    expect(lockedAt(rows, 3)).toBe(3);
    expect(lockedAt(rows, 2)).toBe(-1);
    expect(ids(insertKeepingLocked(rows, snapGap(rows, 3), [row('N')]))).toBe('ABCDNE');
    expect(lockedWords('Canopy')).toBe('Canopy is locked in its place · drops land after it');
    expect(snapGap([row('A'), row('B', true), row('C', true)], 1)).toBe(3);
  });
  it('says where the new rows went', () => {
    expect(placedIndexes(rows, 1, [row('N')])).toEqual([1]);
    expect(placedIndexes(rows, 4, [row('N'), row('M')])).toEqual([4, 5]);
  });
  it('undoes an insert exactly (the unlocked rows flow back)', () => {
    const fresh = [row('N')];
    const next = insertKeepingLocked(rows, 1, fresh);
    expect(ids(removeKeepingLocked(next, [next.indexOf(fresh[0])]))).toBe('ABCDE');
    const two = [row('N'), row('M')];
    const after = insertKeepingLocked(rows, 0, two);
    expect(
      ids(
        removeKeepingLocked(
          after,
          two.map((r) => after.indexOf(r)),
        ),
      ),
    ).toBe('ABCDE');
  });
  it('steps the keyboard over locked places (32d)', () => {
    expect(keyboardTarget(rows, 2, 2, 'down')).toBe(4);
    expect(keyboardTarget(rows, 4, 4, 'up')).toBe(2);
    expect(keyboardTarget(rows, 2, 2, 'top')).toBe(0);
    expect(keyboardTarget(rows, 0, 0, 'end')).toBe(4);
    expect(keyboardTarget(rows, 0, 0, 'up')).toBe(0);
  });
  it('turns a drop gap into the moved row’s index', () => {
    expect(gapToIndex(1, 4)).toBe(3);
    expect(gapToIndex(3, 1)).toBe(1);
  });
});

describe('duplicates (32b state 6)', () => {
  it('finds the number of a track the set already holds', () => {
    expect(duplicateNumber(['1', null, '2', '3'], [t('3')], (i) => i)).toBe(3);
    expect(duplicateNumber(['1', '2'], [t('9')])).toBeNull();
    expect(duplicateWords(4)).toBe('In it already · #4 · drop to add again');
  });
});

describe('the words', () => {
  it('numbers', () => {
    expect(numbersWords([7])).toBe('#7');
    expect(numbersWords([8, 7])).toBe('#7–8');
    expect(numbersWords([3, 9])).toBe('#3, #9');
  });
  it('the ghost: title · key BPM, or two titles and a count', () => {
    expect(ghostWords([t('Static Bloom', '9A', 124)])).toEqual({
      title: 'Static Bloom',
      meta: '9A 124',
      count: 1,
    });
    expect(ghostWords([t('Static Bloom', '9A', 124), t('Undertow', '7A', 122)])).toEqual({
      title: 'Static Bloom, Undertow',
      meta: '9A 124 · 7A 122',
      count: 2,
    });
  });
  it('the toast (32b state 8, 32f)', () => {
    expect(
      dropWords({ mode: 'copy', items: [t('a'), t('b')], where: 'Sunday Set', numbers: [7, 8] }),
    ).toBe('Added 2 to Sunday Set · #7–8');
    expect(
      dropWords({ mode: 'move', items: [t('Canopy')], where: 'Sunday Set', numbers: [5] }),
    ).toBe('Moved Canopy to #5');
    expect(
      dropWords({ mode: 'copy', items: [t('Canopy')], where: 'Up next', playNext: true }),
    ).toBe('Playing next: Canopy');
  });
  it('32d’s announcements', () => {
    expect(pickedUpWords('Canopy', 3, 8)).toBe(
      'Picked up Canopy, 3 of 8. Arrows move it; Enter drops; Escape cancels.',
    );
    expect(
      movedWords(
        'Canopy',
        5,
        8,
        { key: '9A', bpm: 125 },
        { title: 'Brass Tide', key: '4B', bpm: 126 },
        { title: 'Undertow', key: '9A', bpm: 124 },
      ),
    ).toBe(
      'Canopy, 5 of 8. After Brass Tide: Jump, 4B to 9A, the keys clash. Before Undertow: Smooth.',
    );
    expect(movedWords('Canopy', 1, 8, { key: '9A', bpm: 125 }, null, null)).toBe(
      'Canopy, 1 of 8. At the top.',
    );
    expect(cancelledWords('Canopy', 3, 8)).toBe('Cancelled. Canopy is back at 3 of 8.');
  });
});

describe('the pointer', () => {
  it('auto-scrolls at 8 rows a second near an edge, not in the middle (32a)', () => {
    expect(autoScrollSpeed(110, 100, 700, 56)).toBe(-448);
    expect(autoScrollSpeed(690, 100, 700, 56)).toBe(448);
    expect(autoScrollSpeed(400, 100, 700, 56)).toBe(0);
  });
  it('finds the gap under the pointer by the rows’ middles', () => {
    const rects = [
      { top: 0, bottom: 50 },
      { top: 50, bottom: 100 },
    ];
    expect(gapAt(rects, 10)).toBe(0);
    expect(gapAt(rects, 30)).toBe(1);
    expect(gapAt(rects, 99)).toBe(2);
  });
});
