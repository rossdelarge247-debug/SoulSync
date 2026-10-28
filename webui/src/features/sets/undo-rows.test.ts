import { describe, expect, it } from 'vitest';

import { nearestRow, undoMove, undoRemove, undoSwap } from './undo-rows';

/** gauntlet review H1: Undo is the inverse edit on the rows as they are now */

interface R {
  track_id: string | null;
  artist: string;
  title: string;
  state: string;
  version?: string | null;
  want?: string;
  note?: string;
}

const row = (id: string | null, title: string, extra: Partial<R> = {}): R => ({
  track_id: id,
  artist: 'A',
  title,
  state: 'owned',
  ...extra,
});

describe('undo-rows', () => {
  it('puts a removed row back after its old neighbour, keeping a row added since', () => {
    const a = row('1', 'One');
    const b = row('2', 'Two');
    const c = row('3', 'Three');
    // Two was removed; then the Mix tab added Four at the end (a server copy:
    // new objects for the same rows)
    const now = [{ ...a }, { ...c }, row('4', 'Four')];
    expect(undoRemove(now, b, 1, a).map((r) => r.title)).toEqual(['One', 'Two', 'Three', 'Four']);
  });

  it('puts a removed first row back first, and falls back to its index', () => {
    const b = row('2', 'Two');
    expect(undoRemove([row('3', 'Three')], row('1', 'One'), 0, null)[0].title).toBe('One');
    // its neighbour has gone too: its old place, clamped
    expect(undoRemove([row('3', 'Three')], b, 5, row('9', 'Gone')).map((r) => r.title)).toEqual([
      'Three',
      'Two',
    ]);
  });

  it('moves a row back by what it is, not by where the copy had it', () => {
    const moved = row('3', 'Three');
    // Three went from 2 to 0; since then Four was added at the top
    const now = [row('4', 'Four'), { ...moved }, row('1', 'One'), row('2', 'Two')];
    expect(undoMove(now, moved, 0, 2)!.map((r) => r.title)).toEqual([
      'Four',
      'One',
      'Three',
      'Two',
    ]);
  });

  it('drops a move or a swap whose row has gone', () => {
    expect(undoMove([row('1', 'One')], row('3', 'Three'), 0, 1)).toBeNull();
    expect(
      undoSwap([row('1', 'One')], row('6', 'Six'), 0, row('2', 'Two'), ['track_id']),
    ).toBeNull();
  });

  it('swaps back only the swapped fields, keeping a note made since', () => {
    const was = row('2', 'Two', { state: 'missing', version: 'Dub', want: 'wanted' });
    const now = [row('1', 'One'), row('6', 'Six', { note: 'later', want: 'yours' })];
    const back = undoSwap(now, row('6', 'Six'), 1, was, [
      'track_id',
      'artist',
      'title',
      'state',
      'version',
      'want',
    ])!;
    expect(back[1]).toMatchObject({
      track_id: '2',
      title: 'Two',
      state: 'missing',
      version: 'Dub',
      want: 'wanted',
      note: 'later',
    });
    expect(back[0]).toBe(now[0]);
  });

  it('takes the copy nearest where the edit left it when a track is in twice', () => {
    const rows = [row('1', 'One'), row('2', 'Two'), row('1', 'One')];
    expect(nearestRow(rows, row('1', 'One'), 2)).toBe(2);
    expect(nearestRow(rows, row('1', 'One'), 0)).toBe(0);
    // an id from the server as a number is the same row
    expect(
      nearestRow([{ track_id: 1 as never, artist: 'A', title: 'One' }], row('1', 'One'), 0),
    ).toBe(0);
  });
});
