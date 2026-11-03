/**
 * A lane's strip (3b, 37g; 439, 440, 443): Headphones (M), cues 1–4 and Key
 * lock (L), under the lane's line (in the head's corner at 1280, 37m); and
 * the zoom pill (442) at the right end of the line row. Rendered in the
 * lanes' `strip` and `lineEnd` slots (dj-stage.tsx).
 */
import { useSyncExternalStore } from 'react';

import type { DjMixSession } from './dj-mix-session';
import type { DjModeStore } from './dj-mode-store';
import type { DjOutputs } from './dj-outputs-host';

import { cueButtonName, cueButtonText, SLOTS } from './dj-cues';
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
              onClick={() => store.pressCue(deck, slot)}
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
    </div>
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
