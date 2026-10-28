/**
 * Between tracks, Off / Auto mix: one control in its places (33e; Brief C's
 * item 4; UX-13). No crossfade (Ross, 27 October).
 *
 * - **BetweenTracksSettings**, Settings → Library → DJ (replaces 26h's
 *   cards in Player settings): two radio cards, Off and Auto mix, then
 *   "Style when Auto can choose" and "Key lock in DJ now" (Design's 307: off
 *   by default; DJ now reads it), and the note (what always plays as Off,
 *   https, kept per browser);
 * - **BetweenTracksSwitch**, the same choice small: a two-way segmented
 *   control in Up next's head, the Mix tab and the player's "…";
 * - **AutoMixOffLine**, said once at Up next's head (and a set's), never per
 *   step (320, UX-21): "Auto mix is off: tracks play straight on · Turn it on".
 *
 * Where the browser can't run the decks (plain http on another computer's
 * address: 312) Auto mix is disabled with "Needs https or localhost" in
 * each place.
 */
import { useId, useRef, type KeyboardEvent } from 'react';

import styles from './automix.module.css';
import { setPrefs, usePrefs, type BetweenTracks, type Lean } from './prefs';
import { mixSupport, mixSupportShort } from './support';

/** 312's short words, wherever Auto mix is disabled for want of a secure page. */
export const NEEDS_HTTPS = 'Needs https or localhost'; // mixSupportShort's words for a page that isn't secure

const CARDS: { value: BetweenTracks; title: string; line: string }[] = [
  {
    value: 'off',
    title: 'Off',
    line: 'Each track plays to its end; the next starts after it.',
  },
  {
    value: 'dj',
    title: 'Auto mix',
    line: "Beat-matched where both tracks are ready; an echo out or a cut where they can't be; straight on where nothing's known.",
  },
];

/** Arrow keys move the choice and the focus together (one tab stop). */
function arrows(
  e: KeyboardEvent<HTMLElement>,
  current: BetweenTracks,
  canAuto: boolean,
  focus: (value: BetweenTracks) => void,
): void {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  const next: BetweenTracks =
    e.key === 'Home' ? 'off' : e.key === 'End' ? 'dj' : current === 'off' ? 'dj' : 'off';
  if (next === 'dj' && !canAuto) return;
  setPrefs({ between: next });
  focus(next);
}

