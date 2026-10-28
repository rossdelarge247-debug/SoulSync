import { Button } from '@/components/form';

/**
 * The player while auto-mix mixes (26d–26f): one now-playing with a
 * handover, not two mini decks.
 *
 * - **HandoverRecord** (the record): both tracks, going out dimmed with
 *   Deck A's edge, coming in with Deck B's and its tempo change;
 * - **HandoverDeck** (the waveform's place): two lanes on one bar ruler,
 *   the window shaded, the playhead and the marker (the bass swap, the
 *   drop); "Long blend · 32 bars · bass swaps at bar 16 · 0:23 left"; Back
 *   to the outgoing track and Finish now (26d's "Open DJ now" comes with
 *   Brief E: 323). Before it starts, the countdown with Cancel, for Mix now
 *   and for an automatic mix or cut alike, over its last 16 bars (314); on
 *   a phone, 308's line under the mixing sheet (324);
 * - **BarStatus** (the collapsed bar's middle, 26e): counting down in bars
 *   with Cancel, or mixing with both titles and a two-line handover bar; a
 *   pair that couldn't be beat-matched says 302's sentence in the
 *   countdown's line ("Couldn't beat-match: cutting on the phrase · …");
 * - **MixNowButton** (26a): beside Next, which still cuts; key X. In the
 *   bar, "in 2:58" beside it until the countdown (314).
 */
import type { AutomixView, HandoverLanes } from './controller';

import styles from './automix.module.css';
import { STYLE_LABELS, fallbackSentence, inWords } from './plans';

/** 308's words (324): under the phone's mixing sheet, one line. */
export const PHONE_LOCK_WORDS =
  "If a call or the lock stops the sound, SYNCHRO.S cuts to the next track when it's back.";

