import type { ComponentProps, ReactNode } from 'react';

import { Dialog } from '@base-ui/react/dialog';
import clsx from 'clsx';

import styles from './dialog.module.css';

/**
 * A modal dialog: base-ui's focus trap, Escape, outside press and scroll lock.
 *
 * By default it brings its own backdrop and frame, and `className` is added to
 * the popup. An overlay that keeps its own look passes `viewportClassName`
 * instead: that class goes on the viewport (backdrop colour, centring,
 * z-index), `className` alone styles the popup, and none of the default frame
 * styles apply.
 */
export function DialogFrame({
  'aria-label': ariaLabel,
  children,
  className,
  id,
  initialFocus,
  onOpenChange,
  open,
  viewportClassName,
}: {
  'aria-label'?: string;
  children: ReactNode;
  className?: string;
  /** Goes on the popup, the element with role="dialog". */
  id?: string;
  initialFocus?: ComponentProps<typeof Dialog.Popup>['initialFocus'];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  viewportClassName?: string;
}) {
  const custom = viewportClassName !== undefined;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {custom ? null : <Dialog.Backdrop className={styles.backdrop} />}
        <Dialog.Viewport className={custom ? viewportClassName : styles.viewport}>
          <Dialog.Popup
            aria-label={ariaLabel}
            id={id}
            initialFocus={initialFocus}
            className={custom ? className : clsx(styles.popup, className)}
          >
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The title row. `description` is the one sentence under the title that the
 * boards draw (15px at 72%, 4px below it), read as the dialog's description.
 * Each part carries a `data-slot` so a dialog drawn to a board can restyle
 * its frame without reaching into this module's class names.
 */
export function DialogHeader({
  children,
  closeLabel = 'Close dialog',
  description,
  title,
}: {
  children?: ReactNode;
  closeLabel?: string;
  description?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className={styles.header} data-slot="dialog-header">
      <div className={styles.headerContent}>
        <Dialog.Title className={styles.title}>{title}</Dialog.Title>
        {description ? (
          <Dialog.Description className={styles.description}>{description}</Dialog.Description>
        ) : null}
        {children ? <div className={styles.headerMeta}>{children}</div> : null}
      </div>
      <Dialog.Close
        className={styles.close}
        aria-label={closeLabel}
        title={closeLabel}
        data-slot="dialog-close"
      >
        ×
      </Dialog.Close>
    </div>
  );
}

export function DialogBody({ children }: { children: ReactNode }) {
  return (
    <div className={styles.body} data-slot="dialog-body">
      {children}
    </div>
  );
}

/**
 * The footer row of buttons. `note` is the 14px meta line the boards put at
 * its left, taking the slack so the buttons stay right (15e: "It runs in the
 * background; Activity shows it, with Stop.").
 */
export function DialogFooter({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className={styles.footer} data-slot="dialog-footer">
      {note ? (
        <span className={styles.footerNote} data-slot="dialog-footer-note">
          {note}
        </span>
      ) : null}
      {children}
    </div>
  );
}
