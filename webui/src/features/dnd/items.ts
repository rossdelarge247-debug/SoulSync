/**
 * The sources' side of a drag (32g's rows): a track as the ghost and the
 * targets take it, and the pointer handlers a React row puts on its grip
 * (a mouse) and on itself (a phone's long-press, 32e).
 */
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { DjTrack } from '@/features/dj/dj.api';

import { playerTrack } from '@/features/dj/dj-actions';

import type { DragItem } from './dnd-model';

import { pointerDown, type Lifted } from './dnd-engine';

/** A library track (Tracks, a set's rows, the Mix tab) as a drag carries it. */
export function djItem(
  track: Pick<DjTrack, 'id' | 'title' | 'artist_name' | 'file_missing' | 'dj'> & Partial<DjTrack>,
  away?: string | null,
): DragItem {
  return {
    id: String(track.id),
    title: track.title || '',
    artist: track.artist_name ?? null,
    key: track.dj?.key ?? null,
    bpm: track.dj?.bpm ?? null,
    fileMissing: Boolean(track.file_missing),
    away: away ?? null,
    inLibrary: true,
    queue: track.file_path !== undefined ? playerTrack(track as DjTrack) : null,
  };
}

/** A grip's pointerdown: a mouse, a pen or a finger drags from here. */
export function onGripDown(lift: () => Lifted | null) {
  return (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    pointerDown(event, event.currentTarget, lift, 'grip');
  };
}

/**
 * A row's pointerdown on a phone: a long-press anywhere but its buttons,
 * links and fields lifts it (32e); a scroll before then is a scroll.
 */
export function onRowTouch(lift: () => Lifted | null) {
  return (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'touch') return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, select, textarea, [role="menuitem"]')) return;
    pointerDown(event, event.currentTarget, lift);
  };
}
