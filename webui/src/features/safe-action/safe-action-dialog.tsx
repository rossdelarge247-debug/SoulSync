/**
 * The confirm screen every destructive tool shares, plus the two pieces a
 * tool card shows before it (the status tag and the large-move warning).
 *
 * The flow it serves: a tool PREVIEWS first (the backend records a plan of
 * exactly what would move or be deleted, and why), the card says a preview is
 * ready, and this dialog shows the counts, says plainly what happens, lists a
 * sample of the items, says when the preview stops working, and only then
 * offers a button that names the action. A refused confirm (expired, used,
 * unknown plan) keeps the dialog's title and fades its counts, and a warning
 * Notice shows the backend's own sentence with a way to preview again.
 *
 * The confirm is disabled until the large-move box is ticked, and then it is
 * the neutral disabled button (never a faded accent) with the reason written
 * beside it, so the state has a word and focus stays on it (aria-disabled).
 */

import type { ReactNode } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';
import {
  Notice,
  Spinner,
  StatusTag as BaseStatusTag,
  type StatusTagProps,
  type StatusTagTone,
} from '@/components/primitives';

import { previewWindowText } from './plan';
import styles from './safe-action.module.css';

export type SafeActionTone = StatusTagTone;

/** A small status tag: a dot AND a word, never colour alone. The shared
 *  StatusTag (components/primitives), keeping the test hook this feature's
 *  callers already use. */
export function StatusTag(props: StatusTagProps) {
  return <BaseStatusTag data-slot="safe-action-tag" {...props} />;
}

export const LARGE_MOVE_CHECK_LABEL = 'I checked the list and expected this many files to move';

/** The reason the confirm is disabled while the large-move box is unticked. */
export const LARGE_MOVE_REASON = 'Tick "I checked the list" to move the files.';

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
        <span className={styles.guardDot} aria-hidden="true" />
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
  | {
      kind: 'refused';
      /** The backend's own sentence. Shown as it is; the code never is. */
      message: string;
      /** A plan refusal: previewing again is the way out. */
      previewAgain: boolean;
      /** The 409 code (`plan_expired`, `plan_unknown`, …), when there is one. */
      code?: string;
    };

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
  /** `danger` for a confirm that deletes files (dark text on the danger
   *  red); the default is the accent primary. */
  confirmTone?: 'primary' | 'danger';
  confirmDisabled?: boolean;
  /**
   * Why the confirm is disabled, written beside it in the footer. Defaults
   * to LARGE_MOVE_REASON while a guard box is unticked.
   */
  confirmDisabledReason?: ReactNode;
  confirmBusy?: boolean;
  onConfirm?: () => void;
  /** An alternative that acts on nothing destructive ("Scan without moving"). */
  secondary?: { label: string; onClick: () => void };
  onPreviewAgain?: () => void;
}

/** The expiry line's marker: a small ring, as on the board. */
function WindowRing() {
  return <span className={styles.windowRing} aria-hidden="true" />;
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

/** The refused state's Notice title: expired says so, other refusals say the
 *  preview can't be used, and anything else says it didn't go through. */
export function refusalTitle(phase: { code?: string; previewAgain: boolean }): string {
  if (phase.code === 'plan_expired') return 'This preview has expired';
  if (phase.previewAgain) return 'This preview can no longer be used';
  return "That didn't go through";
}

export function SafeActionDialog(props: SafeActionDialogProps) {
  const { open, onClose, phase } = props;

  const header: ReactNode = phase.kind === 'done' ? phase.title : props.title;

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
          <>
            <Notice
              tone={phase.previewAgain ? 'warning' : 'danger'}
              role="alert"
              title={refusalTitle(phase)}
              data-code={phase.code || undefined}
            >
              <p>{phase.message}</p>
              {phase.previewAgain ? <p>Nothing was moved or deleted.</p> : null}
            </Notice>
            {props.stats?.length ? <StatTiles stats={props.stats} faded /> : null}
          </>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Footer {...props} />
      </DialogFooter>
    </DialogFrame>
  );
}

/** The count tiles. Faded (and hidden from screen readers) once the preview
 *  can't be used, so you remember what you were doing. */
function StatTiles({ stats, faded = false }: { stats: SafeActionStat[]; faded?: boolean }) {
  return (
    <dl
      className={styles.stats}
      data-faded={faded ? 'true' : undefined}
      aria-hidden={faded ? true : undefined}
    >
      {stats.map((stat) => (
        <div className={styles.stat} key={stat.label}>
          <dt>{stat.label}</dt>
          <dd>{stat.value}</dd>
        </div>
      ))}
    </dl>
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
      {stats?.length ? <StatTiles stats={stats} /> : null}
      {/* a div, so a lead can carry a list (the delete-original confirm) */}
      {lead ? <div className={styles.lead}>{lead}</div> : null}
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
          <WindowRing />
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
  confirmDisabledReason,
  confirmBusy,
  onConfirm,
  secondary,
  onPreviewAgain,
  guard,
}: SafeActionDialogProps) {
  const reason = confirmDisabledReason ?? (guard && !guard.checked ? LARGE_MOVE_REASON : undefined);
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
          // the reason only while it's waiting on the user, not while busy
          disabledReason={confirmDisabled && !confirmBusy ? reason : undefined}
          onClick={onConfirm}
        >
          {confirmBusy ? 'Working…' : confirmLabel}
        </Button>
      ) : null}
    </>
  );
}
