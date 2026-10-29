/**
 * What the Mix tab is about (BACKLOG, the Mix tab's edge cases; 29d): the
 * playing track, read from the player (`window.SoulSyncPlayer`, redrawn on
 * every 'ss:player') and, for a station, from the radio session
 * (`window.SoulSyncRadio`, on 'ss:radio').
 *
 * - a library track (or a stream of one: the server says whether it's in
 *   the library): the tab works;
 * - a 30-second preview: the tab shows "Mix works on your own tracks";
 * - a station whose track on air is identified and in the library: the tab
 *   works for that track (hear it on a station, mix from your own
 *   collection); any other station: no tab, as before;
 * - a podcast or an audiobook: no tab;
 * - nothing playing: no tab.
 */
import { useEffect, useState } from 'react';

import { RADIO_EVENT, type RadioSessionState } from '@/features/radio/radio.types';

export type MixSubject =
  | {
      kind: 'track';
      id: string;
      title: string;
      artist: string;
      image: string | null;
      /** the track is a station's, identified and in the library */
      radio: boolean;
    }
  | { kind: 'preview'; title: string }
  | { kind: 'none' };

interface PlayerTrackLike {
  id?: string | number | null;
  title?: string | null;
  artist?: string | null;
  image_url?: string | null;
  is_preview?: boolean;
}

interface PlayerLike {
  state?: () => { track: PlayerTrackLike | null; kind?: string | null };
}

interface RadioLike {
  state?: () => RadioSessionState;
}

function playerState() {
  try {
    return (window as unknown as { SoulSyncPlayer?: PlayerLike }).SoulSyncPlayer?.state?.() ?? null;
  } catch {
    return null;
  }
}

function radioState(): RadioSessionState | null {
  try {
    return (window as unknown as { SoulSyncRadio?: RadioLike }).SoulSyncRadio?.state?.() ?? null;
  } catch {
    return null;
  }
}

/** The subject as the player and the radio say it now. */
export function readMixSubject(): MixSubject {
  const st = playerState();
  const track = st?.track;
  if (!track) return { kind: 'none' };
  const kind = st?.kind ?? null;
  if (kind === 'podcast' || kind === 'audiobook') return { kind: 'none' };
  if (kind === 'radio') {
    const np = radioState()?.nowPlaying;
    const id = np?.state === 'identified' && np.library?.in_library ? np.library.track_id : null;
    if (!id || !np?.track) return { kind: 'none' };
    return {
      kind: 'track',
      id: String(id),
      title: np.track.title,
      artist: np.track.artist,
      image: np.track.art_url,
      radio: true,
    };
  }
  if (track.is_preview) return { kind: 'preview', title: String(track.title ?? '') };
  const id = track.id === null || track.id === undefined ? '' : String(track.id);
  if (!id) return { kind: 'preview', title: String(track.title ?? '') };
  return {
    kind: 'track',
    id,
    title: String(track.title ?? ''),
    artist: String(track.artist ?? ''),
    image: track.image_url ?? null,
    radio: false,
  };
}

function sameSubject(a: MixSubject, b: MixSubject): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'track' && b.kind === 'track')
    return a.id === b.id && a.title === b.title && a.radio === b.radio && a.image === b.image;
  if (a.kind === 'preview' && b.kind === 'preview') return a.title === b.title;
  return true;
}

/** The subject, kept current. */
export function useMixSubject(): MixSubject {
  const [subject, setSubject] = useState<MixSubject>(() => readMixSubject());
  useEffect(() => {
    const update = () => {
      const next = readMixSubject();
      setSubject((prev) => (sameSubject(prev, next) ? prev : next));
    };
    update();
    window.addEventListener('ss:player', update);
    window.addEventListener(RADIO_EVENT, update);
    return () => {
      window.removeEventListener('ss:player', update);
      window.removeEventListener(RADIO_EVENT, update);
    };
  }, []);
  return subject;
}

/** Where a queued track came from: a set played (as a mix, or plain Play from its page). */
export interface QueueFrom {
  id: number;
  name: string;
  /** its row in the set */
  row: number;
  /** Play as a mix (its chips play whatever the setting) */
  asMix: boolean;
}

