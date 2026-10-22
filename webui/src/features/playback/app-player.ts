/**
 * The app's one player (board 6a) for pages that play spoken word: the
 * podcast and audiobook pages hand an episode or a sample to it instead of
 * running a player bar of their own, so it keeps playing across pages and gets
 * the speed button, −15 s / +30 s and chapter ticks (src/shell/player.ts over
 * static/media-player.js's window.SoulSyncPlayer).
 */

import { useEffect, useState } from 'react';

export interface MediaItem {
  kind: 'podcast' | 'audiobook';
  /** what identifies it on the page (an episode guid, an ASIN) */
  id: string;
  /** the audio address */
  src: string;
  title: string;
  /** the show, or the author */
  subtitle?: string;
  artUrl?: string | null;
  durationHint?: number | null;
  /** PodcastIndex chapters JSON, when the feed publishes one */
  chaptersUrl?: string | null;
}

interface AppPlayer {
  playMedia?: (item: MediaItem) => Promise<unknown>;
  toggle?: () => void;
  state?: () => {
    track: { kind?: string; media_id?: string } | null;
    playing: boolean;
  };
}

function player(): AppPlayer | undefined {
  return (window as unknown as { SoulSyncPlayer?: AppPlayer }).SoulSyncPlayer;
}

/** Play it (or play / pause it, when it's what's loaded). False without a player. */
export function playInAppPlayer(item: MediaItem): boolean {
  const p = player();
  if (!p?.playMedia) return false;
  void p.playMedia(item);
  return true;
}

export function toggleAppPlayer(): void {
  player()?.toggle?.();
}

export interface AppPlayerMedia {
  /** the id of the item of this kind that's loaded, or null */
  id: string | null;
  playing: boolean;
}

export function readAppPlayerMedia(kind: MediaItem['kind']): AppPlayerMedia {
  const st = player()?.state?.();
  const t = st?.track;
  return t && t.kind === kind && t.media_id
    ? { id: t.media_id, playing: Boolean(st?.playing) }
    : { id: null, playing: false };
}

/** What the app player has loaded of this kind, kept current ('ss:player'). */
export function useAppPlayerMedia(kind: MediaItem['kind']): AppPlayerMedia {
  const [media, setMedia] = useState<AppPlayerMedia>(() => readAppPlayerMedia(kind));
  useEffect(() => {
    const sync = () =>
      setMedia((prev) => {
        const next = readAppPlayerMedia(kind);
        return prev.id === next.id && prev.playing === next.playing ? prev : next;
      });
    sync();
    window.addEventListener('ss:player', sync);
    return () => window.removeEventListener('ss:player', sync);
  }, [kind]);
  return media;
}
