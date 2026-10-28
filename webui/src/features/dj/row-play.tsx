/**
 * The row's primary button (Brief D, `Row primary button (Brief D).dc.html`,
 * 34a–34c; UX-25). One set of glyphs for every track row:
 *
 * - **Play** (a filled triangle, white at 86%, never the accent) is the
 *   row's one visible button: it plays the track now;
 * - **Play next** (a triangle and a bar) shows on the row's hover and focus
 *   beside it, and is always in the "…";
 * - **Playing** (three bars, green) takes Play's place on the playing row;
 *   pressing it pauses (or plays again);
 * - **Move to the top** (an arrow to a bar) is Up next's second icon
 *   (static/media-player.js draws Up next's rows with the same paths);
 * - the star is the only accent in a row (StarButton, 28a).
 *
 * The columns are reserved (Play next's place is kept while hidden), so
 * nothing shifts on hover. ⇧-click on Play is Play next; a double-click on
 * the row plays (`rowPlayHandlers`). On a phone a tap on the row plays and
 * Play next is in the sheet (34c), so phone rows don't use these buttons.
 */
import type { MouseEvent, ReactNode } from 'react';

import styles from './row-play.module.css';

export const PLAY_PATH = 'M6 4l14 8-14 8z';
export const PLAY_NEXT_PATH = 'M4 5l10 7-10 7zM16 5h3v14h-3z';
export const PLAYING_PATH = 'M4 10h3v10H4zM10 4h3v16h-3zM16 13h3v7h-3z';
export const MOVE_TOP_PATH = 'M12 19V7M6 13l6-6 6 6M5 4h14';

export function PlayGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={PLAY_PATH} />
    </svg>
  );
}

export function PlayNextGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={PLAY_NEXT_PATH} />
    </svg>
  );
}

export function PlayingGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={PLAYING_PATH} />
    </svg>
  );
}

export function MoveTopGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={MOVE_TOP_PATH} />
    </svg>
  );
}

/** Pause or play again: what "Playing" does when pressed. */
export function togglePlayer(): void {
  try {
    (window as unknown as { SoulSyncPlayer?: { toggle?: () => void } }).SoulSyncPlayer?.toggle?.();
  } catch {
    /* the player isn't there yet */
  }
}

export interface RowPlayProps {
  /** the track's title, for the buttons' names */
  title: string;
  /** this row is what the player has loaded */
  playing?: boolean;
  /** play now */
  onPlay: () => void;
  /** play next; null when the row has no Play next (none to queue) */
  onPlayNext?: (() => void) | null;
  /** Play next shown always (the Mix tab, 34b), not only on hover and focus */
  nextAlways?: boolean;
  /** why it can't play (a drive that's away): disabled-neutral with the reason */
  disabled?: { id?: string; words: string } | null;
  /** nothing to play (no file): the columns stay, the buttons don't */
  hidden?: boolean;
  /** the Play button's name when it isn't "Play <title>" */
  playLabel?: string;
  className?: string;
  children?: ReactNode;
}

/**
 * Play (or Playing) and Play next, in their reserved columns. ⇧-click on
 * Play does Play next.
 */
export function RowPlay({
  title,
  playing = false,
  onPlay,
  onPlayNext = null,
  nextAlways = false,
  disabled = null,
  hidden = false,
  playLabel,
  className,
  children,
}: RowPlayProps) {
  const name = title || 'this track';
  if (hidden) {
    return (
      <span className={`${styles.group} ${className ?? ''}`} data-row-play="">
        <span className={styles.slot} aria-hidden="true" />
        {onPlayNext !== null ? <span className={styles.slot} aria-hidden="true" /> : null}
        {children}
      </span>
    );
  }
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (disabled) return;
    if (playing) {
      togglePlayer();
      return;
    }
    if (event.shiftKey && onPlayNext) {
      onPlayNext();
      return;
    }
    onPlay();
  };
  return (
    <span className={`${styles.group} ${className ?? ''}`} data-row-play="">
      <button
        type="button"
        className={styles.button}
        data-kind={playing ? 'playing' : 'play'}
        aria-label={playing ? `Pause ${name}` : (playLabel ?? `Play ${name}`)}
        title={
          disabled
            ? undefined
            : playing
              ? 'Playing · press to pause'
              : onPlayNext
                ? 'Play · ⇧-click to play next'
                : 'Play'
        }
        aria-disabled={disabled ? 'true' : undefined}
        aria-describedby={disabled?.id}
        onClick={onClick}
        onDoubleClick={(e) => e.stopPropagation()}
        data-row-play-button=""
      >
        {playing ? <PlayingGlyph /> : <PlayGlyph />}
      </button>
      {onPlayNext !== null ? (
        <button
          type="button"
          className={styles.button}
          data-kind="next"
          data-always={nextAlways ? '' : undefined}
          aria-label={`Play ${name} next`}
          title={disabled ? undefined : 'Play next'}
          aria-disabled={disabled ? 'true' : undefined}
          aria-describedby={disabled?.id}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) onPlayNext?.();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <PlayNextGlyph />
        </button>
      ) : null}
      {children}
    </span>
  );
}

/**
 * A double-click anywhere on the row plays it (34a), but not on its links,
 * buttons or fields, which do their own thing.
 */
export function rowPlayHandlers(play: (() => void) | null): {
  onDoubleClick?: (event: MouseEvent<HTMLElement>) => void;
} {
  if (!play) return {};
  return {
    onDoubleClick: (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('a, button, input, select, textarea, [role="menuitem"]')) return;
      window.getSelection?.()?.removeAllRanges();
      play();
    },
  };
}

/**
 * Play a library track now. With something playing it goes in straight
 * after it and the player cuts to it (Up next stays as it was after it);
 * with nothing playing it starts.
 */
export function playTrackNow(track: Record<string, unknown>): void {
  const engine = (
    window as unknown as {
      SoulSyncPlayer?: {
        state?: () => { track: unknown };
        insertNext?: (t: Record<string, unknown>) => number;
        playIndex?: (i: number) => unknown;
      };
    }
  ).SoulSyncPlayer;
  try {
    if (engine?.state?.().track && engine.insertNext && engine.playIndex) {
      const at = engine.insertNext(track);
      void engine.playIndex(at);
      return;
    }
  } catch {
    /* fall through to the plain path */
  }
  if (window.playNext) {
    // nothing playing: Play next starts it (addToQueue plays the first one)
    window.playNext(track);
    return;
  }
  window.showToast?.("The player isn't ready yet. Try again in a moment.", 'error');
}