export interface QueueView {
  /** the queue's library track ids, in order */
  ids: string[];
  /** where the playing track is in it (-1: not in the queue) */
  index: number;
  /** the set the playing track was queued from (294: "from Sunday Set") */
  from: QueueFrom | null;
  /** how many tracks are up next after the playing one */
  upcoming: number;
  /** the set every one of them came from, when they all did */
  upcomingFrom: string | null;
}

type QueueEntry = {
  id?: string | number | null;
  kind?: string | null;
  media_src?: string | null;
  is_library?: boolean;
  mix_set?: { id?: number; name?: string; row?: number } | null;
  from_set?: { id?: number; name?: string; row?: number } | null;
};

const NOT_LIBRARY_KINDS = new Set(['radio', 'podcast', 'audiobook']);

function isLibraryEntry(entry: QueueEntry): boolean {
  if (entry.media_src) return false;
  if (entry.kind && NOT_LIBRARY_KINDS.has(entry.kind)) return false;
  return entry.is_library !== false;
}

function fromOf(entry: QueueEntry | undefined): QueueFrom | null {
  const m = entry?.mix_set ?? null;
  const f = entry?.from_set ?? null;
  const src = m ?? f;
  if (!src || typeof src.name !== 'string') return null;
  return {
    id: Number(src.id) || 0,
    name: src.name,
    row: typeof src.row === 'number' ? src.row : -1,
    asMix: Boolean(m),
  };
}

/** The player's queue, for "while a set plays" (29b, 294). */
export function readQueue(): QueueView {
  try {
    const st = (
      window as unknown as {
        SoulSyncPlayer?: {
          state?: () => { queue?: QueueEntry[]; index?: number };
        };
      }
    ).SoulSyncPlayer?.state?.();
    const queue = st?.queue ?? [];
    // a station, an episode, a book or a stream that isn't a library file has
    // no library id here, whatever id it carries (gauntlet review L1)
    const ids = queue.map((q) =>
      q?.id === null || q?.id === undefined || !isLibraryEntry(q) ? '' : String(q.id),
    );
    const index = typeof st?.index === 'number' ? st.index : -1;
    const rest = queue.slice(Math.max(0, index + 1));
    const names = new Set(rest.map((q) => fromOf(q)?.name ?? ''));
    const only = names.size === 1 ? [...names][0] : '';
    return {
      ids,
      index,
      from: index >= 0 ? fromOf(queue[index]) : null,
      upcoming: rest.length,
      upcomingFrom: only || null,
    };
  } catch {
    return { ids: [], index: -1, from: null, upcoming: 0, upcomingFrom: null };
  }
}

/** Two reads of the queue that say the same. */
export function sameQueue(a: QueueView, b: QueueView): boolean {
  return (
    a.index === b.index &&
    a.ids.join(',') === b.ids.join(',') &&
    a.upcomingFrom === b.upcomingFrom &&
    a.from?.id === b.from?.id &&
    a.from?.row === b.from?.row &&
    a.from?.asMix === b.from?.asMix &&
    a.from?.name === b.from?.name
  );
}

/** The playing position and length, "2:14 / 6:05". */
export function readClock(): { at: number; length: number } | null {
  try {
    const audio = (
      window as unknown as {
        SoulSyncPlayer?: { audio?: () => HTMLAudioElement | null };
      }
    ).SoulSyncPlayer?.audio?.();
    if (!audio || !Number.isFinite(audio.duration)) return null;
    return { at: audio.currentTime || 0, length: audio.duration || 0 };
  } catch {
    return null;
  }
}

/** The set the playing track was queued from (294), kept current: a set's page marks its row. */
export function useQueueFrom(): QueueFrom | null {
  const [from, setFrom] = useState<QueueFrom | null>(() => readQueue().from);
  useEffect(() => {
    const update = () =>
      setFrom((prev) => {
        const next = readQueue().from;
        return prev?.id === next?.id && prev?.row === next?.row && prev?.asMix === next?.asMix
          ? prev
          : next;
      });
    update();
    window.addEventListener('ss:player', update);
    return () => window.removeEventListener('ss:player', update);
  }, []);
  return from;
}
