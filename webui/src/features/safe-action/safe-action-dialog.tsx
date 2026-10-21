/**
 * The confirm screen every destructive tool shares, plus the two pieces a
 * tool card shows before it (the status tag and the large-move warning).
 *
 * The flow it serves: a tool PREVIEWS first (the backend records a plan of
 * exactly what would move or be deleted, and why), the card says a preview is
 * ready, and this dialog shows the counts, says plainly what happens, lists a
 * sample of the items, says when the preview stops working, and only then
 * offers a button that names the action. A refused confirm (expired, used,
 * unknown plan) shows the backend's own message and a way to preview again.
 */

import type { ReactNode } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';
import { Spinner } from '@/components/primitives';

import { previewWindowText } from './plan';
import styles from './safe-action.module.css';

export type SafeActionTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** A small status tag: a dot AND a word, never colour alone. */
export function StatusTag({
  tone = 'neutral',
  children,
}: {
  tone?: SafeActionTone;
  children: ReactNode;
}) {
  return (
    <span className={styles.tag} data-tone={tone} data-slot="safe-action-tag">
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </span>
  );
}

export const LARGE_MOVE_CHECK_LABEL = 'I checked the list and expected this many files to move';

export interface GuardBoxProps {
  /** What tripped, in plain words. */
  message: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  /** Buttons under the checkbox (the card puts "See the files" + the move here). */
  children?: ReactNode;
}

/** The warning a ratio / empty-database guard shows. The move button it
 *  carries stays disabled until the box is ticked. */
export function GuardBox({
  message,
  checked,
  onChange,
  label = LARGE_MOVE_CHECK_LABEL,
  children,
}: GuardBoxProps) {
  return (
    <div className={styles.guard} data-slot="safe-action-guard">
      <p className={styles.guardText}>
        <svg
          className={styles.guardIcon}
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span>{message}</span>
      </p>
      <label className={styles.guardCheck}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {children ? <div className={styles.actions}>{children}</div> : null}
    </div>
  );
}

export interface SafeActionStat {
  label: string;
  value: ReactNode;
}

export interface SafeActionRow {
  key: string;
  cells: ReactNode[];
}

export type SafeActionPhase =
  | { kind: 'review' }
  | { kind: 'working'; message: ReactNode }
  | {
      kind: 'done';
      title: ReactNode;
      body: ReactNode;
      tone?: 'success' | 'warning';
      extra?: { label: string; onClick: () => void };
    }
  | { kind: 'refused'; message: string; previewAgain: boolean };

export interface SafeActionDialogProps {
  open: boolean;
  onClose: () => void;
  phase: SafeActionPhase;
  /** The review title: a question that names the action. */
  title: ReactNode;
  stats?: SafeActionStat[];
  /** What happens, plainly. */
  lead?: ReactNode;
  /** A neutral or warning note above the list (a hard block, say). */
  notice?: { tone?: 'neutral' | 'warning' | 'danger'; content: ReactNode };
  columns?: string[];
  rows?: SafeActionRow[];
  /** "50 of 214 files shown". */
  shownLabel?: ReactNode;
  fullList?: { label: string; onClick: () => void; busy?: boolean };
  createdAt?: number | null;
  expiresAt?: number | null;
  guard?: GuardBoxProps;
  /** The primary button, named for the action ("Move 214 files"). Omitted
   *  when there is nothing to confirm. */
  confirmLabel?: string;
  /** `danger` for a confirm that deletes files (red, white text); the
   *  default is the accent primary. */
  confirmTone?: 'primary' | 'danger';
  confirmDisabled?: boolean;
  confirmBusy?: boolean;
  onConfirm?: () => void;
  /** An alternative that acts on nothing destructive ("Scan without moving"). */
  secondary?: { label: string; onClick: () => void };
  onPreviewAgain?: () => void;
}

