/**
 * The library track the app's player has loaded, kept current from the
 * shell's 'ss:player' event (static/media-player.js fires it on every
 * change, on every page). Radio, podcasts and audiobooks aren't library
 * tracks, so they read as nothing.
 */
import { useEffect, useState } from 'react';

export interface PlayingTrack {
  id: string;
  title: string;
}

interface PlayerLike {
  state?: () => {
    track: { id?: string | number | null; title?: string | null } | null;
    kind?: string | null;
  };
}

const NOT_TRACKS = new Set(['radio', 'podcast', 'audiobook']);

export function readPlayingTrack(): PlayingTrack | null {
  const player = (window as unknown as { SoulSyncPlayer?: PlayerLike }).SoulSyncPlayer;
  let snapshot: ReturnType<NonNullable<PlayerLike['state']>> | undefined;
  try {
    snapshot = player?.state?.();
  } catch {
    return null;
  }
  const track = snapshot?.track;
  if (!track) return null;
  // a library track or a stream of one; a station, an episode or a book isn't
  if (snapshot?.kind && NOT_TRACKS.has(snapshot.kind)) return null;
  const id = track.id === null || track.id === undefined ? '' : String(track.id);
  if (!id) return null;
  return { id, title: String(track.title ?? '') };
}

/** Call `onChange` with the playing library track whenever it changes. */
export function watchPlayingTrack(onChange: (track: PlayingTrack | null) => void): () => void {
  let last = readPlayingTrack()?.id ?? null;
  const listener = () => {
    const next = readPlayingTrack();
    const id = next?.id ?? null;
    if (id === last) return;
    last = id;
    onChange(next);
  };
  window.addEventListener('ss:player', listener);
  return () => window.removeEventListener('ss:player', listener);
}

/** The playing library track's id, for marking its row (17a's first row). */
export function usePlayingTrackId(): string | null {
  const [id, setId] = useState<string | null>(() => readPlayingTrack()?.id ?? null);
  useEffect(() => {
    setId(readPlayingTrack()?.id ?? null);
    return watchPlayingTrack((track) => setId(track?.id ?? null));
  }, []);
  return id;
}
