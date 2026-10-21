import type { ReactNode } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';

import styles from './wanted-page.module.css';

/**
 * Ask first, the design system's way: a title that names the action, a plain
 * sentence on what happens and what doesn't, then the way back and a button
 * that names the action. Nothing here moves or deletes files, so the confirm
 * is the ordinary primary.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      className={styles.dialog}
    >
      <DialogHeader title={title} />
      <DialogBody>{children}</DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={busy}
          focusableWhenDisabled
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
