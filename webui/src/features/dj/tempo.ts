/**
 * Double BPM / Halve BPM (HANDOFF "Dev, drum and bass BPM (half-time) fix of
 * 27 October"): a person's fix for a track read at half or double its tempo.
 * The server keeps it as the track's BPM (`bpm_source` `override`) so no
 * later analysis undoes it, and the track's beat grid follows it. Tracks'
 * row "…" and the selection's "…" offer it; "Use the measured BPM" undoes it.
 * "BPM is right" (grid v5's third review) keeps the BPM shown as the
 * person's, for a track whose beat grid waits only on its octave.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  DJ_QUERY_KEY,
  postDjBpm,
  type DjBpmResponse,
  type TempoAction,
  type TempoSkip,
} from './dj.api';
import { bpmNumber } from './dj.format';

/** A BPM a person can set stays within these (the server's own limits). */
export const TEMPO_MIN = 40;
export const TEMPO_MAX = 300;

const SKIP_WORDS: Record<TempoSkip, string> = {
  no_bpm: 'no BPM yet',
  out_of_range: `it would leave ${TEMPO_MIN}–${TEMPO_MAX} BPM`,
  not_set: 'not set by hand',
  shared: 'only an admin changes a shared track’s BPM',
  not_yours: 'another profile’s track',
};

/**
 * Every picked track is one this page has loaded and is shared (a member's
 * Double / Halve would change none of them). A pick that isn't loaded any
 * more (the list was filtered since) isn't known to be shared: the items
 * stay on, and the server's answer says what it skipped.
 */
export function allShared(picked: string[], tracks: { id: string; shared?: boolean }[]): boolean {
  if (!picked.length) return false;
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return picked.every((id) => byId.get(id)?.shared === true);
}

/** The most tracks one change sends (the server's own limit). */
export const TEMPO_MAX_TRACKS = 500;

function tracks(n: number): string {
  return n === 1 ? '1 track' : `${n.toLocaleString()} tracks`;
}

/**
 * The toast after a change: "Now 174 BPM", "Doubled the BPM of 3 tracks ·
 * 1 not changed: no BPM yet", "Back to the measured BPM".
 */
export function tempoWords(
  action: TempoAction,
  answer: Pick<DjBpmResponse, 'changed' | 'skipped' | 'ready'>,
  /** how many were picked, when more than one change sends */
  picked = 0,
): { words: string; tone: 'success' | 'error' } {
  const changed = Object.entries(answer.changed);
  const skipped = Object.values(answer.skipped);
  let words: string;
  if (!changed.length) {
    words = skipped.length
      ? `Not changed: ${[...new Set(skipped.map((s) => SKIP_WORDS[s] ?? s))].join(', ')}`
      : 'Nothing to change';
    return { words, tone: 'error' };
  }
  if (action === 'confirm') {
    // "ready to mix" only when the server says the grid is (fourth review)
    const ready = answer.ready ?? {};
    if (changed.length === 1) {
      const [id, bpm] = changed[0]!;
      words = ready[id]
        ? `${bpmNumber(bpm ?? 0)} BPM it is: ready to mix`
        : `Kept ${bpmNumber(bpm ?? 0)} BPM · the beats still don’t line up well enough to mix`;
    } else {
      words = `Kept the BPM of ${tracks(changed.length)}`;
    }
  } else if (action === 'reset') {
    words =
      changed.length === 1
        ? 'Back to the measured BPM'
        : `${tracks(changed.length)} back to their measured BPM`;
  } else if (changed.length === 1 && !skipped.length) {
    const bpm = changed[0]![1];
    words = bpm ? `Now ${bpmNumber(bpm)} BPM` : 'Done';
  } else {
    words = `${action === 'double' ? 'Doubled' : 'Halved'} the BPM of ${tracks(changed.length)}`;
  }
  if (skipped.length) {
    const why = [...new Set(skipped.map((s) => SKIP_WORDS[s] ?? s))].join(', ');
    words += ` · ${skipped.length.toLocaleString()} not changed: ${why}`;
  }
  if (picked > TEMPO_MAX_TRACKS)
    words += ` · only the first ${TEMPO_MAX_TRACKS} of ${picked.toLocaleString()} picked; pick the rest and change them again`;
  return { words, tone: 'success' };
}

/**
 * `setTempo(ids, action)`: asks the server, says what happened in a toast and
 * reads the DJ data again (rows, Mixes well with, grids and plans).
 */
export function useSetTempo(): (ids: string[], action: TempoAction) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (ids: string[], action: TempoAction) => {
      if (!ids.length) return;
      try {
        // the server takes 500 at a time (and one change a second): the
        // rest are said in the toast, not sent quietly or dropped quietly
        const answer = await postDjBpm(ids.slice(0, TEMPO_MAX_TRACKS), action);
        const said = tempoWords(action, answer, ids.length);
        window.showToast?.(said.words, said.tone);
        await queryClient.invalidateQueries({ queryKey: DJ_QUERY_KEY });
      } catch (error) {
        window.showToast?.(error instanceof Error ? error.message : "That didn't work.", 'error');
      }
    },
    [queryClient],
  );
}
