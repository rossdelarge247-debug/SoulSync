/**
 * "Mixes well with…" (Brief C, 33a; HANDOFF 329). The docked Mixes panel is
 * retired: every "Mixes well with…" (any track's "…", Search's library
 * rows, the phone's sheet) opens the player's tray in Mix following that
 * track, "Following Copper Sky · Back to Night Ferry", with the playing
 * track's own matches one press away. Its one ranking, words and actions
 * are the Mix tab's.
 *
 * With nothing at all in the player there's no tray to open: the track is
 * played (as Play would) and Mix opens on it, so its matches are the playing
 * track's. With a station, an episode or a book in the player it isn't
 * stopped for this (gauntlet review M1): Mix opens following the track.
 */
import { readPlayingTrack } from '@/features/dj/playing-track';

import { backToPlaying, followTrack, setTrayMode, type ChainStep } from './mix-store';
import { mixTabShown } from './mix-visibility';

interface ChromeLike {
  expand: () => void;
  isExpanded: () => boolean;
}

function chrome(): ChromeLike | null {
  return (window as unknown as { SoulSyncPlayerChrome?: ChromeLike }).SoulSyncPlayerChrome ?? null;
}

function expand(): void {
  const c = chrome();
  if (c && !c.isExpanded()) c.expand();
}

/** How long to wait for a track asked to play before giving up on opening the tray. */
const START_WAIT_MS = 8_000;

/** Anything in the player at all: a track, a station, an episode, a book. */
function playerHasSomething(): boolean {
  try {
    const st = (
      window as unknown as { SoulSyncPlayer?: { state?: () => { track: unknown } } }
    ).SoulSyncPlayer?.state?.();
    return Boolean(st?.track);
  } catch {
    return false;
  }
}

export function openMixWith(seed: ChainStep, opts: { play?: (() => void) | null } = {}): void {
  // the Mix tab is hidden (Settings → Library → DJ): nothing to open, and no
  // way in should be showing; a stale one does nothing rather than play
  if (!mixTabShown()) return;
  const playing = readPlayingTrack();
  if (playing) {
    if (playing.id === seed.id) {
      backToPlaying();
      setTrayMode('mix');
    } else followTrack(seed);
    expand();
    return;
  }
  if (playerHasSomething()) {
    followTrack(seed);
    expand();
    return;
  }
  if (!opts.play) {
    window.showToast?.(
      `Play something first: Mixes well with follows ${seed.title || 'a track'} from the player.`,
      'info',
    );
    return;
  }
  // nothing playing: play it, then open Mix on it once the player has it
  backToPlaying();
  setTrayMode('mix');
  const started = Date.now();
  const onPlayer = () => {
    const now = readPlayingTrack();
    if (now?.id === seed.id) {
      window.removeEventListener('ss:player', onPlayer);
      expand();
    } else if (Date.now() - started > START_WAIT_MS) {
      window.removeEventListener('ss:player', onPlayer);
    }
  };
  window.addEventListener('ss:player', onPlayer);
  opts.play();
}