export interface HandoverActions {
  mixNow: () => void;
  cancel: () => void;
  finishNow: () => void;
  back: () => void;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function styleWords(view: AutomixView): string {
  const t = view.transition;
  const plan = view.plan;
  const raw = t?.style ?? plan?.style ?? 'auto';
  // the engine's own finish of a mix the system cut off (Design's 252)
  if (raw === 'crossfade') return 'Finishing the mix';
  const style = raw as keyof typeof STYLE_LABELS;
  const label = STYLE_LABELS[style] ?? t?.label ?? 'Mix';
  const bars = t?.bars || plan?.bars;
  return style === 'cut' || !bars ? label : `${label} · ${bars} bars`;
}

function markerWords(view: AutomixView): string | null {
  const m = view.transition?.marker;
  if (!m) return null;
  // the bar the change comes after: a 32-bar blend's swap is "at bar 16" (26d)
  const bar = Math.max(1, Math.round(m.beat / 4));
  if (/bass/.test(m.label)) return `bass swaps at bar ${bar}`;
  if (/drop/.test(m.label)) return `the drop lands at bar ${bar}`;
  return `${m.label} at bar ${bar}`;
}

/** A `cut` plan (302's cut on the phrase, or a cut on the bar): the player cuts, no decks. */
function isCut(view: AutomixView): boolean {
  return view.plan?.status === 'cut';
}

/**
 * How far off the countdown is: in bars, or in seconds for 302's echo out
 * placed by time (no grid going out, so no bars to count: step 2's review).
 */
export function countWords(view: AutomixView): string {
  const plan = view.plan;
  if (plan?.status === 'ok' && plan.out && plan.out.bar == null) {
    const s = Math.max(0, Math.ceil(view.inSeconds ?? view.transition?.secondsLeft ?? 0));
    return `${s} s`;
  }
  const n = view.barsToGo ?? 0;
  return `${n} bar${n === 1 ? '' : 's'}`;
}

/** "Mixing · bar 12 of 32", or the countdown's words. */
export function stageWords(view: AutomixView): string {
  const t = view.transition;
  const to = view.pair?.toTitle || 'the next track';
  if (view.stage === 'counting' || (!t && view.barsToGo !== null)) {
    const bars = countWords(view);
    return isCut(view) ? `Cutting to ${to} in ${bars}…` : `Mixing into ${to} in ${bars}…`;
  }
  if (view.stage === 'back') return `Back to ${view.pair?.fromTitle || 'the last track'}`;
  if (view.stage === 'settling' || view.stage === 'handback') return `Mixed into ${to}`;
  if (t?.bar && t.bars) return `Mixing · bar ${t.bar} of ${t.bars}`;
  return 'Mixing';
}

/** The countdown's line: where it starts and in what style, or 302's sentence. */
export function countdownMeta(view: AutomixView): string {
  const sentence = fallbackSentence(view.plan);
  if (sentence) return sentence;
  return `starts on the next phrase · ${styleWords(view)}`;
}

export function MixNowButton({
  view,
  onMixNow,
  compact = false,
}: {
  view: AutomixView;
  onMixNow: () => void;
  compact?: boolean;
}) {
  if (!view.dj) return null;
  // the countdown has its own Cancel in Mix now's place (26e)
  if (view.barsToGo !== null) return null;
  if (['counting', 'mixing', 'settling', 'handback', 'back', 'rejoin'].includes(view.stage))
    return null;
  const disabled = !view.canMixNow;
  // the bar keeps "in 2:58" until the last 16 bars' countdown (314)
  const when = compact && !view.cancelled ? inWords(view.inSeconds) : null;
  const button = (
    <button
      type="button"
      className={`${styles.mixNow} ${compact ? styles.mixNowBar : ''}`}
      aria-disabled={disabled ? 'true' : undefined}
      aria-keyshortcuts="X"
      title={
        disabled
          ? (view.mixNowWhy ?? undefined)
          : view.failed
            ? `Couldn't start the mix: ${view.failed}. Try again (X)`
            : 'Mix now (X)'
      }
      data-failed={view.failed ? '' : undefined}
      data-automix-mixnow=""
      onClick={disabled ? undefined : onMixNow}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="9" cy="12" r="6" />
        <circle cx="15" cy="12" r="6" />
      </svg>
      Mix now
    </button>
  );
  return when ? (
    <>
      {button}
      <span className={styles.mixNowWhen} data-automix-when="">
        {when}
      </span>
    </>
  ) : (
    button
  );
}

/**
 * UX-9: a mix that couldn't start says so, visibly, with Try again; the
 * track meanwhile plays on straight.
 */
export function FailedLine({
  view,
  onRetry,
  className,
}: {
  view: AutomixView;
  onRetry: () => void;
  className?: string;
}) {
  if (!view.failed) return null;
  return (
    <div className={className ?? styles.bar} data-automix-failed="">
      <span className={styles.barWords}>
        <strong>Couldn&apos;t start the mix</strong>
        <span className={styles.barMeta}>
          {view.failed} · {view.pair?.fromTitle || 'the track'} plays on straight
        </span>
      </span>
      <span className={styles.barActions}>
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      </span>
    </div>
  );
}

export function BarStatus({ view, actions }: { view: AutomixView; actions: HandoverActions }) {
  const t = view.transition;
  const counting = view.stage === 'counting' || (!t && view.barsToGo !== null);
  if (view.failed && !counting && !t) return <FailedLine view={view} onRetry={actions.mixNow} />;
  if (counting) {
    return (
      <div className={styles.bar} data-automix-bar="counting">
        <span className={styles.barWords}>
          <strong>{stageWords(view)}</strong>
          <span className={styles.barMeta}>{countdownMeta(view)}</span>
        </span>
        <span className={styles.barActions}>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Cancel: ${view.pair?.fromTitle || 'this track'} plays out straight on`}
            onClick={actions.cancel}
          >
            Cancel
          </Button>
        </span>
      </div>
    );
  }
  if (!t) return null;
  const progress = t.bars ? Math.min(1, Math.max(0, ((t.bar ?? 1) - 1) / t.bars)) : 0;
  const mixing = view.stage === 'mixing';
  return (
    <div className={styles.bar} data-automix-bar="mixing">
      <span className={styles.barWords}>
        <strong>
          {view.pair?.fromTitle} → {view.pair?.toTitle}
        </strong>
        <span className={styles.barMeta}>{stageWords(view)}</span>
      </span>
      <span className={styles.handoverBar} aria-hidden="true">
        <span>
          <i style={{ width: `${(1 - progress) * 100}%` }} />
        </span>
        <span>
          <i style={{ width: `${progress * 100}%` }} />
        </span>
      </span>
      {mixing ? (
        <span className={styles.barActions}>
          <Button
            size="sm"
            variant="ghost"
            disabled={!t.canGoBack}
            focusableWhenDisabled
            aria-label={`Back to ${view.pair?.fromTitle || 'the last track'}`}
            title={
              t.canGoBack ? undefined : `Too near the end of ${view.pair?.fromTitle} to go back`
            }
            onClick={actions.back}
          >
            Back
          </Button>
          <Button size="sm" variant="secondary" onClick={actions.finishNow}>
            Finish now
          </Button>
        </span>
      ) : null}
    </div>
  );
}

export function HandoverRecord({ view }: { view: AutomixView }) {
  const pair = view.pair;
  if (!pair) return null;
  const tempo = view.incomingBpm;
  const change = tempo
    ? ` · ${tempo.bpm.toFixed(1)} (${tempo.pct >= 0 ? '+' : '−'}${Math.abs(tempo.pct).toFixed(1)}%)`
    : '';
  const back = view.stage === 'back';
  return (
    <div className={styles.record} data-automix-record="">
      <p className={styles.label}>{stageWords(view)}</p>
      <div className={styles.deckLine} data-deck={back ? 'b' : 'a'}>
        <strong>{pair.fromTitle}</strong>
        <span>
          {pair.fromArtist ? `${pair.fromArtist} · ` : ''}
          {back ? 'staying' : 'going out'}
        </span>
      </div>
      <div className={styles.deckLine} data-deck={back ? 'a' : 'b'}>
        <strong>{pair.toTitle}</strong>
        <span>
          {pair.toArtist ? `${pair.toArtist} · ` : ''}
          {back ? 'going back to Up next' : 'coming in'}
          {back ? '' : change}
        </span>
      </div>
    </div>
  );
}

/** The two lanes on one bar ruler (26d). */
export function Lanes({ lanes, phi }: { lanes: HandoverLanes; phi: number | null }) {
  const W = 600;
  const H = 84;
  const ruler = 12;
  const laneH = (H - ruler - 6) / 2;
  const span = lanes.phi1 - lanes.phi0;
  const x = (beat: number) => ((beat - lanes.phi0) / span) * W;
  const n = lanes.a.levels.length;
  const bw = W / n;
  const play = phi === null ? null : Math.max(0, Math.min(W, x(phi)));
  const bars = Math.floor(span / 4);
  const ticks: number[] = [];
  for (let b = 0; b <= bars; b++) ticks.push(Math.ceil(lanes.phi0 / 4) * 4 + b * 4);
  const label = Math.max(1, Math.round(lanes.beats / 4 / 4));
  return (
    <svg
      className={styles.lanes}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`The mix's ${Math.round(lanes.beats / 4)} bars: the track going out above, the one coming in below`}
      data-automix-lanes=""
    >
      <rect
        x={x(0)}
        y={0}
        width={Math.max(0, x(lanes.beats) - x(0))}
        height={H}
        fill="rgba(255,255,255,0.05)"
      />
      {ticks.map((beat) => {
        const bar = beat / 4;
        const inWindow = beat >= 0 && beat <= lanes.beats;
        return (
          <g key={beat}>
            <line
              x1={x(beat)}
              x2={x(beat)}
              y1={0}
              y2={ruler - 4}
              stroke={inWindow ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.18)'}
              strokeWidth={1}
            />
            {inWindow && bar % label === 0 && bar < lanes.beats / 4 ? (
              <text x={x(beat) + 2} y={ruler - 3} fontSize={9} fill="rgba(255,255,255,0.62)">
                {bar + 1}
              </text>
            ) : null}
          </g>
        );
      })}
      {Array.from(lanes.a.levels, (v, i) => {
        const h = Math.max(1, v * laneH);
        const xi = i * bw;
        return (
          <rect
            key={`a${i}`}
            x={xi + 0.5}
            y={ruler + (laneH - h) / 2}
            width={Math.max(1, bw - 1)}
            height={h}
            fill="var(--ss-deck-a)"
            opacity={play !== null && xi > play ? 0.4 : 0.95}
          />
        );
      })}
      {Array.from(lanes.b.levels, (v, i) => {
        if (v <= 0) return null;
        const h = Math.max(1, v * laneH);
        const xi = i * bw;
        return (
          <rect
            key={`b${i}`}
            x={xi + 0.5}
            y={ruler + laneH + 6 + (laneH - h) / 2}
            width={Math.max(1, bw - 1)}
            height={h}
            fill="var(--ss-deck-b)"
            opacity={play !== null && xi > play ? 0.4 : 0.95}
          />
        );
      })}
      {lanes.marker ? (
        <line
          x1={x(lanes.marker.beat)}
          x2={x(lanes.marker.beat)}
          y1={ruler}
          y2={H}
          stroke="var(--ss-deck-b)"
          strokeDasharray="3 3"
          strokeWidth={1.5}
        />
      ) : null}
      {play !== null ? (
        <line x1={play} x2={play} y1={0} y2={H} stroke="#fff" strokeWidth={2} />
      ) : null}
    </svg>
  );
}

export function HandoverDeck({
  view,
  actions,
  phone = false,
}: {
  view: AutomixView;
  actions: HandoverActions;
  /** a phone's mixing sheet: 308's line under it (324) */
  phone?: boolean;
}) {
  const t = view.transition;
  const counting = view.stage === 'counting' || (!t && view.barsToGo !== null);
  if (view.failed && !counting && !t)
    return (
      <div className={styles.deck} data-automix-deck="failed">
        <FailedLine view={view} onRetry={actions.mixNow} className={styles.countdown} />
      </div>
    );
  if (counting && !view.lanes) {
    return (
      <div className={styles.deck} data-automix-deck="counting">
        <div className={styles.countdown}>
          <strong>{stageWords(view)}</strong>
          <span>{countdownMeta(view)}</span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Cancel: ${view.pair?.fromTitle || 'this track'} plays out straight on`}
            onClick={actions.cancel}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (!t) return null;
  const marker = markerWords(view);
  const meta = [
    styleWords(view),
    marker,
    view.stage === 'mixing' || view.stage === 'back' ? `${clock(t.secondsLeft)} left` : null,
    counting ? `starts in ${clock(t.secondsLeft)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const mixing = view.stage === 'mixing';
  const from = view.pair?.fromTitle || 'the last track';
  return (
    <div className={styles.deck} data-automix-deck={view.stage}>
      {view.lanes ? <Lanes lanes={view.lanes} phi={view.phi} /> : null}
      <p className={styles.deckMeta}>{meta}</p>
      <div className={styles.deckActions}>
        {counting ? (
          <Button size="md" variant="ghost" onClick={actions.cancel}>
            Cancel
          </Button>
        ) : null}
        {mixing ? (
          <>
            <Button
              size="md"
              variant="ghost"
              disabled={!t.canGoBack}
              disabledReason={t.canGoBack ? undefined : `Too near the end of ${from} to go back`}
              onClick={actions.back}
            >
              Back to {from}
            </Button>
            <Button size="md" variant="secondary" onClick={actions.finishNow}>
              Finish now
            </Button>
          </>
        ) : null}
      </div>
      {phone && (mixing || counting) ? (
        <p className={styles.phoneNote} data-automix-phone-note="">
          {PHONE_LOCK_WORDS}
        </p>
      ) : null}
    </div>
  );
}
