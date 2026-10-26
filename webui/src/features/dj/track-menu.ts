/**
 * One "…" for every track in the DJ area (24a): Play next, Mixes well
 * with…, Versions… (not built yet), Add to mix set…, Add to playlist…, Open
 * artist · Open album. On a desktop the star is never in the menu (it's in
 * the row); on a phone the sheet's first line is Star, or Unstar (28d).
 * Tracks, Listening history, the Artist page, Search, Mixes well with and a
 * mix set's rows all build their menu here, so the order stays one.
 */
import { openAddToMixSet } from '@/features/sets/add-to-mix-set';
import { showsStar, starStore, type StarState } from '@/features/stars/stars-store';

import { openMixes } from './mixes-store';

export interface TrackMenuEntry {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** why it's disabled, beside it (SafeAction v2) */
  reason?: string;
}

export interface TrackMenuTrack {
  id: string;
  title: string;
  artist?: string;
  /** its file isn't on this computer */
  fileMissing?: boolean;
}

export function trackMenu(
  track: TrackMenuTrack,
  opts: {
    /** the phone's sheet: Star / Unstar first */
    phone?: boolean;
    star?: StarState;
    playNext?: { onSelect: () => void; disabled?: boolean; reason?: string } | null;
    /** Mixes well with… (on unless a page has its own) */
    mixes?: boolean;
    /** where Add to mix set… pops from */
    anchor?: () => HTMLElement | null | undefined;
    addToPlaylist?: (() => void) | null;
    artistHref?: string | null;
    albumHref?: string | null;
  } = {},
): TrackMenuEntry[] {
  const entries: TrackMenuEntry[] = [];
  if (opts.phone && showsStar(opts.star)) {
    const on = Boolean(opts.star?.starred);
    entries.push({
      key: 'star',
      label: on ? 'Unstar' : 'Star',
      onSelect: () => void starStore().toggle(track.id, track.title),
    });
  }
  if (opts.playNext) entries.push({ key: 'next', label: 'Play next', ...opts.playNext });
  if (opts.mixes !== false && !track.fileMissing)
    entries.push({
      key: 'mixes',
      label: 'Mixes well with…',
      onSelect: () => openMixes({ id: track.id, title: track.title }),
    });
  if (!track.fileMissing)
    entries.push({
      key: 'mixset',
      label: 'Add to mix set…',
      onSelect: () =>
        openAddToMixSet(
          { id: track.id, title: track.title, artist: track.artist ?? '' },
          opts.anchor?.() ?? null,
        ),
    });
  if (opts.addToPlaylist)
    entries.push({ key: 'playlist', label: 'Add to playlist…', onSelect: opts.addToPlaylist });
  if (opts.artistHref) {
    const href = opts.artistHref;
    entries.push({
      key: 'artist',
      label: 'Open artist',
      onSelect: () => window.location.assign(href),
    });
  }
  if (opts.albumHref) {
    const href = opts.albumHref;
    entries.push({
      key: 'album',
      label: 'Open album',
      onSelect: () => window.location.assign(href),
    });
  }
  return entries;
}
