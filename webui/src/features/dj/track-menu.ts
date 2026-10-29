import type { DragItem } from '@/features/dnd/dnd-model';

import { openSendToTray, sendToEntries } from '@/features/dnd/send-to-ui';
import { openMixWith } from '@/features/mix/open-mix';
/**
 * One "…" for every track in the DJ area (24a): Play next, Add to Up next
 * (277), Mixes well with…, Versions… (not built yet), Add to set…, Send
 * to… (Brief B, step 4: a hook, `sendTo`), Add to playlist…, Open artist ·
 * Open album. Send to… (Brief B, 32d) is a submenu on a desktop (the
 * working set, Up next, Another set…) and the foot tray on a phone (32e).
 * On a desktop the star is never in the menu (it's in the row);
 * on a phone the sheet is 34c's: Star (or Unstar) · Play next · Mixes well
 * with… · Add to set… ("Sunday Set is working" at its end) · Send to… · Add
 * to playlist…, with Brief D's glyphs beside Star and Play next.
 * "Mixes well with…" opens the tray in Mix following the track (33a; the
 * docked Mixes panel is retired, HANDOFF 329).
 * Tracks, Listening history, the Artist page, Search, Mixes well with and a
 * set's rows all build their menu here, so the order stays one. Tracks
 * adds Double BPM and Halve BPM after Add to playlist… (HANDOFF 344), led by
 * "BPM is right" when the beat grid waits only on its octave (Design 399).
 */
import { openAddToMixSet } from '@/features/sets/add-to-mix-set';
import { showsStar, starStore, type StarState } from '@/features/stars/stars-store';

import type { TempoAction } from './dj.api';

import { bpmNumber } from './dj.format';
import { TEMPO_MAX, TEMPO_MIN } from './tempo';

export interface TrackMenuEntry {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** why it's disabled, beside it (SafeAction v2) */
  reason?: string;
  /** a quiet line at its end on the phone's sheet ("Sunday Set is working", 34c) */
  meta?: string;
  /** Brief D's glyph beside it on the phone's sheet */
  icon?: 'star' | 'starred' | 'next';
  /** a desktop submenu (Send to…, 32d) */
  submenu?: TrackMenuEntry[];
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
    /** Add to Up next (277): appends, after Play next */
    addToUpNext?: { onSelect: () => void; disabled?: boolean; reason?: string } | null;
    /** Mixes well with… (on unless a page has its own) */
    mixes?: boolean;
    /** with nothing playing, Mixes well with… plays the track first (open-mix.ts) */
    play?: (() => void) | null;
    /** the working set's name: "Sunday Set is working" beside Add to set… on a phone (34c) */
    working?: string | null;
    /**
     * Send to… (Brief B, 32d and 32e: the working set · Up next · Another
     * set… · DJ now when step 5 lands): what would be sent (this track, or
     * the selection). Without it the item isn't shown.
     */
    sendTo?: DragItem[] | null;
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
      /** the grid waits only on its octave: "BPM is right" settles it */
      unsure?: boolean;
      /** it would be ready at more than one octave: "It's 172 BPM" / "It's 86 BPM" */
      choices?: number[];
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
      icon: on ? 'starred' : 'star',
      onSelect: () => void starStore().toggle(track.id, track.title),
    });
  }
  if (opts.playNext)
    entries.push({
      key: 'next',
      label: 'Play next',
      ...(opts.phone ? { icon: 'next' as const } : {}),
      ...opts.playNext,
    });
  if (opts.addToUpNext && !opts.phone)
    entries.push({ key: 'upnext', label: 'Add to Up next', ...opts.addToUpNext });
  if (opts.mixes !== false && !track.fileMissing)
    entries.push({
      key: 'mixes',
      label: 'Mixes well with…',
      onSelect: () => openMixWith({ id: track.id, title: track.title }, { play: opts.play }),
    });
  if (!track.fileMissing)
    entries.push({
      key: 'mixset',
      label: 'Add to set…',
      ...(opts.phone && opts.working ? { meta: `${opts.working} is working` } : {}),
      onSelect: () =>
        openAddToMixSet(
          { id: track.id, title: track.title, artist: track.artist ?? '' },
          opts.anchor?.() ?? null,
        ),
    });
  if (opts.sendTo?.length && !track.fileMissing) {
    const items = opts.sendTo;
    entries.push(
      opts.phone
        ? { key: 'send', label: 'Send to…', onSelect: () => openSendToTray(items) }
        : {
            key: 'send',
            label: 'Send to…',
            onSelect: () => undefined,
            submenu: sendToEntries(items, opts.anchor),
          },
    );
  }
  if (opts.addToPlaylist)
    entries.push({ key: 'playlist', label: 'Add to playlist…', onSelect: opts.addToPlaylist });
  if (opts.tempo?.bpm && !track.fileMissing) {
    const { bpm, onSet, overridden, unsure, choices, blocked } = opts.tempo;
    if (unsure)
      entries.push({
        key: 'confirm',
        label: 'BPM is right',
        onSelect: () => onSet('confirm'),
        disabled: Boolean(blocked),
        reason: blocked || undefined,
      });
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
    // more than one octave would do (a track read at double): both said,
    // after Double and Halve, none led with (grid v5's fourth review)
    if (choices && choices.length > 1 && !unsure)
      for (const choice of choices) {
        const near = (x: number) => Math.abs(choice - x) / x <= 0.04;
        const action: TempoAction | null = near(bpm)
          ? 'confirm'
          : near(bpm * 2)
            ? 'double'
            : near(bpm / 2)
              ? 'halve'
              : null;
        if (!action) continue;
        entries.push({
          key: `choice-${action}`,
          label: `It’s ${bpmNumber(choice)} BPM`,
          onSelect: () => onSet(action),
          disabled: Boolean(blocked),
          reason: blocked || undefined,
        });
      }
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
