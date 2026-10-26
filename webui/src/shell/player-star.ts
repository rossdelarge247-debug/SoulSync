/**
 * The star in the player (28c): after the title in the bar, in the phone's
 * mini bar, and in the tray's record (the phone's sheet too). One control,
 * star-control.ts, in each `[data-player-star]` slot of index.html, pointed
 * at the playing library track on every 'ss:player' event. Not shown for a
 * stream preview, a podcast, an audiobook or radio, nor for a track whose
 * file isn't here and was never starred.
 *
 * It also gives the rest of the page the star: `window.SoulSyncStarKey()`
 * (S, from static/media-player.js's keys: the focused row's track, else the
 * playing one) and `window.SoulSyncStarButton` (a star for a legacy page's
 * row).
 */
import {
  createStarButton,
  starFromKeyboard,
  type StarButtonHandle,
} from '@/features/stars/star-control';
import { starStore } from '@/features/stars/stars-store';

declare global {
  interface Window {
    /** S: star or unstar the focused row's track, else the playing one; true when it acted */
    SoulSyncStarKey?: () => boolean;
    SoulSyncStarButton?: typeof createStarButton;
  }
}

interface PlayingLike {
  state?: () => {
    track: {
      id?: string | number | null;
      title?: string | null;
      is_preview?: boolean;
      is_library?: boolean;
    } | null;
    kind?: string | null;
  };
}

/**
 * The playing track the star is for: a library track, not a preview, a
 * station, an episode or a book. (The shell reads the engine itself: it
 * can't import the React side's playing-track.ts.)
 */
export function starredTrackOf(view: Window): { id: string; title: string } | null {
  try {
    const st = (view as unknown as { SoulSyncPlayer?: PlayingLike }).SoulSyncPlayer?.state?.();
    const t = st?.track;
    if (!t || t.is_preview) return null;
    if (st?.kind && st.kind !== 'library') return null;
    const id = t.id === null || t.id === undefined ? '' : String(t.id);
    return id ? { id, title: String(t.title ?? '') } : null;
  } catch {
    return null;
  }
}

export function bootPlayerStar(root: ParentNode = document, view: Window = window): () => void {
  const store = starStore();
  view.SoulSyncStarButton = createStarButton;
  view.SoulSyncStarKey = () => Boolean(starFromKeyboard(starredTrackOf(view), store));
  const handles: StarButtonHandle[] = [];
  for (const slot of root.querySelectorAll<HTMLElement>('[data-player-star]')) {
    if (slot.querySelector('.ss-star')) continue;
    const handle = createStarButton(null, { variant: 'player', store });
    slot.appendChild(handle.button);
    handles.push(handle);
  }
  let last = '';
  const follow = () => {
    const track = starredTrackOf(view);
    const key = track ? `${track.id}\u0000${track.title}` : '';
    if (key === last) return;
    last = key;
    for (const h of handles) h.setTrack(track?.id ?? null, track?.title ?? '');
  };
  follow();
  view.addEventListener('ss:player', follow);
  return () => {
    view.removeEventListener('ss:player', follow);
    for (const h of handles) h.destroy();
  };
}
