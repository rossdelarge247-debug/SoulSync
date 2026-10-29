/**
 * A set and auto-mix (26i, 28e, 319):
 *
 * - **Play as a mix**: the set's tracks with their files, in order, as the
 *   queue; each carries its row, the set's chip after it and the track that
 *   chip leads into (`mix_set: {id, name, row, transition, next}`), so Up
 *   next shows the set's chips and they play with Auto mix for this play,
 *   whatever the setting. A draft has it too (319): its id is 0;
 * - **Save it to the set too**: a chip changed in Up next while a set plays
 *   is asked about once, in place (26i, 319), and saved to the set's row
 *   here, at the revision the set is at (the set page's own rule), or to the
 *   draft in this browser.
 */
import type { SetRow, Transition, ViewRow } from '@/features/sets/sets.api';

import { readDraft, writeDraft } from '@/features/sets/draft-store';
import { fetchSet, updateSet } from '@/features/sets/sets.api';

import type { QueueTrack } from './controller';

/** The queue a set plays as: its rows whose files are here, each with its chip. */
export function setQueue(
  set: { id: number; name: string; draft?: boolean },
  rows: ViewRow[],
  { asMix = true }: { asMix?: boolean } = {},
): QueueTrack[] {
  const out: QueueTrack[] = [];
  const playable = (row: ViewRow | undefined) => Boolean(row?.track && row.track.file_path);
  rows.forEach((row, index) => {
    const t = row.track;
    if (!t || !t.file_path) return;
    // the track the set's chip leads into: the next row that plays here
    let next: string | null = null;
    for (let k = index + 1; k < rows.length; k++)
      if (playable(rows[k])) {
        next = String(rows[k].track!.id);
        break;
      }
    out.push({
      id: t.id,
      title: t.title,
      artist: t.artist_name,
      album_id: t.album_id,
      file_path: t.file_path,
      image_url: t.image_url,
      duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
      ...(asMix
        ? {
            mix_set: {
              id: set.id,
              name: set.name,
              row: index,
              transition: row.transition
                ? { style: row.transition.style, bars: row.transition.bars }
                : null,
              next,
              ...(set.draft ? { draft: true } : {}),
            },
          }
        : // Play (33c): the set as a plain queue, marked so Up next and Mix
          // say "from Sunday Set" (294); its chips play only with Auto mix on
          { from_set: { id: set.id, name: set.name, row: index } }),
      ...({
        album: t.album_title,
        artist_id: t.artist_id,
        bitrate: t.bitrate,
      } as Record<string, unknown>),
    } as QueueTrack);
  });
  return out;
}