function ClockIcon() {
  return (
    <svg
      className={styles.windowIcon}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ResultIcon({ tone }: { tone: 'success' | 'warning' }) {
  return (
    <span className={styles.resultIcon} data-tone={tone} aria-hidden="true">
      {tone === 'success' ? (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )}
    </span>
  );
}

export function SafeActionDialog(props: SafeActionDialogProps) {
  const { open, onClose, phase } = props;

  let header: ReactNode = props.title;
  if (phase.kind === 'done') header = phase.title;
  else if (phase.kind === 'refused') header = 'This preview can no longer be used';

  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className={styles.popup}
    >
      <DialogHeader title={header} closeLabel="Close" />
      <DialogBody>
        {phase.kind === 'review' ? <ReviewBody {...props} /> : null}
        {phase.kind === 'working' ? (
          <p className={styles.working} role="status">
            <Spinner size={20} />
            <span>{phase.message}</span>
          </p>
        ) : null}
        {phase.kind === 'done' ? (
          <div className={styles.result} role="status">
            <ResultIcon tone={phase.tone ?? 'success'} />
            <div className={styles.lead}>{phase.body}</div>
          </div>
        ) : null}
        {phase.kind === 'refused' ? (
          <div className={styles.result} role="alert">
            <ResultIcon tone="warning" />
            <p className={styles.lead}>{phase.message}</p>
            {phase.previewAgain ? (
              <p className={styles.note}>Nothing was moved or deleted.</p>
            ) : null}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Footer {...props} />
      </DialogFooter>
    </DialogFrame>
  );
}

function ReviewBody({
  stats,
  lead,
  notice,
  columns,
  rows,
  shownLabel,
  fullList,
  createdAt,
  expiresAt,
  guard,
}: SafeActionDialogProps) {
  const windowText = previewWindowText(createdAt, expiresAt);
  return (
    <>
      {stats?.length ? (
        <dl className={styles.stats}>
          {stats.map((stat) => (
            <div className={styles.stat} key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {lead ? <p className={styles.lead}>{lead}</p> : null}
      {notice ? (
        <p className={styles.notice} data-tone={notice.tone ?? 'neutral'}>
          {notice.content}
        </p>
      ) : null}
      {guard ? <GuardBox {...guard} /> : null}
      {rows?.length && columns?.length ? (
        <div className={styles.sample}>
          <div className={styles.sampleScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    {row.cells.map((cell, index) => (
                      <td key={columns[index] ?? index}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shownLabel || fullList ? (
            <div className={styles.sampleFoot}>
              <span>{shownLabel}</span>
              {fullList ? (
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={fullList.busy}
                  onClick={fullList.onClick}
                >
                  {fullList.busy ? 'Preparing the list…' : fullList.label}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {windowText ? (
        <p className={styles.window}>
          <ClockIcon />
          <span>{windowText}</span>
        </p>
      ) : null}
    </>
  );
}

function Footer({
  phase,
  onClose,
  confirmLabel,
  confirmTone = 'primary',
  confirmDisabled,
  confirmBusy,
  onConfirm,
  secondary,
  onPreviewAgain,
}: SafeActionDialogProps) {
  if (phase.kind === 'working') {
    return (
      <Button size="lg" onClick={onClose}>
        Close
      </Button>
    );
  }
  if (phase.kind === 'done') {
    return (
      <>
        {phase.extra ? (
          <Button size="lg" onClick={phase.extra.onClick}>
            {phase.extra.label}
          </Button>
        ) : null}
        <Button size="lg" variant="primary" onClick={onClose}>
          Done
        </Button>
      </>
    );
  }
  if (phase.kind === 'refused') {
    return phase.previewAgain && onPreviewAgain ? (
      <>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button size="lg" variant="primary" onClick={onPreviewAgain}>
          Preview again
        </Button>
      </>
    ) : (
      <Button size="lg" variant="primary" onClick={onClose}>
        Close
      </Button>
    );
  }
  return (
    <>
      <Button size="lg" onClick={onClose}>
        Cancel
      </Button>
      {secondary ? (
        <Button size="lg" onClick={secondary.onClick} disabled={confirmBusy}>
          {secondary.label}
        </Button>
      ) : null}
      {confirmLabel && onConfirm ? (
        <Button
          size="lg"
          variant={confirmTone === 'danger' ? 'default' : 'primary'}
          className={confirmTone === 'danger' ? styles.dangerButton : undefined}
          data-tone={confirmTone}
          disabled={confirmDisabled || confirmBusy}
          onClick={onConfirm}
        >
          {confirmBusy ? 'Working…' : confirmLabel}
        </Button>
      ) : null}
    </>
  );
}
