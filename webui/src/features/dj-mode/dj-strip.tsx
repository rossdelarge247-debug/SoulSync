/**
 * A lane's strip (3b, 37g; 439, 440, 443): Headphones (M), cues 1–4 and Key
 * lock (L), under the lane's line (in the head's corner at 1280, 37m); and
 * the zoom pill (442) at the right end of the line row. Rendered in the
 * lanes' `strip` and `lineEnd` slots (dj-stage.tsx).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { DjMixSession } from './dj-mix-session';
import type { DjModeStore } from './dj-mode-store';
import type { DjOutputs } from './dj-outputs-host';

import { cueButtonName, cueButtonText, cueButtonTitle, SLOTS } from './dj-cues';
import styles from './dj-mixer.module.css';
import { headphonesWhy } from './dj-outputs';
import { useDjMode } from './dj-stage';
import { zoomWords, ZOOM_LEVELS } from './dj-zoom';

function useOutputs(outputs: DjOutputs) {
  return useSyncExternalStore(outputs.subscribe, outputs.snapshot, outputs.snapshot);
}

export function LaneStrip({
  deck,
  store,
  session,
  outputs,
}: {
  deck: 'a' | 'b';
  store: DjModeStore;
  session: DjMixSession;
  outputs: DjOutputs;
}) {
  const s = useDjMode(store);
  const v = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const o = useOutputs(outputs);
  const lane = s[deck];
  if (!lane) return null;
  const D = deck === 'a' ? 'A' : 'B';
  const settings = v.decks[D];
  const why = o.known ? headphonesWhy(o.state) : null;
  const pick = s.pick[deck];
  return (
    <div
      className={styles.strip}
      role="group"
      aria-label={`Deck ${D}’s strip`}
      data-dj-strip={deck}
    >
      <Transport deck={deck} store={store} />
      <button
        type="button"
        className={styles.phones}
        aria-pressed={settings.phones}
        aria-keyshortcuts="M"
        data-unavailable={why ? '' : undefined}
        title={
          why
            ? `${why} · Headphones for deck ${D} (M)`
            : deck === 'a' && !v.aOnDeck
              ? 'Deck A comes to the headphones once it’s on its deck (Play B) · M'
              : `Deck ${D} in the headphones (M)`
        }
        onClick={() => session.setPhones(D, !settings.phones)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.icon}>
          <path
            d="M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
        {settings.phones ? 'In the headphones' : 'Headphones'}
      </button>
      <span className={styles.cues} role="group" aria-label="Cues">
        {SLOTS.map((slot) => {
          const cue = lane.cues[slot - 1] ?? null;
          return (
            <button
              key={slot}
              type="button"
              className={styles.cue}
              data-set={cue ? '' : undefined}
              aria-pressed={pick === slot}
              aria-label={cueButtonName(slot, cue, pick === slot)}
              aria-keyshortcuts={String(slot)}
              data-dj-cue={slot}
              title={cueButtonTitle(slot, cue)}
              // ⌥ picks a set cue to move it; a plain press only jumps (M1)
              onClick={(e) => store.pressCue(deck, slot, { move: e.altKey })}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  store.pressCue(deck, slot, { move: true });
                }
              }}
            >
              {cueButtonText(slot, cue)}
            </button>
          );
        })}
      </span>
      <button
        type="button"
        className={styles.keyLock}
        aria-pressed={settings.keyLock}
        aria-keyshortcuts="L"
        title={
          settings.keyLock
            ? 'Key lock: the key stays as the tempo moves (L)'
            : 'Key lock off: the pitch moves with the tempo (L)'
        }
        onClick={() => session.setKeyLock(D, !settings.keyLock)}
      >
        <span className={styles.syncDot} aria-hidden="true" />
        Key lock
      </button>
      <LoopControls deck={D} session={session} place="strip" />
    </div>
  );
}

/** The auto loop's sizes on show (beats); ½ goes on down to 1/32 (step 6). */
export const LOOP_SIZES = [1, 2, 4, 8, 16, 32] as const;
/** Beatjump's sizes (beats). */
export const JUMP_SIZES = [1, 4, 16, 32] as const;

function sizeLabel(beats: number): string {
  return beats >= 1 ? String(beats) : `1/${Math.round(1 / beats)}`;
}

/**
 * A deck's loops and beatjump (step 6, Traktor's and a CDJ's): Loop (its
 * size, O), the size (1–32, and ½ ×2 on down to 1/32, [ ]), In and Out
 * (I, ⇧I), Reloop (⇧O); then beatjump back and on (⇧← ⇧→) by its size
 * (the loop's while looping). A's loops wait for its deck (the player's own
 * playback can't loop to the sample); its beatjump is the player's seek.
 */
