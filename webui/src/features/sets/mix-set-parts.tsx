/**
 * A mix set's page beyond 22c (28e, 28f): the note per track (a third line,
 * typed in place; "Add a note" only on hover and focus), and the transition
 * chip at the end of each step line (26i's shape: "Long blend · 32 bars",
 * then who chose it). The chip opens 26a's picker: Auto, the seven styles,
 * and a length of 2 · 4 · 8 · 16 · 32 bars. Auto-mix isn't built yet, so
 * the chip only says what's saved; Auto stays the default.
 */
import { useEffect, useId, useRef, useState } from 'react';

import { usePopoverDismiss } from '@/routes/sync/-ui/use-popover-dismiss';

import type { Step, Transition, TransitionStyle } from './sets.api';

import { TRANSITION_BARS, TRANSITION_STYLES } from './sets.api';
import { STYLE_WORDS, chipWords, transitionOf, whoChose } from './sets.format';
import styles from './sets.module.css';

/** The note's longest (the server keeps 500 characters). */
export const NOTE_MAX = 500;

export function NoteLine({
  note,
  title,
  onSave,
}: {
  note: string | null | undefined;
  title: string;
  onSave: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note ?? '');
  const id = useId();
  useEffect(() => {
    if (!editing) setText(note ?? '');
  }, [note, editing]);
  const done = () => {
    setEditing(false);
    const next = text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
    if (next !== (note ?? '')) onSave(next || null);
  };
  if (editing) {
    return (
      <span className={styles.noteEdit}>
        <label className={styles.srOnly} htmlFor={id}>
          A note for {title}
        </label>
        <input
          id={id}
          className={styles.noteInput}
          value={text}
          maxLength={NOTE_MAX}
          placeholder="mix out at the breakdown"
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onBlur={done}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              done();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setText(note ?? '');
              setEditing(false);
            }
          }}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.note}
      data-empty={note ? undefined : ''}
      aria-label={note ? `Note for ${title}: ${note}. Change it` : `Add a note to ${title}`}
      onClick={() => setEditing(true)}
    >
      {note || 'Add a note'}
    </button>
  );
}

const STYLE_HINTS: Partial<Record<TransitionStyle, string>> = {
  auto: 'Auto-mix picks when it plays',
};

export function TransitionChip({
  transition,
  step,
  from,
  to,
  onChange,
}: {
  transition: Transition | null | undefined;
  step: Step;
  from: string;
  to: string;
  onChange: (next: Transition) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const t = transitionOf(transition);
  return (
    <span className={styles.chipWrap}>
      <button
        ref={ref}
        type="button"
        className={styles.chip}
        data-tone={step.kind}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Transition from ${from} to ${to}: ${chipWords(t)}, ${whoChose(t) === 'auto' ? 'auto' : 'your choice'}. Change it`}
        onClick={() => setOpen((v) => !v)}
      >
        <i aria-hidden="true" />
        {chipWords(t)}
      </button>
      <span className={styles.chipWho}>{whoChose(t)}</span>
      {open ? (
        <TransitionPicker
          anchor={ref.current}
          transition={t}
          step={step}
          from={from}
          to={to}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}

function TransitionPicker({
  anchor,
  transition,
  step,
  from,
  to,
  onChange,
  onClose,
}: {
  anchor: HTMLElement | null;
  transition: Transition;
  step: Step;
  from: string;
  to: string;
  onChange: (next: Transition) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const name = useId();
  usePopoverDismiss({ ref, anchor, onClose });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => {
      if (anchor && document.contains(anchor)) anchor.focus();
    };
  }, [anchor]);
  const pick = (style: TransitionStyle) =>
    onChange({
      style,
      bars: style === 'cut' ? null : (transition.bars ?? (style === 'auto' ? null : 16)),
    });
  const cut = transition.style === 'cut';
  return (
    <div
      ref={ref}
      className={styles.picker}
      role="dialog"
      aria-label={`How ${from} goes into ${to}`}
      data-popover-layer=""
    >
      <p className={styles.pickerPair}>
        {from} → {to}
      </p>
      <p className={styles.pickerWhy}>{step.reason}</p>
      <div className={styles.pickerStyles} role="radiogroup" aria-label="Style">
        {TRANSITION_STYLES.map((style) => (
          <button
            key={style}
            type="button"
            role="radio"
            aria-checked={transition.style === style}
            className={styles.pickerStyle}
            onClick={() => pick(style)}
          >
            <span>{STYLE_WORDS[style]}</span>
            {STYLE_HINTS[style] ? (
              <span className={styles.pickerHint}>{STYLE_HINTS[style]}</span>
            ) : null}
          </button>
        ))}
      </div>
      <p className={styles.pickerLabel} id={`${name}-len`}>
        Length
      </p>
      <div className={styles.pickerBars} role="radiogroup" aria-labelledby={`${name}-len`}>
        {TRANSITION_BARS.map((bars) => (
          <button
            key={bars}
            type="button"
            role="radio"
            aria-checked={!cut && transition.bars === bars}
            aria-disabled={cut ? 'true' : undefined}
            aria-label={`${bars} bars`}
            className={styles.pickerBar}
            onClick={cut ? undefined : () => onChange({ ...transition, bars })}
          >
            {bars}
          </button>
        ))}
      </div>
      {cut ? <p className={styles.pickerWhy}>A cut has no length.</p> : null}
      <div className={styles.pickerFoot}>
        <button type="button" className={styles.pickerDone} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