export function BetweenTracksSettings() {
  const prefs = usePrefs();
  const id = useId();
  const unsupported = mixSupport();
  const refs = useRef<Partial<Record<BetweenTracks, HTMLButtonElement | null>>>({});
  return (
    <section className={styles.settings} aria-labelledby={`${id}-head`} data-between-tracks="">
      <h4 className={styles.settingsTitle} id={`${id}-head`}>
        Between tracks
      </h4>
      <div
        className={styles.cards}
        role="radiogroup"
        aria-labelledby={`${id}-head`}
        onKeyDown={(e) =>
          arrows(e, prefs.between, unsupported === null, (v) => refs.current[v]?.focus())
        }
      >
        {CARDS.map((c) => {
          // Auto mix on a page that can't run the decks: listed, with why (312)
          const off = c.value === 'dj' && unsupported !== null;
          const checked = prefs.between === c.value;
          return (
            <button
              key={c.value}
              ref={(el) => {
                refs.current[c.value] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-disabled={off ? 'true' : undefined}
              tabIndex={checked ? 0 : -1}
              title={off ? (unsupported ?? undefined) : undefined}
              className={styles.card}
              data-unavailable={off ? '' : undefined}
              data-between={c.value}
              onClick={off ? undefined : () => setPrefs({ between: c.value })}
            >
              <strong>{c.title}</strong>
              <small>{off ? mixSupportShort(unsupported) : c.line}</small>
            </button>
          );
        })}
      </div>
      <label className={styles.row}>
        <span>Style when Auto can choose</span>
        <span className={styles.selectWrap}>
          <select
            className={styles.rowSelect}
            value={prefs.lean}
            onChange={(e) => setPrefs({ lean: e.target.value as Lean })}
          >
            <option value="auto">Auto&apos;s own pick</option>
            <option value="long">Long blends</option>
            <option value="short">Short blends</option>
          </select>
        </span>
      </label>
      <label className={styles.row}>
        <span>Key lock in DJ now</span>
        <span className={styles.selectWrap}>
          <select
            className={styles.rowSelect}
            value={prefs.keyLock ? 'on' : 'off'}
            onChange={(e) => setPrefs({ keyLock: e.target.value === 'on' })}
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </span>
      </label>
      <p className={styles.note}>
        Not for podcasts, audiobooks or radio. Auto mix needs SYNCHRO.S on https or opened on its
        own computer. Kept per browser.
      </p>
    </section>
  );
}

/**
 * The same choice, small (33e): Off · Auto mix as a two-way segmented
 * control. Disabled with "Needs https or localhost" where the decks can't
 * run (312).
 */
export function BetweenTracksSwitch({
  label = 'Between tracks',
  showLabel = false,
  className,
}: {
  label?: string;
  /** say "Between tracks" before it (the player's "…", the Mix tab) */
  showLabel?: boolean;
  className?: string;
}) {
  const prefs = usePrefs();
  const id = useId();
  const unsupported = mixSupport();
  const refs = useRef<Partial<Record<BetweenTracks, HTMLButtonElement | null>>>({});
  const options: { value: BetweenTracks; title: string }[] = [
    { value: 'off', title: 'Off' },
    { value: 'dj', title: 'Auto mix' },
  ];
  return (
    <span
      className={[styles.switchRow, className].filter(Boolean).join(' ')}
      data-between-switch=""
      data-unavailable={unsupported ? '' : undefined}
    >
      {showLabel ? (
        <span className={styles.switchLabel} id={`${id}-label`}>
          {label}
        </span>
      ) : null}
      <span
        className={styles.segmented}
        role="radiogroup"
        aria-label={showLabel ? undefined : label}
        aria-labelledby={showLabel ? `${id}-label` : undefined}
        aria-describedby={unsupported ? `${id}-why` : undefined}
        onKeyDown={(e) =>
          arrows(e, prefs.between, unsupported === null, (v) => refs.current[v]?.focus())
        }
      >
        {options.map((o) => {
          const off = o.value === 'dj' && unsupported !== null;
          const checked = prefs.between === o.value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[o.value] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-disabled={off ? 'true' : undefined}
              tabIndex={checked ? 0 : -1}
              title={off ? (unsupported ?? undefined) : undefined}
              className={styles.segment}
              data-between={o.value}
              onClick={off ? undefined : () => setPrefs({ between: o.value })}
            >
              {o.title}
            </button>
          );
        })}
      </span>
      {unsupported ? (
        <span className={styles.switchWhy} id={`${id}-why`}>
          {mixSupportShort(unsupported)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Off, said once at the head of a list (Up next's, a set's), never per step
 * (320, UX-21): "Auto mix is off: tracks play straight on · Turn it on".
 */
export function AutoMixOffLine({
  className,
  besideSwitch = false,
}: {
  className?: string;
  /** under the small control, which says "Needs https or localhost" already */
  besideSwitch?: boolean;
}) {
  const prefs = usePrefs();
  const unsupported = mixSupport();
  if (prefs.between === 'dj') return null;
  return (
    <p className={[styles.offLine, className].filter(Boolean).join(' ')} data-automix-off="">
      Auto mix is off: tracks play straight on
      {unsupported && besideSwitch ? null : ' · '}
      {unsupported && besideSwitch ? null : unsupported ? (
        <span title={unsupported}>{mixSupportShort(unsupported)}</span>
      ) : (
        <button
          type="button"
          className={styles.textButton}
          onClick={() => setPrefs({ between: 'dj' })}
        >
          Turn it on
        </button>
      )}
    </p>
  );
}
