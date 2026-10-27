/**
 * Player settings → Between tracks (26h): Off / Smart crossfade / DJ mix as
 * radio cards, then Mix automatically and Auto's lean (with DJ mix), the
 * note on what always plays as Off, and on a phone the screen-on warning,
 * said here rather than promised away (Design's 252; HANDOFF 308).
 */
import { useEffect, useId, useState } from 'react';

import { LabelledSwitch } from '@/components/form';
import { looksLikePhone } from '@/features/engine/lifecycle';

import styles from './automix.module.css';
import { setPrefs, usePrefs, type BetweenTracks, type Lean } from './prefs';
import { mixSupport } from './support';

const PHONE_QUERY = '(max-width: 768px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(PHONE_QUERY).matches),
  );
  useEffect(() => {
    const list = window.matchMedia?.(PHONE_QUERY);
    if (!list) return;
    const on = () => setNarrow(list.matches);
    list.addEventListener?.('change', on);
    return () => list.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

export function BetweenTracksSettings({ crossfadeSeconds = 6 }: { crossfadeSeconds?: number }) {
  const prefs = usePrefs();
  const id = useId();
  const narrow = useNarrow();
  const phone =
    narrow || looksLikePhone(typeof navigator === 'object' ? (navigator as Navigator) : null);
  const secs = crossfadeSeconds > 0 ? crossfadeSeconds : 6;
  const unsupported = mixSupport();
  const cards: { value: BetweenTracks; title: string; line: string; short: string }[] = [
    {
      value: 'off',
      title: 'Off',
      line: 'Each track plays to its end; the next starts after it. Gapless albums stay gapless.',
      short: 'Each track plays to its end.',
    },
    {
      value: 'smart',
      title: 'Smart crossfade',
      line: `A ${secs} s crossfade that skips silence at the ends and evens out loudness. Not on albums played in order.`,
      short: `${secs} s, silence skipped, loudness evened.`,
    },
    {
      value: 'dj',
      title: 'DJ mix',
      line: "Matches tempo, lines up the beats and mixes on a phrase, in the style each pair's chip says. Best on electronic music with clean intros and outros.",
      short: 'Beat-matched, on the phrase.',
    },
  ];
  return (
    <section className={styles.settings} aria-labelledby={`${id}-head`} data-between-tracks="">
      <div className={styles.settingsHead}>
        <p className="ss-player-section" id={`${id}-head`}>
          Between tracks
        </p>
        <p>How one track gives way to the next. For this browser.</p>
      </div>
      <div className={styles.cards} role="radiogroup" aria-labelledby={`${id}-head`}>
        {cards.map((c) => {
          // DJ mix on a page that can't run the decks: listed, with why
          const off = c.value === 'dj' && unsupported !== null;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={prefs.between === c.value}
              aria-disabled={off ? 'true' : undefined}
              className={styles.card}
              data-unavailable={off ? '' : undefined}
              onClick={off ? undefined : () => setPrefs({ between: c.value })}
            >
              <span className={styles.radio} aria-hidden="true" />
              <strong>{c.title}</strong>
              <small>{off ? unsupported : phone ? c.short : c.line}</small>
            </button>
          );
        })}
      </div>
      {prefs.between === 'dj' ? (
        <>
          <div className={styles.row}>
            <span>
              <span id={`${id}-auto`}>Mix automatically</span>
              <small id={`${id}-auto-why`}>
                {prefs.auto
                  ? 'Each pair mixes on its own, in its chip’s style.'
                  : 'Off: DJ mix waits for Mix now, and tracks play to their end.'}
              </small>
            </span>
            <LabelledSwitch
              checked={prefs.auto}
              aria-labelledby={`${id}-auto`}
              aria-describedby={`${id}-auto-why`}
              onCheckedChange={(auto) => setPrefs({ auto })}
            />
          </div>
          <label className={styles.row}>
            <span>
              <span>Style when Auto can choose</span>
              <small>Auto picks per pair from key and BPM; this leans it.</small>
            </span>
            <select
              className="ss-player-select"
              value={prefs.lean}
              onChange={(e) => setPrefs({ lean: e.target.value as Lean })}
            >
              <option value="auto">Auto&apos;s own pick</option>
              <option value="long">Long blends</option>
              <option value="short">Short blends</option>
            </select>
          </label>
        </>
      ) : null}
      <p className={styles.note}>
        Podcasts, audiobooks and radio always play as Off. A track still being analysed crossfades
        until it&apos;s done.
      </p>
      {phone ? (
        <p className={styles.phoneNote} role="note">
          On a phone, keep the screen on while it mixes; a locked iPhone can stop the sound. If it
          does, SYNCHRO.S finishes the mix with a short crossfade once the sound is back.
        </p>
      ) : null}
    </section>
  );
}
