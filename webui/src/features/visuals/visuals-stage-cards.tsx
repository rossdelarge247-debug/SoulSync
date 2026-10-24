/**
 * What sits on the stage (10c, 10d, 10f): the credit after every change, a
 * preset that won't load (in the credit's place), the radio stream the
 * browser can't hear, and the still overlay for Reduce motion.
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/form';
import { Spinner } from '@/components/primitives';

import { StarIcon } from './milkdrop-browser';
import { useVisuals, useVisualsController } from './use-visuals';
import styles from './visuals.module.css';

function PulseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  );
}

/** The credit (10c): 4 s after every change, and with the chrome after that. */
export function VisualsCredit() {
  const s = useVisuals();
  const c = useVisualsController();
  const [, tick] = useState(0);
  const credit = s.credit;
  useEffect(() => {
    if (!credit || !credit.until) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, credit.until - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [credit]);
  if (!s.open || s.panelOpen || s.still || s.failure || !credit) return null;
  const fresh = credit.until > Date.now();
  const milk = s.family === 'milkdrop';
  const fav = milk && s.presetKey ? s.favourites.has(s.presetKey) : false;
  return (
    <div
      className={styles.creditWrap}
      data-fresh={fresh ? 'true' : undefined}
      data-visuals-credit
      data-phone={s.phone ? 'true' : undefined}
    >
      <div className={styles.credit} role="status" aria-live="polite">
        <span className={styles.creditIcon} aria-hidden="true">
          {credit.loading ? <Spinner size={20} /> : <PulseIcon />}
        </span>
        <span className={styles.creditText}>
          <span className={styles.creditName}>{credit.name}</span>
          <span className={styles.creditLine}>{credit.line}</span>
        </span>
        {credit.guard ? (
          <Button variant="secondary" size="lg" onClick={() => c.restoreQuality()}>
            Put it back
          </Button>
        ) : null}
        {s.phone && milk && !credit.guard && s.presetKey ? (
          <button
            type="button"
            className={styles.star}
            aria-pressed={fav}
            aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
            onClick={() => void c.toggleFavourite()}
          >
            <StarIcon on={fav} />
          </button>
        ) : null}
      </div>
      {credit.hints && !s.phone ? (
        <p className={styles.hints} aria-hidden="true">
          <kbd>V</kbd> next{' '}
          {milk ? (
            <>
              <kbd>S</kbd> favourite
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** A preset that won't load (10d): what's back on, and what to do. */
export function FailureCard() {
  const s = useVisuals();
  const c = useVisualsController();
  if (!s.open || !s.failure || s.still) return null;
  const f = s.failure;
  return (
    <div className={styles.stateCard} data-tone="warning" data-visuals-failure role="alert">
      <p className={styles.stateTitle}>
        <span className={styles.stateDot} aria-hidden="true" />
        Couldn’t load {f.name}
      </p>
      <p className={styles.stateBody}>
        It didn’t load in this browser. {f.backName ? `${f.backName} is back on; ` : ''}auto-cycle
        skips {f.name} from now on.
      </p>
      <div className={styles.stateActions}>
        <Button variant="secondary" size="lg" onClick={() => c.nextAfterFailure()}>
          Next preset
        </Button>
        <Button variant="secondary" size="lg" onClick={() => c.retryFailure()}>
          Try it again
        </Button>
      </div>
    </div>
  );
}

/** A direct radio stream the analyser can't hear (10d). */
export function RadioCard() {
  const s = useVisuals();
  const c = useVisualsController();
  const [busy, setBusy] = useState(false);
  if (!s.open || !s.radioDirect || s.still) return null;
  return (
    <div className={styles.stateCard} data-visuals-radio role="status">
      <p className={styles.stateTitle}>Visuals can’t follow this station</p>
      <p className={styles.stateBody}>
        {s.radioDirect.station} plays straight from its own server, which doesn’t let the browser
        read the sound. Played through SYNCHRO.S instead, it can. The stream restarts: a second or
        two of silence.
      </p>
      <div className={styles.stateActions}>
        <Button
          variant="secondary"
          size="lg"
          disabled={busy}
          focusableWhenDisabled
          onClick={async () => {
            setBusy(true);
            try {
              await c.playThroughSynchros();
            } finally {
              setBusy(false);
            }
          }}
        >
          Play through SYNCHRO.S
        </Button>
      </div>
    </div>
  );
}

/** Reduce motion (10d): the overlay opens still, with the art. */
/** Close the overlay and open the tray's Player settings (its MilkDrop group). */
export function openPlayerSettings(): void {
  const w = window as Window & { npV2?: { closeVisuals?: () => void } };
  w.npV2?.closeVisuals?.();
  setTimeout(() => {
    document.querySelector<HTMLElement>('[data-player-menu="settings"]')?.click();
  }, 50);
}

export function StillCard({ art }: { art: string | null }) {
  const s = useVisuals();
  const c = useVisualsController();
  if (!s.open || !s.still) return null;
  return (
    <div className={styles.still} data-visuals-still>
      {art ? (
        <img className={styles.stillArt} src={art} alt="" />
      ) : (
        <span className={styles.stillArt} aria-hidden="true" />
      )}
      <div className={styles.stillCard}>
        <p className={styles.stillTitle}>Visuals are off while Reduce motion is on</p>
        <p className={styles.stateBody}>
          {s.still === 'setting'
            ? 'Set in Player settings → Reduce visual effects. The art stays still instead.'
            : 'Set in this browser’s system settings, or in Player settings → Reduce visual effects. The art stays still instead.'}
        </p>
        <Button variant="secondary" size="lg" onClick={() => c.playVisualsThisTime()}>
          Play visuals this time
        </Button>
        <button type="button" className={styles.linkButton} onClick={openPlayerSettings}>
          Player settings
        </button>
      </div>
    </div>
  );
}
