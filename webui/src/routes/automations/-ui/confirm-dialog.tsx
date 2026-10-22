import type { ReactNode } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';

import styles from './automations.module.css';

/**
 * Ask first: a title that names the action, a plain sentence on what happens
 * and what doesn't, the way back, then a button that names the action. A
 * delete (`danger`) gets the danger fill, as the design system's permanent
 * deletes do.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
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
      <DialogBody>
        <div className={styles.dialogText}>{children}</div>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          size="lg"
          variant="primary"
          className={tone === 'danger' ? styles.dangerButton : undefined}
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
