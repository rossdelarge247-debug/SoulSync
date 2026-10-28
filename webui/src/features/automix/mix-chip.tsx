/**
 * The transition chip and its style picker (26a, 26c, 26g, 26i): one
 * component for Up next's gaps and a set's step lines.
 *
 * The chip: a 32px pill with a dot in the step's tone and "style · length",
 * then in meta who chose it ("auto" or "yours") and the step's reason. Its
 * states (26g): Auto and yours (the step's dot), covering a jump (the dot
 * stays warning), Waiting (being analysed · Analyse now), 302's move for a
 * pair that couldn't be beat-matched (Cut, Echo out or Straight on, amber,
 * "couldn't beat-match: <why>"), a short blend where a long one didn't fit
 * (303) and an unsure "one" (304, the warning dot), Mixing now and the
 * countdown (Deck B's cyan), and a set's chip with Auto mix off (dimmed,
 * with no line of its own: Up next's head says it once, 320).
 *
 * The picker: the pair and why, Auto naming its pick, the seven styles with
 * one line each (a style the pair can't do stays listed, aria-disabled,
 * with why), and the length in bars. In Up next it floats over the tray
 * (a sheet on a phone); after a change to a set's chip from Up next it asks
 * "Save it to Sunday Set too?" in place.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import type { AnalysisEntry } from '@/features/dj/analysis.api';
import type { Step, StepKind, Transition, TransitionStyle } from '@/features/sets/sets.api';

import { AnalysisLine } from '@/features/dj/analysis-line';
import { pending } from '@/features/dj/analysis.format';
import { TRANSITION_BARS } from '@/features/sets/sets.api';
import { chipWords, transitionOf, whoChose } from '@/features/sets/sets.format';
import sets from '@/features/sets/sets.module.css';
import { usePopoverDismiss } from '@/routes/sync/-ui/use-popover-dismiss';

import styles from './automix.module.css';
import {
  PICKER_STYLES,
  STYLE_LABELS,
  STYLE_LINES,
  autoLine,
  chipWhy,
  chipWhyShort,
  fallbackOf,
  fallbackSentence,
  planWords,
  type PairPlan,
} from './plans';

export type ChipLive =
  | { kind: 'mixing'; words: string }
  | { kind: 'counting'; bars: number; onCancel: () => void };

export interface TransitionChipProps {
  transition: Transition | null | undefined;
  /** the step (Sets' Smooth / Jump / Not known yet and its reason) */
  step: Pick<Step, 'kind' | 'reason'>;
  from: string;
  to: string;
  onChange: (next: Transition) => void;
  /** the plan for this choice, once known (stage A's planner) */
  plan?: PairPlan | null;
  /** Auto's own plan, for "Auto: Echo out" in the picker */
  autoPlan?: PairPlan | null;
  live?: ChipLive | null;
  /** a set's chip with Auto mix off: dimmed, with no line of what plays instead (320, UX-21) */
  dimmed?: boolean;
  /** a set's step line (26i): it says the pair already, so the chip's line is
   *  who chose it ("auto" or "yours", UX-29), and what stood in the way */
  inSet?: boolean;
  /** the first gap's "in 2:58" (Design's 249) */
  when?: string | null;
  /** Waiting's Analyse now, while the track isn't in line yet */
  analyse?: (() => void) | null;
  /** Waiting: where the track it waits for is in the analysis (its bar and step) */
  progress?: AnalysisEntry | null;
  /** asked after a change in Up next while a set plays (26i) */
  saveTo?: { name: string; save: (t: Transition) => Promise<void> } | null;
  /** the phone's short reason (26b) */
  compact?: boolean;
  /** the picker floats over the page (Up next, in the player's tray) */
  floating?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type Tone = StepKind | 'wait' | 'warn' | 'mix';

const DEFAULT_LENGTH: Partial<Record<TransitionStyle, number>> = {
  long_blend: 32,
  short_blend: 8,
  bass_swap: 16,
  echo_out: 4,
  filter_sweep: 16,
  drop_swap: 16,
};

function toneOf(plan: PairPlan | null | undefined, step: Pick<Step, 'kind'>): Tone {
  if (plan?.status === 'waiting') return 'wait';
  // 302's move, and 304's unsure "one": the warning dot
  if (fallbackOf(plan) || plan?.unsure_bars) return 'warn';
  return step.kind;
}

