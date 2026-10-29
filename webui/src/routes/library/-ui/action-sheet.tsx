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
  /** A quiet line at the row's end ("Sunday Set is working", 34c). */
  meta?: string;
  /** Brief D's glyph before the words (34c): the star, or Play next. */
  icon?: 'star' | 'starred' | 'next';
  /** a desktop "…"'s submenu (Send to…, 32d); the sheet opens its own tray instead */
  submenu?: SheetAction[];
}

function SheetIcon({ icon }: { icon: NonNullable<SheetAction['icon']> }) {
  if (icon === 'next')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M4 5l10 7-10 7zM16 5h3v14h-3z" />
      </svg>
    );
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={icon === 'starred' ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
    </svg>
  );
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
              <span className={styles.icon} aria-hidden="true">
                {action.icon ? <SheetIcon icon={action.icon} /> : null}
              </span>
              {action.label}
              {action.disabled && action.reason ? (
                <span className={styles.reason}>{action.reason}</span>
              ) : action.meta ? (
                <span className={styles.reason}>{action.meta}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </DialogFrame>
  );
}
