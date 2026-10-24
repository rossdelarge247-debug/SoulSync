import { DialogFrame } from '@/components/dialog';

import styles from './action-sheet.module.css';

export interface SheetAction {
  key: string;
  label: string;
  onSelect: () => void;
  /** Disabled-neutral: kept in the list with its reason beside it, and does nothing. */
  disabled?: boolean;
  /** Why it's disabled ("Music HD isn't connected"), written at the row's end. */
  reason?: string;
}

/**
 * The phone's action sheet (15d, HANDOFF 94): a `#141416` sheet from the
 * bottom over a 50% scrim, the 36×4 grabber, a 14px line naming what it's
 * for, then 52px rows on hairlines. A dialog (focus kept inside, Escape and
 * a press on the scrim close it, the focus goes back to the "…"); choosing a
 * row closes the sheet first, then does it.
 */
export function ActionSheet({
  label,
  heading,
  actions,
  onClose,
}: {
  label: string;
  heading: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  return (
    <DialogFrame
      open
      onOpenChange={(open) => !open && onClose()}
      aria-label={label}
      viewportClassName={styles.viewport}
      className={styles.sheet}
    >
      <span className={styles.grabber} aria-hidden="true" />
      <p className={styles.heading}>{heading}</p>
      <ul className={styles.list}>
        {actions.map((action) => (
          <li key={action.key}>
            <button
              type="button"
              className={styles.item}
              aria-disabled={action.disabled ? 'true' : undefined}
              onClick={
                action.disabled
                  ? undefined
                  : () => {
                      onClose();
                      action.onSelect();
                    }
              }
            >
              {action.label}
              {action.disabled && action.reason ? (
                <span className={styles.reason}>{action.reason}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </DialogFrame>
  );
}