export function TransitionChip({
  transition,
  step,
  from,
  to,
  onChange,
  plan = null,
  autoPlan = null,
  live = null,
  dimmed = false,
  inSet = false,
  when = null,
  analyse = null,
  progress = null,
  saveTo = null,
  compact = false,
  floating = false,
  onOpenChange,
}: TransitionChipProps) {
  const [open, setOpenState] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const t = transitionOf(transition);
  const setOpen = (v: boolean | ((was: boolean) => boolean)) => {
    setOpenState((was) => {
      const next = typeof v === 'function' ? v(was) : v;
      if (next !== was) onOpenChange?.(next);
      return next;
    });
  };
  if (live) {
    const words =
      live.kind === 'mixing' ? 'Mixing now' : `In ${live.bars} bar${live.bars === 1 ? '' : 's'}`;
    return (
      <span className={sets.chipWrap} data-live={live.kind}>
        {/* visual only: LiveWords says each state once (UX-15) */}
        <span className={sets.chip} data-tone="mix">
          <i aria-hidden="true" />
          {words}
        </span>
        {live.kind === 'mixing' ? (
          <span className={sets.chipWho}>{live.words}</span>
        ) : (
          <button type="button" className={styles.textButton} onClick={live.onCancel}>
            Cancel
          </button>
        )}
      </span>
    );
  }
  // a quiet play-on (an album in its order, a page that can't run the
  // decks): Up next shows no chip; 302's "plays straight on" names itself;
  // a set's chip keeps its own choice
  if (plan?.status === 'play_on' && floating && !fallbackOf(plan)) return null;
  const words =
    plan && (plan.status !== 'play_on' || fallbackOf(plan)) ? planWords(plan, t) : chipWords(t);
  const who = whoChose(t);
  // the track it waits for is in line or being worked out: its bar shows
  const inLine = pending(progress) && (progress?.state !== 'waiting' || progress.position !== null);
  const tone = toneOf(plan, step);
  // a set's chip says who chose it on screen (UX-29); dimmed (Auto mix
  // off) it has no line of what plays instead: Up next's head says it once (320)
  const detail = Boolean(
    plan && (fallbackOf(plan) || plan.shortened || plan.unsure_bars || plan.status === 'waiting'),
  );
  const meta =
    dimmed || !plan || (inSet && !detail)
      ? who
      : compact
        ? chipWhyShort(plan, t)
        : chipWhy(plan, t, to, from);
  // a phone's Waiting chip is two lines (31e): the chip, then its analysis
  const twoLine = compact && plan?.status === 'waiting' && inLine;
  return (
    <span
      className={twoLine ? `${sets.chipWrap} ${styles.twoLine}` : sets.chipWrap}
      data-dimmed={dimmed ? '' : undefined}
      title={fallbackSentence(plan) ?? undefined}
    >
      <button
        ref={ref}
        type="button"
        className={sets.chip}
        data-tone={tone}
        data-open={open ? '' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`How ${from} goes into ${to}: ${words}, ${who === 'auto' ? 'auto' : 'your choice'}${dimmed ? ' (Auto mix is off: plays straight on)' : ''}. Change it`}
        onClick={() => setOpen((v) => !v)}
      >
        <i aria-hidden="true" />
        {words}
      </button>
      <span className={sets.chipWho} data-chip-who="">
        {/* Waiting with its track in line (31c, 31e): the chip's line is the analysis */}
        {plan?.status === 'waiting' && inLine ? null : meta}
        {plan?.status === 'waiting' && analyse && !inLine ? (
          <>
            {' · '}
            <button type="button" className={styles.textButton} onClick={analyse}>
              Analyse now
            </button>
          </>
        ) : null}
      </span>
      {plan?.status === 'waiting' && inLine ? (
        <AnalysisLine
          size="marker"
          entry={progress}
          title={compact ? null : plan.waiting_for === 'from' ? from : to}
          className={styles.chipProgress}
        />
      ) : null}
      {when ? <span className={styles.chipWhen}>{when}</span> : null}
      {open ? (
        <TransitionPicker
          anchor={ref.current}
          transition={t}
          step={step}
          from={from}
          to={to}
          plan={plan}
          autoPlan={t.style === 'auto' ? plan : autoPlan}
          floating={floating}
          saveTo={saveTo}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}

/** "no drop found in Brass Tide" → "Needs a drop: none found in Brass Tide" (26a). */
export function unavailableWords(why: string | null | undefined): string {
  if (!why) return "This pair can't do it";
  const drop = /^no (drop|breakdown) found in (.+)$/.exec(why);
  if (drop) return `Needs a ${drop[1]}: none found in ${drop[2]}`;
  return why.charAt(0).toUpperCase() + why.slice(1);
}

function TransitionPicker({
  anchor,
  transition,
  step,
  from,
  to,
  plan,
  autoPlan,
  floating,
  saveTo,
  onChange,
  onClose,
}: {
  anchor: HTMLElement | null;
  transition: Transition;
  step: Pick<Step, 'kind' | 'reason'>;
  from: string;
  to: string;
  plan: PairPlan | null;
  autoPlan: PairPlan | null;
  floating: boolean;
  saveTo: TransitionChipProps['saveTo'];
  onChange: (next: Transition) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const name = useId();
  const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
  const [ask, setAsk] = useState<Transition | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  usePopoverDismiss({ ref, anchor, onClose });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => {
      if (anchor && document.contains(anchor)) anchor.focus();
    };
  }, [anchor]);
  useLayoutEffect(() => {
    // UX-22: anchored to the chip, flipped above it when there's more room
    // there, and kept inside the window (it scrolls within it), wherever the
    // chip is: Up next's tray or a set's page. On a phone it's a sheet from
    // the bottom (sets.module.css)
    if (!anchor || window.innerWidth <= 640) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(r.left, vw - 348));
    const below = vh - r.bottom;
    setPlace(
      below >= 460 || below >= r.top
        ? { position: 'fixed', left, top: r.bottom + 6, bottom: 'auto', maxHeight: below - 16 }
        : { position: 'fixed', left, top: 'auto', bottom: vh - r.top + 6, maxHeight: r.top - 16 },
    );
  }, [anchor]);
  const choose = (next: Transition) => {
    onChange(next);
    if (saveTo) {
      setAsk(next);
      setSaving('idle');
    }
  };
  // a style starts at its own length (the planner's: long blend 32, short
  // blend 8, echo out 4, the rest 16), or keeps the one already chosen
  const pick = (style: TransitionStyle) =>
    choose({
      style,
      bars:
        style === 'cut' || style === 'auto'
          ? null
          : transition.style !== 'auto' && transition.style !== 'cut' && transition.bars
            ? transition.bars
            : (DEFAULT_LENGTH[style] ?? 16),
    });
  const cut = transition.style === 'cut';
  const auto = transition.style === 'auto';
  const known = autoPlan ?? plan;
  const why = new Map((known?.styles ?? []).map((s) => [s.style, s]));
  const head = autoLine(autoPlan);
  const reason = (known?.why ?? '').includes(': ') ? known!.why! : step.reason;
  const pickerWhy =
    known?.pair && !reason.startsWith(known.pair) ? `${known.pair}: ${reason}` : reason;
  const body = (
    <div
      ref={ref}
      className={sets.picker}
      data-floating=""
      data-in-tray={floating ? '' : undefined}
      style={place}
      role="dialog"
      aria-label={`How ${from} goes into ${to}`}
      data-popover-layer=""
    >
      <p className={sets.pickerPair}>
        {from} → {to}
      </p>
      {pickerWhy ? <p className={sets.pickerWhy}>{pickerWhy}</p> : null}
      <div className={sets.pickerStyles} role="radiogroup" aria-label="Style">
        <button
          type="button"
          role="radio"
          aria-checked={auto}
          aria-label={head.name}
          aria-describedby={`${name}-auto`}
          className={sets.pickerStyle}
          onClick={() => pick('auto')}
        >
          <span>{head.name}</span>
          <span className={sets.pickerHint} id={`${name}-auto`}>
            {head.why}
          </span>
        </button>
        {PICKER_STYLES.map((style) => {
          const s = why.get(style);
          const unavailable = s ? !s.available : false;
          return (
            <button
              key={style}
              type="button"
              role="radio"
              aria-checked={transition.style === style}
              aria-disabled={unavailable ? 'true' : undefined}
              aria-label={STYLE_LABELS[style]}
              aria-describedby={`${name}-${style}`}
              className={sets.pickerStyle}
              data-unavailable={unavailable ? '' : undefined}
              onClick={unavailable ? undefined : () => pick(style)}
            >
              <span>{STYLE_LABELS[style]}</span>
              <span className={sets.pickerHint} id={`${name}-${style}`}>
                {unavailable ? unavailableWords(s?.why) : STYLE_LINES[style]}
              </span>
            </button>
          );
        })}
      </div>
      <p className={sets.pickerLabel} id={`${name}-len`}>
        Length
      </p>
      <div className={sets.pickerBars} role="radiogroup" aria-labelledby={`${name}-len`}>
        {TRANSITION_BARS.map((bars) => (
          <button
            key={bars}
            type="button"
            role="radio"
            aria-checked={!cut && !auto && transition.bars === bars}
            aria-disabled={cut || auto ? 'true' : undefined}
            aria-label={`${bars} bars`}
            className={sets.pickerBar}
            onClick={cut || auto ? undefined : () => choose({ ...transition, bars })}
          >
            {bars}
          </button>
        ))}
      </div>
      {cut ? <p className={sets.pickerWhy}>A cut has no length.</p> : null}
      {auto ? <p className={sets.pickerWhy}>Auto takes its pick&apos;s own length.</p> : null}
      {ask && saveTo ? (
        <div className={styles.askSave} role="group" aria-label={`Save it to ${saveTo.name} too?`}>
          <p>
            {saving === 'saved'
              ? `Saved to ${saveTo.name}.`
              : saving === 'error'
                ? `Couldn't save it to ${saveTo.name}. It plays this way in Up next.`
                : `Save it to ${saveTo.name} too?`}
          </p>
          {saving === 'idle' || saving === 'saving' ? (
            <span className={styles.askButtons}>
              <button
                type="button"
                className={sets.pickerDone}
                disabled={saving === 'saving'}
                onClick={() => {
                  setSaving('saving');
                  saveTo.save(ask).then(
                    () => setSaving('saved'),
                    () => setSaving('error'),
                  );
                }}
              >
                {saving === 'saving' ? 'Saving…' : `Save to ${saveTo.name}`}
              </button>
              <button type="button" className={styles.textButton} onClick={() => setAsk(null)}>
                Not now
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={sets.pickerFoot}>
        <button type="button" className={sets.pickerDone} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
  return createPortal(body, document.body);
}
