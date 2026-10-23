/**
 * The flow's frame (14b, 14l): the 64px header (wordmark, hairline, title,
 * the promise line, Leave or Close), the six-step row, an 880px column and
 * the pinned footer. On a phone: the 56px bar (× or ‹, title, "n of 6"), the
 * promise as a 40px line, and the footer's primary full width.
 */

import type { ReactNode } from 'react';

import { useEffect, useId, useRef } from 'react';

import { Button } from '@/components/form';

import type { PromiseLine } from './drives.api';

import { STEPS } from './drives.format';
import styles from './move.module.css';

export interface FlowShellProps {
  /** 0–5 for the step row ("n of 6"), or null where the board has none. */
  step: number | null;
  promise: PromiseLine;
  /** "Leave" until copying starts, then "Close". */
  leaveLabel: 'Leave' | 'Close' | null;
  onLeave: () => void;
  /** The phone bar's ‹, where there's a step to go back to. */
  onBack?: () => void;
  phoneTitle?: string;
  footer?: ReactNode;
  /** the footer only on a phone (the failure's buttons sit in its Notice on a computer) */
  footerPhoneOnly?: boolean;
  children: ReactNode;
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function Tick({ tone = 'success' }: { tone?: 'success' | 'warning' }) {
  return (
    <span className={styles.check} data-tone={tone} aria-hidden="true">
      {tone === 'success' ? <CheckIcon /> : '!'}
    </span>
  );
}

export function StepRow({ current }: { current: number }) {
  return (
    <ol className={styles.steps} aria-label="Steps">
      {STEPS.map((name, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'upcoming';
        return (
          <li
            key={name}
            className={styles.step}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className={styles.stepChip} aria-hidden="true">
              {state === 'done' ? <CheckIcon /> : i + 1}
            </span>
            <span>
              {name}
              {state === 'done' ? <span className={styles.srOnly}> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function FlowShell({
  step,
  promise,
  leaveLabel,
  onLeave,
  onBack,
  phoneTitle = 'Move to another drive',
  footer,
  footerPhoneOnly = false,
  children,
}: FlowShellProps) {
  const titleId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  // a new step starts at the top
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [step, phoneTitle]);
  // the app's floating buttons step aside while the flow is open
  useEffect(() => {
    document.body.setAttribute('data-drive-move-open', '');
    return () => document.body.removeAttribute('data-drive-move-open');
  }, []);
  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-drive-move=""
    >
      <header className={styles.header}>
        <span className={styles.wordmark}>SYNCHRO.S</span>
        <span className={styles.headRule} aria-hidden="true" />
        <h1 className={styles.headTitle} id={titleId}>
          Move your music to another drive
        </h1>
        <span className={styles.headSpacer} />
        <p className={styles.promise} data-tone={promise.tone} aria-live="polite">
          <span className={styles.dot} aria-hidden="true" />
          {promise.words}
        </p>
        {leaveLabel ? (
          <Button size="lg" variant="ghost" onClick={onLeave}>
            {leaveLabel}
          </Button>
        ) : null}
      </header>
      <div className={styles.phoneBar}>
        {onBack ? (
          <button type="button" className={styles.iconButton} aria-label="Back" onClick={onBack}>
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={leaveLabel ?? 'Close'}
            onClick={onLeave}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        <p className={styles.headTitle} aria-hidden="true">
          {phoneTitle}
        </p>
        {step !== null ? <span className={styles.stepCount}>{step + 1} of 6</span> : null}
      </div>
      <p className={styles.promiseLine} data-tone={promise.tone} aria-hidden="true">
        <span className={styles.dot} />
        {promise.words}
      </p>
      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.column}>
          {step !== null ? <StepRow current={step} /> : null}
          {children}
        </div>
      </div>
      {footer ? (
        <footer className={`${styles.footer} ${footerPhoneOnly ? styles.footerPhoneOnly : ''}`}>
          {footer}
        </footer>
      ) : null}
    </div>
  );
}

export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackCopy(text),
    );
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
