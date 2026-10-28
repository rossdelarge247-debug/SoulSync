/**
 * One "…" for every track in the DJ area (24a): Play next, Mixes well
 * with…, Versions… (not built yet), Add to set…, Add to playlist…, Open
 * artist · Open album. On a desktop the star is never in the menu (it's in
 * the row); on a phone the sheet's first line is Star, or Unstar (28d).
 * Tracks, Listening history, the Artist page, Search, Mixes well with and a
 * set's rows all build their menu here, so the order stays one. Tracks
 * adds Double BPM and Halve BPM after Add to playlist… (HANDOFF 344).
 */
import { openAddToMixSet } from '@/features/sets/add-to-mix-set';
import { showsStar, starStore, type StarState } from '@/features/stars/stars-store';

import type { TempoAction } from './dj.api';

import { openMixes } from './mixes-store';
import { TEMPO_MAX, TEMPO_MIN } from './tempo';

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
    /** where Add to set… pops from */
    anchor?: () => HTMLElement | null | undefined;
    addToPlaylist?: (() => void) | null;
    /**
     * Double BPM / Halve BPM, for a track with a BPM; with `overridden`
     * (a person's BPM) also "Use the measured BPM".
     */
    tempo?: {
      bpm: number | null;
      overridden?: boolean;
      /** why the person can't set it (a member, a shared track), or null */
      blocked?: string | null;
      onSet: (action: TempoAction) => void;
    } | null;
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
      label: 'Add to set…',
      onSelect: () =>
        openAddToMixSet(
          { id: track.id, title: track.title, artist: track.artist ?? '' },
          opts.anchor?.() ?? null,
        ),
    });
  if (opts.addToPlaylist)
    entries.push({ key: 'playlist', label: 'Add to playlist…', onSelect: opts.addToPlaylist });
  if (opts.tempo?.bpm && !track.fileMissing) {
    const { bpm, onSet, overridden, blocked } = opts.tempo;
    const tooFast = bpm * 2 > TEMPO_MAX;
    const tooSlow = bpm / 2 < TEMPO_MIN;
    entries.push({
      key: 'double',
      label: 'Double BPM',
      onSelect: () => onSet('double'),
      disabled: Boolean(blocked) || tooFast,
      reason: blocked || (tooFast ? `It would be over ${TEMPO_MAX} BPM` : undefined),
    });
    entries.push({
      key: 'halve',
      label: 'Halve BPM',
      onSelect: () => onSet('halve'),
      disabled: Boolean(blocked) || tooSlow,
      reason: blocked || (tooSlow ? `It would be under ${TEMPO_MIN} BPM` : undefined),
    });
    if (overridden)
      entries.push({
        key: 'measured',
        label: 'Use the measured BPM',
        onSelect: () => onSet('reset'),
        disabled: Boolean(blocked),
        reason: blocked || undefined,
      });
  }
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