/** Play as a mix (28e, 319): Auto mix for this play, with the set's chips; a draft's too. */
export async function playSetAsMix(
  set: { id: number; name: string; draft?: boolean },
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

/** The player as a set played from the playing track needs it (static/media-player.js). */
interface PlayerLike {
  state(): { track: QueueTrack | null; queue: QueueTrack[]; index: number };
  /** the rows straight after the playing one, each once, drawn and saved once */
  queueAfterPlaying(tracks: QueueTrack[]): number;
}

/**
 * auto-mix's stages while it holds a mix (controller.ts): the queue isn't
 * touched then. Before (windows loading, ready, a cut set) a new next track
 * is planned afresh and nothing of the old pair acts: no cut to it, no
 * decks for it (controller.test.ts, the phase follow-up of 29 October)
 */
const MIXING = new Set(['counting', 'mixing', 'settling', 'handback', 'back', 'rejoin']);

/**
 * Play a set as a mix from the playing track (the Mix tab's working set;
 * Ross's report of 28 October: a working set built in the Mix tab isn't
 * Up next, so the playing track ended and nothing followed). When the
 * playing track is one of the set's rows, it carries its chip and the
 * set's later rows go straight after it, each once (one already queued
 * after it moves), so it plays on into them with no restart; otherwise the
 * set plays from its start (Play as a mix). What was Up next stays after
 * the set. Not while a mix holds the next row. `'continued'`, `'started'` or
 * `'failed'`.
 */
export async function playSetFromPlaying(
  set: { id: number; name: string },
  rows: ViewRow[],
  player: PlayerLike | null = (window as unknown as { SoulSyncPlayer?: PlayerLike })
    .SoulSyncPlayer ?? null,
): Promise<'continued' | 'started' | 'failed'> {
  const queue = setQueue(set, rows);
  const st = player?.state();
  const playingId = st?.track?.id;
  const at =
    playingId === null || playingId === undefined
      ? -1
      : queue.findIndex((t) => String(t.id) === String(playingId));
  const current = st && st.index >= 0 ? st.queue[st.index] : null;
  if (!player || at < 0 || !current || String(current.id) !== String(playingId)) {
    return (await playSetAsMix(set, rows)) ? 'started' : 'failed';
  }
  if (at === queue.length - 1) {
    window.showToast?.(`${playingTitle(current)} is the last track in ${set.name}.`, 'info');
    return 'failed';
  }
  // a mix in progress holds the next row (its incoming deck): the queue is
  // left alone until it's over (the gauntlet review's M3)
  const stage = (
    window as unknown as { SoulSyncAutomix?: { view?: () => { stage?: string } } }
  ).SoulSyncAutomix?.view?.()?.stage;
  if (stage && MIXING.has(stage)) {
    window.showToast?.('Mixing now: play the set once the mix is over.', 'info');
    return 'failed';
  }
  // the playing row's chip is the set's (Auto mix for this play, 28e)
  current.mix_set = queue[at].mix_set;
  player.queueAfterPlaying(queue.slice(at + 1));
  const n = queue.length - 1 - at;
  window.showToast?.(
    `${set.name} plays next as a mix · ${n} ${n === 1 ? 'track' : 'tracks'}`,
    'success',
  );
  return 'continued';
}

function playingTitle(t: QueueTrack): string {
  return t.title || 'This track';
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

/**
 * A draft played as a mix (319): a chip changed in Up next saved to the
 * draft's row in this browser, the outgoing track's row with the incoming
 * one the next row that has a track.
 */
export function saveTransitionToDraft(
  profileId: number,
  fromId: string,
  toId: string,
  t: Transition,
): void {
  const draft = readDraft(profileId);
  if (!draft) throw new Error('The draft is gone from this browser.');
  const rows: SetRow[] = draft.rows.slice();
  const at = rows.findIndex((row, i) => {
    if (String(row.track_id ?? '') !== fromId) return false;
    for (let k = i + 1; k < rows.length; k++)
      if (rows[k].track_id != null) return String(rows[k].track_id) === toId;
    return false;
  });
  if (at < 0) throw new Error('That pair is no longer next to each other in the draft.');
  rows[at] = { ...rows[at], transition: { style: t.style, bars: t.bars } };
  writeDraft(profileId, { ...draft, rows });
}

/**
 * Play (33c, the set's primary; 34b's row Play): the set's tracks as Up
 * next, from the first row or from the row pressed, marked "from Sunday
 * Set" (294). Between tracks applies as set (unlike Play as a mix).
 */
export async function playSet(
  set: { id: number; name: string; draft?: boolean },
  rows: ViewRow[],
  fromRow = 0,
): Promise<boolean> {
  const queue = setQueue(set, rows, { asMix: false });
  if (!queue.length || !window.playTrackList) {
    window.showToast?.(
      queue.length
        ? "The player isn't ready yet. Try again in a moment."
        : 'Nothing in it plays here yet.',
      'error',
    );
    return false;
  }
  const at = queue.findIndex(
    (t) => ((t as { from_set?: { row: number } }).from_set?.row ?? -1) >= fromRow,
  );
  await window.playTrackList(queue, set.name, { startIndex: Math.max(0, at) });
  return true;
}
