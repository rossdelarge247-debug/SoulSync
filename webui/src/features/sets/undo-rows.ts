/**
 * UX-8's Undo on a set's page, as the inverse of the edit applied to the rows
 * as they are NOW (gauntlet review H1). Putting back a copy taken before the
 * edit would also throw away whatever came in since: a track the Mix tab
 * added, a newer copy the autosave adopted from the server.
 *
 * Rows are matched by what they are (track, artist, title), not by object:
 * a row adopted from the server is a new object for the same row. With the
 * same track twice, the one nearest where the edit left it is taken.
 */
import { moveRow } from './sets.format';

interface RowLike {
  track_id: string | number | null;
  artist: string | null;
  title: string | null;
  locked?: boolean | null;
}

const key = (row: RowLike) =>
  `${String(row.track_id ?? '')}\u0000${row.artist ?? ''}\u0000${row.title ?? ''}`;

/** The index of the row that is `like`, nearest `hint`; -1 when it's gone. */
export function nearestRow<T extends RowLike>(rows: T[], like: RowLike, hint: number): number {
  const want = key(like);
  let best = -1;
  rows.forEach((row, i) => {
    if (key(row) !== want) return;
    if (best < 0 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
  });
  return best;
}

/** Put a removed row back after the row that was before it (or at its old place). */
export function undoRemove<T extends RowLike>(
  rows: T[],
  removed: T,
  index: number,
  before: RowLike | null,
): T[] {
  let at = index;
  if (before) {
    const prev = nearestRow(rows, before, index - 1);
    if (prev >= 0) at = prev + 1;
  } else at = 0;
  at = Math.max(0, Math.min(rows.length, at));
  return [...rows.slice(0, at), removed, ...rows.slice(at)];
}

/** Move a moved row back to `from`; null when it isn't in the set any more. */
export function undoMove<T extends RowLike>(
  rows: T[],
  moved: RowLike,
  at: number,
  from: number,
): T[] | null {
  const now = nearestRow(rows, moved, at);
  if (now < 0) return null;
  return moveRow(rows, now, from);
}

/** The fields a swap changes, put back as they were. */
export function undoSwap<T extends RowLike>(
  rows: T[],
  swappedIn: RowLike,
  index: number,
  was: T,
  fields: readonly (keyof T)[],
): T[] | null {
  const now = nearestRow(rows, swappedIn, index);
  if (now < 0) return null;
  const back: Partial<T> = {};
  for (const field of fields) back[field] = was[field];
  return rows.map((row, i) => (i === now ? { ...row, ...back } : row));
}
