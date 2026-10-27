/**
 * A mix set and auto-mix (26i, 28e):
 *
 * - **Play as a mix**: the set's tracks with their files, in order, as the
 *   queue; each carries its row and the set's chip after it
 *   (`mix_set: {id, name, row, transition}`), so Up next shows the set's
 *   chips and they play with DJ mix for this play, whatever the setting;
 * - **Save it to the set too**: a chip changed in Up next while a set plays
 *   is asked about in place (26i), and saved to the set's row here, at the
 *   revision the set is at (the set page's own rule).
 */
import type { Transition, ViewRow } from '@/features/sets/sets.api';

import { fetchSet, updateSet } from '@/features/sets/sets.api';

import type { QueueTrack } from './controller';

/** The queue a set plays as: its rows whose files are here, each with its chip. */
export function setQueue(set: { id: number; name: string }, rows: ViewRow[]): QueueTrack[] {
  const out: QueueTrack[] = [];
  rows.forEach((row, index) => {
    const t = row.track;
    if (!t || !t.file_path) return;
    out.push({
      id: t.id,
      title: t.title,
      artist: t.artist_name,
      album_id: t.album_id,
      file_path: t.file_path,
      image_url: t.image_url,
      duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
      mix_set: {
        id: set.id,
        name: set.name,
        row: index,
        transition: row.transition
          ? { style: row.transition.style, bars: row.transition.bars }
          : null,
      },
      ...({
        album: t.album_title,
        artist_id: t.artist_id,
        bitrate: t.bitrate,
      } as Record<string, unknown>),
    } as QueueTrack);
  });
  return out;
}

/** Play as a mix… (28e): DJ mix for this play, with the set's chips. */
export async function playSetAsMix(
  set: { id: number; name: string },
  rows: ViewRow[],
): Promise<boolean> {
  const queue = setQueue(set, rows);
  if (!queue.length || !window.playTrackList) {
    window.showToast?.(
      queue.length
        ? "The player isn't ready yet. Try again in a moment."
        : 'Nothing in it plays here yet.',
      'error',
    );
    return false;
  }
  await window.playTrackList(queue, `${set.name} · as a mix`);
  return true;
}

/**
 * Save a chip changed in Up next to the set's row (26i): the row is the one
 * the queue came from while it's still the pair's; else the row holding the
 * outgoing track with the incoming one next.
 */
export async function saveTransitionToSet(
  set: { id: number; row: number },
  fromId: string,
  toId: string,
  t: Transition,
): Promise<void> {
  const view = await fetchSet(set.id);
  const rows = view.rows.slice();
  const nextPlaying = (i: number) => {
    for (let k = i + 1; k < rows.length; k++) if (rows[k].track) return rows[k];
    return null;
  };
  const pairAt = (i: number) =>
    String(rows[i]?.track_id ?? '') === fromId && String(nextPlaying(i)?.track_id ?? '') === toId;
  let at = pairAt(set.row) ? set.row : -1;
  if (at < 0) at = rows.findIndex((_, i) => pairAt(i));
  if (at < 0) throw new Error('That pair is no longer next to each other in the set.');
  rows[at] = { ...rows[at], transition: { style: t.style, bars: t.bars } };
  await updateSet(set.id, { rows, baseRevision: view.set.revision });
}