export function LoopControls({
  deck,
  session,
  place,
}: {
  deck: 'A' | 'B';
  session: DjMixSession;
  /**
   * where it's drawn: the strip (1440 and wider) or the line row (1280,
   * where the strip sits in the head's corner, 37m); CSS shows one
   */
  place: 'strip' | 'line';
}) {
  const v = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const why = session.loopWhy(deck);
  const loop = v.loops[deck];
  const looping = Boolean(loop?.active);
  const size = v.loopSize[deck];
  const jump = looping && loop!.beats !== null ? loop!.beats : v.jumpSize[deck];
  const sizes: number[] = LOOP_SIZES.includes(size as (typeof LOOP_SIZES)[number])
    ? [...LOOP_SIZES]
    : [size, ...LOOP_SIZES];
  const dis = why !== null;
  const tip = (words: string) => (why ? `${why} · ${words}` : words);
  return (
    <span
      className={styles.loops}
      role="group"
      aria-label={`Deck ${deck} loops`}
      data-place={place}
      data-dj-loops={place === 'strip' ? deck.toLowerCase() : undefined}
      data-dj-loops-line={place === 'line' ? deck.toLowerCase() : undefined}
    >
      <button
        type="button"
        className={styles.loopBtn}
        aria-pressed={looping}
        aria-disabled={dis}
        aria-keyshortcuts="O"
        title={tip(
          looping ? 'Out of the loop: plays on from here (O)' : `Loop ${sizeLabel(size)} beats (O)`,
        )}
        data-dj-loop-btn=""
        onClick={() => !dis && session.autoLoop(deck)}
      >
        Loop
      </button>
      <button
        type="button"
        className={styles.loopSmall}
        aria-label={`Deck ${deck} loop size halved`}
        aria-keyshortcuts="["
        title="Half the size (an active loop with it) ([)"
        disabled={size <= 1 / 32}
        onClick={() => session.resizeLoop(deck, 0.5)}
      >
        ½
      </button>
      <select
        className={styles.loopSize}
        aria-label={`Deck ${deck} loop size, beats`}
        value={String(size)}
        onChange={(e) => session.setLoopSize(deck, Number(e.target.value))}
      >
        {sizes.map((b) => (
          <option key={b} value={String(b)}>
            {sizeLabel(b)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={styles.loopSmall}
        aria-label={`Deck ${deck} loop size doubled`}
        aria-keyshortcuts="]"
        title="Double the size (an active loop with it) (])"
        disabled={size >= 32}
        onClick={() => session.resizeLoop(deck, 2)}
      >
        ×2
      </button>
      <button
        type="button"
        className={styles.loopSmall}
        aria-label={`Deck ${deck} loop in`}
        aria-pressed={v.loopIn[deck] !== null}
        aria-disabled={dis}
        aria-keyshortcuts="I"
        title={tip('Loop in, here (I)')}
        onClick={() => !dis && session.loopInHere(deck)}
      >
        In
      </button>
      <button
        type="button"
        className={styles.loopSmall}
        aria-label={`Deck ${deck} loop out`}
        aria-disabled={dis || v.loopIn[deck] === null}
        aria-keyshortcuts="Shift+I"
        title={tip('Loop out, here: loops from its in (⇧I)')}
        onClick={() => !dis && session.loopOutHere(deck)}
      >
        Out
      </button>
      <button
        type="button"
        className={styles.loopSmall}
        aria-label={`Deck ${deck} reloop`}
        aria-disabled={dis || !loop}
        aria-keyshortcuts="Shift+O"
        title={tip('Reloop: the last loop again, from its start (⇧O)')}
        onClick={() => !dis && session.reloop(deck)}
      >
        Reloop
      </button>
      <span className={styles.jump} role="group" aria-label={`Deck ${deck} beatjump`}>
        <button
          type="button"
          className={styles.loopSmall}
          aria-label={`Deck ${deck} beatjump back ${sizeLabel(jump)} beats`}
          aria-keyshortcuts="Shift+ArrowLeft"
          title={`Beatjump back ${sizeLabel(jump)} (⇧←)`}
          data-dj-jump="back"
          onClick={() => session.beatjump(deck, -1)}
        >
          ◀
        </button>
        <select
          className={styles.loopSize}
          aria-label={`Deck ${deck} beatjump size, beats`}
          value={String(v.jumpSize[deck])}
          disabled={looping}
          title={looping ? 'While looping it jumps by the loop' : undefined}
          onChange={(e) => session.setJumpSize(deck, Number(e.target.value))}
        >
          {JUMP_SIZES.map((b) => (
            <option key={b} value={String(b)}>
              {b}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.loopSmall}
          aria-label={`Deck ${deck} beatjump on ${sizeLabel(jump)} beats`}
          aria-keyshortcuts="Shift+ArrowRight"
          title={`Beatjump on ${sizeLabel(jump)} (⇧→)`}
          data-dj-jump="on"
          onClick={() => session.beatjump(deck, 1)}
        >
          ▶
        </button>
      </span>
    </span>
  );
}

/** Whether a deck plays, looked at a few times a second (the player's element doesn't say through the store). */
function useDeckPlaying(store: DjModeStore, deck: 'a' | 'b', open: boolean): boolean {
  const [playing, setPlaying] = useState(() => store.deckPlaying(deck));
  useEffect(() => {
    // only while the overlay shows (review L-6); looked at again as it opens
    if (!open) return;
    setPlaying(store.deckPlaying(deck));
    const id = window.setInterval(() => setPlaying(store.deckPlaying(deck)), 200);
    return () => window.clearInterval(id);
  }, [store, deck, open]);
  return playing;
}

/**
 * A deck's Play/Pause and CUE (step 4b), a CDJ's: CUE stopped sets the cue
 * point (on the beat), held at it plays from it and goes back when let go,
 * playing it goes back to it and stops; Play while CUE is held plays on.
 * Deck A's are the player's own while A is on its element; deck B's play
 * into the headphones before the blend (Play B is still the synced start).
 */
function Transport({ deck, store }: { deck: 'a' | 'b'; store: DjModeStore }) {
  const D = deck === 'a' ? 'A' : 'B';
  const open = useDjMode(store).open;
  const playing = useDeckPlaying(store, deck, open);
  const [held, setHeld] = useState(false);
  const down = () => {
    if (held) return;
    setHeld(true);
    store.transport(deck, 'cueDown');
  };
  const up = () => {
    if (!held) return;
    setHeld(false);
    store.transport(deck, 'cueUp');
  };
  return (
    <span className={styles.transport} role="group" aria-label={`Deck ${D} transport`}>
      <button
        type="button"
        className={styles.transportBtn}
        aria-pressed={playing}
        aria-keyshortcuts="G"
        aria-label={`Deck ${D} ${playing ? 'pause' : 'play'}`}
        title={`${playing ? 'Pause' : 'Play'} deck ${D} (G on the lane)${deck === 'b' ? ' · in the headphones before the blend' : ''}`}
        data-dj-transport-play={deck}
        onClick={() => store.transport(deck, 'play')}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" className={styles.transportIcon}>
          {playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2 1l9 5-9 5z" />}
        </svg>
      </button>
      <button
        type="button"
        className={styles.cueBtn}
        aria-pressed={held}
        aria-keyshortcuts="C"
        aria-label={`Deck ${D} cue`}
        title={`CUE (C on the lane): stopped, sets the cue point; held at it, plays from it; playing, back to it`}
        data-dj-transport-cue={deck}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* not capturable */
          }
          down();
        }}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            down();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            up();
          }
        }}
        onBlur={up}
      >
        CUE
      </button>
    </span>
  );
}

/** The −/+ pill (37s): five snap levels; its label says where it is. */
export function ZoomPill({ deck, store }: { deck: 'a' | 'b'; store: DjModeStore }) {
  const s = useDjMode(store);
  if (!s[deck]) return null;
  const level = s.zoom[deck];
  const i = ZOOM_LEVELS.indexOf(level);
  const D = deck === 'a' ? 'A' : 'B';
  return (
    <span className={styles.zoom} role="group" aria-label={`Deck ${D} zoom`} data-dj-zoom={deck}>
      <button
        type="button"
        className={styles.zoomBtn}
        aria-label={`Zoom out deck ${D}`}
        aria-keyshortcuts="-"
        disabled={i === 0}
        onClick={() => store.zoom(deck, -1)}
      >
        −
      </button>
      <span className={styles.zoomLabel}>{zoomWords(level)}</span>
      <button
        type="button"
        className={styles.zoomBtn}
        aria-label={`Zoom in deck ${D}`}
        aria-keyshortcuts="+"
        disabled={i === ZOOM_LEVELS.length - 1}
        onClick={() => store.zoom(deck, 1)}
      >
        +
      </button>
    </span>
  );
}
